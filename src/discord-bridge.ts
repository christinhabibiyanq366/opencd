import { Client, GatewayIntentBits, type Message } from "discord.js";

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

export class DiscordBridge {
  private readonly client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  async start(): Promise<void> {
    this.client.once("ready", () => {
      console.log(`opencd connected as ${this.client.user?.tag ?? "unknown"}`);
    });

    this.client.on("messageCreate", async (message) => {
      await this.onMessage(message);
    });

    await this.client.login(config.discordToken);
  }

  private async onMessage(message: Message): Promise<void> {
    if (message.author.bot || !this.client.user) return;
    if (config.allowedChannels.size > 0 && !config.allowedChannels.has(message.channelId)) {
      return;
    }
    if (!message.mentions.has(this.client.user.id)) return;

    const prompt = stripBotMention(message.content, this.client.user.id);
    if (!prompt) {
      await message.reply("请在 @ 我之后输入你的问题。");
      return;
    }

    const senderContext = {
      schema: "opencd.sender.v1",
      sender_id: message.author.id,
      sender_name: message.author.username,
      display_name: message.member?.displayName ?? message.author.displayName,
      channel: "discord",
      channel_id: message.channelId,
      is_bot: false,
    };
    const fullPrompt = `<sender_context>\n${JSON.stringify(senderContext)}\n</sender_context>\n\n${prompt}`;

    const acp = new AcpClient(config.kiroCommand, config.kiroArgs, config.kiroWorkdir);
    try {
      await acp.start();
      await acp.initialize();
      const sessionId = await acp.createSession(config.kiroWorkdir);
      const result = await acp.prompt(sessionId, fullPrompt);
      const chunks = splitMessage(result);
      for (const chunk of chunks) {
        await message.reply(chunk);
      }
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      await message.reply(`⚠️ opencd 调用 Kiro 失败：${text}`);
    } finally {
      await acp.close();
    }
  }
}
