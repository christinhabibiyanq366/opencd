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
    if (existing) return existing;

    const acp = new AcpClient(config.kiroCommand, config.kiroArgs, config.kiroWorkdir);
    await acp.start();
    await acp.initialize();
    const sessionId = await acp.createSession(config.kiroWorkdir);
    const session = { acp, sessionId };
    this.sessions.set(threadId, session);
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

    let session: ActiveSession;
    try {
      session = await this.getOrCreateSession(thread.id);
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      await thread.send(`⚠️ opencd 无法启动 Kiro：${text}`);
      return;
    }

    try {
      const result = await session.acp.prompt(session.sessionId, fullPrompt);
      const chunks = splitMessage(result);
      for (const chunk of chunks) {
        await thread.send(chunk);
      }
    } catch (error) {
      // Session broken — remove it so next message creates a fresh one
      this.sessions.delete(thread.id);
      await session.acp.close().catch(() => {});
      const text = error instanceof Error ? error.message : String(error);
      await thread.send(`⚠️ opencd 调用 Kiro 失败：${text}`);
    }
  }
}
