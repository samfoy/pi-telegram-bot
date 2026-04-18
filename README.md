# pi-telegram-bot

Telegram bot exposing [pi](https://github.com/mariozechner/pi) as a personal coding agent. Chat with pi in Telegram with streaming responses, tool execution, and model switching.

## Setup

### 1. Create a Telegram bot

1. Message [@BotFather](https://t.me/BotFather) on Telegram
2. Send `/newbot` and follow the prompts
3. Copy the bot token

### 2. Get your Telegram user ID

1. Message [@userinfobot](https://t.me/userinfobot) on Telegram
2. It will reply with your user ID (a number like `123456789`)

### 3. Configure environment

```bash
cp .env.example .env
# Edit .env with your TELEGRAM_BOT_TOKEN and TELEGRAM_USER_ID
```

### 4. Install and run

```bash
npm install
npm start
# or
./start.sh
```

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Yes | — | Bot token from BotFather |
| `TELEGRAM_USER_ID` | Yes | — | Your Telegram user ID (security: bot only responds to you) |
| `PROVIDER` | No | `anthropic` | LLM provider |
| `MODEL` | No | `claude-sonnet-4-5` | Model ID |
| `THINKING_LEVEL` | No | `off` | Thinking level (off/minimal/low/medium/high/xhigh) |
| `MAX_SESSIONS` | No | `10` | Maximum concurrent sessions |
| `SESSION_IDLE_TIMEOUT` | No | `3600` | Seconds before idle sessions are reaped |
| `SESSION_DIR` | No | `~/.pi/agent/sessions` | Session storage directory |
| `STREAM_THROTTLE_MS` | No | `1000` | Minimum ms between message edits (Telegram rate limit) |
| `TELEGRAM_MSG_LIMIT` | No | `4000` | Max message length before splitting |
| `ACK_REACTION` | No | `🦞` | Emoji reaction on received messages (set empty to disable) |

## Commands

| Command | Description |
|---|---|
| `/help` | Show available commands |
| `/new` | Start a fresh session (clears history) |
| `/cancel` | Abort the current stream |
| `/status` | Show session info (model, tokens, cwd) |
| `/model <name>` | Switch model (no args = list available) |
| `/thinking <level>` | Set thinking level |
| `/sessions` | List all active sessions |
| `/cwd <path>` | Change working directory |
| `/reload` | Reload extensions and prompt templates |
| `/diff` | Show git diff of uncommitted changes |
| `/compact` | Compact conversation to free context |
| `/context` | Show context window usage |

Unknown `/commands` are forwarded to pi as extension commands.

## Features

- **Streaming responses** — Messages update in-place as tokens arrive, respecting Telegram's rate limit
- **Ack reactions** — Reacts to your message immediately so you know it was received
- **Persistent sessions** — Sessions survive bot restarts via on-disk registry
- **Session management** — Multiple concurrent sessions with idle timeout and auto-reaping
- **File handling** — Send photos/documents and they're saved to the session's working directory
- **Tool activity** — See what tools pi is using in real-time during streaming
- **Context tracking** — Warnings at 80% and 90% context usage
- **Auto-diff** — Automatic diff posting when pi modifies files
- **Security** — Only responds to your configured Telegram user ID

## Architecture

```
index.ts              → Entry point, dotenv, signal handlers
telegram.ts           → grammY bot setup, message/command routing
thread-session.ts     → Wraps pi AgentSession with streaming
session-manager.ts    → Session lifecycle, limits, idle reaping
streaming-updater.ts  → Throttled message editing with chunking
commands.ts           → Telegram slash command handlers
config.ts             → Environment variable parsing
session-registry.ts   → Persistent session state across restarts
formatter.ts          → Markdown + tool call formatting
file-handling.ts      → Download Telegram files, vision extraction
diff-reviewer.ts      → Git diff generation and posting
```

## Requirements

- Node.js >= 20
- A pi-coding-agent installation (`@mariozechner/pi-coding-agent`)
- Anthropic API key (or other LLM provider configured in pi)
