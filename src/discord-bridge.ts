import {
  Client,
  GatewayIntentBits,
  ThreadAutoArchiveDuration,
  type Message,
  type TextChannel,
  type ThreadChannel,
} from "discord.js";

import { AcpClient } from "./acp-client.js";
import { config } from "./config.js";

const DISCORD_MESSAGE_LIMIT = 2000;

const MOOD_FACES = ["😊", "😎", "🫡", "🤓", "😏", "✌️", "💪", "🦾"];

async function setReaction(message: Message, emoji: string, current: string): Promise<string> {
  await message.react(emoji).catch(() => {});
  if (current && current !== emoji) {
    await message.reactions.cache.get(current)?.users.remove(message.client.user?.id).catch(() => {});
  }
  return emoji;
}

async function clearReaction(message: Message, current: string): Promise<void> {
  if (current) {
    await message.reactions.cache.get(current)?.users.remove(message.client.user?.id).catch(() => {});
  }
}

function splitMessage(content: string, limit = DISCORD_MESSAGE_LIMIT): string[] {
  if (content.length <= limit) return [content];
  const chunks: string[] = [];
  let text = content;
  while (text.length > limit) {
    const slice = text.slice(0, limit);
    const cut = Math.max(slice.lastIndexOf("\n"), slice.lastIndexOf(" "));
    const end = cut > 200 ? cut : limit;
    chunks.push(text.slice(0, end).trim());
    text = text.slice(end).trim();
  }
  if (text) chunks.push(text);
  return chunks;
}

function stripBotMention(content: string, botId: string): string {
  return content.replace(new RegExp(`<@!?${botId}>`, "g"), "").trim();
}

function threadName(prompt: string): string {
  const name = prompt.slice(0, 40);
  return name.length < prompt.length ? `${name}...` : name;
}

async function getOrCreateThread(message: Message, prompt: string): Promise<ThreadChannel> {
  if (message.channel.isThread()) {
    return message.channel as ThreadChannel;
  }
  return (message.channel as TextChannel).threads.create({
    name: threadName(prompt),
    autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
    startMessage: message,
  });
}

interface ActiveSession {
  acp: AcpClient;
  sessionId: string;
}

export class DiscordBridge {
  private readonly client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  // thread ID → active kiro session (persists across messages)
  private readonly sessions = new Map<string, ActiveSession>();

  async start(): Promise<void> {
    this.client.once("ready", () => {
      console.log(`opencd connected as ${this.client.user?.tag ?? "unknown"}`);
    });

    this.client.on("messageCreate", async (message) => {
      await this.onMessage(message);
    });

    await this.client.login(config.discordToken);
  }

  private async getOrCreateSession(threadId: string): Promise<ActiveSession> {
    const existing = this.sessions.get(threadId);
    if (existing) {
      console.log(`[session] reusing sessionId=${existing.sessionId} for thread=${threadId}`);
      return existing;
    }

    console.log(`[session] creating new ACP session for thread=${threadId}`);
    const acp = new AcpClient(config.kiroCommand, config.kiroArgs, config.kiroWorkdir);
    await acp.start();
    await acp.initialize();
    const sessionId = await acp.createSession(config.kiroWorkdir);
    const session = { acp, sessionId };
    this.sessions.set(threadId, session);
    console.log(`[session] session ready sessionId=${sessionId} thread=${threadId}`);
    return session;
  }

  private async onMessage(message: Message): Promise<void> {
    if (message.author.bot || !this.client.user) return;

    const channelId = message.channel.isThread()
      ? (message.channel as ThreadChannel).parentId ?? message.channelId
      : message.channelId;
    if (config.allowedChannels.size > 0 && !config.allowedChannels.has(channelId)) {
      return;
    }

    const inThread = message.channel.isThread();
    if (!inThread && !message.mentions.has(this.client.user.id)) return;

    const prompt = stripBotMention(message.content, this.client.user.id);
    if (!prompt) {
      if (!inThread) await message.reply("请在 @ 我之后输入你的问题。");
      return;
    }

    const thread = await getOrCreateThread(message, prompt).catch(() => null);
    if (!thread) {
      await message.reply("⚠️ 无法创建 thread，请检查 Bot 权限。");
      return;
    }

    const senderContext = {
      schema: "opencd.sender.v1",
      sender_id: message.author.id,
      sender_name: message.author.username,
      display_name: message.member?.displayName ?? message.author.displayName,
      channel: "discord",
      channel_id: channelId,
      thread_id: thread.id,
      is_bot: false,
    };
    const fullPrompt = `<sender_context>\n${JSON.stringify(senderContext)}\n</sender_context>\n\n${prompt}`;

    console.log(`[discord→kiro] thread=${thread.id} user=${message.author.tag} prompt=${prompt}`);

    // ⏳ queued
    let reaction = await setReaction(message, "⏳", "");

    // Stall timers: 🥱 at 30s, 😨 at 60s
    const stallSoft = setTimeout(async () => { reaction = await setReaction(message, "🥱", reaction); }, 30_000);
    const stallHard = setTimeout(async () => { reaction = await setReaction(message, "😨", reaction); }, 60_000);

    let session: ActiveSession;
    try {
      session = await this.getOrCreateSession(thread.id);
    } catch (error) {
      clearTimeout(stallSoft); clearTimeout(stallHard);
      await setReaction(message, "❌", reaction);
      const text = error instanceof Error ? error.message : String(error);
      await thread.send(`⚠️ opencd 无法启动 Kiro：${text}`);
      return;
    }

    // Send placeholder immediately, then stream edits as kiro replies
    const placeholder = await thread.send("…");

    let latestText = "";
    let editPending = false;
    let thinkingSet = false;

    const editLoop = setInterval(async () => {
      if (!editPending) return;
      editPending = false;
      // 🤔 thinking — switch from ⏳ on first chunk
      if (!thinkingSet) {
        thinkingSet = true;
        reaction = await setReaction(message, "🤔", reaction);
      }
      const display = latestText.length > DISCORD_MESSAGE_LIMIT - 100
        ? `…${latestText.slice(-(DISCORD_MESSAGE_LIMIT - 100))}`
        : latestText;
      await placeholder.edit(display).catch(() => {});
    }, 1500);

    try {
      const result = await session.acp.prompt(session.sessionId, fullPrompt, (accumulated) => {
        latestText = accumulated;
        editPending = true;
      });

      clearInterval(editLoop);
      clearTimeout(stallSoft); clearTimeout(stallHard);
      console.log(`[kiro→discord] thread=${thread.id} reply=${result.slice(0, 200)}${result.length > 200 ? "…" : ""}`);

      // ✅ done + random mood face
      await setReaction(message, "✅", reaction);
      const face = MOOD_FACES[Math.floor(Math.random() * MOOD_FACES.length)];
      await message.react(face).catch(() => {});

      const chunks = splitMessage(result);
      await placeholder.edit(chunks[0] ?? result).catch(() => {});
      for (const chunk of chunks.slice(1)) {
        await thread.send(chunk);
      }

    } catch (error) {
      clearInterval(editLoop);
      clearTimeout(stallSoft); clearTimeout(stallHard);
      // Session broken — remove it so next message creates a fresh one
      this.sessions.delete(thread.id);
      await session.acp.close().catch(() => {});
      await setReaction(message, "❌", reaction);
      const text = error instanceof Error ? error.message : String(error);
      await placeholder.edit(`⚠️ opencd 调用 Kiro 失败：${text}`).catch(() => {});
    }
  }
}
