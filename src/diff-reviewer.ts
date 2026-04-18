import { execSync } from "child_process";
import { InputFile } from "grammy";
import type { Api } from "grammy";
import type { ToolCallRecord } from "./formatter.js";
import { createLogger } from "./logger.js";

const log = createLogger("diff-reviewer");

const FILE_MUTATING_TOOLS = new Set(["edit", "write"]);

export function extractModifiedFiles(records: ToolCallRecord[]): string[] {
  const seen = new Set<string>();
  const paths: string[] = [];

  for (const r of records) {
    if (!FILE_MUTATING_TOOLS.has(r.toolName)) continue;
    const args = r.args as Record<string, unknown> | null;
    const filePath = args?.path;
    if (typeof filePath !== "string") continue;
    if (seen.has(filePath)) continue;
    seen.add(filePath);
    paths.push(filePath);
  }

  return paths;
}

export function hasFileModifications(records: ToolCallRecord[]): boolean {
  return records.some((r) => FILE_MUTATING_TOOLS.has(r.toolName));
}

export interface DiffResult {
  diff: string;
  fileCount: number;
  stats: string;
}

export function getHeadRef(cwd: string): string | null {
  try {
    return execSync("git rev-parse HEAD", { cwd, encoding: "utf-8", stdio: "pipe" }).trim();
  } catch {
    return null;
  }
}

export function isGitRepo(cwd: string): boolean {
  try {
    execSync("git rev-parse --is-inside-work-tree", { cwd, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

export interface GenerateDiffOptions {
  baseRef?: string;
}

export function generateDiff(cwd: string, options?: GenerateDiffOptions): DiffResult | null {
  if (!isGitRepo(cwd)) return null;

  try {
    const baseRef = options?.baseRef;
    let diff: string;
    const diffCmd = baseRef ? `git diff ${baseRef}` : "git diff HEAD";
    try {
      diff = execSync(diffCmd, { cwd, encoding: "utf-8", maxBuffer: 2 * 1024 * 1024 });
    } catch {
      diff = execSync("git diff --cached", { cwd, encoding: "utf-8", maxBuffer: 2 * 1024 * 1024 });
    }

    diff = appendUntrackedDiffs(diff, cwd);

    if (!diff.trim()) return null;

    return buildDiffResult(diff);
  } catch (err) {
    log.error("Error generating diff", { error: err });
    return null;
  }
}

function appendUntrackedDiffs(diff: string, cwd: string): string {
  const untracked = execSync("git ls-files --others --exclude-standard", {
    cwd,
    encoding: "utf-8",
  }).trim();

  if (!untracked) return diff;

  for (const file of untracked.split("\n").filter(Boolean)) {
    try {
      const fileDiff = execSync(`git diff --no-index /dev/null "${file}" || true`, {
        cwd,
        encoding: "utf-8",
        maxBuffer: 1024 * 1024,
      });
      if (fileDiff.trim()) {
        diff += "\n" + fileDiff;
      }
    } catch {
      // skip
    }
  }

  return diff;
}

export function computeDiffStats(diff: string): {
  fileCount: number;
  insertions: number;
  deletions: number;
} {
  const lines = diff.split("\n");
  let fileCount = 0;
  let insertions = 0;
  let deletions = 0;
  let inHunk = false;

  for (const line of lines) {
    if (line.startsWith("diff --git ") || line.startsWith("diff --no-index ")) {
      fileCount++;
      inHunk = false;
    } else if (line.startsWith("@@ ")) {
      inHunk = true;
    } else if (inHunk) {
      if (line.startsWith("+") && !line.startsWith("+++")) {
        insertions++;
      } else if (line.startsWith("-") && !line.startsWith("---")) {
        deletions++;
      }
    }
  }

  return { fileCount, insertions, deletions };
}

function buildDiffResult(diff: string): DiffResult {
  const { fileCount, insertions, deletions } = computeDiffStats(diff);
  const statParts: string[] = [];
  statParts.push(`${fileCount} file${fileCount === 1 ? "" : "s"} changed`);
  if (insertions > 0) statParts.push(`${insertions} insertion${insertions === 1 ? "" : "s"}(+)`);
  if (deletions > 0) statParts.push(`${deletions} deletion${deletions === 1 ? "" : "s"}(-)`);
  return { diff, fileCount, stats: statParts.join(", ") };
}

export interface PostDiffOptions {
  baseRef?: string | null;
  toolRecords?: ToolCallRecord[];
}

export async function postDiffReview(
  api: Api,
  chatId: number,
  threadId: number | undefined,
  cwd: string,
  options?: PostDiffOptions,
): Promise<boolean> {
  const baseRef = options?.baseRef ?? undefined;
  const toolRecords = options?.toolRecords;

  const gitResult = generateDiff(cwd, { baseRef });
  if (gitResult) {
    await postDiff(api, chatId, threadId, gitResult);
    return true;
  }

  if (toolRecords && toolRecords.length > 0) {
    const syntheticResult = generateSyntheticDiff(toolRecords);
    if (syntheticResult) {
      await postDiff(api, chatId, threadId, syntheticResult);
      return true;
    }
  }

  return false;
}

async function postDiff(api: Api, chatId: number, threadId: number | undefined, result: DiffResult): Promise<void> {
  const MAX_INLINE = 3000;
  const title = `\u{1F4DD} ${result.fileCount} file${result.fileCount === 1 ? "" : "s"} changed`;
  const statsLine = result.stats ? `\n${result.stats}` : "";

  if (result.diff.length <= MAX_INLINE) {
    const text = `${title}${statsLine}\n\n\`\`\`diff\n${result.diff.slice(0, MAX_INLINE)}\n\`\`\``;
    await api.sendMessage(chatId, text, {
      message_thread_id: threadId,
      parse_mode: "Markdown",
    });
  } else {
    const buf = Buffer.from(result.diff, "utf-8");
    await api.sendDocument(chatId, new InputFile(buf, "changes.diff"), {
      message_thread_id: threadId,
      caption: `${title}${statsLine}`,
    });
  }
}

function generateSyntheticDiff(records: ToolCallRecord[]): DiffResult | null {
  const parts: string[] = [];
  const seenWrites = new Set<string>();
  const reversed = [...records].reverse();
  const toProcess: ToolCallRecord[] = [];

  for (const r of reversed) {
    if (r.toolName === "write") {
      const args = r.args as Record<string, unknown> | null;
      const filePath = typeof args?.path === "string" ? args.path : null;
      if (!filePath || seenWrites.has(filePath)) continue;
      seenWrites.add(filePath);
      toProcess.unshift(r);
    } else if (r.toolName === "edit") {
      toProcess.unshift(r);
    }
  }

  for (const r of toProcess) {
    const args = r.args as Record<string, unknown> | null;
    if (!args) continue;
    const filePath = typeof args.path === "string" ? args.path : null;
    if (!filePath) continue;

    if (r.toolName === "edit") {
      const oldText = typeof args.oldText === "string" ? args.oldText : "";
      const newText = typeof args.newText === "string" ? args.newText : "";
      if (oldText || newText) {
        const oldLines = oldText.split("\n");
        const newLines = newText.split("\n");
        parts.push([
          `diff --git a/${filePath} b/${filePath}`,
          `--- a/${filePath}`,
          `+++ b/${filePath}`,
          `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
          ...oldLines.map((l) => `-${l}`),
          ...newLines.map((l) => `+${l}`),
        ].join("\n"));
      }
    } else if (r.toolName === "write") {
      const content = typeof args.content === "string" ? args.content : "";
      const lines = content.split("\n");
      parts.push([
        `diff --git a/${filePath} b/${filePath}`,
        `new file mode 100644`,
        `--- /dev/null`,
        `+++ b/${filePath}`,
        `@@ -0,0 +1,${lines.length} @@`,
        ...lines.map((l) => `+${l}`),
      ].join("\n"));
    }
  }

  if (parts.length === 0) return null;
  return buildDiffResult(parts.join("\n"));
}

