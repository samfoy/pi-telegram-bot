import fs from "fs/promises";
import type { Api } from "grammy";
import type { Config, ThinkingLevel } from "./config.js";
import { ThreadSession, type ThreadSessionCreateParams } from "./thread-session.js";
import { SessionRegistry, type SessionEntry } from "./session-registry.js";
import { createLogger } from "./logger.js";

const log = createLogger("session-manager");

export class SessionLimitError extends Error {
  constructor() {
    super("Too many active sessions");
    this.name = "SessionLimitError";
  }
}

export interface ThreadSessionInfo {
  threadKey: string;
  chatId: number;
  threadId: number | undefined;
  cwd: string;
  messageCount: number;
  model: string;
  thinkingLevel: ThinkingLevel;
  lastActivity: Date;
  isStreaming: boolean;
}

export interface GetOrCreateParams {
  threadKey: string;
  chatId: number;
  threadId: number | undefined;
  cwd: string;
  resumeSessionPath?: string;
}

type SessionFactory = (params: ThreadSessionCreateParams) => Promise<ThreadSession>;

export class BotSessionManager {
  private _sessions = new Map<string, ThreadSession>();
  private _reaper: ReturnType<typeof setInterval>;
  private _registry: SessionRegistry;
  private _exitHandlers = new Map<string, () => void>();

  constructor(
    private _config: Config,
    private _api: Api,
    private _factory: SessionFactory = ThreadSession.create,
    registry?: SessionRegistry,
  ) {
    this._registry = registry ?? new SessionRegistry(_config.sessionDir);
    this._reaper = setInterval(() => void this._reap(), 60_000);
  }

  get(threadKey: string): ThreadSession | undefined {
    return this._sessions.get(threadKey);
  }

  async getOrCreate(params: GetOrCreateParams): Promise<ThreadSession> {
    const existing = this._sessions.get(params.threadKey);
    if (existing) return existing;

    if (this._sessions.size >= this._config.maxSessions) {
      throw new SessionLimitError();
    }

    await fs.mkdir(this._config.sessionDir, { recursive: true });

    const session = await this._factory({
      ...params,
      config: this._config,
      api: this._api,
      sessionDir: this._config.sessionDir,
    });

    this._sessions.set(params.threadKey, session);
    this._monitorSession(params.threadKey, session);
    this._persistRegistry();
    return session;
  }

  async dispose(threadKey: string): Promise<void> {
    const session = this._sessions.get(threadKey);
    if (session) {
      this._sessions.delete(threadKey);
      // Clean up exit handler
      const unsub = this._exitHandlers.get(threadKey);
      if (unsub) {
        unsub();
        this._exitHandlers.delete(threadKey);
      }
      await session.dispose();
      this._persistRegistry();
    }
  }

  async disposeAll(): Promise<void> {
    await Promise.all([...this._sessions.keys()].map((key) => this.dispose(key)));
  }

  async restoreAll(): Promise<number> {
    const entries = await this._registry.load();
    if (entries.length === 0) return 0;

    log.info("Restoring sessions from registry", { count: entries.length });

    const results = await Promise.allSettled(
      entries.map((entry) => this._restoreOne(entry)),
    );

    let restored = 0;
    for (const result of results) {
      if (result.status === "fulfilled" && result.value) {
        restored++;
      }
    }

    this._persistRegistry();

    log.info("Restored sessions", { restored, total: entries.length });
    return restored;
  }

  list(): ThreadSessionInfo[] {
    return [...this._sessions.values()].map((s) => ({
      threadKey: s.threadKey,
      chatId: s.chatId,
      threadId: s.threadId,
      cwd: s.cwd,
      messageCount: s.messageCount,
      model: s.model?.id ?? "unknown",
      thinkingLevel: s.thinkingLevel,
      lastActivity: s.lastActivity,
      isStreaming: s.isStreaming,
    }));
  }

  count(): number {
    return this._sessions.size;
  }

  get sessionDir(): string {
    return this._config.sessionDir;
  }

  stopReaper(): void {
    clearInterval(this._reaper);
  }

  disposeRegistry(): void {
    this._registry.dispose();
  }

  async flushRegistry(): Promise<void> {
    await this._registry.flush();
  }

  private async _restoreOne(entry: SessionEntry): Promise<boolean> {
    if (this._sessions.has(entry.threadKey)) {
      log.info("Skipping restore \u2014 already active", { threadKey: entry.threadKey });
      return true;
    }

    try {
      await this.getOrCreate({
        threadKey: entry.threadKey,
        chatId: entry.chatId,
        threadId: entry.threadId,
        cwd: entry.cwd,
        resumeSessionPath: entry.sessionPath,
      });

      await this._api.sendMessage(entry.chatId, "\u{1F504} Session restored after restart.", {
        message_thread_id: entry.threadId,
      });

      return true;
    } catch (err) {
      log.error("Failed to restore session", { threadKey: entry.threadKey, error: err });
      return false;
    }
  }

  private _persistRegistry(): void {
    const entries: SessionEntry[] = [...this._sessions.values()].map((s) => ({
      threadKey: s.threadKey,
      chatId: s.chatId,
      threadId: s.threadId,
      cwd: s.cwd,
      sessionPath: s.sessionPath,
    }));
    this._registry.scheduleSave(entries);
  }

  private async _reap(): Promise<void> {
    const now = Date.now();
    const timeout = this._config.sessionIdleTimeoutSecs * 1000;
    for (const [key, session] of this._sessions) {
      if (now - session.lastActivity.getTime() > timeout) {
        await this.dispose(key);
      }
    }
  }

  /**
   * Monitor a session's underlying agent for unexpected termination.
   * Subscribes to session events and watches for auto_retry_end with
   * success=false, which indicates an unrecoverable agent failure.
   * Notifies the user and cleans up.
   */
  private _monitorSession(threadKey: string, session: ThreadSession): void {
    const unsub = session.subscribe((event) => {
      if (
        event.type === "auto_retry_end" &&
        !event.success
      ) {
        log.error("Session hit unrecoverable error after retries", {
          threadKey,
          attempt: event.attempt,
          finalError: event.finalError,
        });
        this._handleDeadSession(threadKey, session).catch((err) => {
          log.error("Failed to handle dead session", { threadKey, error: err });
        });
      }
    });
    this._exitHandlers.set(threadKey, unsub);
  }

  private async _handleDeadSession(threadKey: string, session: ThreadSession): Promise<void> {
    // Remove from active sessions
    this._sessions.delete(threadKey);
    const unsub = this._exitHandlers.get(threadKey);
    if (unsub) {
      unsub();
      this._exitHandlers.delete(threadKey);
    }
    this._persistRegistry();

    // Notify the user
    try {
      await this._api.sendMessage(
        session.chatId,
        "\u26a0\ufe0f Session ended unexpectedly. Start a new conversation to create a fresh session.",
        { message_thread_id: session.threadId },
      );
    } catch (err) {
      log.error("Failed to notify user about dead session", { threadKey, error: err });
    }

    // Clean up the session
    try {
      await session.dispose();
    } catch (err) {
      log.error("Error disposing dead session", { threadKey, error: err });
    }
  }
}
