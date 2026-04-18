/**
 * MessageBuffer — reassembles split messages before dispatching to the agent.
 *
 * Telegram splits messages at 4096 chars. Users pasting large code blocks end
 * up sending 2-3 consecutive messages in quick succession. We buffer them with
 * a short debounce and combine them into one prompt.
 */

const DEBOUNCE_MS = 1500;
const MAX_PARTS = 12;
const MAX_TOTAL_CHARS = 50_000;

export interface BufferedMessage {
  text: string;
  images?: import("@mariozechner/pi-ai").ImageContent[];
}

type FlushCallback = (combined: BufferedMessage) => void;

interface Buffer {
  parts: BufferedMessage[];
  timer: ReturnType<typeof setTimeout>;
}

export class MessageBuffer {
  private _buffers = new Map<string, Buffer>();
  private _onFlush: FlushCallback;

  constructor(onFlush: FlushCallback) {
    this._onFlush = onFlush;
  }

  push(key: string, msg: BufferedMessage): void {
    const existing = this._buffers.get(key);

    if (existing) {
      // Check if we'd exceed limits — if so flush immediately then start fresh
      const totalChars = existing.parts.reduce((s, p) => s + p.text.length, 0) + msg.text.length;
      if (existing.parts.length >= MAX_PARTS || totalChars > MAX_TOTAL_CHARS) {
        clearTimeout(existing.timer);
        this._buffers.delete(key);
        this._flush(existing.parts);
        // Start new buffer for this message
        this._startBuffer(key, msg);
        return;
      }

      clearTimeout(existing.timer);
      existing.parts.push(msg);
      existing.timer = setTimeout(() => {
        this._buffers.delete(key);
        this._flush(existing.parts);
      }, DEBOUNCE_MS);
    } else {
      this._startBuffer(key, msg);
    }
  }

  /** Flush all pending buffers immediately (e.g. on shutdown). */
  flushAll(): void {
    for (const [key, buf] of this._buffers) {
      clearTimeout(buf.timer);
      this._buffers.delete(key);
      this._flush(buf.parts);
    }
  }

  private _startBuffer(key: string, msg: BufferedMessage): void {
    const parts = [msg];
    const timer = setTimeout(() => {
      this._buffers.delete(key);
      this._flush(parts);
    }, DEBOUNCE_MS);
    this._buffers.set(key, { parts, timer });
  }

  private _flush(parts: BufferedMessage[]): void {
    if (parts.length === 0) return;
    if (parts.length === 1) {
      this._onFlush(parts[0]);
      return;
    }
    // Combine text with newlines, merge images
    const text = parts.map((p) => p.text).filter(Boolean).join("\n");
    const images = parts.flatMap((p) => p.images ?? []);
    this._onFlush({ text, images: images.length > 0 ? images : undefined });
  }
}
