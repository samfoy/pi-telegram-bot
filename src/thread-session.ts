import path from "path";
import { mkdirSync, realpathSync } from "fs";
import { createAgentSession, createCodingTools, DefaultResourceLoader, SessionManager as PiSessionManager } from "@mariozechner/pi-coding-agent";
import type { AgentSession, AgentSessionEvent, AgentSessionEventListener, CompactionResult, ContextUsage, PromptTemplate } from "@mariozechner/pi-coding-agent";
import type { ImageContent } from "@mariozechner/pi-ai";
import type { Api } from "grammy";
import type { Config, ThinkingLevel } from "./config.js";
import { StreamingUpdater } from "./streaming-updater.js";
import { encodeCwd } from "./session-path.js";
import { hasFileModifications, postDiffReview, getHeadRef } from "./diff-reviewer.js";
import { createNoopUiContext } from "./noop-ui-context.js";
import { formatTokenCount, formatContextUsage, getContextWarningThreshold } from "./context-format.js";
import { createLogger } from "./logger.js";
import type { ToolCallRecord } from "./formatter.js";

const log = createLogger("thread-session");

export interface ThreadSessionCreateParams {
  threadKey: string;
  chatId: number;
  threadId: number | undefined;
  cwd: string;
  config: Config;
  api: Api;
  sessionDir: string;
  resumeSessionPath?: string;
}

export class ThreadSession {
  readonly threadKey: string;
  readonly chatId: number;
  readonly threadId: number | undefined;
  readonly sessionPath: string;
  cwd: string;
  lastActivity: Date;

  private _agentSession: AgentSession;
  private _api: Api;
  private _updater: StreamingUpdater;
  private _tasks: Array<() => Promise<void>> = [];
  private _processing = false;

  constructor(
    threadKey: string,
    chatId: number,
    threadId: number | undefined,
    cwd: string,
    sessionPath: string,
    api: Api,
    agentSession: AgentSession,
    updater: StreamingUpdater,
  ) {
    this.threadKey = threadKey;
    this.chatId = chatId;
    this.threadId = threadId;
    this.cwd = cwd;
    this.sessionPath = sessionPath;
    this._api = api;
    this._agentSession = agentSession;
    this._updater = updater;
    this.lastActivity = new Date();
  }

  private _persistentUnsub: (() => void) | null = null;
  private _activeStreamState: import("./streaming-updater.js").StreamingState | null = null;
  private _turnToolRecords: ToolCallRecord[] = [];
  private _turnBaseRef: string | null = null;
  private _turnCompletePromise: Promise<void> | null = null;
  private _turnCompleteResolve: (() => void) | null = null;
  private _lastContextWarningThreshold = 0;
  private _lastUserPrompt: string | null = null;
  private _typingTimer: ReturnType<typeof setInterval> | null = null;

  static async create(params: ThreadSessionCreateParams): Promise<ThreadSession> {
    params = { ...params, cwd: realpathSync(params.cwd) };

    const cwdEncoded = encodeCwd(params.cwd);
    const nativeSessionDir = path.join(params.sessionDir, cwdEncoded);
    mkdirSync(nativeSessionDir, { recursive: true });

    const sessionFilePath = params.resumeSessionPath
      ?? path.join(nativeSessionDir, `${params.threadKey}.jsonl`);
    const piSessionManager = PiSessionManager.open(sessionFilePath, nativeSessionDir);

    const resourceLoader = new DefaultResourceLoader({ cwd: params.cwd });
    await resourceLoader.reload();

    const { session } = await createAgentSession({
      cwd: params.cwd,
      sessionManager: piSessionManager,
      tools: createCodingTools(params.cwd),
      customTools: [],
      resourceLoader,
    });

    const uiContext = createNoopUiContext({
      notify: (message: string, type?: "info" | "warning" | "error") => {
        log.info("Extension notification", { type: type ?? "info", message, threadKey: params.threadKey });
      },
    });
    await session.bindExtensions({
      uiContext,
      onError: (err) => {
        log.error("Extension error", { extensionPath: err.extensionPath, event: err.event, error: err.error, stack: err.stack ?? "" });
      },
    });

    const registry = session.modelRegistry;
    const allModels = registry.getAll();
    const model = allModels.find(
      (m) => m.provider === params.config.provider && m.id === params.config.model,
    ) ?? allModels.find(
      (m) => m.provider === params.config.provider,
    );
    if (model) {
      await session.setModel(model);
      session.setThinkingLevel(params.config.thinkingLevel);
    }

    const updater = new StreamingUpdater(params.api, params.config.streamThrottleMs, params.config.telegramMsgLimit);

    const ts = new ThreadSession(
      params.threadKey,
      params.chatId,
      params.threadId,
      params.cwd,
      sessionFilePath,
      params.api,
      session,
      updater,
    );
    ts._setupPersistentSubscriber();
    return ts;
  }

  enqueue(task: () => Promise<void>): void {
    this.lastActivity = new Date();
    this._tasks.push(task);
    if (!this._processing) void this._drain();
  }

  private async _drain(): Promise<void> {
    this._processing = true;
    while (this._tasks.length > 0) {
      const task = this._tasks.shift()!;
      try {
        await task();
      } catch (err) {
        log.error("Task error", { threadKey: this.threadKey, error: err });
      }
    }
    this._processing = false;
  }

  private _startTyping(): void {
    if (this._typingTimer !== null) return;
    // Send immediately, then refresh every 4s (Telegram expires after ~5s)
    void this._api.sendChatAction(this.chatId, "typing", {
      message_thread_id: this.threadId,
    }).catch(() => { /* ignore */ });
    this._typingTimer = setInterval(() => {
      void this._api.sendChatAction(this.chatId, "typing", {
        message_thread_id: this.threadId,
      }).catch(() => { /* ignore */ });
    }, 4000);
  }

  private _stopTyping(): void {
    if (this._typingTimer !== null) {
      clearInterval(this._typingTimer);
      this._typingTimer = null;
    }
  }

  private _setupPersistentSubscriber(): void {
    let pendingEvents: AgentSessionEvent[] = [];
    let stateReady = false;

    const flushPending = () => {
      stateReady = true;
      const state = this._activeStreamState;
      if (!state) return;
      for (const event of pendingEvents) {
        this._dispatchStreamEvent(event, state);
      }
      pendingEvents = [];
    };

    this._persistentUnsub = this._agentSession.subscribe((event) => {
      if (event.type === "agent_start") {
        stateReady = false;
        pendingEvents = [];
        this._turnToolRecords = [];
        this._turnBaseRef = getHeadRef(this.cwd);
        this._startTyping();

        this._updater.begin(this.chatId, this.threadId).then((state) => {
          this._activeStreamState = state;
          flushPending();
        }).catch((err) => {
          log.error("Failed to begin streaming", { threadKey: this.threadKey, error: err });
        });
        return;
      }

      if (event.type === "agent_end") {
        this._stopTyping();
        const state = this._activeStreamState;
        const toolRecords = [...this._turnToolRecords];
        const baseRef = this._turnBaseRef;
        this._activeStreamState = null;
        stateReady = false;
        pendingEvents = [];
        if (state) {
          this._updater.finalize(state).then(async () => {
            if (hasFileModifications(toolRecords)) {
              try {
                await postDiffReview(this._api, this.chatId, this.threadId, this.cwd, {
                  baseRef,
                  toolRecords,
                });
              } catch (err) {
                log.error("Failed to post diff review", { threadKey: this.threadKey, error: err });
              }
            }
            this._checkContextWarning();
          }).catch((err) => {
            log.error("Failed to finalize streaming", { threadKey: this.threadKey, error: err });
          });
        } else {
          this._checkContextWarning();
        }
        if (this._turnCompleteResolve) {
          this._turnCompleteResolve();
          this._turnCompleteResolve = null;
          this._turnCompletePromise = null;
        }
        return;
      }

      if (event.type === "auto_compaction_start") {
        this._postToChat("\u{1F5DC}\uFE0F Auto-compacting conversation...").catch((err) => {
          log.error("Failed to post auto-compaction start", { threadKey: this.threadKey, error: err });
        });
        return;
      }

      if (event.type === "auto_compaction_end") {
        const result = event.result;
        if (result) {
          const after = this.getContextUsage();
          const beforeStr = formatTokenCount(result.tokensBefore);
          const afterStr = after?.tokens != null ? formatTokenCount(after.tokens) : "unknown";
          this._postToChat(`\u{1F5DC}\uFE0F Auto-compacted: ${beforeStr} \u2192 ${afterStr} tokens`).catch((err) => {
            log.error("Failed to post auto-compaction end", { threadKey: this.threadKey, error: err });
          });
          this._lastContextWarningThreshold = 0;
        }
        return;
      }

      if (event.type === "tool_execution_start") {
        this._turnToolRecords.push({
          toolName: event.toolName,
          args: event.args,
          startTime: Date.now(),
        });
      } else if (event.type === "tool_execution_end") {
        const record = [...this._turnToolRecords].reverse().find(
          (r) => r.toolName === event.toolName && r.endTime === undefined,
        );
        if (record) {
          record.endTime = Date.now();
          record.isError = event.isError;
        }
      }

      if (!stateReady) {
        pendingEvents.push(event);
        return;
      }

      const state = this._activeStreamState;
      if (!state) return;
      this._dispatchStreamEvent(event, state);
    });
  }

  private _dispatchStreamEvent(event: AgentSessionEvent, state: import("./streaming-updater.js").StreamingState): void {
    if (
      event.type === "message_update" &&
      event.assistantMessageEvent?.type === "text_delta"
    ) {
      this._updater.appendText(state, event.assistantMessageEvent.delta);
    } else if (
      event.type === "message_update" &&
      event.assistantMessageEvent?.type === "thinking_delta"
    ) {
      this._updater.appendThinking(state, event.assistantMessageEvent.delta);
    } else if (event.type === "tool_execution_start") {
      this._updater.appendToolStart(state, event.toolName, event.args);
    } else if (event.type === "tool_execution_end") {
      this._updater.appendToolEnd(state, event.toolName, event.isError);
    }
  }

  async prompt(text: string, options?: { images?: ImageContent[] }): Promise<void> {
    this._lastUserPrompt = text;

    const piText = text.replace(/^\//, "/");

    this._turnCompletePromise = new Promise<void>((resolve) => {
      this._turnCompleteResolve = resolve;
    });

    try {
      await this._agentSession.prompt(piText, {
        images: options?.images,
      });

      if (this._turnCompletePromise !== null) {
        await Promise.race([
          this._turnCompletePromise,
          new Promise<void>((resolve) => setTimeout(resolve, 500)),
        ]);
      }

      while (true) {
        if (!this._agentSession.isStreaming) {
          await new Promise((r) => setTimeout(r, 200));
          if (!this._agentSession.isStreaming) break;
        }
        await new Promise<void>((resolve) => {
          this._turnCompletePromise = new Promise<void>((r) => {
            this._turnCompleteResolve = r;
          });
          void this._turnCompletePromise.then(resolve);
        });
      }
    } catch (err) {
      const state = this._activeStreamState;
      if (state) {
        this._activeStreamState = null;
        await this._updater.error(state, err instanceof Error ? err : new Error(String(err)));
      }
      if (this._turnCompleteResolve) {
        this._turnCompleteResolve();
        this._turnCompleteResolve = null;
        this._turnCompletePromise = null;
      }
    }
  }

  /**
   * Ask a side question using the current session context without adding it
   * to the conversation history. The answer is returned as a string.
   */
  async btw(question: string): Promise<string> {
    const model = this._agentSession.model;
    if (!model) throw new Error("No model loaded.");

    // Build a context from current messages + the btw question (no tools, no save)
    const { streamSimple } = await import("@mariozechner/pi-ai");
    const { convertToLlm } = await import("@mariozechner/pi-coding-agent");

    const existingMessages = this._agentSession.messages;
    const llmMessages = convertToLlm(existingMessages);

    const eventStream = streamSimple(model, {
      messages: [
        ...llmMessages,
        { role: "user" as const, content: [{ type: "text" as const, text: question }], timestamp: Date.now() },
      ],
    });

    let result = "";
    for await (const event of eventStream) {
      if (event.type === "text_delta") result += event.delta;
    }
    return result.trim() || "(no response)";
  }

  abort(): void {
    void this._agentSession.abort();
    if (this._turnCompleteResolve) {
      this._turnCompleteResolve();
      this._turnCompleteResolve = null;
      this._turnCompletePromise = null;
    }
  }

  private async _postToChat(text: string): Promise<void> {
    await this._api.sendMessage(this.chatId, text, {
      message_thread_id: this.threadId,
    });
  }

  async dispose(): Promise<void> {
    this._stopTyping();
    if (this._persistentUnsub) {
      this._persistentUnsub();
      this._persistentUnsub = null;
    }
    this._agentSession.dispose();
  }

  async newSession(): Promise<void> {
    await this._agentSession.newSession();
    this._lastContextWarningThreshold = 0;
  }

  async reload(): Promise<void> {
    await this._agentSession.reload();
  }

  get isStreaming(): boolean {
    return this._agentSession.isStreaming;
  }

  get messageCount(): number {
    return this._agentSession.messages.length;
  }

  getContextUsage(): ContextUsage | undefined {
    return this._agentSession.getContextUsage();
  }

  async compact(customInstructions?: string): Promise<CompactionResult> {
    return this._agentSession.compact(customInstructions);
  }

  private _checkContextWarning(): void {
    const usage = this.getContextUsage();
    if (usage?.percent === null || usage?.percent === undefined) return;

    const threshold = getContextWarningThreshold(usage.percent, this._lastContextWarningThreshold);
    if (threshold !== null) {
      this._lastContextWarningThreshold = threshold;
      const usageStr = formatContextUsage(usage);
      this._postToChat(
        `\u26A0\uFE0F Context is ${Math.round(usage.percent)}% full (${usageStr}). Use /compact to summarize or /new for a fresh session.`,
      ).catch((err) => {
        log.error("Failed to post context warning", { threadKey: this.threadKey, error: err });
      });
    }
  }

  get model(): AgentSession["model"] {
    return this._agentSession.model;
  }

  get modelRegistry(): AgentSession["modelRegistry"] {
    return this._agentSession.modelRegistry;
  }

  get thinkingLevel(): ThinkingLevel {
    return this._agentSession.thinkingLevel as ThinkingLevel;
  }

  async setModel(modelName: string): Promise<void> {
    const registry = this._agentSession.modelRegistry;
    const all = registry.getAll();
    const match = all.find(
      (m) => m.id === modelName || m.name.toLowerCase() === modelName.toLowerCase(),
    );
    if (!match) {
      throw new Error(`Unknown model: ${modelName}. Available: ${all.map((m) => m.id).join(", ")}`);
    }
    await this._agentSession.setModel(match);
  }

  setThinkingLevel(level: ThinkingLevel): void {
    this._agentSession.setThinkingLevel(level);
  }

  subscribe(handler: AgentSessionEventListener): () => void {
    return this._agentSession.subscribe(handler);
  }

  get promptTemplates(): ReadonlyArray<PromptTemplate> {
    return this._agentSession.promptTemplates;
  }

  get lastUserPrompt(): string | null {
    return this._lastUserPrompt;
  }
}
