import { expandHome } from "./paths.js";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface Config {
  telegramBotToken: string;
  telegramUserId: number;

  provider: string;
  model: string;
  thinkingLevel: ThinkingLevel;

  maxSessions: number;
  sessionIdleTimeoutSecs: number;
  sessionDir: string;

  streamThrottleMs: number;
  telegramMsgLimit: number;

  ackReaction: string;
}

function required(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

function optional(name: string, defaultVal: string): string {
  return process.env[name] ?? defaultVal;
}

function optionalInt(name: string, defaultVal: number): number {
  const val = process.env[name];
  if (!val) return defaultVal;
  const n = parseInt(val, 10);
  if (isNaN(n)) throw new Error(`Env var ${name} must be an integer, got: ${val}`);
  return n;
}

const VALID_THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

function parseThinkingLevel(val: string): ThinkingLevel {
  if (VALID_THINKING_LEVELS.includes(val as ThinkingLevel)) return val as ThinkingLevel;
  throw new Error(`Invalid THINKING_LEVEL: ${val}. Must be one of: ${VALID_THINKING_LEVELS.join(", ")}`);
}

export function loadConfig(): Config {
  return {
    telegramBotToken: required("TELEGRAM_BOT_TOKEN"),
    telegramUserId: parseInt(required("TELEGRAM_USER_ID"), 10),

    provider: optional("PROVIDER", "anthropic"),
    model: optional("MODEL", "claude-sonnet-4-5"),
    thinkingLevel: parseThinkingLevel(optional("THINKING_LEVEL", "off")),

    maxSessions: optionalInt("MAX_SESSIONS", 10),
    sessionIdleTimeoutSecs: optionalInt("SESSION_IDLE_TIMEOUT", 3600),
    sessionDir: expandHome(optional("SESSION_DIR", "~/.pi/agent/sessions")),

    streamThrottleMs: optionalInt("STREAM_THROTTLE_MS", 1000),
    telegramMsgLimit: optionalInt("TELEGRAM_MSG_LIMIT", 4000),

    ackReaction: optional("ACK_REACTION", "👀"),
  };
}
