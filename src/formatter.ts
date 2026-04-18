const SPECIAL_CHARS = /([_*\[\]()~`>#+\-=|{}.!\\])/g;

export function escapeMarkdownV2(text: string): string {
  return text.replace(SPECIAL_CHARS, "\\$1");
}

export function markdownToTelegram(markdown: string, partial?: boolean): string {
  let md = markdown;
  if (partial) {
    const fenceCount = (md.match(/```/g) ?? []).length;
    if (fenceCount % 2 !== 0) md += "\n```";
  }
  return md;
}

export function splitMessage(text: string, limit = 4000): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > limit) {
    const window = remaining.slice(0, limit);
    const splitAt = findSplitPoint(window);
    const chunk = remaining.slice(0, splitAt).trimEnd();
    if (chunk) chunks.push(chunk);
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining.trim()) chunks.push(remaining.trim());
  return chunks;
}

function findSplitPoint(text: string): number {
  for (const sep of ["\n\n", "\n", " "]) {
    const idx = lastSafeSplit(text, sep);
    if (idx > 0) return idx + sep.length;
  }
  return text.length;
}

function lastSafeSplit(text: string, sep: string): number {
  let best = -1;
  let inCode = false;
  let i = 0;

  while (i < text.length) {
    if (text.startsWith("```", i)) {
      inCode = !inCode;
      i += 3;
      continue;
    }
    if (!inCode && text.startsWith(sep, i)) {
      best = i;
      i += sep.length;
      continue;
    }
    i++;
  }

  return best;
}

export function formatToolStart(toolName: string, args: unknown): string {
  const argStr = formatToolArgs(toolName, args);
  return `> \u{1F527} \`${toolName}\`(${argStr})`;
}

export function formatToolEnd(toolName: string, isError: boolean): string {
  const icon = isError ? "\u274C" : "\u2705";
  return `> ${icon} \`${toolName}\``;
}

export interface ToolCallRecord {
  toolName: string;
  args: unknown;
  startTime: number;
  endTime?: number;
  isError?: boolean;
}

export function formatToolLog(records: ToolCallRecord[]): string {
  if (records.length === 0) return "";

  const lines: string[] = [];
  lines.push("\u2500\u2500\u2500 Tool Activity \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500");

  let totalDuration = 0;
  let failCount = 0;

  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    const num = String(i + 1).padStart(2, " ");
    const icon = r.isError ? "\u2717" : "\u2713";
    const duration = r.endTime ? (r.endTime - r.startTime) / 1000 : 0;
    totalDuration += duration;
    if (r.isError) failCount++;

    const desc = describeToolCall(r.toolName, r.args);
    const durStr = duration >= 0.1 ? `${duration.toFixed(1)}s` : "<0.1s";
    lines.push(`${num}. ${icon} ${desc}  ${durStr}`);
  }

  lines.push("\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500");
  const failStr = failCount > 0 ? ` (${failCount} failed)` : "";
  lines.push(`${records.length} tools ran${failStr} in ${totalDuration.toFixed(1)}s`);

  return lines.join("\n");
}

export function formatToolArgs(toolName: string, args: unknown): string {
  if (args === null || args === undefined) return "";
  if (typeof args !== "object") return truncateStr(String(args), 60);

  const obj = args as Record<string, unknown>;

  switch (toolName) {
    case "read":
    case "write":
    case "edit":
    case "share_file":
      return truncateStr(String(obj.path ?? ""), 60);
    case "bash":
      return truncateStr(String(obj.command ?? ""), 60);
    case "web_search":
      return truncateStr(String(obj.query ?? obj.queries ?? ""), 60);
    case "fetch_content":
      return truncateStr(String(obj.url ?? obj.urls ?? ""), 60);
    default:
      return formatGenericArgs(obj);
  }
}

function formatGenericArgs(obj: Record<string, unknown>): string {
  const entries = Object.entries(obj);
  if (entries.length === 0) return "";

  return entries
    .slice(0, 3)
    .map(([, v]) => {
      const s = typeof v === "string" ? v : JSON.stringify(v);
      return truncateStr(s, 40);
    })
    .join(", ");
}

function truncateStr(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 3) + "..." : s;
}

function shortPath(fullPath: string): string {
  const parts = fullPath.split("/").filter(Boolean);
  if (parts.length <= 2) return fullPath;
  return parts.slice(-2).join("/");
}

function describeToolCall(toolName: string, args: unknown, opts?: { backtick?: boolean }): string {
  const bt = opts?.backtick ? "`" : "";
  if (!args || typeof args !== "object") return `${bt}${toolName}${bt}`;
  const obj = args as Record<string, unknown>;

  switch (toolName) {
    case "read": {
      const p = shortPath(String(obj.path ?? ""));
      return `Read ${bt}${p}${bt}`;
    }
    case "write": {
      const p = shortPath(String(obj.path ?? ""));
      return `Wrote ${bt}${p}${bt}`;
    }
    case "edit": {
      const p = shortPath(String(obj.path ?? ""));
      return `Edited ${bt}${p}${bt}`;
    }
    case "bash": {
      const cmd = String(obj.command ?? "").split("\n")[0] ?? "";
      return `Ran ${bt}${truncateStr(cmd, 50)}${bt}`;
    }
    case "web_search": {
      const q = String(obj.query ?? obj.queries ?? "");
      return `Searched "${truncateStr(q, 40)}"`;
    }
    case "fetch_content": {
      const u = String(obj.url ?? obj.urls ?? "");
      return `Fetched ${bt}${truncateStr(u, 50)}${bt}`;
    }
    case "share_file": {
      const p = shortPath(String(obj.path ?? ""));
      return `Shared ${bt}${p}${bt}`;
    }
    default: {
      const argStr = formatToolArgs(toolName, args);
      return `${bt}${toolName}${bt}(${argStr})`;
    }
  }
}

export function formatToolCompleted(record: ToolCallRecord): string {
  const icon = record.isError ? "\u2717" : "\u2713";
  const desc = describeToolCall(record.toolName, record.args, { backtick: true });
  const duration = record.endTime ? record.endTime - record.startTime : 0;
  const durStr = duration >= 1000 ? ` _(${(duration / 1000).toFixed(1)}s)_` : "";
  return `> ${icon} ${desc}${durStr}`;
}

export function formatToolSummaryLine(records: ToolCallRecord[]): string {
  if (records.length === 0) return "";

  const counts: Record<string, number> = {};
  for (const r of records) {
    const label = toolActionLabel(r.toolName);
    counts[label] = (counts[label] ?? 0) + 1;
  }

  const parts = Object.entries(counts).map(([label, count]) =>
    count > 1 ? `${label} \u00D7${count}` : label,
  );

  const totalMs = records.reduce((sum, r) => sum + (r.endTime ? r.endTime - r.startTime : 0), 0);
  const timeStr = totalMs >= 1000 ? ` (${(totalMs / 1000).toFixed(1)}s)` : "";

  return `> \u{1F4CB} ${records.length} tool calls${timeStr}: ${parts.join(", ")}`;
}

function toolActionLabel(toolName: string): string {
  switch (toolName) {
    case "read": return "read";
    case "write": return "write";
    case "edit": return "edit";
    case "bash": return "command";
    case "web_search": return "search";
    case "fetch_content": return "fetch";
    default: return toolName;
  }
}
