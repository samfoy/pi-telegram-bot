import type { Api } from "grammy";
import { GrammyError } from "grammy";
import { markdownToTelegram, splitMessage, formatToolSummaryLine, type ToolCallRecord } from "./formatter.js";
import { retryTelegramCall, getRetryDelayMs } from "./telegram-retry.js";
import { createLogger } from "./logger.js";

const log = createLogger("streaming-updater");

export interface StreamingState {
  chatId: number;
  threadId: number | undefined;
  initialMessageId: number;
  currentMessageId: number;
  rawMarkdown: string;
  thinkingText: string;        // accumulated reasoning/thinking text
  toolLines: string[];
  toolRecords: ToolCallRecord[];
  completedToolLines: string[];
  completedCount: number;
  failedCount: number;
  postedMessageIds: number[];
  timer: ReturnType<typeof setTimeout> | null;
  retryCount: number;
  coalesceTimer: ReturnType<typeof setTimeout> | null;
  flushInFlight: boolean;
  needsReflush: boolean;
}

export class StreamingUpdater {
  private _api: Api;
  private _throttleMs: number;
  private _msgLimit: number;
  private _coalesceMs: number;

  constructor(api: Api, throttleMs = 1000, msgLimit = 4000, coalesceMs = 300) {
    this._api = api;
    this._throttleMs = throttleMs;
    this._msgLimit = msgLimit;
    this._coalesceMs = coalesceMs;
  }

  async begin(chatId: number, threadId: number | undefined): Promise<StreamingState> {
    const res = await retryTelegramCall(
      () => this._api.sendMessage(chatId, "\u23F3 Thinking...", {
        message_thread_id: threadId,
      }),
      "sendMessage (begin)",
    );

    return {
      chatId,
      threadId,
      initialMessageId: res.message_id,
      currentMessageId: res.message_id,
      rawMarkdown: "",
      thinkingText: "",
      toolLines: [],
      toolRecords: [],
      completedToolLines: [],
      completedCount: 0,
      failedCount: 0,
      postedMessageIds: [],
      timer: null,
      retryCount: 0,
      coalesceTimer: null,
      flushInFlight: false,
      needsReflush: false,
    };
  }

  appendText(state: StreamingState, delta: string): void {
    state.rawMarkdown += delta;
    this._scheduleFlush(state);
  }

  appendThinking(state: StreamingState, delta: string): void {
    state.thinkingText += delta;
    this._scheduleFlush(state);
  }

  appendToolStart(state: StreamingState, toolName: string, args: unknown): void {
    state.toolLines.push(toolName);
    state.toolRecords.push({ toolName, args, startTime: Date.now() });
    this._coalescedFlush(state);
  }

  appendToolEnd(state: StreamingState, toolName: string, isError: boolean): void {
    const record = [...state.toolRecords].reverse().find(
      (r) => r.toolName === toolName && r.endTime === undefined,
    );
    if (record) {
      record.endTime = Date.now();
      record.isError = isError;
    }

    const idx = state.toolLines.indexOf(toolName);
    if (idx !== -1) {
      state.toolLines.splice(idx, 1);
    }
    if (isError) {
      state.failedCount++;
    } else {
      state.completedCount++;
    }
    this._coalescedFlush(state);
  }

  appendRetry(state: StreamingState, attempt: number): void {
    state.retryCount = attempt;
    state.rawMarkdown += `\n_\u21A9\uFE0F Retrying (${attempt}/3)..._\n`;
    this._scheduleFlush(state);
  }

  async finalize(state: StreamingState): Promise<void> {
    this._cancelTimer(state);
    this._cancelCoalesceTimer(state);
    await this._doFlush(state, false);

    if (state.toolRecords.length > 0) {
      await this._postToolLog(state);
    }
  }

  async error(state: StreamingState, err: Error): Promise<void> {
    this._cancelTimer(state);
    this._cancelCoalesceTimer(state);

    const maxErrLen = this._msgLimit - 20;
    const msg = err.message.length > maxErrLen
      ? err.message.slice(0, maxErrLen - 3) + "..."
      : err.message;

    await this._safePost(state.chatId, state.threadId, `\u274C Error: ${msg}`);
  }

  private _scheduleFlush(state: StreamingState): void {
    if (state.timer !== null) return;
    state.timer = setTimeout(() => {
      state.timer = null;
      this._doFlush(state, true).catch((err) => log.error("Flush error", { error: err }));
    }, this._throttleMs);
  }

  private _coalescedFlush(state: StreamingState): void {
    this._cancelTimer(state);

    if (state.coalesceTimer !== null) return;

    if (state.flushInFlight) {
      state.needsReflush = true;
      return;
    }

    state.coalesceTimer = setTimeout(() => {
      state.coalesceTimer = null;
      this._doFlush(state, true).catch((err) => log.error("Coalesced flush error", { error: err }));
    }, this._coalesceMs);
  }

  private _cancelTimer(state: StreamingState): void {
    if (state.timer !== null) {
      clearTimeout(state.timer);
      state.timer = null;
    }
  }

  private _cancelCoalesceTimer(state: StreamingState): void {
    if (state.coalesceTimer !== null) {
      clearTimeout(state.coalesceTimer);
      state.coalesceTimer = null;
    }
  }

  private async _doFlush(state: StreamingState, partial: boolean): Promise<void> {
    state.flushInFlight = true;
    try {
      await this._flush(state, partial);
    } finally {
      state.flushInFlight = false;
      if (state.needsReflush && partial) {
        state.needsReflush = false;
        this._doFlush(state, true).catch((err) =>
          log.error("Re-flush error", { error: err }),
        );
      }
    }
  }

  private async _postToolLog(_state: StreamingState): Promise<void> {
    // Tool activity is summarised inline in the response message — no separate log needed.
  }

  private async _flush(state: StreamingState, partial: boolean): Promise<void> {
    const body = state.rawMarkdown.trim();

    let toolBlock = "";
    if (partial) {
      // Show a single compact live status line while tools are running
      const running = state.toolLines.length;
      const done = state.completedCount;
      const failed = state.failedCount;
      const total = done + failed + running;

      if (total > 0) {
        const activeNames = state.toolRecords
          .filter((r) => r.endTime === undefined)
          .map((r) => r.toolName);
        const uniqueActive = [...new Set(activeNames)];

        if (running > 0) {
          toolBlock = `> \u{1F527} ${uniqueActive.join(", ")}…`;
        } else {
          // All done but turn not yet finalized — show brief summary
          toolBlock = `> \u2713 ${total} tool call${total === 1 ? "" : "s"}`;
          if (failed > 0) toolBlock += ` (${failed} failed)`;
        }
      }
    } else {
      if (state.toolRecords.length > 0) {
        toolBlock = formatToolSummaryLine(state.toolRecords);
      }
    }

    // Thinking block — shown as a collapsed blockquote prefix while streaming,
    // dropped from the final message (the answer speaks for itself).
    let thinkingBlock = "";
    if (partial && state.thinkingText && !body) {
      const preview = state.thinkingText.slice(-200).trim().replace(/\n+/g, " ");
      thinkingBlock = `> _\u{1F9E0} ${preview}_`;
    }

    const parts = [thinkingBlock, body, toolBlock].filter(Boolean);
    const combined = parts.join("\n\n");
    if (!combined) return;

    const formatted = markdownToTelegram(combined, partial);
    await this._postChunked(state, formatted, this._msgLimit);
  }

  private async _postChunked(state: StreamingState, text: string, limit: number): Promise<void> {
    const chunks = splitMessage(text, limit);

    const allMessages = [...state.postedMessageIds, state.currentMessageId];

    try {
      for (let i = 0; i < chunks.length; i++) {
        if (i < allMessages.length) {
          await this._safeEdit(state.chatId, allMessages[i], chunks[i]);
        } else {
          const res = await retryTelegramCall(
            () => this._api.sendMessage(state.chatId, chunks[i], {
              message_thread_id: state.threadId,
            }),
            "sendMessage (continuation)",
          );
          allMessages.push(res.message_id);
        }
      }

      const used = allMessages.slice(0, chunks.length);
      state.postedMessageIds = used.slice(0, -1);
      state.currentMessageId = used[used.length - 1] ?? state.currentMessageId;
    } catch (err: unknown) {
      const reduced = Math.floor(limit * 0.6);
      if (this._isMsgTooLong(err) && reduced >= 100) {
        log.warn("Message too long, retrying with reduced limit", { limit, reduced });
        return this._postChunked(state, text, reduced);
      }
      throw err;
    }
  }

  private async _safePost(chatId: number, threadId: number | undefined, text: string): Promise<void> {
    try {
      await retryTelegramCall(
        () => this._api.sendMessage(chatId, text, {
          message_thread_id: threadId,
        }),
        "sendMessage (safe)",
      );
    } catch (err: unknown) {
      if (this._isMsgTooLong(err)) {
        const truncated = text.slice(0, 1500) + "\n...(truncated)";
        await retryTelegramCall(
          () => this._api.sendMessage(chatId, truncated, {
            message_thread_id: threadId,
          }),
          "sendMessage (truncated)",
        );
      } else {
        throw err;
      }
    }
  }

  private _isMsgTooLong(err: unknown): boolean {
    return err instanceof Error && (
      err.message.includes("message is too long") ||
      err.message.includes("MESSAGE_TOO_LONG")
    );
  }

  /**
   * Edit a message with 429 rate-limit retry and Markdown parse fallback.
   * On 429: reads retry_after, waits, then retries once.
   * On "can't parse" error: retries without parse_mode.
   */
  private async _safeEdit(
    chatId: number,
    messageId: number,
    text: string,
  ): Promise<void> {
    try {
      await this._api.editMessageText(chatId, messageId, text);
    } catch (err) {
      // Handle 429 rate limit — wait retry_after seconds, then retry once
      if (err instanceof GrammyError && err.error_code === 429) {
        const delayMs = getRetryDelayMs(err, 5000);
        log.warn("editMessageText rate limited, waiting", { delayMs, messageId });
        await new Promise<void>((r) => setTimeout(r, delayMs));
        try {
          await this._api.editMessageText(chatId, messageId, text);
          return;
        } catch (retryErr) {
          log.warn("editMessageText retry also failed", { messageId, error: retryErr });
          throw retryErr;
        }
      }

      // Handle Markdown parse errors — retry without parse_mode
      if (
        err instanceof GrammyError &&
        err.message.toLowerCase().includes("can't parse")
      ) {
        log.warn("Markdown parse failed, retrying without parse_mode", { messageId });
        await this._api.editMessageText(chatId, messageId, text, { parse_mode: undefined });
        return;
      }

      throw err;
    }
  }
}
