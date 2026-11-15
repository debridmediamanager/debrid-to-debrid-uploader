import fs from "node:fs";
import path from "node:path";

const VIDEO_EXTENSIONS = new Set([
  ".mkv",
  ".mp4",
  ".avi",
  ".mov",
  ".wmv",
  ".flv",
  ".webm",
  ".m4v",
  ".ts",
  ".m2ts",
  ".mpg",
  ".mpeg",
]);

export function isVideoFile(filename: string): boolean {
  return VIDEO_EXTENSIONS.has(path.extname(filename).toLowerCase());
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}
