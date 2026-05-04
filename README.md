# opencd

Node/TypeScript MVP for one OpenAB-style link: **Discord -> opencd -> Kiro (ACP)**.

## Implemented MVP flow

1. User mentions the bot in Discord.
2. opencd receives the message and injects `sender_context`.
3. opencd starts `kiro-cli acp`, then calls ACP:
   - `initialize`
   - `session/new`
   - `session/prompt`
4. Streamed `agent_message_chunk` text is merged and sent back to Discord.

This mirrors a single end-to-end route from `openabdev/openab` (Discord adapter + ACP bridge), simplified for MVP.

## Requirements

- Node.js 20+
- `kiro-cli` installed and already authenticated
- A Discord bot token with Message Content intent enabled

## Quick start

```bash
cp .env.example .env
# edit .env
npm install
npm run dev
```

## Environment

| Variable | Required | Description |
|---|---|---|
| `DISCORD_BOT_TOKEN` | Yes | Discord bot token |
| `DISCORD_ALLOWED_CHANNELS` | No | Comma-separated channel IDs (empty = all) |
| `KIRO_COMMAND` | No | ACP command, default `kiro-cli` |
| `KIRO_ARGS` | No | ACP args, default `acp --trust-all-tools` |
| `KIRO_WORKDIR` | No | Working directory passed to `session/new` |

