import { GrammyError } from "grammy";
import { createLogger } from "./logger.js";

const log = createLogger("telegram-retry");

export function isRateLimitError(err: unknown): boolean {
  if (err instanceof GrammyError && err.error_code === 429) return true;
  return false;
}

export function getRetryDelayMs(err: unknown, fallbackMs: number): number {
  if (err instanceof GrammyError && err.error_code === 429) {
    const params = err.parameters;
    if (params && typeof params.retry_after === "number" && params.retry_after > 0) {
      return params.retry_after * 1000;
    }
  }
  return fallbackMs;
}

export interface RetryOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  maxTotalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function retryTelegramCall<T>(
  fn: () => Promise<T>,
  label: string,
  opts?: RetryOptions,
): Promise<T> {
  const maxRetries = opts?.maxRetries ?? 3;
  const initialDelayMs = opts?.initialDelayMs ?? 1000;
  const maxTotalMs = opts?.maxTotalMs ?? 10_000;
  const sleep = opts?.sleep ?? defaultSleep;

  let totalWaited = 0;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isRateLimitError(err) || attempt >= maxRetries) {
        throw err;
      }

      const backoff = initialDelayMs * Math.pow(2, attempt);
      let delay = getRetryDelayMs(err, backoff);

      const remaining = maxTotalMs - totalWaited;
      if (remaining <= 0) {
        throw err;
      }
      delay = Math.min(delay, remaining);

      log.warn("Rate limited, retrying", { label, delayMs: delay, attempt: attempt + 1, maxRetries });

      await sleep(delay);
      totalWaited += delay;
    }
  }

  throw new Error(`[TelegramRetry] ${label} exceeded max retries`);
}
