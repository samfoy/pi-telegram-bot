import fs from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { createLogger } from "./logger.js";

const log = createLogger("session-registry");

export interface SessionEntry {
  threadKey: string;
  chatId: number;
  threadId: number | undefined;
  cwd: string;
  sessionPath: string;
}

interface RegistryFile {
  sessions: SessionEntry[];
}

const REGISTRY_FILENAME = "active-sessions.json";

export class SessionRegistry {
  private _dir: string;
  private _filePath: string;
  private _debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private _pendingEntries: SessionEntry[] | null = null;
  private _debounceMs: number;

  constructor(sessionDir: string, debounceMs = 1000) {
    this._dir = sessionDir;
    this._filePath = path.join(sessionDir, REGISTRY_FILENAME);
    this._debounceMs = debounceMs;
  }

  get filePath(): string {
    return this._filePath;
  }

  async load(): Promise<SessionEntry[]> {
    try {
      const raw = await fs.readFile(this._filePath, "utf-8");
      const data = JSON.parse(raw) as RegistryFile;

      if (!Array.isArray(data?.sessions)) return [];

      return data.sessions.filter((entry) =>
        typeof entry.threadKey === "string" &&
        typeof entry.chatId === "number" &&
        typeof entry.cwd === "string" &&
        typeof entry.sessionPath === "string" &&
        existsSync(entry.sessionPath),
      );
    } catch {
      return [];
    }
  }

  async save(entries: SessionEntry[]): Promise<void> {
    const data: RegistryFile = { sessions: entries };
    const tmpPath = this._filePath + ".tmp";

    try {
      await fs.mkdir(this._dir, { recursive: true });
      await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), "utf-8");
      await fs.rename(tmpPath, this._filePath);
    } catch (err) {
      log.error("Failed to save session registry", { error: err });
      try { await fs.unlink(tmpPath); } catch { /* ignore */ }
    }
  }

  scheduleSave(entries: SessionEntry[]): void {
    this._pendingEntries = entries;

    if (this._debounceTimer !== null) return;

    this._debounceTimer = setTimeout(() => {
      this._debounceTimer = null;
      const toSave = this._pendingEntries;
      this._pendingEntries = null;
      if (toSave) {
        void this.save(toSave);
      }
    }, this._debounceMs);
  }

  async flush(): Promise<void> {
    if (this._debounceTimer !== null) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }
    if (this._pendingEntries) {
      const toSave = this._pendingEntries;
      this._pendingEntries = null;
      await this.save(toSave);
    }
  }

  dispose(): void {
    if (this._debounceTimer !== null) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }
    this._pendingEntries = null;
  }
}
