import { createWriteStream, existsSync, mkdirSync, readFileSync } from "fs";
import { extname, join } from "path";
import { pipeline } from "stream/promises";
import { Readable } from "stream";
import type { Api } from "grammy";
import type { ImageContent } from "@mariozechner/pi-ai";
import { createLogger } from "./logger.js";

const log = createLogger("file-handling");

export const INBOUND_DIR = ".telegram-files";

const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;
export const MAX_VISION_BYTES = 5 * 1024 * 1024;
const MAX_IMAGES_PER_MESSAGE = 10;

const IMAGE_MIMETYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

export function isImageFile(mimetype?: string): boolean {
  return mimetype != null && IMAGE_MIMETYPES.has(mimetype);
}

export interface TelegramFile {
  fileId: string;
  fileName: string;
  mimeType?: string;
  fileSize?: number;
}

export interface DownloadedFile {
  originalName: string;
  localPath: string;
  size: number;
  mimetype?: string;
}

export async function downloadTelegramFiles(
  files: TelegramFile[],
  cwd: string,
  api: Api,
): Promise<DownloadedFile[]> {
  const destDir = join(cwd, INBOUND_DIR);
  mkdirSync(destDir, { recursive: true });

  const results: DownloadedFile[] = [];

  for (const file of files) {
    if (file.fileSize && file.fileSize > MAX_DOWNLOAD_BYTES) {
      log.warn("Skipping file: exceeds size limit", { fileName: file.fileName, size: file.fileSize });
      continue;
    }

    try {
      const tgFile = await api.getFile(file.fileId);
      if (!tgFile.file_path) {
        log.warn("Skipping file: no file_path from Telegram", { fileName: file.fileName });
        continue;
      }

      const url = `https://api.telegram.org/file/bot${api.token}/${tgFile.file_path}`;
      const localPath = uniquePath(destDir, file.fileName);
      await downloadFile(url, localPath);

      const size = file.fileSize ?? 0;
      results.push({
        originalName: file.fileName,
        localPath,
        size,
        mimetype: file.mimeType,
      });
    } catch (err) {
      log.error("Failed to download file", { fileName: file.fileName, error: err });
    }
  }

  return results;
}

export function formatInboundFileContext(downloaded: DownloadedFile[]): string {
  if (downloaded.length === 0) return "";

  const lines = ["The user shared the following files (saved to your cwd):"];
  for (const f of downloaded) {
    lines.push(`- \`${f.localPath}\` (${formatBytes(f.size)}) \u2014 originally "${f.originalName}"`);
  }
  return lines.join("\n");
}

export interface EnrichedPrompt {
  text: string;
  images: ImageContent[];
}

export async function enrichPromptWithFiles(
  files: TelegramFile[],
  text: string,
  cwd: string,
  api: Api,
): Promise<EnrichedPrompt> {
  if (files.length === 0) return { text, images: [] };

  const downloaded = await downloadTelegramFiles(files, cwd, api);
  const context = formatInboundFileContext(downloaded);
  const enrichedText = context
    ? (text ? `${context}\n\n${text}` : context)
    : text;

  const images: ImageContent[] = [];
  for (const file of downloaded) {
    if (images.length >= MAX_IMAGES_PER_MESSAGE) break;
    if (!isImageFile(file.mimetype)) continue;
    if (file.size > MAX_VISION_BYTES) continue;

    try {
      const data = readFileSync(file.localPath);
      images.push({
        type: "image",
        data: data.toString("base64"),
        mimeType: file.mimetype!,
      });
    } catch (err) {
      log.error("Failed to read image for vision", { fileName: file.originalName, error: err });
    }
  }

  return { text: enrichedText, images };
}

async function downloadFile(url: string, destPath: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} downloading file`);
  }
  if (!res.body) {
    throw new Error("No response body");
  }
  const ws = createWriteStream(destPath);
  await pipeline(Readable.fromWeb(res.body as ReadableStream<Uint8Array>), ws);
}

function uniquePath(dir: string, name: string): string {
  const base = join(dir, name);
  if (!existsSync(base)) return base;

  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let counter = 1;
  let candidate: string;
  do {
    candidate = join(dir, `${stem}-${counter}${ext}`);
    counter++;
  } while (existsSync(candidate));

  return candidate;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
