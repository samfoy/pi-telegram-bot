import { config as loadDotenv } from "dotenv";
loadDotenv();

import { loadConfig } from "./config.js";
import { createApp } from "./telegram.js";
import { createLogger } from "./logger.js";

const log = createLogger("main");
const config = loadConfig();

log.info("pi-telegram-bot starting", {
  telegramUserId: config.telegramUserId,
  provider: config.provider,
  model: config.model,
  thinkingLevel: config.thinkingLevel,
  maxSessions: config.maxSessions,
  sessionIdleTimeoutSecs: config.sessionIdleTimeoutSecs,
  sessionDir: config.sessionDir,
  streamThrottleMs: config.streamThrottleMs,
  telegramMsgLimit: config.telegramMsgLimit,
  ackReaction: config.ackReaction,
});

const { bot, sessionManager, flushAllBuffers } = createApp(config);

async function startWithRetry(): Promise<void> {
  let attempt = 0;
  // Retry indefinitely on 409 — another instance is still shutting down.
  // Throwing would cause launchd to spawn a new instance, making the conflict worse.
  while (true) {
    attempt++;
    try {
      await new Promise<void>((resolve, reject) => {
        bot.start({
          onStart: () => {
            log.info("Bot running");
            // Don't resolve here — bot.start runs indefinitely until error
          },
        }).then(resolve).catch(reject);
      });
      return; // clean exit
    } catch (err: unknown) {
      const is409 = err instanceof Error && err.message.includes("409");
      if (is409) {
        // Exponential backoff capped at 60s so we eventually win without flooding
        const delayMs = Math.min(5000 * attempt, 60_000);
        log.warn(`409 conflict on attempt ${attempt}, retrying in ${delayMs / 1000}s...`);
        await new Promise((r) => setTimeout(r, delayMs));
      } else {
        throw err;
      }
    }
  }
}

startWithRetry().catch((err) => {
  log.error("Bot failed to start", { error: err });
  process.exit(1);
});

sessionManager.restoreAll().then((count) => {
  if (count > 0) log.info("Restored sessions from previous run", { count });
}).catch((err) => {
  log.error("Failed to restore sessions", { error: err });
});

let isShuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;
  log.info(`Shutting down (${signal})`);
  try {
    await flushAllBuffers();
  } catch (err) {
    log.error("Failed to flush message buffers on shutdown", { error: err });
  }
  await sessionManager.disposeAll();
  await sessionManager.flushRegistry();
  sessionManager.disposeRegistry();
  await bot.stop();
  process.exit(0);
}

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});
