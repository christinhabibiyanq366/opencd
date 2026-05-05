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

## Installation

Download the latest `.tgz` from [Releases](https://github.com/christinhabibiyanq366/opencd/releases/latest), then:

```bash
# 全局安装（推荐）
npm install -g ./opencd-<version>.tgz
opencd

# 或者用 npx 直接运行（无需全局安装）
npx ./opencd-<version>.tgz

# 也可以直接用 Release URL
npx https://github.com/christinhabibiyanq366/opencd/releases/download/<tag>/opencd-<version>.tgz
```

运行前需要在当前目录创建 `.env` 文件，参考 [Environment](#environment) 章节。

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

