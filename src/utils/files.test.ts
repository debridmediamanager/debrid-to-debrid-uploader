import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureDir, isVideoFile } from "./files";

let tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "debrid-files-"));
  tempDirs.push(dir);
  return dir;
}

describe("file helpers", () => {
  test("creates directories recursively", () => {
    const dir = path.join(tempDir(), "a", "b");
    ensureDir(dir);
    expect(fs.statSync(dir).isDirectory()).toBe(true);
  });
});

describe("isVideoFile", () => {
  test("recognizes video extensions", () => {
    expect(isVideoFile("movie.mkv")).toBe(true);
    expect(isVideoFile("movie.mp4")).toBe(true);
    expect(isVideoFile("movie.avi")).toBe(true);
    expect(isVideoFile("show.ts")).toBe(true);
  });

  test("rejects non-video extensions", () => {
    expect(isVideoFile("info.nfo")).toBe(false);
    expect(isVideoFile("subs.srt")).toBe(false);
    expect(isVideoFile("readme.txt")).toBe(false);
  });

  test("is case insensitive", () => {
    expect(isVideoFile("movie.MKV")).toBe(true);
  });
});
