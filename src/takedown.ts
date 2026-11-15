import fs from "node:fs";
import path from "node:path";

/**
 * DMM's notice-and-takedown blocklist, and the refusal it drives.
 *
 * DMM publishes the infohashes and release names named in copyright notices at
 * `GET /api/takedown/blocklist`. This service refuses to deliver any of them:
 * at submission with a 451, and again before each job runs, because a job can
 * wait in the queue (or across a restart) while the list changes under it.
 *
 * **Fails open.** A fetch error keeps the last good list and logs a warning; it
 * never empties the list and never refuses everything. The last good copy is
 * written under `data/`, which `deploy.sh` excludes from `git clean`, so a
 * restart during a DMM outage still enforces what was known before it.
 */

export const TAKEDOWN_MESSAGE = "blocked by a copyright notice";
export const DEFAULT_BLOCKLIST_URL = "https://debridmediamanager.com/api/takedown/blocklist";
export const BLOCKLIST_POLL_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;

export type Blocklist = { version: string; hashes: Set<string>; releases: Set<string> };

/**
 * DMM's release normalization, exactly: lowercase, strip a trailing `.nzb`,
 * collapse every run outside `[a-z0-9]` to one `.`, trim dots at both ends.
 */
export function normalizeRelease(name: string): string {
  return name
    .toLowerCase()
    .replace(/\.nzb$/, "")
    .replace(/[^a-z0-9]+/g, ".")
    .replace(/^\.+|\.+$/g, "");
}

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** A 32-character base32 BTIH as 40-character lowercase hex. */
export function base32ToHex(value: string): string | null {
  if (!/^[A-Za-z2-7]{32}$/.test(value)) return null;
  let bits = 0;
  let acc = 0;
  let hex = "";
  for (const ch of value.toUpperCase()) {
    acc = (acc << 5) | BASE32_ALPHABET.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      hex += ((acc >> bits) & 0xff).toString(16).padStart(2, "0");
    }
  }
  return hex;
}

/**
 * Every infohash a submission names, as lowercase hex.
 *
 * Wider than the pipeline's own parsing on purpose: a magnet can carry several
 * `xt` entries or a base32 BTIH, and the refusal must not be steerable around
 * by choosing an encoding the rest of the code happens to ignore.
 */
export function infoHashesOf(input: string): string[] {
  const hashes = new Set<string>();
  for (const m of input.matchAll(/btih:([0-9A-Za-z]+)/gi)) {
    const value = m[1];
    if (/^[0-9a-f]{40}$/i.test(value)) hashes.add(value.toLowerCase());
    const hex = base32ToHex(value);
    if (hex) hashes.add(hex);
  }
  for (const m of input.matchAll(/(?<![0-9a-f])[0-9a-f]{40}(?![0-9a-f])/gi)) {
    hashes.add(m[0].toLowerCase());
  }
  return [...hashes];
}

/** The `dn` a magnet carries, if any. */
export function magnetDisplayName(input: string): string | null {
  const query = input.startsWith("magnet:?") ? input.slice("magnet:?".length) : null;
  if (query === null) return null;
  return new URLSearchParams(query).get("dn") || null;
}

/**
 * The payload validated into a list, or null when it is not the contract's
 * shape. A malformed answer is treated like a failed fetch: it must not replace
 * a good list with an empty one.
 */
export function parseBlocklist(payload: unknown): Blocklist | null {
  if (!payload || typeof payload !== "object") return null;
  const { version, hashes, releases } = payload as Record<string, unknown>;
  if (typeof version !== "string" || !Array.isArray(hashes) || !Array.isArray(releases)) {
    return null;
  }
  if (!hashes.every((h) => typeof h === "string")) return null;
  if (!releases.every((r) => typeof r === "string")) return null;
  return {
    version,
    hashes: new Set((hashes as string[]).map((h) => h.trim().toLowerCase()).filter(Boolean)),
    releases: new Set((releases as string[]).map(normalizeRelease).filter(Boolean)),
  };
}

/** Terminal: a notice does not lapse between retry attempts. */
export class TakedownBlockedError extends Error {
  readonly reason: "hash" | "release";
  constructor(reason: "hash" | "release") {
    super(TAKEDOWN_MESSAGE);
    this.name = "TakedownBlockedError";
    this.reason = reason;
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type TakedownOptions = {
  /** Empty disables the check entirely. */
  url: string;
  /** Where the last good copy is kept; null keeps it in memory only. */
  statePath: string | null;
  fetch?: FetchLike;
  warn?: (message: string) => void;
};

export class TakedownList {
  private readonly url: string;
  private readonly statePath: string | null;
  private readonly fetchImpl: FetchLike;
  private readonly warn: (message: string) => void;
  private list: Blocklist | null;
  private etag: string | null;

  // Fields assigned here rather than as initializers: Bun 1.3.14 miscounts
  // class field initializers for function coverage.
  constructor(opts: TakedownOptions) {
    this.url = opts.url;
    this.statePath = opts.statePath;
    this.fetchImpl = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.warn = opts.warn ?? ((message) => console.warn(message));
    this.list = null;
    this.etag = null;
  }

  get enabled(): boolean {
    return this.url !== "";
  }

  get version(): string | null {
    return this.list?.version ?? null;
  }

  /** Install a payload. False, and nothing changes, when it is malformed. */
  accept(payload: unknown, etag?: string | null): boolean {
    const parsed = parseBlocklist(payload);
    if (!parsed) return false;
    this.list = parsed;
    this.etag = etag || `"${parsed.version}"`;
    return true;
  }

  /** Load the last good copy written by a previous process, if there is one. */
  loadPersisted(): void {
    if (!this.statePath || !fs.existsSync(this.statePath)) return;
    try {
      const payload = JSON.parse(fs.readFileSync(this.statePath, "utf8"));
      if (!this.accept(payload)) this.warn(`[takedown] ignoring malformed ${this.statePath}`);
    } catch (err) {
      this.warn(`[takedown] could not read ${this.statePath}: ${err}`);
    }
  }

  /** One poll. Never throws: every failure keeps the list it already had. */
  async refresh(): Promise<void> {
    if (!this.enabled) return;
    try {
      const headers: Record<string, string> = { accept: "application/json" };
      if (this.etag) headers["if-none-match"] = this.etag;
      const res = await this.fetchImpl(this.url, {
        headers,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (res.status === 304) return;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const payload = await res.json();
      if (!this.accept(payload, res.headers.get("etag"))) throw new Error("malformed blocklist");
      this.persist(payload);
    } catch (err) {
      const kept = this.list ? `keeping version ${this.list.version}` : "no list loaded";
      this.warn(`[takedown] blocklist fetch failed (${kept}): ${err}`);
    }
  }

  /** Load the persisted copy, poll now, then poll on an interval. */
  start(intervalMs = BLOCKLIST_POLL_MS): () => void {
    if (!this.enabled) return () => {};
    this.loadPersisted();
    void this.refresh();
    const timer = setInterval(() => void this.refresh(), intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  /** Why this source is refused, or null when it is not. */
  check(source: { input: string; name?: string | null }): TakedownBlockedError | null {
    if (!this.enabled || !this.list) return null;
    for (const hash of infoHashesOf(source.input)) {
      if (this.list.hashes.has(hash)) return new TakedownBlockedError("hash");
    }
    for (const name of [source.name, magnetDisplayName(source.input)]) {
      if (!name) continue;
      const normalized = normalizeRelease(name);
      if (normalized && this.list.releases.has(normalized)) {
        return new TakedownBlockedError("release");
      }
    }
    return null;
  }

  private persist(payload: unknown): void {
    if (!this.statePath) return;
    try {
      fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
      const tmp = `${this.statePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(payload));
      fs.renameSync(tmp, this.statePath);
    } catch (err) {
      this.warn(`[takedown] could not persist ${this.statePath}: ${err}`);
    }
  }
}

const STATE_PATH = path.join(import.meta.dir, "..", "data", "takedown-blocklist.json");

/**
 * The process-wide list. Under `bun test` it keeps nothing on disk, and nothing
 * polls until `index.ts` calls `start()`.
 */
export const takedown = new TakedownList({
  url: process.env.DMM_BLOCKLIST_URL ?? DEFAULT_BLOCKLIST_URL,
  statePath: process.env.NODE_ENV === "test" ? null : STATE_PATH,
});

/** Throw when a job's source or release name is on the list. */
export function assertNotTakenDown(job: { input: string; name?: string | null }): void {
  const blocked = takedown.check(job);
  if (blocked) throw blocked;
}
