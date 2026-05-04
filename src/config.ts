import { z } from "zod";

const schema = z.object({
  DISCORD_BOT_TOKEN: z.string().min(1),
  DISCORD_ALLOWED_CHANNELS: z.string().optional(),
  KIRO_COMMAND: z.string().default("kiro-cli"),
  KIRO_ARGS: z.string().default("acp --trust-all-tools"),
  KIRO_WORKDIR: z.string().default(process.cwd()),
});

const env = schema.parse(process.env);

export const config = {
  discordToken: env.DISCORD_BOT_TOKEN,
  allowedChannels: new Set(
    (env.DISCORD_ALLOWED_CHANNELS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  ),
  kiroCommand: env.KIRO_COMMAND,
  kiroArgs: env.KIRO_ARGS.split(/\s+/).filter(Boolean),
  kiroWorkdir: env.KIRO_WORKDIR,
};

