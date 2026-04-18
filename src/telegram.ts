import { Bot } from "grammy";
import type { ImageContent } from "@mariozechner/pi-ai";
import type { Config } from "./config.js";
import { BotSessionManager, SessionLimitError } from "./session-manager.js";
import { dispatchCommand, BOT_COMMANDS } from "./commands.js";
import { enrichPromptWithFiles, type TelegramFile } from "./file-handling.js";
import { MessageBuffer } from "./message-buffer.js";
import { createLogger } from "./logger.js";

const log = createLogger("telegram");

export interface TelegramApp {
  bot: Bot;
  sessionManager: BotSessionManager;
}

export function makeThreadKey(chatId: number, threadId: number | undefined): string {
  return threadId ? `${chatId}:${threadId}` : `${chatId}`;
}

export function createApp(config: Config): TelegramApp {
  const bot = new Bot(config.telegramBotToken);

  const sessionManager = new BotSessionManager(config, bot.api);

  // Per-thread message buffers — reassemble messages split at Telegram's 4096-char limit
  const threadBuffers = new Map<string, MessageBuffer>();

  function getThreadBuffer(
    threadKey: string,
    chatId: number,
    threadId: number | undefined,
  ): MessageBuffer {
    if (!threadBuffers.has(threadKey)) {
      const buf = new MessageBuffer(async (combined) => {
        await dispatchMessage(chatId, threadId, threadKey, combined.text ?? "", combined.images);
      });
      threadBuffers.set(threadKey, buf);
    }
    return threadBuffers.get(threadKey)!;
  }

  async function dispatchMessage(
    chatId: number,
    threadId: number | undefined,
    threadKey: string,
    text: string,
    images?: ImageContent[],
  ): Promise<void> {
    const existingSession = sessionManager.get(threadKey);

    if (existingSession) {
      existingSession.enqueue(() => existingSession.prompt(text, {
        images: images && images.length > 0 ? images : undefined,
      }));
      return;
    }

    const cwd = process.env.HOME ?? process.cwd();

    try {
      const session = await sessionManager.getOrCreate({
        threadKey,
        chatId,
        threadId,
        cwd,
      });

      session.enqueue(() => session.prompt(text, {
        images: images && images.length > 0 ? images : undefined,
      }));
    } catch (err) {
      if (err instanceof SessionLimitError) {
        await bot.api.sendMessage(
          chatId,
          "\u26A0\uFE0F Too many active sessions. Try again later or use /sessions to see active ones.",
          { message_thread_id: threadId },
        );
        return;
      }
      log.error("Failed to create session", { error: err });
      await bot.api.sendMessage(
        chatId,
        `\u274C Failed to create session: ${err instanceof Error ? err.message : String(err)}`,
        { message_thread_id: threadId },
      );
    }
  }

  bot.command("start", async (ctx) => {
    if (ctx.from?.id !== config.telegramUserId) return;
    await ctx.reply("Welcome! Send me a message to start a coding session. Use /help to see available commands.");
  });

  // Register commands with Telegram so the autocomplete menu works
  bot.api.setMyCommands(BOT_COMMANDS).catch((err) => {
    log.warn("Failed to register bot commands", { error: err });
  });

  const KNOWN_COMMANDS = ["start", ...BOT_COMMANDS.map((c) => c.command)];

  for (const cmdName of KNOWN_COMMANDS) {
    if (cmdName === "start") continue;
    bot.command(cmdName, async (ctx) => {
      if (ctx.from?.id !== config.telegramUserId) return;

      const chatId = ctx.chat.id;
      const threadId = ctx.message?.message_thread_id;
      const threadKey = makeThreadKey(chatId, threadId);
      const session = sessionManager.get(threadKey);

      const rawText = ctx.message?.text ?? "";
      const spaceIdx = rawText.indexOf(" ");
      const args = spaceIdx === -1 ? "" : rawText.slice(spaceIdx + 1);

      await dispatchCommand(cmdName, args, {
        chatId,
        threadId,
        threadKey,
        api: bot.api,
        sessionManager,
        session,
      });
    });
  }

  bot.on("message", async (ctx) => {
    if (ctx.from?.id !== config.telegramUserId) return;

    const chatId = ctx.chat.id;
    const threadId = ctx.message.message_thread_id;
    const threadKey = makeThreadKey(chatId, threadId);

    const text = ctx.message.text ?? ctx.message.caption ?? "";

    if (text.startsWith("/")) return;

    // Ack the message with a reaction so the user knows we received it
    if (config.ackReaction) {
      try {
        await bot.api.setMessageReaction(chatId, ctx.message.message_id, [
          { type: "emoji", emoji: config.ackReaction as never },
        ]);
      } catch (err) {
        log.warn("Failed to set ack reaction", { error: err });
      }
    }

    const telegramFiles: TelegramFile[] = [];

    if (ctx.message.document) {
      const doc = ctx.message.document;
      telegramFiles.push({
        fileId: doc.file_id,
        fileName: doc.file_name ?? "document",
        mimeType: doc.mime_type,
        fileSize: doc.file_size,
      });
    }

    if (ctx.message.photo && ctx.message.photo.length > 0) {
      const largest = ctx.message.photo[ctx.message.photo.length - 1];
      telegramFiles.push({
        fileId: largest.file_id,
        fileName: "photo.jpg",
        mimeType: "image/jpeg",
        fileSize: largest.file_size,
      });
    }

    // Enrich with file/image content eagerly (before the debounce window closes)
    const existingSession = sessionManager.get(threadKey);
    const cwdForFiles = existingSession?.cwd ?? (process.env.HOME ?? process.cwd());
    const { text: enrichedText, images } = await enrichPromptWithFiles(
      telegramFiles, text, cwdForFiles, bot.api,
    );

    // Push into the per-thread buffer — debounces and combines split messages
    getThreadBuffer(threadKey, chatId, threadId).push(threadKey, {
      text: enrichedText,
      images: images && images.length > 0 ? images : undefined,
    });
  });

  return { bot, sessionManager };
}
