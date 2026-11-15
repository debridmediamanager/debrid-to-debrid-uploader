import fs from "node:fs";
import path from "node:path";
import { MissingCredentialError } from "./credentials";
import { counters } from "./metrics";
import { torboxFetch } from "./torbox-http";

const API = "https://api.torbox.app/v1/api";

/**
 * Per-call TorBox credentials, required with no operator fallback.
 *
 * REST uses the key as a bearer token; WebDAV uses the fixed username `torbox`
 * with that same key as its Basic-auth password (see `proxy.ts`).
 */
export type TorboxOptions = {
  apiKey?: string;
};

/** No operator fallback — see the note on `headers` in `realdebrid.ts`. */
function keyFor(opts: TorboxOptions): string {
  if (!opts.apiKey) throw new MissingCredentialError("TorBox");
  return opts.apiKey;
}

function headers(opts: TorboxOptions) {
  return { Authorization: `Bearer ${keyFor(opts)}` };
}

/** Identity of the account a key belongs to, for the per-user job limit. */
export type TorboxUser = {
  id: number;
};

/**
 * Who owns this key.
 *
 * The counterpart to `rd.getUser`, and scoped to an account for the same reason:
 * TorBox *rotates the API key on every abuse warning*, so a limit keyed on the
 * key itself would silently reset exactly when it matters most.
 */
export async function getCurrentUser(opts: TorboxOptions = {}): Promise<TorboxUser> {
  const res = await torboxFetch(`${API}/user/me`, { headers: headers(opts) });
  if (!res.ok) throw new Error(`TorBox user lookup failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { data?: { id?: number; plan?: number } };
  const id = data.data?.id;
  // A 200 carrying no id is TorBox's `success: false` shape in another costume;
  // returning `undefined` here would make every account share one owner string.
  if (typeof id !== "number") throw new Error("TorBox user lookup returned no id");
  if (data.data?.plan === 0) throw new PlanRestrictedError("A paid TorBox plan is required");
  return { id };
}

export async function createDownload(
  magnetUri: string,
  opts: TorboxOptions = {},
): Promise<{ id: number; hash: string }> {
  const body = new FormData();
  body.append("magnet", magnetUri);

  const res = await torboxFetch(`${API}/torrents/createtorrent`, {
    method: "POST",
    headers: headers(opts),
    body,
  });

  if (res.status === 429) {
    throw new RateLimitError("TorBox rate limited");
  }
  if (!res.ok) {
    const body = await res.text();
    if (isPlanRestricted(res.status, body)) throw new PlanRestrictedError(body);
    throw new Error(`TorBox create failed: ${res.status} ${body}`);
  }

  const data = (await res.json()) as {
    success: boolean;
    data: { torrent_id: number; hash: string };
  };
  if (!data.success) throw new Error("TorBox create returned success=false");
  return { id: data.data.torrent_id, hash: data.data.hash };
}

/**
 * Hand TorBox a rewritten `.torrent` and let its client fetch our webseed.
 *
 * This is the reverse direction, and it works because **TorBox honours BEP19**.
 * Measured 2026-08-16 against a negative control: an identical torrent carrying
 * no `url-list` goes to `stalled (no seeds)` and stays at 0, while the one with
 * a webseed completes — its client (`qBittorrent/5.1.4`) pulls the file in 16 MiB
 * ranges, and composes `<url-list><info.name>/<path>` correctly for multi-file.
 *
 * `seed: 3` is "do not seed". Seeding is outgoing traffic, billed at full file
 * size against the rolling threshold whose fourth strike is a permanent ban, and
 * the submitter asked for a copy in their account, not to become a seeder.
 *
 * Note every torrent sent here is **uncached by construction** — the rewrite
 * gives it a fresh info hash — so this call is on TorBox's 60/hour uncached
 * `createtorrent` budget rather than the 300/min one.
 */
export async function createTorrentFromFile(
  torrentPath: string,
  opts: TorboxOptions = {},
): Promise<{ id: number; hash: string }> {
  const body = new FormData();
  body.append("file", new Blob([fs.readFileSync(torrentPath)]), path.basename(torrentPath));
  body.append("seed", "3");

  const res = await torboxFetch(`${API}/torrents/createtorrent`, {
    method: "POST",
    headers: headers(opts),
    body,
  });

  if (res.status === 429) throw new RateLimitError("TorBox rate limited");
  if (!res.ok) {
    const text = await res.text();
    if (isPlanRestricted(res.status, text)) throw new PlanRestrictedError(text);
    throw new Error(`TorBox createtorrent failed: ${res.status} ${text}`);
  }

  const data = (await res.json()) as {
    success: boolean;
    detail?: string;
    data?: { torrent_id: number; hash: string };
  };
  // The same trap as `deleteTorrent`: TorBox reports logical failure as HTTP 200
  // with `success: false`, so the status alone would have us monitor an id that
  // does not exist for the whole uploading stage before failing as a stall.
  if (!data.success || !data.data) {
    throw new Error(`TorBox createtorrent rejected: ${data.detail ?? "success=false"}`);
  }
  return { id: data.data.torrent_id, hash: data.data.hash };
}

export type TorboxTorrentInfo = {
  id: number;
  hash: string;
  name: string;
  download_state: string;
  progress: number;
  files: { id: number; name: string; size: number }[];
};

export async function getTorrentInfo(
  id: number,
  opts: TorboxOptions = {},
): Promise<TorboxTorrentInfo> {
  // **`bypass_cache=true` is not optional here.** TorBox caches `mylist`
  // server-side, and without this the monitor can watch a stale snapshot
  // indefinitely: observed live on a completed 12.4 GB transfer that kept
  // reading back `downloading 79%` for minutes after the last byte had been
  // served, with no error to notice — so the job could only ever end by stalling
  // out, and a stalled destination job deletes the copy it just delivered.
  const res = await torboxFetch(`${API}/torrents/mylist?id=${id}&bypass_cache=true`, {
    headers: headers(opts),
  });
  if (!res.ok) throw new Error(`TorBox info failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { data: TorboxTorrentInfo | null; detail?: string };
  // A 200 carrying no row is TorBox's `success: false` shape again, and it is
  // the *normal* answer once a finished, non-seeding torrent has been dropped
  // from the list — `mylist?id=` then returns `DATABASE_ERROR` forever. Throwing
  // something explicit lets `monitorTorboxDestination` ask the cache whether the
  // content actually arrived, instead of reading a `TypeError` off `undefined`.
  if (!data.data) throw new TorboxTorrentGoneError(id, data.detail);
  return data.data;
}

/**
 * TorBox no longer lists this torrent.
 *
 * Not an error in itself: TorBox drops the row once a transfer is finished and
 * not seeding, so this is what *success* looks like from the id endpoint.
 */
export class TorboxTorrentGoneError extends Error {
  constructor(id: number, detail?: string) {
    super(`TorBox no longer lists torrent ${id}: ${detail ?? "no data"}`);
    this.name = "TorboxTorrentGoneError";
  }
}

export async function checkCached(hash: string, opts: TorboxOptions = {}): Promise<boolean> {
  const res = await torboxFetch(`${API}/torrents/checkcached?hash=${hash}&format=list`, {
    headers: headers(opts),
  });
  if (res.status === 429) throw new RateLimitError("TorBox rate limited");
  if (!res.ok) throw new Error(`TorBox cache check failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as {
    success?: boolean;
    detail?: string;
    data: { size: number }[] | null;
  };
  if (data.success === false) {
    throw new Error(`TorBox cache check rejected: ${data.detail ?? "success=false"}`);
  }
  return Array.isArray(data.data) && data.data.some((item) => item.size > 0);
}

/**
 * Free the active slot this torrent is holding.
 *
 * TorBox Pro allows ten active slots, and a torrent occupies one for as long as
 * it is downloading *or* seeding — up to 30 days on a paid plan. A cached add
 * takes a slot too. Without this the slots fill permanently and every later
 * `createDownload` starts failing.
 *
 * Deleting also stops TorBox seeding the release onward. That is outgoing
 * traffic, billed at full file size against the rolling bandwidth threshold
 * whose fourth strike is a permanent ban with the API key revoked, so the slot
 * is only half the reason to call this.
 */
export async function deleteTorrent(id: number, opts: TorboxOptions = {}): Promise<void> {
  const res = await torboxFetch(`${API}/torrents/controltorrent`, {
    method: "POST",
    headers: { ...headers(opts), "Content-Type": "application/json" },
    body: JSON.stringify({ torrent_id: id, operation: "delete" }),
  });
  const body = await res.text();
  if (!res.ok) {
    counters.inc("torbox.delete_failures");
    throw new Error(`TorBox delete failed: ${res.status} ${body}`);
  }
  // A logical failure comes back as HTTP 200 with `success: false` — observed
  // as `{"success":false,...,"detail":"DATABASE_ERROR"}`. Checking only the
  // status would count a leaked slot as a released one, which is precisely the
  // failure this function exists to prevent, and it would be invisible.
  let ok = true;
  try {
    ok = (JSON.parse(body) as { success?: boolean }).success !== false;
  } catch {
    // A non-JSON 2xx is unusual but not evidence of failure; take the status.
  }
  if (!ok) {
    counters.inc("torbox.delete_failures");
    throw new Error(`TorBox delete rejected: ${body}`);
  }
  counters.inc("torbox.deletes");
}

export async function requestDownloadLink(
  torrentId: number,
  fileId?: number,
  opts: TorboxOptions = {},
): Promise<string> {
  const params = new URLSearchParams({ token: keyFor(opts), torrent_id: String(torrentId) });
  if (fileId !== undefined) params.set("file_id", String(fileId));

  const res = await torboxFetch(`${API}/torrents/requestdl?${params}`);
  if (res.status === 429) throw new RateLimitError("TorBox rate limited");
  if (!res.ok) throw new Error(`TorBox requestdl failed: ${res.status} ${await res.text()}`);

  const data = (await res.json()) as { data: string };
  return data.data;
}

/**
 * The submitter's TorBox account has no paid plan, so the API is closed to it.
 *
 * Observed as `403 {"error":"PLAN_RESTRICTED_FEATURE","detail":"API feature not
 * available on your plan..."}` from `createtorrent`. `user/me` and `checkcached`
 * still work on free accounts. Submission rejects a definite free plan; this
 * error also covers jobs already queued or whose submit-time lookup failed.
 *
 * **Terminal, like `UncachedError`.** A plan does not change during a retry
 * ladder, so the three attempts return the same 403 several seconds apart and
 * spend one of the ten concurrency slots doing it. Six jobs burned their full
 * ladder this way in the twelve hours after 2026-08-07. It is still thrown
 * rather than swallowed, so `downloads.ts` can hand off to AllDebrid if the
 * submitter also supplied a key for it — only a job with nowhere left to go
 * reaches `retryOrFail` and fails on sight.
 */
export class PlanRestrictedError extends Error {
  constructor(body: string) {
    super(`TorBox plan does not permit API access: ${body}`);
    this.name = "PlanRestrictedError";
  }
}

/** TorBox reports this as a 403 whose body names the restriction. */
function isPlanRestricted(status: number, body: string): boolean {
  return status === 403 && body.includes("PLAN_RESTRICTED_FEATURE");
}

export class RateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateLimitError";
  }
}
