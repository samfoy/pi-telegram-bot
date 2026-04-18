import { resolve } from "path";
import { existsSync, statSync } from "fs";
import type { Api } from "grammy";
import type { ThreadSession } from "./thread-session.js";
import type { BotSessionManager, ThreadSessionInfo } from "./session-manager.js";
import type { ThinkingLevel } from "./config.js";
import { formatContextUsage, formatContextBar, formatTokenCount } from "./context-format.js";
import { generateDiff } from "./diff-reviewer.js";

const VALID_THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

export const BOT_COMMANDS: { command: string; description: string }[] = [
  { command: "new",      description: "Start a new session" },
  { command: "cancel",   description: "Cancel the current stream" },
  { command: "status",   description: "Show session info" },
  { command: "model",    description: "Switch model (or list available models)" },
  { command: "thinking", description: "Set thinking level (off, minimal, low, medium, high, xhigh)" },
  { command: "sessions", description: "List active sessions" },
  { command: "cwd",      description: "Change working directory" },
  { command: "reload",   description: "Reload extensions and prompt templates" },
  { command: "diff",     description: "Show git diff of uncommitted changes" },
  { command: "compact",  description: "Compact conversation to free context space" },
  { command: "context",  description: "Show context window usage" },
  { command: "btw",      description: "Ask a side question without affecting session history" },
  { command: "help",     description: "Show this list" },
];

export interface CommandContext {
  chatId: number;
  threadId: number | undefined;
  threadKey: string;
  api: Api;
  sessionManager: BotSessionManager;
  session: ThreadSession | undefined;
}

type CommandHandler = (ctx: CommandContext, args: string) => Promise<void>;

async function reply(ctx: CommandContext, text: string): Promise<void> {
  await ctx.api.sendMessage(ctx.chatId, text, {
    message_thread_id: ctx.threadId,
  });
}

const handlers: Record<string, CommandHandler> = {
  async help(ctx) {
    const lines = [
      "Commands:",
      "/new \u2014 Start a new session",
      "/cancel \u2014 Cancel the current stream",
      "/status \u2014 Show session info",
      "/model <name> \u2014 Switch model",
      "/thinking <level> \u2014 Set thinking level (off, minimal, low, medium, high, xhigh)",
      "/sessions \u2014 List active sessions",
      "/cwd <path> \u2014 Change working directory",
      "/reload \u2014 Reload extensions and prompt templates",
      "/diff \u2014 Show git diff of uncommitted changes",
      "/compact \u2014 Compact conversation to free context space",
      "/context \u2014 Show context window usage",
      "/btw <question> \u2014 Ask a side question without affecting history",
      "/help \u2014 Show this list",
    ];
    await reply(ctx, lines.join("\n"));
  },

  async start(ctx) {
    await reply(ctx, "Welcome! Send me a message to start a coding session. Use /help to see available commands.");
  },

  async new(ctx) {
    if (!ctx.session) {
      await reply(ctx, "No active session.");
      return;
    }
    await ctx.session.newSession();
    await reply(ctx, "\u{1F195} New session started.");
  },

  async cancel(ctx) {
    if (!ctx.session) {
      await reply(ctx, "No active session.");
      return;
    }
    ctx.session.abort();
    await reply(ctx, "\u{1F6D1} Cancelled.");
  },

  async status(ctx) {
    if (!ctx.session) {
      await reply(ctx, "No active session.");
      return;
    }
    const s = ctx.session;
    const lines = [
      `Model: ${s.model?.id ?? "unknown"}`,
      `Thinking: ${s.thinkingLevel}`,
      `Messages: ${s.messageCount}`,
      `CWD: ${s.cwd}`,
      `Last activity: ${s.lastActivity.toISOString()}`,
    ];
    const usage = s.getContextUsage();
    if (usage) {
      lines.push(`Context: ${formatContextUsage(usage)}`);
    }
    await reply(ctx, lines.join("\n"));
  },

  async model(ctx, args) {
    if (!ctx.session) {
      await reply(ctx, "No active session.");
      return;
    }
    const modelName = args.trim();
    if (!modelName) {
      const registry = ctx.session.modelRegistry;
      const allModels = registry.getAll();
      const currentId = ctx.session.model?.id;
      const lines = ["Available models:"];
      for (const m of allModels) {
        const marker = m.id === currentId ? " \u2705" : "";
        lines.push(`  ${m.provider}/${m.id}${marker}`);
      }
      lines.push("\nUsage: /model <name>");
      await reply(ctx, lines.join("\n"));
      return;
    }
    try {
      await ctx.session.setModel(modelName);
      await reply(ctx, `\u2705 Model set to ${modelName}.`);
    } catch (err) {
      await reply(ctx, `\u274C ${err instanceof Error ? err.message : String(err)}`);
    }
  },

  async thinking(ctx, args) {
    if (!ctx.session) {
      await reply(ctx, "No active session.");
      return;
    }
    const level = args.trim() as ThinkingLevel;
    if (!VALID_THINKING_LEVELS.includes(level)) {
      await reply(ctx, `\u274C Invalid level. Must be one of: ${VALID_THINKING_LEVELS.join(", ")}`);
      return;
    }
    ctx.session.setThinkingLevel(level);
    await reply(ctx, `\u2705 Thinking level set to ${level}.`);
  },

  async sessions(ctx) {
    const list = ctx.sessionManager.list();
    if (list.length === 0) {
      await reply(ctx, "No active sessions.");
      return;
    }
    const rows = list.map((s: ThreadSessionInfo) =>
      `\u2022 ${s.threadKey} \u2014 ${s.model} | ${s.messageCount} msgs | ${s.cwd} | ${s.isStreaming ? "\u{1F534} streaming" : "\u26AA idle"}`
    );
    await reply(ctx, rows.join("\n"));
  },

  async cwd(ctx, args) {
    const target = args.trim();
    if (!target) {
      if (!ctx.session) {
        await reply(ctx, "No active session.");
      } else {
        await reply(ctx, `Current cwd: ${ctx.session.cwd}`);
      }
      return;
    }
    const resolved = resolve(target);
    if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
      await reply(ctx, `\u274C Not a valid directory: ${resolved}`);
      return;
    }

    if (ctx.session) {
      await ctx.sessionManager.dispose(ctx.threadKey);
    }
    await ctx.sessionManager.getOrCreate({
      threadKey: ctx.threadKey,
      chatId: ctx.chatId,
      threadId: ctx.threadId,
      cwd: resolved,
    });
    await reply(ctx, `\u{1F4C2} New session in ${resolved}. Project AGENTS.md, extensions, and prompts loaded.`);
  },

  async reload(ctx) {
    if (!ctx.session) {
      await reply(ctx, "No active session.");
      return;
    }
    await ctx.session.reload();
    await reply(ctx, "\u{1F504} Extensions and prompt templates reloaded.");
  },

  async diff(ctx) {
    if (!ctx.session) {
      await reply(ctx, "No active session.");
      return;
    }
    const result = generateDiff(ctx.session.cwd);
    if (!result) {
      await reply(ctx, "No uncommitted changes found (or not a git repo).");
      return;
    }
    const statsLine = result.stats ? `\n${result.stats}` : "";
    const diffPreview = result.diff.length > 3000
      ? result.diff.slice(0, 3000) + "\n...(truncated)"
      : result.diff;
    await reply(ctx, `\u{1F4DD} ${result.fileCount} file${result.fileCount === 1 ? "" : "s"} changed${statsLine}\n\n\`\`\`diff\n${diffPreview}\n\`\`\``);
  },

  async compact(ctx) {
    if (!ctx.session) {
      await reply(ctx, "No active session.");
      return;
    }
    if (ctx.session.isStreaming) {
      await reply(ctx, "\u274C Can't compact while streaming. Wait for the current turn to finish.");
      return;
    }
    await reply(ctx, "\u{1F5DC}\uFE0F Compacting conversation...");
    try {
      const result = await ctx.session.compact();
      const afterUsage = ctx.session.getContextUsage();
      const beforeStr = formatTokenCount(result.tokensBefore);
      const afterStr = afterUsage?.tokens != null ? formatTokenCount(afterUsage.tokens) : "unknown";
      await reply(ctx, `\u{1F5DC}\uFE0F Compacted: ${beforeStr} \u2192 ${afterStr} tokens`);
    } catch (err) {
      await reply(ctx, `\u274C Compaction failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  },

  async context(ctx) {
    if (!ctx.session) {
      await reply(ctx, "No active session.");
      return;
    }
    const usage = ctx.session.getContextUsage();
    if (!usage) {
      await reply(ctx, "Context usage not available yet.");
      return;
    }
    const lines = [
      "Context Window",
      formatContextBar(usage.percent ?? 0),
      `Tokens: ${formatContextUsage(usage)}`,
      `Model: ${ctx.session.model?.id ?? "unknown"}`,
      "",
      "Use /compact to free space or /new for a fresh session.",
    ];
    await reply(ctx, lines.join("\n"));
  },

  async btw(ctx, args) {
    if (!ctx.session) {
      await reply(ctx, "No active session. Start one first by sending a message.");
      return;
    }
    const question = args.trim();
    if (!question) {
      await reply(ctx, "Usage: /btw <question>\n\nAsk a side question without it being added to the session history.");
      return;
    }
    if (ctx.session.isStreaming) {
      await reply(ctx, "\u274C Can't use /btw while streaming. Wait for the current turn to finish.");
      return;
    }
    try {
      const answer = await ctx.session.btw(question);
      await reply(ctx, answer);
    } catch (err) {
      await reply(ctx, `\u274C btw failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  },

};

export function parseCommand(text: string): { name: string; args: string } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  const spaceIdx = trimmed.indexOf(" ");
  if (spaceIdx === -1) {
    return { name: trimmed.slice(1).toLowerCase(), args: "" };
  }
  return {
    name: trimmed.slice(1, spaceIdx).toLowerCase(),
    args: trimmed.slice(spaceIdx + 1),
  };
}

export async function dispatchCommand(
  name: string,
  args: string,
  ctx: CommandContext,
): Promise<boolean> {
  const handler = handlers[name];
  if (handler) {
    await handler(ctx, args);
    return true;
  }

  if (ctx.session) {
    const piCommand = args ? `/${name} ${args}` : `/${name}`;
    ctx.session.enqueue(() => ctx.session!.prompt(piCommand));
    return true;
  }

  await reply(ctx, `No active session. Send a message first to start one, then use /${name}.`);
  return false;
}
