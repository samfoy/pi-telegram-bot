import type { ContextUsage } from "@mariozechner/pi-coding-agent";

export function formatTokenCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) {
    const k = n / 1000;
    const rounded = Math.round(k * 10) / 10;
    return rounded < 10 ? `${rounded.toFixed(1)}K` : `${Math.round(k)}K`;
  }
  const m = n / 1_000_000;
  const roundedM = Math.round(m * 10) / 10;
  return roundedM < 10 ? `${roundedM.toFixed(1)}M` : `${Math.round(m)}M`;
}

export function formatContextUsage(usage: ContextUsage): string {
  const window = formatTokenCount(usage.contextWindow);
  if (usage.tokens === null || usage.percent === null) {
    return `unknown / ${window} tokens`;
  }
  const used = formatTokenCount(usage.tokens);
  return `${used} / ${window} tokens (${Math.round(usage.percent)}%)`;
}

export function formatContextBar(percent: number, width = 16): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * width);
  const empty = width - filled;
  const bar = "\u2588".repeat(filled) + "\u2591".repeat(empty);
  return `[${bar}] ${Math.round(clamped)}%`;
}

export const CONTEXT_WARNING_THRESHOLDS = [80, 90] as const;

export function getContextWarningThreshold(
  percent: number,
  lastWarningThreshold: number,
): number | null {
  for (let i = CONTEXT_WARNING_THRESHOLDS.length - 1; i >= 0; i--) {
    const threshold = CONTEXT_WARNING_THRESHOLDS[i];
    if (percent >= threshold && lastWarningThreshold < threshold) {
      return threshold;
    }
  }
  return null;
}
