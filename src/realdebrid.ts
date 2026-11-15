import fs from "node:fs";
import { MissingCredentialError } from "./credentials";
import { counters } from "./metrics";
import { type AccountBlockOptions, RdRefusalError, throughAccountBlock } from "./rd-account-block";
import { sleep } from "./utils/async";

const API = "https://api.real-debrid.com/rest/1.0";

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export type RdOptions = {
  fetcher?: Fetcher;
  /** Per-job RD key; falls back to the shared env key when absent. */
  apiKey?: string;
  /** Backoff between transient-failure retries. Real `sleep` in prod, a no-op in tests. */
  sleepFor?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /**
   * The RD account behind `apiKey` (`rd:67890`), when the job resolved it. Keys
   * the hold on adds after a 451; see `rd-account-block.ts`.
   */
  account?: string;
};

/**
 * Options for `addTorrent`/`addMagnet`, which ride out an account-wide 451
 * block rather than taking it as a verdict. See `rd-account-block.ts`.
 */
export type RdAddOptions = RdOptions & AccountBlockOptions;

/**
 * There is no operator fallback here by design: a job without its own key must
 * fail loudly rather than quietly land content in the operator's account. The
 * submission layer already refuses those, so reaching this throw means a job row
 * predating that rule was resumed.
 */
function headers(opts: RdOptions = {}) {
  if (!opts.apiKey) throw new MissingCredentialError("Real-Debrid");
  return { Authorization: `Bearer ${opts.apiKey}` };
}

export const RD_RETRY_ATTEMPTS = 5;
export const RD_RETRY_BASE_MS = 500;
export const RD_RETRY_MAX_MS = 8000;

/**
 * A 429 or any 5xx is RD momentarily unhappy, not refusing — worth another try.
 *
 * So is one specific 404. A torrent RD has just accepted is briefly not yet
 * addressable: `addTorrent` returns a valid id, but `selectFiles` on it answers
 * `404 {"error":"unknown_ressource","error_code":7}` until RD has registered it.
 * Treating that as permanent loses the whole `preparing` stage to a race we
 * created by asking too soon. Matched on RD's own (misspelled) error string,
 * which is stabler than its whitespace.
 *
 * A 451 is not here even though it is usually transient too: on an add it is
 * mostly an account block of 21 s to ~5 min, and this ladder's ~15 s would fire
 * five more adds into it. `rd-account-block.ts` waits those out on their own
 * ladder, for adds only.
 */
function isTransient(status: number, body: string): boolean {
  if (status === 429 || status >= 500) return true;
  return status === 404 && body.includes("unknown_ressource");
}

function backoffMs(attempt: number): number {
  return Math.min(RD_RETRY_BASE_MS * 2 ** (attempt - 1), RD_RETRY_MAX_MS);
}

/**
 * One RD request plus the retry policy. A transient failure — a network throw,
 * a 429, or any 5xx — is retried with exponential backoff rather than surfaced
 * as a hard error: RD's API blips, and a single blip must not fail a job, least
 * of all mid-poll during a multi-hour download, where `uploading` has only two
 * stage retries to spend. A permanent 4xx is thrown at once, since retrying it
 * only burns time.
 */
async function request(
  url: string,
  init: RequestInit | undefined,
  label: string,
  opts: RdOptions,
): Promise<Response> {
  const fetcher = opts.fetcher ?? fetch;
  const sleepFor = opts.sleepFor ?? sleep;

  for (let attempt = 1; ; attempt++) {
    const last = attempt === RD_RETRY_ATTEMPTS;
    counters.inc("rd.calls");
    counters.inc(`rd.call_${label}`);
    let res: Response;
    try {
      res = await fetcher(url, init);
    } catch (err) {
      counters.inc("rd.network_throws");
      if (last) {
        counters.inc("rd.gave_up");
        throw new Error(`RD ${label} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      counters.inc("rd.retries");
      await sleepFor(backoffMs(attempt));
      continue;
    }

    if (res.ok) return res;
    const body = await res.text();
    if (!last && isTransient(res.status, body)) {
      counters.inc("rd.transient");
      if (res.status === 404) counters.inc("rd.not_yet_registered");
      counters.inc("rd.retries");
      await sleepFor(backoffMs(attempt));
      continue;
    }
    counters.inc("rd.gave_up");
    // Classify what the ladder has finished with, so the caller can tell a
    // permanently broken job from a bad minute. `monitorRd` rides out a failed
    // poll rather than killing a live download — right in general, but it used
    // to absorb *every* error that way, so a revoked token or a torrent RD had
    // lost spent the whole five-minute stall window and then reported
    // `uploading stalled` as its cause. Of 16 failures sampled on 2026-08-08,
    // 3 were a dead token and 6 a missing torrent; all were recorded as stalls.
    if (res.status === 401 || res.status === 403) throw new RdAuthError(res.status, body);
    // Any 404 still here means RD does not have the resource: an
    // `unknown_ressource` body has already survived the whole ladder (the
    // post-`addTorrent` race resolves inside it), and any other 404 was never
    // retried because it was never transient. Discriminating on the *status*
    // rather than the body is also what `nzb2rd` had to do — the same condition
    // comes back from `selectFiles` worded as `parameter_missing`.
    if (res.status === 404) throw new RdMissingTorrentError(body);
    // Typed so the add calls can tell it apart; the message is unchanged.
    if (res.status === 451) throw new RdRefusalError(label, body);
    throw new Error(`RD ${label} failed: ${res.status} ${body}`);
  }
}

/** The submitter's RD key is rejected. Retrying cannot fix a revoked token. */
export class RdAuthError extends Error {
  constructor(status: number, body: string) {
    super(`RD credentials rejected: ${status} ${body}`);
    this.name = "RdAuthError";
  }
}

/**
 * The torrent RD was working on is gone from the account.
 *
 * Observed live across six unrelated accounts. Retrying the `uploading` stage
 * cannot help: it re-monitors the same `rd_torrent_id`, which will 404 again.
 */
export class RdMissingTorrentError extends Error {
  constructor(body: string) {
    super(`RD torrent no longer exists: ${body}`);
    this.name = "RdMissingTorrentError";
  }
}

/** Errors no amount of waiting or retrying will clear. */
export function isPermanentRdError(err: unknown): boolean {
  return err instanceof RdAuthError || err instanceof RdMissingTorrentError;
}

export async function addTorrent(torrentPath: string, opts: RdAddOptions = {}): Promise<string> {
  const fileData = fs.readFileSync(torrentPath);
  return throughAccountBlock(async () => {
    const res = await request(
      `${API}/torrents/addTorrent`,
      {
        method: "PUT",
        headers: { ...headers(opts), "Content-Type": "application/octet-stream" },
        body: fileData,
      },
      "addTorrent",
      opts,
    );
    const data = (await res.json()) as { id: string };
    return data.id;
  }, opts);
}

export async function selectFiles(
  torrentId: string,
  fileIds?: number[],
  opts: RdOptions = {},
): Promise<void> {
  await request(
    `${API}/torrents/selectFiles/${torrentId}`,
    {
      method: "POST",
      headers: { ...headers(opts), "Content-Type": "application/x-www-form-urlencoded" },
      body: fileIds ? `files=${fileIds.join(",")}` : "files=all",
    },
    "selectFiles",
    opts,
  );
}

const RD_STREAMABLE_EXTENSIONS = new Set([
  ".avi",
  ".flv",
  ".m2ts",
  ".m4v",
  ".mkv",
  ".mov",
  ".mp4",
  ".mpg",
  ".mpeg",
  ".ts",
  ".webm",
  ".wmv",
  ".mp3",
  ".flac",
  ".m4a",
]);

export function isRdStreamable(filePath: string): boolean {
  return RD_STREAMABLE_EXTENSIONS.has(`.${filePath.toLowerCase().split(".").pop()}`);
}

export type TorrentInfo = {
  id: string;
  status: string;
  progress: number;
  filename: string;
  speed: number;
  seeders: number;
  links: string[];
  files: { id: number; path: string; bytes: number; selected: number }[];
  /** Present on `/torrents` list rows and on info; lower-cased by RD. */
  hash?: string;
};

/**
 * Find a release the account already holds, by info hash.
 *
 * Checked before adding anything, for two reasons. RD has no by-hash lookup and
 * `addMagnet` does not deduplicate — it creates a second torrent for content the
 * account already has, and that duplicate then sits at 0% forever because RD
 * stalls on duplicate content. And a release the submitter already owns is one
 * we must not later delete, which `rdSourceTorrentId` depends on knowing.
 *
 * Only a `downloaded` torrent counts: one still fetching has no usable links
 * yet, and treating it as a source would hand the proxy a half-empty file.
 */
export async function findTorrentByHash(
  hash: string,
  opts: RdOptions = {},
): Promise<TorrentInfo | undefined> {
  const res = await request(
    `${API}/torrents?limit=${RD_LIST_LIMIT}`,
    { headers: headers(opts) },
    "listTorrents",
    opts,
  );
  const rows = (await res.json()) as TorrentInfo[];
  const wanted = hash.toLowerCase();
  return rows.find((t) => t.hash?.toLowerCase() === wanted && t.status === "downloaded");
}

/** How much of the account's torrent list to search for an existing release. */
const RD_LIST_LIMIT = 200;

export async function addMagnet(magnetUri: string, opts: RdAddOptions = {}): Promise<string> {
  return throughAccountBlock(async () => {
    const res = await request(
      `${API}/torrents/addMagnet`,
      {
        method: "POST",
        headers: { ...headers(opts), "Content-Type": "application/x-www-form-urlencoded" },
        body: `magnet=${encodeURIComponent(magnetUri)}`,
      },
      "addMagnet",
      opts,
    );
    const data = (await res.json()) as { id: string };
    return data.id;
  }, opts);
}

/**
 * Turn a restricted `real-debrid.com/d/…` link into a direct, ranged URL.
 *
 * The result supports ranges but is account-specific and valid for seven days.
 * RD tracks download IPs even when another IP gets a successful response;
 * cross-IP success is not permission to share. Mint and consume from the
 * account's single egress host (or use RD's client-IP parameter where applicable).
 */
export async function unrestrictLink(link: string, opts: RdOptions = {}): Promise<string> {
  const res = await request(
    `${API}/unrestrict/link`,
    {
      method: "POST",
      headers: { ...headers(opts), "Content-Type": "application/x-www-form-urlencoded" },
      body: `link=${encodeURIComponent(link)}`,
    },
    "unrestrictLink",
    opts,
  );
  const data = (await res.json()) as { download?: string };
  if (!data.download) throw new Error("RD unrestrict returned no download link");
  return data.download;
}

/**
 * Remove a torrent from the account.
 *
 * Only ever called for a torrent this service added — see `getRdSourceTorrentId`.
 * A 404 is success: something else already removed it, and turning that into a
 * failure would fail a job over cleanup of a thing that is already gone.
 */
export async function deleteTorrent(torrentId: string, opts: RdOptions = {}): Promise<void> {
  try {
    await request(
      `${API}/torrents/delete/${torrentId}`,
      { method: "DELETE", headers: headers(opts) },
      "deleteTorrent",
      opts,
    );
  } catch (err) {
    if (err instanceof RdMissingTorrentError) return;
    throw err;
  }
}

/** Identity of the account a key belongs to, for the per-user job limit. */
export type RdUser = {
  id: number;
  username: string;
};

/**
 * Who owns this key.
 *
 * Used to scope the concurrent-job limit to an account rather than to a key, so
 * that rotating a key — or submitting the same account's key twice — cannot be
 * used to get a second slot. Goes through the ordinary retry policy: a blip here
 * would otherwise reject a submission outright.
 */
export async function getUser(opts: RdOptions = {}): Promise<RdUser> {
  const res = await request(`${API}/user`, { headers: headers(opts) }, "getUser", opts);
  return (await res.json()) as RdUser;
}

export async function getTorrentInfo(
  torrentId: string,
  opts: RdOptions = {},
): Promise<TorrentInfo> {
  const res = await request(
    `${API}/torrents/info/${torrentId}`,
    { headers: headers(opts) },
    "getTorrentInfo",
    opts,
  );
  return (await res.json()) as TorrentInfo;
}
