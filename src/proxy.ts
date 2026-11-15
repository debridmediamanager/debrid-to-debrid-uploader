import fs from "node:fs";
import * as alldebrid from "./alldebrid";
import { config } from "./config";
import { MissingCredentialError } from "./credentials";
import {
  type Destination,
  deleteProxySession,
  getJobAlldebridApiKey,
  getJobDestination,
  getJobRealdebridApiKey,
  getJobTorboxApiKey,
  getProxyMappings,
  insertProxyMappings,
  type ProxyOrigin,
  type ProxySource,
  proxySourceOf,
  setJobSource,
} from "./db";
import { counters } from "./metrics";
import { QbitClient } from "./qbittorrent";
import * as rd from "./realdebrid";
import * as torbox from "./torbox";
import { torboxInit } from "./torbox-http";
import { sleep } from "./utils/async";

const WEBDAV_BASE = "https://webdav.torbox.app";
/**
 * TorBox's WebDAV host takes the API key as the Basic-auth password under this
 * fixed username — its documented scheme, and the same key the REST client
 * uses, so one credential covers both halves of the TorBox path.
 *
 * It also accepts the account email as the username, and measured 2026-08-04
 * it does *not* validate the password on that path at all: any string
 * authenticates and serves the full library. Do not reach for that; it is a
 * TorBox bug, not an interface, and `torbox:<key>` is the form where the key is
 * actually checked (a wrong key 401s).
 */
const WEBDAV_USER = "torbox";
/**
 * Range expansion when the bytes are already on local disk. Nothing is paid per
 * byte there, so the only effect of a large window is fewer round trips — this
 * is the number the service has always used and there is no reason to shrink
 * it. The metered TorBox path uses `config.torboxChunkSize` instead; see the
 * comment there.
 */
export const DISK_CHUNK_SIZE = 64 * 1024 * 1024;
const QBIT_PRIORITY_MAX = 7;

const qbit = new QbitClient();

export type ProxyMapping = {
  rewrittenPath: string;
  webdavPath: string;
  size: number;
  qbitFileIndex?: number;
  /** TorBox's file id, needed to mint a CDN link for the redirect path. */
  torboxFileId?: number;
  /** AllDebrid's locked `alldebrid.com/f/…` link for this file. */
  adLink?: string;
  /** Real-Debrid's restricted `real-debrid.com/d/…` link for this file. */
  rdLink?: string;
};

/**
 * Cached `requestdl` links, keyed `torrentId:fileId`.
 *
 * Minting one per range would exhaust the endpoint's 100/min API budget.
 * Lifetime is unmeasured; 45 minutes is a cache policy, not an expiry claim.
 * Stale 400/404 delivery responses evict and re-mint once before WebDAV.
 */
const cdnLinks = new Map<
  string,
  { url: string | null; expiresAt: number; failures: number; dbErrors: number }
>();
const CDN_LINK_TTL_MS = 45 * 60_000;
// A failed mint is cached too (url null), or every RD range read asks again:
// one job sent 7,783 failed requestdl calls on the user's key (2026-10-24).
// Retries back off 30 s, doubling to 10 min. DATABASE_ERROR recovered 16 s
// after a fresh add (2026-11-14), so only a persisting one ends CDN use.
const CDN_MINT_BACKOFF_MS = 30_000;
const CDN_MINT_BACKOFF_CAP_MS = 10 * 60_000;
const CDN_MINT_GONE_AFTER = 4;
let cdnMints = new Map<string, Promise<string | null>>();

/** TorBox's global edges, which unlike a `nexus-NNN` node survive concurrency. */
const CDN_EDGE_HOSTS: Record<string, string> = {
  erth: "nexus.erth.tb-cdn.earth",
  hare: "nexus.hare.tb-cdn.earth",
};

/**
 * Point a minted link at a global edge, when one is configured.
 *
 * The path and token are what authenticate the request, and both edges serve
 * any file in the account, so only the host changes. Unknown names are dropped
 * rather than guessed at, and an empty result leaves the link untouched.
 *
 * Accepts a comma-separated list (`erth,hare`), picking one at random per mint.
 * Links are cached per file, so a multi-file release spreads its files across
 * both edges instead of concentrating every stream on one — and neither edge
 * becomes a single point of failure. The two measured indistinguishable under
 * concurrency (12/12 at ~35 MB/s each).
 */
export function applyCdnEdge(url: string): string {
  const hosts = config.torboxCdnEdge
    .split(",")
    .map((name) => CDN_EDGE_HOSTS[name.trim()])
    .filter((host): host is string => Boolean(host));
  if (hosts.length === 0) return url;
  const host = hosts.length === 1 ? hosts[0] : hosts[Math.floor(Math.random() * hosts.length)];
  return url.replace(/^(https?:\/\/)[^/]+\//, `$1${host}/`);
}

/** Test seam: reach the live session map to simulate a restart. */
export function sessionsForTest(): Map<string, ProxySession> {
  return sessions;
}

/** Test seam: drop cached links so a test can control what gets minted. */
export function _clearCdnLinks(): void {
  cdnLinks.clear();
  cdnMints = new Map();
}

type SessionFile = {
  webdavPath: string;
  size: number;
  qbitFileIndex?: number;
  torboxFileId?: number;
  adLink?: string;
  rdLink?: string;
};

type ProxySession = {
  source: ProxySource;
  torboxTorrentId: number;
  files: Map<string, SessionFile>;
  requestCount: number;
  /** Bytes handed to RD, for the amplification figure logged at completion. */
  servedBytes: number;
  /**
   * Bytes pulled *in* from the provider, the other half of "is this job moving
   * any traffic at all". Zero on the qBittorrent path, which reads from local
   * disk and so has no inbound network to measure — there `servedBytes` alone
   * carries the signal.
   */
  upstreamBytes: number;
  /** Total size of the payload RD is fetching, the denominator of that figure. */
  payloadBytes: number;
  /**
   * Per file, the furthest end offset RD has been served, as a high-water mark.
   *
   * Distinct from `servedBytes`, and the difference is the whole point: a job
   * wedged on its last piece re-requests the *same* range forever, so
   * `servedBytes` climbs steadily while nothing actually advances. This only
   * moves when RD reaches ground it has not covered, which makes it the one
   * honest liveness signal the stall detector can use (`worker.ts` `monitorRd`).
   */
  reachedBytes: Map<string, number>;
  qbitHash?: string;
  /**
   * This job's own TorBox key, when it was submitted with one. Held on the
   * session rather than looked up per request: RD makes a great many range
   * requests against one session and they all resolve to the same account.
   */
  torboxApiKey?: string;
  /** Likewise for AllDebrid, used to unlock this session's file links. */
  alldebridApiKey?: string;
  /** Likewise for Real-Debrid, used to unrestrict this session's file links. */
  realdebridApiKey?: string;
  /**
   * Where this job's bytes are going, because it decides whether the range
   * expansion is safe — see `expandedEndFor`.
   */
  destination: Destination;
};

const sessions = new Map<string, ProxySession>();

/** True when this job's bytes come from a remote upstream rather than disk. */
function isMetered(session: ProxySession): boolean {
  return session.source !== "qbit";
}

/**
 * How far to expand RD's range, decided by what the bytes cost to produce.
 *
 * Three different answers because the economics differ: local disk is free so
 * it takes the widest window, TorBox bills every byte against a ban threshold
 * so it takes the narrowest, and AllDebrid sits in between — unlimited, but the
 * surplus still crosses this host's NIC twice.
 */
export function chunkSizeFor(session: ProxySession): number {
  if (session.source === "qbit") return DISK_CHUNK_SIZE;
  if (session.source === "alldebrid") return config.alldebridChunkSize;
  if (session.source === "realdebrid") return config.realdebridChunkSize;
  return config.torboxChunkSize;
}

/**
 * Note that RD has been served up to `endExclusive` of `filePath`.
 *
 * Monotone per file: a re-request of ground already covered leaves it alone,
 * which is exactly what lets `proxyReachedBytes` distinguish real progress from
 * a job spinning on one range.
 */
function recordReach(session: ProxySession, filePath: string, endExclusive: number): void {
  const seen = session.reachedBytes.get(filePath) ?? 0;
  if (endExclusive > seen) session.reachedBytes.set(filePath, endExclusive);
}

/**
 * How far RD has actually got across every file of a job, in bytes.
 *
 * `undefined` when there is no session — the job has not reached the proxy yet,
 * which the caller must not read as "no progress".
 */
export function proxyReachedBytes(jobId: string): number | undefined {
  const session = sessions.get(jobId);
  if (!session) return undefined;
  let total = 0;
  for (const reached of session.reachedBytes.values()) total += reached;
  return total;
}

/** Serving totals for a job, for the completion log. */
export function proxyStats(
  jobId: string,
):
  | { requests: number; servedBytes: number; upstreamBytes: number; payloadBytes: number }
  | undefined {
  const session = sessions.get(jobId);
  if (!session) return undefined;
  return {
    requests: session.requestCount,
    servedBytes: session.servedBytes,
    upstreamBytes: session.upstreamBytes,
    payloadBytes: session.payloadBytes,
  };
}

/**
 * Everything about a session that is not per-file.
 *
 * `source` may be omitted, in which case it is inferred from `torboxTorrentId`
 * on the pre-AllDebrid rule (-1 is qBittorrent). That keeps the many existing
 * two-source call sites reading naturally while making the AllDebrid path state
 * its origin explicitly.
 */
export type ProxySessionOrigin = ProxyOrigin & {
  torboxApiKey?: string;
  alldebridApiKey?: string;
  realdebridApiKey?: string;
  destination?: Destination;
};

export function registerProxySession(
  jobId: string,
  torboxTorrentId: number,
  mappings: ProxyMapping[],
  origin: ProxySessionOrigin = {},
): void {
  const files = filesByRewrittenPath(mappings);
  const source =
    origin.source ?? proxySourceOf({ source: null, torbox_torrent_id: torboxTorrentId });
  sessions.set(jobId, {
    source,
    torboxTorrentId,
    files,
    requestCount: 0,
    servedBytes: 0,
    upstreamBytes: 0,
    payloadBytes: mappings.reduce((sum, m) => sum + m.size, 0),
    reachedBytes: new Map(),
    qbitHash: origin.qbitHash,
    torboxApiKey: origin.torboxApiKey,
    alldebridApiKey: origin.alldebridApiKey,
    realdebridApiKey: origin.realdebridApiKey,
    destination: origin.destination ?? "rd",
  });
  insertProxyMappings(
    jobId,
    torboxTorrentId,
    mappings.map((m) => ({
      rewrittenPath: m.rewrittenPath,
      webdavPath: m.webdavPath,
      size: m.size,
      qbitFileIndex: m.qbitFileIndex,
      // Must be persisted, not just held in memory: a session rehydrated after
      // a restart reads its file ids from here, and without them the CDN
      // upstream silently degrades to WebDAV for the rest of the job.
      torboxFileId: m.torboxFileId,
      // Same reasoning for AllDebrid: without the locked link a rehydrated
      // session has nothing to unlock and every range 502s. And the same again
      // for Real-Debrid's restricted link.
      adLink: m.adLink,
      rdLink: m.rdLink,
    })),
    {
      source,
      qbitHash: origin.qbitHash,
      adMagnetId: origin.adMagnetId,
      rdSourceTorrentId: origin.rdSourceTorrentId,
    },
  );
  // Also on the job row, which outlives these mappings: `removeProxySession`
  // drops them when the job finishes, and a finished job is exactly when a
  // caller wants to know which provider its bytes came from.
  setJobSource(jobId, source);
}

export function removeProxySession(jobId: string): void {
  sessions.delete(jobId);
  deleteProxySession(jobId);
}

export function getProxySession(jobId: string): ProxySession | undefined {
  const cached = sessions.get(jobId);
  if (cached) return cached;

  const rows = getProxyMappings(jobId);
  if (rows.length === 0) return undefined;

  const files = filesByRewrittenPath(
    rows.map((row) => ({
      rewrittenPath: row.rewritten_path,
      webdavPath: row.webdav_path,
      size: row.file_size,
      qbitFileIndex: row.qbit_file_index ?? undefined,
      torboxFileId: row.torbox_file_id ?? undefined,
      adLink: row.ad_link ?? undefined,
      rdLink: row.rd_link ?? undefined,
    })),
  );
  let torboxTorrentId = 0;
  let qbitHash: string | undefined;
  for (const row of rows) {
    torboxTorrentId = row.torbox_torrent_id;
    if (row.qbit_hash) qbitHash = row.qbit_hash;
  }
  // Rehydrating after a restart: the mappings survive in `proxy_sessions`, but
  // the key lives on the job row, so a resumed custom-key job would otherwise
  // fall back to the operator's account and 404 on every byte.
  const session: ProxySession = {
    source: proxySourceOf(rows[0]),
    torboxTorrentId,
    files,
    requestCount: 0,
    servedBytes: 0,
    upstreamBytes: 0,
    payloadBytes: rows.reduce((sum, row) => sum + row.file_size, 0),
    // Starts empty on a rehydrate, so a resumed job gets a fresh stall window
    // rather than being judged against ground it covered before the restart.
    reachedBytes: new Map(),
    qbitHash,
    torboxApiKey: getJobTorboxApiKey(jobId),
    alldebridApiKey: getJobAlldebridApiKey(jobId),
    // Same reason as the other two: a resumed job that read the operator's key
    // here would unrestrict against the wrong account and 401 on every byte.
    realdebridApiKey: getJobRealdebridApiKey(jobId),
    destination: getJobDestination(jobId),
  };
  sessions.set(jobId, session);
  return session;
}

function filesByRewrittenPath(mappings: ProxyMapping[]): Map<string, SessionFile> {
  const files = new Map<string, SessionFile>();
  for (const m of mappings) {
    files.set(m.rewrittenPath, {
      webdavPath: m.webdavPath,
      size: m.size,
      qbitFileIndex: m.qbitFileIndex,
      torboxFileId: m.torboxFileId,
      adLink: m.adLink,
      rdLink: m.rdLink,
    });
  }
  return files;
}

/**
 * Basic auth for the WebDAV fetch, preferring the job's own key.
 *
 * Same key the REST client authenticates with, so a job cannot end up creating
 * a torrent in one account and reading its bytes from another.
 */
function webdavAuth(session: ProxySession): string {
  const key = session.torboxApiKey;
  if (!key) throw new MissingCredentialError("TorBox");
  return `Basic ${Buffer.from(`${WEBDAV_USER}:${key}`).toString("base64")}`;
}

/**
 * Thrown when a source claims a release and then cannot serve its bytes.
 *
 * Distinct from a transport failure so `downloadJobFile` can hand off to the
 * next cached source, exactly as it does for any other source that claims a
 * release and then fails.
 */
export class UnservableSourceError extends Error {
  readonly status: number;

  constructor(source: string, status: number, path: string) {
    super(`${source} reports the release cached but serves ${status} for ${path}`);
    this.name = "UnservableSourceError";
    this.status = status;
  }
}

/**
 * Check that TorBox will actually serve the bytes it says it has.
 *
 * `checkcached` answering yes is not the same as the item existing on WebDAV.
 * Observed live 2026-08-09 on a UIndex release: TorBox reported
 * `download_state: "cached"`, `download_present: true`, `progress: 1`, and the
 * item never appeared among the WebDAV root's entries at all — nine minutes
 * after it was added. Every range RD asked for came back `404 There was no item
 * found at this path`, so RD never left 0%, and the job died five minutes later
 * as `uploading stalled: no progress for 5 minutes` — a message about the wrong
 * thing entirely, which is what made this expensive to diagnose.
 *
 * Run **before** `registerProxySession` so an unservable source can fall through
 * to AllDebrid without a stale session mapping. TorBox's returned id does not
 * prove creation, so neither this failure nor terminal cleanup deletes it.
 *
 * The largest file stands for the whole item, the one RD will actually pull.
 * Each file TorBox's own listing left out is probed as well: a mapping carrying
 * a `torboxFileId` key with no value is a path guessed from the original
 * torrent. TorBox does not keep a release's tracker ad files, and RD cannot
 * verify the piece they share with the video without them: on 2026-10-13 job
 * 470954d9 pulled all 8.4 GB of an mkv, then asked for `NEW upcoming releases
 * by Xclusive.txt` (71 bytes) for half an hour, got 404 every time, and died as
 * `uploading stalled`. 12 of the 27 stalls on debrid02 since 2026-09-20 had
 * that 404. Listed files are not probed; every probe is a round trip on the
 * critical path.
 *
 * **Probe the path the bytes will take.** With `TORBOX_UPSTREAM=cdn` every range
 * is served from a minted CDN link and WebDAV is only the fallback, yet this
 * probe read WebDAV alone. WebDAV lists a fresh cached add late: measured
 * 2026-11-04 over the 434 releases DMM's request board called cached, the CDN
 * link served 427 within seconds of the add while WebDAV served 15 inside the
 * 25 s grace, the rest after 18 s to minutes or not at all. So the probe failed
 * 412 servable releases as "cached but serves 404" — 705 jobs in the preceding
 * 30 days, one release 94 times for 59 different people. The largest file is
 * therefore read through its CDN link first and WebDAV second, in the order
 * `fetchUpstream` uses, and the link minted here is the one the first range
 * request reuses.
 */
export async function assertTorboxServable(
  jobId: string,
  mappings: { webdavPath: string; size: number; torboxFileId?: number }[],
  torboxApiKey: string | undefined,
  opts: {
    sleepFor?: (ms: number) => Promise<void>;
    graceMs?: number;
    /** The add this job made, needed to mint the largest file's CDN link. */
    torboxTorrentId?: number;
  } = {},
): Promise<void> {
  const biggest = mappings.reduce<(typeof mappings)[number] | undefined>(
    (best, m) => (best === undefined || m.size > best.size ? m : best),
    undefined,
  );
  if (!biggest) return;
  if (!torboxApiKey) throw new MissingCredentialError("TorBox");
  // Adds reuse held torrents, so a new attempt starts with a clean failure slate.
  for (const [key, link] of cdnLinks) {
    if (link.url === null && key.startsWith(`${opts.torboxTorrentId}:`)) cdnLinks.delete(key);
  }
  const cdnUrl =
    config.torboxUpstream === "cdn" &&
    opts.torboxTorrentId !== undefined &&
    biggest.torboxFileId !== undefined
      ? await mintCdnLink(jobId, opts.torboxTorrentId, biggest.torboxFileId, torboxApiKey)
      : null;
  await assertTorboxServesPath(jobId, biggest.webdavPath, torboxApiKey, opts, cdnUrl);
  const unlisted = mappings.filter(
    (m) => m !== biggest && "torboxFileId" in m && m.torboxFileId === undefined,
  );
  for (const m of unlisted) {
    await assertTorboxServesPath(jobId, m.webdavPath, torboxApiKey, opts, null);
  }
}

/** One byte from a CDN link: true when it serves, false on any refusal. */
async function cdnServesOneByte(jobId: string, cdnUrl: string): Promise<boolean> {
  let res: Response;
  try {
    res = await fetch(cdnUrl, torboxInit({ headers: { Range: "bytes=0-0" } }));
  } catch (err) {
    counters.inc("proxy.servable_cdn_unreachable");
    console.warn(`[torbox] job=${jobId} CDN probe could not run, trying WebDAV: ${err}`);
    return false;
  }
  // Never drain the body — a 200 to a ranged request carries the whole file.
  await res.body?.cancel();
  if (res.ok) return true;
  counters.inc(`proxy.servable_cdn_refused_${res.status}`);
  return false;
}

async function assertTorboxServesPath(
  jobId: string,
  webdavPath: string,
  torboxApiKey: string,
  opts: { sleepFor?: (ms: number) => Promise<void>; graceMs?: number },
  cdnUrl: string | null,
): Promise<void> {
  const headers = {
    Authorization: `Basic ${Buffer.from(`${WEBDAV_USER}:${torboxApiKey}`).toString("base64")}`,
    // One byte: enough to prove the path resolves, small enough to be free.
    Range: "bytes=0-0",
  };
  // **A fresh add is not in WebDAV immediately, and probing once loses that
  // race.** `createtorrent` answers `Found Cached Torrent` and returns an id,
  // but the item takes a few seconds to appear under the account's WebDAV root
  // — measured live on 2026-08-16: absent at 3s, present at 6s. The probe fired
  // ~2s after the add and 404'd a release that was perfectly servable, then all
  // three stage retries re-added and lost the same race. Three real jobs died
  // that way in six minutes, and one of them completed on the first attempt
  // once it had already materialised.
  //
  // So a 404 is retried for `torboxServableGraceMs` before it is believed. That
  // keeps what this probe was built for: the genuine case is an item still
  // absent *nine minutes* after being added, which no grace period this short
  // will ever mask.
  const sleepFor = opts.sleepFor ?? sleep;
  const deadline = Date.now() + (opts.graceMs ?? config.torboxServableGraceMs);
  let attempt = 0;
  while (true) {
    if (cdnUrl && (await cdnServesOneByte(jobId, cdnUrl))) {
      counters.inc("proxy.servable_via_cdn");
      if (attempt > 0) {
        console.log(`[torbox] job=${jobId} became servable after ${attempt} retr(ies)`);
        counters.inc("proxy.servable_after_wait");
      }
      return;
    }
    let res: Response;
    try {
      res = await fetch(webdavUrlFor(webdavPath), torboxInit({ headers }));
    } catch (err) {
      // A network failure here says nothing about whether the item exists, and
      // failing the source on it would take TorBox out over one bad moment.
      console.warn(`[torbox] job=${jobId} servability probe could not run: ${err}`);
      return;
    }
    if (res.ok || res.status === 206) {
      // Never drain the body — a 200 to a ranged request carries the whole file.
      await res.body?.cancel();
      if (attempt > 0) {
        console.log(`[torbox] job=${jobId} became servable after ${attempt} retr(ies)`);
        counters.inc("proxy.servable_after_wait");
      }
      return;
    }
    await res.body?.cancel();

    // Only the not-yet-there shapes are worth waiting on. A 401 is a bad key and
    // will read the same in twenty seconds.
    const worthRetrying = res.status === 404 || res.status >= 500;
    if (!worthRetrying || Date.now() >= deadline) {
      counters.inc(`proxy.unservable_${res.status}`);
      throw new UnservableSourceError("TorBox", res.status, webdavPath);
    }
    attempt++;
    counters.inc("proxy.servable_retry");
    await sleepFor(Math.min(1000 * 2 ** (attempt - 1), 4000));
  }
}

/**
 * Fetch one upstream range, falling back to WebDAV if the CDN refuses.
 *
 * TorBox's CDN nodes answer `ConnectionRefused` once a job opens too many
 * connections at once — routine for a multi-file release, where RD pulls
 * several episodes in parallel. That throw used to escape `handleProxyRequest`
 * entirely (the old fallback only covered a failure to *mint* a link), so RD
 * saw a dead webseed and stopped requesting after ~400 ranges, leaving the job
 * frozen at 3.9% while RD still advertised a healthy speed. WebDAV sits behind
 * Cloudflare and does not refuse this way, so it is the safety net.
 *
 * **A refusal is not always a throw, and for a long time only the throw was
 * caught.** Measured live on debrid02 2026-08-17 with `TORBOX_UPSTREAM=cdn` and
 * four concurrent jobs: the nexus node answered 45 ranges `503` inside one
 * window, and one `400` carrying an HTML error page. Those arrive as ordinary
 * responses, so they were handed straight back to RD as dead ranges while the
 * safety net sat unused. RD retried and the jobs still advanced, which is
 * precisely why this went unnoticed — it costs throughput rather than the job.
 */
async function fetchUpstream(
  jobId: string,
  cdnUrl: string | null,
  webdavUrl: string,
  webdavHeaders: Record<string, string>,
  range: string | undefined,
  viaTorbox: boolean,
  refreshCdn?: () => Promise<string | null>,
): Promise<Response> {
  // `viaTorbox` marks the TorBox path, which `torboxInit` gives the shared
  // egress address and `User-Agent` that `torbox.ts` also uses — the data plane
  // and the control plane have to look like one client, or the API key joins
  // them back together anyway. AllDebrid passes false: its API requires
  // IP confirmation, but its unlocked delivery URLs are not IP-bound.
  for (let attempt = 0; cdnUrl && attempt < 2; attempt++) {
    const headers: Record<string, string> = range ? { Range: range } : {};
    try {
      const res = await fetch(cdnUrl, viaTorbox ? torboxInit({ headers }) : { headers });
      // A 416 is the CDN answering correctly that the range does not exist, so
      // it stands — retrying it against WebDAV only buys the same answer twice.
      // Anything else non-2xx is the node refusing, and the safety net applies.
      if (res.ok || res.status === 416) {
        counters.inc("proxy.cdn_upstream");
        return res;
      }
      // Never drain the body: a refusal can still carry a whole file, and a
      // 400 here was observed carrying an HTML error page.
      await res.body?.cancel();
      counters.inc(`proxy.cdn_refused_${res.status}`);
      // Stale presigned URLs answer 400, or an empty 404 on erth. Do not
      // drain an arbitrary error body just to classify it: retry these statuses
      // once, including a fresh URL identical to the old one, then use WebDAV.
      if (attempt === 0 && (res.status === 400 || res.status === 404) && refreshCdn) {
        cdnUrl = await refreshCdn();
        continue;
      }
      console.warn(`[cdn] job=${jobId} upstream refused ${res.status}, using WebDAV`);
    } catch (err) {
      counters.inc("proxy.cdn_fetch_failures");
      console.warn(`[cdn] job=${jobId} upstream fetch failed, using WebDAV: ${err}`);
    }
    break;
  }
  const headers = { ...webdavHeaders };
  if (range) headers.Range = range;
  return fetch(webdavUrl, viaTorbox ? torboxInit({ headers }) : { headers });
}

/**
 * Hand RD a CDN link instead of the bytes.
 *
 * This opt-in path exposes the full TorBox API key in the Location URL.
 * It does not forward or expand Range here; measured RD clients lose Range
 * across both 302 and 307 redirects, so keep WEBSEED_REDIRECT off for RD.
 * Returns null when minting fails, leaving the caller to proxy the bytes.
 */
async function cdnLinkFor(
  jobId: string,
  session: ProxySession,
  fileInfo: SessionFile,
  refresh = false,
): Promise<string | null> {
  const fileId = fileInfo.torboxFileId;
  if (fileId === undefined) return null;
  const key = `${session.torboxTorrentId}:${fileId}`;
  // Only a refused link is evicted; a failure recorded meanwhile keeps its backoff.
  if (refresh && cdnLinks.get(key)?.url) cdnLinks.delete(key);
  return mintCdnLink(jobId, session.torboxTorrentId, fileId, session.torboxApiKey);
}

/** The cached `requestdl` link for one file, minting it when there is none. */
async function mintCdnLink(
  jobId: string,
  torrentId: number,
  fileId: number,
  apiKey: string | undefined,
): Promise<string | null> {
  const key = `${torrentId}:${fileId}`;
  const cached = cdnLinks.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.url;
  // RD reads several ranges at once; they share one requestdl call.
  let minting = cdnMints.get(key);
  if (!minting) {
    minting = requestCdnLink(jobId, key, torrentId, fileId, apiKey).finally(() =>
      cdnMints.delete(key),
    );
    cdnMints.set(key, minting);
  }
  return minting;
}

async function requestCdnLink(
  jobId: string,
  key: string,
  torrentId: number,
  fileId: number,
  apiKey: string | undefined,
): Promise<string | null> {
  const prev = cdnLinks.get(key);
  let url: string;
  try {
    url = applyCdnEdge(await torbox.requestDownloadLink(torrentId, fileId, { apiKey }));
  } catch (err) {
    const failures = (prev?.failures ?? 0) + 1;
    const dbErrors = String(err).includes('"error":"DATABASE_ERROR"')
      ? (prev?.dbErrors ?? 0) + 1
      : 0;
    const gone = dbErrors >= CDN_MINT_GONE_AFTER;
    const waitMs = Math.min(CDN_MINT_BACKOFF_CAP_MS, CDN_MINT_BACKOFF_MS * 2 ** (failures - 1));
    cdnLinks.set(key, {
      url: null,
      expiresAt: gone ? Number.POSITIVE_INFINITY : Date.now() + waitMs,
      failures,
      dbErrors,
    });
    counters.inc("proxy.cdn_mint_failures");
    const next = gone ? "not retrying this attempt" : `retry in ${waitMs / 1000}s`;
    console.warn(`[cdn] job=${jobId} could not mint link for file=${fileId} (${next}): ${err}`);
    return null;
  }
  cdnLinks.set(key, { url, expiresAt: Date.now() + CDN_LINK_TTL_MS, failures: 0, dbErrors: 0 });
  console.log(`[cdn] job=${jobId} minted link for file=${fileId}`);
  return url;
}

/**
 * Unlocked AllDebrid links, keyed `jobId:rewrittenPath`.
 *
 * Same reasoning as `cdnLinks`: RD issues thousands of ranges per job and
 * `/link/unlock` is an API call against a 600/min budget, so one unlock serves
 * a whole file. AllDebrid does not document how long a direct link stays valid,
 * which is why `handleProxyRequest` also re-unlocks on a response that is not a
 * 206 rather than trusting this TTL alone — the TTL keeps the call rate sane,
 * the retry is what makes expiry survivable.
 */
const adLinks = new Map<string, { url: string; expiresAt: number }>();
const AD_LINK_TTL_MS = 30 * 60_000;
// Failures and in-flight unlocks belong to the session's file, not the token
// globally: a different job/key or a rehydrated session must be able to retry.
let deadAdFiles = new WeakSet<SessionFile>();
let pendingLinks = new WeakMap<SessionFile, Promise<string | null>>();

/** Test seam: drop cached unlocks so a test can control what gets minted. */
export function _clearAdLinks(): void {
  adLinks.clear();
  deadAdFiles = new WeakSet();
  pendingLinks = new WeakMap();
}

/**
 * The two link-unlocking sources, which differ only in the details.
 *
 * AllDebrid and Real-Debrid both hand out a long-lived *locked* per-file link
 * that must be exchanged for a short-lived direct one, so both need the same
 * three things: a cache (RD and TorBox alike issue thousands of ranges per job
 * against a per-minute API budget), a TTL, and a forced refresh when a link has
 * aged out mid-job. Sharing the machinery keeps that third property — the one
 * that is easy to forget and only fails hours into a transfer — true for both by
 * construction rather than by remembering to copy it.
 */
type LinkSource = {
  /** The stored locked link for a file, if this source has one. */
  locked: (file: SessionFile) => string | undefined;
  /** Exchange it for a direct, ranged URL. */
  resolve: (locked: string, session: ProxySession) => Promise<string>;
  ttlMs: number;
  label: string;
};

const LINK_SOURCES: Record<string, LinkSource> = {
  alldebrid: {
    locked: (file) => file.adLink,
    resolve: (locked, session) => alldebrid.unlockLink(locked, { apiKey: session.alldebridApiKey }),
    ttlMs: AD_LINK_TTL_MS,
    label: "alldebrid",
  },
  realdebrid: {
    locked: (file) => file.rdLink,
    resolve: (locked, session) => rd.unrestrictLink(locked, { apiKey: session.realdebridApiKey }),
    // Measured 2026-11-05: RD delivery URLs live exactly seven days from mint.
    // Keep this conservative cache policy; early revocation or a failed host
    // still needs the existing one-shot refresh.
    ttlMs: 20 * 60_000,
    label: "realdebrid",
  },
};

/**
 * A direct, ranged URL for one file, cached and refreshable.
 *
 * Returns null when this source has no link for the file or the exchange failed
 * — the caller turns that into a 502 rather than serving nothing silently.
 */
async function directLinkFor(
  jobId: string,
  session: ProxySession,
  filePath: string,
  fileInfo: SessionFile,
  refresh = false,
): Promise<string | null> {
  const source = LINK_SOURCES[session.source];
  if (!source) return null;
  const locked = source.locked(fileInfo);
  if (!locked) return null;

  const key = `${session.source}:${jobId}:${filePath}`;
  if (deadAdFiles.has(fileInfo)) return null;
  const pending = pendingLinks.get(fileInfo);
  if (pending) return pending;
  if (!refresh) {
    const cached = adLinks.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.url;
  }

  const resolving = resolveDirectLink(source, locked, session, fileInfo, key, jobId);
  pendingLinks.set(fileInfo, resolving);
  try {
    return await resolving;
  } finally {
    pendingLinks.delete(fileInfo);
  }
}

async function resolveDirectLink(
  source: LinkSource,
  locked: string,
  session: ProxySession,
  fileInfo: SessionFile,
  key: string,
  jobId: string,
): Promise<string | null> {
  try {
    const url = await source.resolve(locked, session);
    adLinks.set(key, { url, expiresAt: Date.now() + source.ttlMs });
    return url;
  } catch (err) {
    adLinks.delete(key);
    if (
      session.source === "alldebrid" &&
      err instanceof alldebrid.AlldebridError &&
      err.code === "LINK_HOST_NOT_SUPPORTED"
    ) {
      // Measured dead/truncated torrent token. Repeating every range cannot
      // restore content; transient API/delivery failures remain retryable.
      deadAdFiles.add(fileInfo);
    }
    console.warn(`[${source.label}] job=${jobId} could not resolve link: ${err}`);
    return null;
  }
}

/**
 * One read against a provider's delivery host, with a failed dial reported as
 * null instead of a throw. See `fetchLinkUpstream` for why that distinction is
 * the whole point.
 */
async function dialLink(
  jobId: string,
  label: string,
  url: string,
  range: string | undefined,
): Promise<Response | null> {
  try {
    // Delivery links authenticate themselves, never with TorBox headers.
    // AD delivery is not IP-bound (its API is IP-confirmed); RD delivery is
    // IP-tracked, so keep these reads on this host's own egress.
    return await fetchUpstream(jobId, null, url, {}, range, false);
  } catch (err) {
    counters.inc("proxy.ad_link_dial_failures");
    console.warn(`[${label}] job=${jobId} delivery host could not be dialled: ${err}`);
    return null;
  }
}

/**
 * Fetch one read from a direct provider link, re-resolving it once if the first
 * attempt does not serve.
 *
 * Two unrelated-looking failures land here and both have the same single
 * remedy. The first is a link that has aged out, which answers something other
 * than what was asked for. AllDebrid's lifetime is unmeasured; RD's is seven
 * days from mint (2026-11-05). Either can fail sooner, so the link is re-resolved
 * and the read retried rather than making an early refusal fatal.
 *
 * The second is not a response at all. **AllDebrid mints a delivery hostname
 * per `/link/unlock`, and a slice of those hostnames DNS-resolve to `0.0.0.0`
 * and `::` globally** — null-routed, and incapable of ever serving a byte.
 * Measured 2026-08-23, three of them (`l4m5n6.debrid.it`, `o7p8q9.debrid.it`,
 * `c1uw74.debrid.it`) carried 15.6% of resolved links, across unrelated files.
 * The unlock itself succeeds and the URL looks entirely ordinary, so nothing
 * before the byte read can see it; `fetch` simply throws when the connect is
 * attempted. That is a fact about the node rather than about the file, and a
 * fresh unlock usually draws a live one — the same remedy, which is why it is
 * folded into this retry rather than given a path of its own. The sibling Go
 * service solves it the same way, deliberately classifying the dial to the
 * unspecified address apart from a generic network error.
 *
 * Note the symmetry with `fetchUpstream` above. On the TorBox path a refusal
 * was not always a throw and for a long time only the throw was caught; here it
 * was the exact reverse — only the response was ever inspected, so the throw
 * escaped `fetchUpstream`, escaped the retry that would have fixed it, and 502'd
 * a range a second unlock would have served.
 *
 * Returns null when neither the first host nor the fresh one could be dialled.
 * There is no response to hand back in that case, which is precisely the shape
 * that used to be impossible to express here.
 *
 * No headers are sent with either attempt. A provider link carries its own
 * token in the path, so `resolveUpstream` hands these sources an empty set to
 * begin with — and TorBox's WebDAV credential must never travel to an unrelated
 * host. The retry has always been written that way; the first attempt now
 * matches it rather than forwarding a set that is empty by construction.
 */
async function fetchLinkUpstream(
  jobId: string,
  session: ProxySession,
  filePath: string,
  fileInfo: SessionFile,
  url: string,
  range: string | undefined,
): Promise<Response | null> {
  const { label } = LINK_SOURCES[session.source];
  let res = await dialLink(jobId, label, url, range);
  // A ranged read has to come back 206: `res.ok` is true for a 200 that ignored
  // the Range, and the caller rejects that separately rather than relabelling
  // whole-file bytes. A whole-file read only has to be ok. A null is neither —
  // the host was never reached.
  const served = range === undefined ? res?.ok : res?.status === 206;
  if (served) return res;

  counters.inc("proxy.ad_link_refreshes");
  const fresh = await directLinkFor(jobId, session, filePath, fileInfo, true);
  if (fresh) res = await dialLink(jobId, label, fresh, range);
  return res;
}

/** Where one range request should be fetched from, and with what headers. */
type Upstream = { url: string; headers: Record<string, string>; cdnUrl: string | null };

/**
 * Resolve the upstream for a metered session.
 *
 * AllDebrid's unlocked links carry their own token in the path, so they are
 * fetched with no `Authorization` header — sending one is harmless but sending
 * TorBox's would be a credential leak to an unrelated host. Returns null only
 * when AllDebrid could not be unlocked at all, which the caller turns into a
 * 502 rather than silently serving nothing.
 */
async function resolveUpstream(
  jobId: string,
  session: ProxySession,
  filePath: string,
  fileInfo: SessionFile,
): Promise<Upstream | null> {
  // AllDebrid's and Real-Debrid's direct links both carry their own token in the
  // path, so they are fetched with no `Authorization` header — harmless to send
  // one, but sending TorBox's would leak a credential to an unrelated host.
  if (session.source in LINK_SOURCES) {
    const url = await directLinkFor(jobId, session, filePath, fileInfo);
    if (!url) return null;
    return { url, headers: {}, cdnUrl: null };
  }

  let cdnUrl: string | null = null;
  if (config.torboxUpstream === "cdn") {
    cdnUrl = await cdnLinkFor(jobId, session, fileInfo);
    if (!cdnUrl) counters.inc("proxy.cdn_fallbacks");
  }
  return {
    url: webdavUrlFor(fileInfo.webdavPath),
    headers: { Authorization: webdavAuth(session) },
    cdnUrl,
  };
}

async function cdnRedirect(
  jobId: string,
  session: ProxySession,
  fileInfo: SessionFile,
): Promise<Response | null> {
  const url = await cdnLinkFor(jobId, session, fileInfo);
  if (!url) return null;
  counters.inc("proxy.redirects");
  // Preserve the original method by using 307, but do not assume that a
  // downloader preserves Range: RD was measured losing it across 307 too.
  return new Response(null, {
    status: 307,
    headers: { location: url, "accept-ranges": "bytes" },
  });
}

export async function handleProxyRequest(
  jobId: string,
  filePath: string,
  range: string | null,
): Promise<Response> {
  const session = getProxySession(jobId);
  if (!session) return new Response("proxy session not found", { status: 404 });

  const fileInfo = session.files.get(filePath);
  if (!fileInfo) return new Response("file not found in proxy session", { status: 404 });

  session.requestCount++;
  counters.inc("proxy.requests");

  if (!isMetered(session)) {
    return handleLocalFileProxy(jobId, session, fileInfo, filePath, range);
  }

  if (config.webseedRedirect && fileInfo.torboxFileId !== undefined) {
    const redirect = await cdnRedirect(jobId, session, fileInfo);
    if (redirect) return redirect;
    // Minting failed — fall through and proxy this request rather than failing
    // it, so a TorBox API blip degrades to the slow path instead of the job.
    counters.inc("proxy.redirect_fallbacks");
  }

  // Local disk was handled above; the remote sources resolve here. There used
  // to be a webtorrent sidecar reached when the id was neither -1 nor positive
  // — dead since qBittorrent replaced that path. The TorBox CDN link and the
  // AllDebrid unlocked link are both self-authenticating, so neither carries an
  // Authorization header; only WebDAV does. TorBox falls back to WebDAV
  // whenever a link cannot be minted, which keeps an API blip off the job's
  // critical path, but AllDebrid has no second host to fall back to.
  const upstream = await resolveUpstream(jobId, session, filePath, fileInfo);
  if (!upstream) {
    counters.inc("proxy.upstream_unavailable");
    return new Response("upstream unavailable", { status: 502 });
  }
  const { url: upstreamUrl, cdnUrl } = upstream;
  const headers: Record<string, string> = { ...upstream.headers };
  const viaTorbox = session.source === "torbox";
  // AllDebrid and Real-Debrid are the sources a second `/link/unlock` can
  // rescue, so their reads go through `fetchLinkUpstream` on both the ranged and
  // the whole-file path. TorBox keeps the CDN-then-WebDAV call it has always
  // had: a throw out of WebDAV is real infrastructure failing, and there is no
  // second unlock there that could fix it.
  const viaLink = session.source in LINK_SOURCES;
  const refreshCdn = cdnUrl ? () => cdnLinkFor(jobId, session, fileInfo, true) : undefined;

  if (range) {
    const start = rangeStart(range);
    if (start !== null) {
      if (start >= fileInfo.size) {
        return new Response("range not satisfiable", {
          status: 416,
          headers: { "content-range": `bytes */${fileInfo.size}` },
        });
      }

      const expandedEnd = expandedEndFor(
        range,
        start,
        chunkSizeFor(session),
        fileInfo.size,
        mayOverServe(session),
      );
      const rangeHeader = `bytes=${start}-${expandedEnd}`;
      headers.Range = rangeHeader;

      const res = viaLink
        ? await fetchLinkUpstream(jobId, session, filePath, fileInfo, upstreamUrl, rangeHeader)
        : await fetchUpstream(
            jobId,
            cdnUrl,
            upstreamUrl,
            headers,
            rangeHeader,
            viaTorbox,
            refreshCdn,
          );
      // Null means no host answered: the link's delivery node was null-routed
      // and so was the one the fresh unlock drew. There is no response to read a
      // status off, which is exactly why this cannot go through
      // `upstreamFailure`.
      if (!res) return unreachableUpstream(jobId, `range=${rangeHeader}`);

      // A ranged request must be answered 206. A 200 means the upstream ignored
      // the Range and is sending the file from byte 0 — `res.ok` is true for it,
      // so the old check let it through and we relabelled whole-file bytes as
      // the requested range, handing RD silently corrupt pieces. WebDAV always
      // honours the Range, which is why this only surfaced on the CDN path.
      if (res.status !== 206) {
        counters.inc("proxy.upstream_not_partial");
        return await upstreamFailure(jobId, res, `range=${rangeHeader}`);
      }

      // Everything fetched here is billable egress on the TorBox side, so it is
      // counted separately from what RD is handed.
      const length = expandedEnd - start + 1;
      counters.inc("proxy.upstream_requests");
      counters.inc("proxy.upstream_bytes", length);
      counters.inc("proxy.served_bytes", length);
      session.upstreamBytes += length;
      session.servedBytes += length;
      recordReach(session, filePath, expandedEnd + 1);

      const respHeaders = new Headers();
      respHeaders.set("content-type", "application/octet-stream");
      respHeaders.set("accept-ranges", "bytes");
      respHeaders.set("content-length", String(length));
      respHeaders.set("content-range", `bytes ${start}-${expandedEnd}/${fileInfo.size}`);

      if (session.requestCount % 100 === 0) {
        console.log(
          `[proxy] job=${jobId} reqs=${session.requestCount} file="${filePath}" range=${start}-${expandedEnd}`,
        );
      }

      // **A streamed body loses the `Content-Length` set above.** Bun answers a
      // `ReadableStream` with `Transfer-Encoding: chunked` and drops the header,
      // and libtorrent — the client behind the TorBox destination — needs the
      // length to know where the response for this range ends. Observed live at
      // 74% of a 12.4 GB transfer: it re-requested the same 48,961-byte piece
      // tail **167 times in three minutes** and never advanced again, while our
      // answers were byte-perfect (piece 551 hash-verified) and RD's upstream
      // returned a correct `Content-Range` and `Content-Length`. The POC webseed
      // that TorBox consumed without complaint answered with a sized body.
      //
      // Buffering is confined to that destination on purpose: RD's Transmission
      // is happy with chunked, and holding a whole chunk per in-flight request
      // is real memory, so the proven streaming
      // path stays exactly as it was.
      if (needsContentLength(session)) {
        return new Response(await res.arrayBuffer(), { status: 206, headers: respHeaders });
      }
      return new Response(res.body, { status: 206, headers: respHeaders });
    }
  }

  // A whole-file read draws the same delivery host and can be handed the same
  // null-routed one, where the throw did not merely skip a retry — there was no
  // retry here at all — but escaped `handleProxyRequest` outright and reached
  // the client as a bare 500 from Hono. It takes the same one-shot re-resolve,
  // which as a side effect also gives this path the aged-out-link recovery the
  // ranged path has had all along.
  const res = viaLink
    ? await fetchLinkUpstream(jobId, session, filePath, fileInfo, upstreamUrl, undefined)
    : await fetchUpstream(jobId, cdnUrl, upstreamUrl, headers, undefined, viaTorbox, refreshCdn);
  if (!res) return unreachableUpstream(jobId, "whole-file");
  if (!res.ok) {
    counters.inc("proxy.upstream_whole_file_failed");
    return await upstreamFailure(jobId, res, "whole-file");
  }

  const respHeaders = new Headers();
  respHeaders.set("content-type", "application/octet-stream");
  respHeaders.set("accept-ranges", "bytes");
  respHeaders.set("content-length", String(fileInfo.size));
  return new Response(res.body, { status: 200, headers: respHeaders });
}

/**
 * Turn an upstream that was never reached into a 502.
 *
 * The sibling of `upstreamFailure`, for the case where the connect itself never
 * completed and there is therefore no status to read. Kept separate rather than
 * folded in so `proxy.upstream_status_<n>` keeps meaning "a status the upstream
 * actually sent" — a synthesised 502 there would quietly corrupt the one number
 * every diagnosis of this path starts from. `proxy.ad_link_dial_failures` counts
 * every dead host dialled; this counts only the reads that ran out of retries.
 */
function unreachableUpstream(jobId: string, context: string): Response {
  counters.inc("proxy.upstream_unreachable");
  console.warn(`[upstream] job=${jobId} ${context} unreachable: no delivery host answered`);
  return new Response("upstream error", { status: 502 });
}

/**
 * Turn a refused upstream read into a 502, and *say why*.
 *
 * The count of non-206 answers has always been recorded, but never the status
 * behind it — so every diagnosis of the dominant failure mode has had to be
 * reconstructed from manual probes. On 2026-08-08 a job served 4.0GB happily and
 * then died with 2 of 2 upstream reads refused, and the logs could not say
 * whether TorBox had answered 429, 404 or 503. `proxy.upstream_status_<n>` makes
 * that a fact in the stage report instead of an inference.
 *
 * The body is *peeked*, never drained. A refused range can come back as a `200`
 * carrying the entire file, and `await res.text()` on that would pull a whole
 * release into memory to print 160 characters of it.
 */
async function upstreamFailure(jobId: string, res: Response, context: string): Promise<Response> {
  counters.inc(`proxy.upstream_status_${res.status}`);
  const detail = await peekBody(res);
  console.warn(`[upstream] job=${jobId} ${context} refused: status=${res.status} ${detail}`);
  return new Response("upstream error", { status: 502 });
}

/** The first chunk of a response body, bounded, then cancelled. */
async function peekBody(res: Response, limit = 160): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  try {
    const { value } = await reader.read();
    if (!value) return "";
    return new TextDecoder().decode(value.slice(0, limit)).replace(/\s+/g, " ").trim();
  } catch {
    // A body that errors on read tells us nothing extra; the status is the point.
    return "";
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export async function waitForBytes(
  filePath: string,
  needed: number,
  timeoutMs = 600_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const stat = fs.statSync(filePath);
      if (stat.size >= needed) return;
    } catch {}
    await sleep(500);
  }
  throw new Error(`Timed out waiting for ${needed} bytes in ${filePath}`);
}

async function handleLocalFileProxy(
  jobId: string,
  session: ProxySession,
  fileInfo: { webdavPath: string; size: number; qbitFileIndex?: number },
  filePath: string,
  range: string | null,
): Promise<Response> {
  const localPath = fileInfo.webdavPath;

  if (range) {
    const start = rangeStart(range);
    if (start !== null) {
      if (start >= fileInfo.size) {
        return new Response("range not satisfiable", {
          status: 416,
          headers: { "content-range": `bytes */${fileInfo.size}` },
        });
      }

      const expandedEnd = expandedEndFor(
        range,
        start,
        chunkSizeFor(session),
        fileInfo.size,
        mayOverServe(session),
      );
      const length = expandedEnd - start + 1;

      if (!bytesAvailable(localPath, expandedEnd + 1)) {
        await ensureQbitPriority(session, fileInfo);
      }
      await waitForBytes(localPath, expandedEnd + 1);

      counters.inc("proxy.disk_reads");
      counters.inc("proxy.served_bytes", length);
      session.servedBytes += length;
      recordReach(session, filePath, expandedEnd + 1);

      const fd = fs.openSync(localPath, "r");
      try {
        const buf = Buffer.alloc(length);
        fs.readSync(fd, buf, 0, length, start);

        const respHeaders = new Headers();
        respHeaders.set("content-type", "application/octet-stream");
        respHeaders.set("accept-ranges", "bytes");
        respHeaders.set("content-length", String(length));
        respHeaders.set("content-range", `bytes ${start}-${expandedEnd}/${fileInfo.size}`);

        if (session.requestCount % 100 === 0) {
          console.log(
            `[proxy] job=${jobId} reqs=${session.requestCount} file="${filePath}" range=${start}-${expandedEnd}`,
          );
        }

        return new Response(buf, { status: 206, headers: respHeaders });
      } finally {
        fs.closeSync(fd);
      }
    }
  }

  if (!bytesAvailable(localPath, fileInfo.size)) {
    await ensureQbitPriority(session, fileInfo);
  }
  await waitForBytes(localPath, fileInfo.size);

  const stream = fs.createReadStream(localPath);
  const respHeaders = new Headers();
  respHeaders.set("content-type", "application/octet-stream");
  respHeaders.set("accept-ranges", "bytes");
  respHeaders.set("content-length", String(fileInfo.size));
  return new Response(stream as unknown as ReadableStream, { status: 200, headers: respHeaders });
}

function bytesAvailable(filePath: string, needed: number): boolean {
  try {
    return fs.statSync(filePath).size >= needed;
  } catch {
    return false;
  }
}

async function ensureQbitPriority(
  session: ProxySession,
  fileInfo: { qbitFileIndex?: number },
): Promise<void> {
  if (!session.qbitHash || fileInfo.qbitFileIndex === undefined) return;
  try {
    await qbit.setFilePriority(session.qbitHash, [fileInfo.qbitFileIndex], QBIT_PRIORITY_MAX);
  } catch (err) {
    console.warn(`[proxy] failed to set qBit file priority: ${err}`);
  }
}

function webdavUrlFor(webdavPath: string): string {
  return `${WEBDAV_BASE}/${webdavPath.split("/").map(encodeURIComponent).join("/")}`;
}

function rangeStart(range: string): number | null {
  const match = range.match(/bytes=(\d+)-(\d*)/);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * The last byte a client asked for, or null when it left the end open.
 *
 * Needed because the chunk size must widen a small request without ever
 * *narrowing* a large one — see `expandedEndFor`.
 */
function rangeEnd(range: string): number | null {
  const match = range.match(/bytes=(\d+)-(\d+)/);
  return match ? parseInt(match[2], 10) : null;
}

/**
 * How far to actually read, given what the client asked for.
 *
 * **The destinations' torrent clients disagree about over-sized responses, and
 * the two measured halves of that were learned the hard way.**
 *
 * Real-Debrid drives Transmission, which tolerates a 206 wider than it asked
 * for. That is what the chunk size is *for*: RD asks in ~426 KB ranges and pays
 * an upstream round trip on each, so widening to 8 MiB is what makes the proxy
 * beat a direct CDN webseed (133s against 234s on the same file).
 *
 * TorBox drives `qBittorrent/5.1.4`, which accepts neither a short answer nor an
 * over-long one:
 *
 * - **Truncating** — the chunk applied as a *ceiling* to its 16 MiB asks — had
 *   it give up after a few requests and sit at `stalled (no seeds)` with
 *   `total_downloaded: 0`.
 * - **Over-serving** — the chunk applied as a *floor* to a smaller ask, e.g.
 *   answering `4683921582-4692310189` to a request for `4683921582-4689231871` —
 *   had it re-request the identical range and then stall the same way, after
 *   ~11 MB.
 *
 * Neither looked like a fault at this end: both responses were valid HTTP and
 * the bytes were hash-verified against the torrent's own pieces. So the rule is
 * to expand only where expansion is known to be safe, and otherwise answer
 * exactly what was asked.
 */
function expandedEndFor(
  range: string,
  start: number,
  chunkSize: number,
  fileSize: number,
  mayOverServe: boolean,
): number {
  const chunkEnd = start + chunkSize - 1;
  const asked = rangeEnd(range);
  if (asked === null) return Math.min(chunkEnd, fileSize - 1);
  const end = mayOverServe ? Math.max(asked, chunkEnd) : asked;
  return Math.min(end, fileSize - 1);
}

/**
 * Whether this session's client tolerates a 206 wider than it requested.
 *
 * Phrased as an allow-list of the one destination known to tolerate it rather
 * than as a deny-list of the one known not to. That matters for every
 * destination added later: a deny-list grants the risky behaviour by default, so
 * a new provider would silently inherit the setting that froze TorBox jobs at
 * `total_downloaded: 0` until somebody measured it. Premiumize's client has not
 * been measured here, so it gets the safe answer — serve exactly what was asked,
 * which also makes amplification 1.00x.
 */
function mayOverServe(session: ProxySession): boolean {
  return session.destination === "rd";
}

/**
 * Whether this session's client needs a real `Content-Length` on every range.
 *
 * Same client split as `mayOverServe`, and kept as its own predicate because it
 * is a different property: one is about the *size* of the answer, this is about
 * how the answer is *framed*.
 */
function needsContentLength(session: ProxySession): boolean {
  return session.destination !== "rd";
}

export function proxyWebseedUrl(jobId: string): string {
  return `${config.baseUrl}/webseed/${jobId}/`;
}
