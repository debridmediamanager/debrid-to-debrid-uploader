import fs from "node:fs";
import path from "node:path";
import * as alldebrid from "./alldebrid";
import { config } from "./config";
import type { Destination, ProxySource } from "./db";
import { fetchTorrentFile } from "./itorrents";
import {
  fetchDmmInfo,
  fetchMdbInfo,
  fetchMediaInfo,
  fetchOmdbInfo,
  fetchTmdbInfo,
  type MdbInfo,
  type MetadataSource,
  resolveViaDmm,
  searchMedia,
} from "./mdblist";
import { buildCleanName, parseRelease } from "./naming";
import { applyCdnEdge, assertTorboxServable, proxyWebseedUrl, registerProxySession } from "./proxy";
import { QbitClient } from "./qbittorrent";
import { describeAddHold, RdAddCancelledError } from "./rd-account-block";
import * as rd from "./realdebrid";
import * as torbox from "./torbox";
import { isSingleFileTorrent, rewriteTorrent, torrentName } from "./torrent-rewrite";
import { resolveTorrentFile } from "./torrent-source";
import { enrichMagnet, getTrackers } from "./trackers";
import { sleep } from "./utils/async";
import { ensureDir, isVideoFile } from "./utils/files";

export type DownloadResult = {
  filePath: string;
  webseedUrl: string;
  allFiles: { name: string; size: number }[];
  proxyInfoHash?: string;
};

type ProgressReporter = {
  set(message: string): void;
  setName(name: string): void;
  clear(): void;
};

export type DownloadOptions = {
  forceWebtorrent?: boolean;
  /**
   * The submitter's own TorBox key, when they supplied one. It drives the REST
   * calls and authenticates the WebDAV reads alike, so this one value routes
   * the whole TorBox path to their account.
   */
  torboxApiKey?: string;
  /** The submitter's own AllDebrid key, on the same terms. */
  alldebridApiKey?: string;
  /** The submitter's own Real-Debrid key, used when RD is the *source*. */
  realdebridApiKey?: string;
  /** The RD account behind that key (`rd:67890`), which a 451 block is held under. */
  realdebridAccount?: string;
  /** Whether the job has been deleted; an add waiting out a block stops on it. */
  cancelled?: () => boolean;
  /** Where the bytes are going, which decides what may supply them. */
  destination?: Destination;
};

/**
 * Which sources may feed a destination, in preference order.
 *
 * **A provider is never its own source.** Sending TorBox's bytes back to TorBox
 * through our webseed would pay egress to re-import something the account
 * already holds, and for the RD destination it is worse than pointless: RD
 * stalls forever on content it already has, so the job could only ever fail.
 *
 * Real-Debrid appears only as a source for the TorBox destination because the
 * original direction has no use for it — there the RD account is where the
 * content is going, not where it lives.
 */
export function sourcesFor(destination: Destination): ProxySource[] {
  if (destination === "torbox") return ["realdebrid", "alldebrid"];
  // Premiumize is the only destination that is not also a cache source here, so
  // it is the only one that can try all three without ever sourcing a job from
  // the account it is delivering to. TorBox leads for the same reason it leads
  // `CACHE_SOURCES`: its `checkcached` is a free read-only probe, where
  // AllDebrid's only probe is the upload itself.
  if (destination === "premiumize") return ["torbox", "alldebrid", "realdebrid"];
  return config.cacheSources;
}

/**
 * Salt for the rewritten torrent, unique per *attempt* rather than per job.
 *
 * `rewriteTorrent` writes this into the info dict, so it is what makes the info
 * hash fresh. That matters because RD caches torrent *errors* by info hash and
 * refuses a resubmission on sight — in under a second, with a bare
 * `status: "error"` and no explanation, while still reporting the filename and
 * byte count correctly, which makes it look like a download failure rather than
 * a rejection. `url-list` and `announce` live in the torrent's root dict, not in
 * `info`, so changing BASE_URL or the tracker list leaves the info hash
 * identical; deleting the torrent from the RD account does not clear the cache
 * either. A per-job salt therefore resubmits the same blacklisted hash on every
 * stage retry and is refused forever. Only a per-attempt salt escapes it.
 */
function attemptSalt(jobId: string): string {
  return `${jobId}:${Date.now()}`;
}

/**
 * No configured cached source holds this release.
 *
 * A distinct type because it is **not retryable**: it is a fact about what the
 * providers have, not a transient failure, so re-running the same probes three
 * times with backoff only delays the same answer — and on the AllDebrid path
 * each retry costs another mutating upload round trip against the account.
 * `worker.ts` `retryOrFail` fails the job on sight of this.
 *
 * The message is the bare word `uncached` so it reads cleanly as the job's
 * error and is trivial to filter on; the hash and job id go to the log instead.
 */
export class UncachedError extends Error {
  constructor() {
    super("uncached");
    this.name = "UncachedError";
  }
}

export async function downloadMagnet(
  jobId: string,
  magnetUri: string,
  imdbId: string,
  progress: ProgressReporter,
  signal?: AbortSignal,
  options?: DownloadOptions,
): Promise<DownloadResult> {
  const trackers = await getTrackers();
  const enriched = enrichMagnet(magnetUri, trackers);

  const hash = enriched.match(/btih:([0-9a-fA-F]+)/i)?.[1]?.toLowerCase();
  if (!hash) throw new Error("Could not extract info hash from magnet URI");

  // A submitter's own key makes a cached path available even when the operator
  // never configured one, so every gate below checks the *effective* key.
  //
  // `forceWebtorrent` (the `force_qbit` job field) only means anything while
  // the qBittorrent route exists. With it disabled, honouring the flag would
  // skip the cache check and then fail the job as uncached with nothing left to
  // try, so the flag is ignored rather than turned into a guaranteed failure.
  // A source that says "cached" and then fails to deliver must not take the job
  // down with it — the next source gets a turn. This is not hypothetical: when
  // TorBox rotated the API key on 2026-08-06, `checkCached` kept answering from
  // cache while `createtorrent` returned `403 PLAN_RESTRICTED_FEATURE`, and five
  // jobs died having committed to TorBox without ever trying AllDebrid.
  let sourceError: unknown;

  /** Run a source, and on failure record it and let the loop continue. */
  const attempt = async <T>(label: string, run: () => Promise<T | null>): Promise<T | null> => {
    try {
      return await run();
    } catch (err) {
      // An abort is the job being deleted or the stage stalling out. It is not
      // this source's fault and the next one would only abort too.
      if (signal?.aborted || err instanceof RdAddCancelledError) throw err;
      sourceError = err;
      console.warn(`[${label}] job=${jobId} cached path failed, trying the next source: ${err}`);
      return null;
    }
  };

  const destination: Destination = options?.destination ?? "rd";

  if (!(options?.forceWebtorrent && config.qbitEnabled)) {
    for (const source of sourcesFor(destination)) {
      if (source === "realdebrid") {
        const rdKey = options?.realdebridApiKey;
        if (!rdKey) continue;
        const result = await attempt("realdebrid", () =>
          proxyViaRealdebrid(
            jobId,
            enriched,
            hash,
            imdbId,
            progress,
            destination,
            signal,
            rdKey,
            options?.realdebridAccount,
            options?.cancelled,
          ),
        );
        if (result) return result;
        continue;
      }

      if (source === "torbox") {
        const tbOpts: torbox.TorboxOptions = { apiKey: options?.torboxApiKey };
        if (!tbOpts.apiKey) continue;
        const result = await attempt("torbox", async () => {
          if (!(await torbox.checkCached(hash, tbOpts))) return null;
          console.log(`[torbox] job=${jobId} hash=${hash} is cached, using proxy path`);
          return proxyViaTorbox(
            jobId,
            enriched,
            hash,
            imdbId,
            progress,
            destination,
            signal,
            options?.torboxApiKey,
          );
        });
        if (result) return result;
        continue;
      }

      const adKey = options?.alldebridApiKey;
      if (!adKey) continue;
      // The probe goes through `attempt` like any other source: a probe that
      // could not be made records a source error, so the job reports why
      // AllDebrid was no help instead of ending as a terminal `uncached`.
      const magnet = await attempt("alldebrid", () =>
        probeAlldebrid(jobId, enriched, progress, adKey),
      );
      if (magnet) {
        console.log(`[alldebrid] job=${jobId} hash=${hash} is cached, using proxy path`);
        const result = await attempt("alldebrid", () =>
          proxyViaAlldebrid(jobId, magnet, hash, imdbId, progress, destination, signal, adKey),
        );
        if (result) return result;
      }
    }
  }

  if (config.qbitEnabled) {
    console.log(`[qbit] job=${jobId} hash=${hash} proxying via qBittorrent`);
    return proxyViaQbit(jobId, enriched, hash, imdbId, progress, signal);
  }

  // A source that *held* the release and broke is a transient provider fault,
  // not a verdict about what exists — so it is rethrown as itself and stays
  // retryable. Only a clean set of "no" answers is `uncached`, which is
  // terminal. Getting this backwards would turn a TorBox outage into a
  // permanent failure for every job that ran during it.
  if (sourceError) throw sourceError;

  console.log(`[uncached] job=${jobId} hash=${hash} no configured source holds it`);
  throw new UncachedError();
}

/**
 * Ask AllDebrid whether it already holds this release.
 *
 * **The probe is the upload**, because AllDebrid retired every read-only way to
 * ask: `/v4/magnet/instant` 404s and v4 `/magnet/status` answers
 * `DISCONTINUED` (both checked 2026-08-06). So unlike `torbox.checkCached`,
 * finding out can mutate the account and a miss may leave an uncached download.
 * The returned id can also be a held magnet, so it never authorizes deletion.
 *
 * Returns the magnet only when `ready`; null means a clean miss. API failures
 * reach the source-fallback boundary and remain provider errors if none succeeds.
 */
/**
 * When AllDebrid last told this host it is not allowed to use the feature.
 *
 * `NO_SERVER` — "Servers are not allowed to use this feature" — is a property of
 * the *host's IP*, not of the job, the key or the release: AllDebrid blocks
 * datacenter ranges from `magnet/upload`, and since every read-only cache check
 * was retired that endpoint **is** the probe. So the whole AllDebrid path is
 * dead on that host until someone whitelists the address.
 *
 * Measured 2026-08-16: debrid02 (Hetzner) answers `NO_SERVER`
 * while a since-retired host succeeded on the identical call — which is why
 * debrid02 has no AllDebrid completion in its history.
 * Without this breaker every job re-learns it, one wasted round trip at a time,
 * and the log says nothing an operator would notice.
 *
 * Re-probed after a cool-off rather than latched forever, so whitelisting the
 * address takes effect on its own instead of needing a restart.
 */
let alldebridBlockedUntil = 0;
let alldebridBlockedReason: Error | null = null;
const AD_BLOCKED_COOLOFF_MS = 30 * 60_000;

/**
 * Whether AllDebrid refused the *asking* rather than answering about the release.
 *
 * `NO_SERVER` is the host's IP being blocked from `magnet/upload`, and the
 * `AUTH_*` codes are AllDebrid rejecting the submitter's key — most often
 * `AUTH_BLOCKED`, "you are logging from a new location, device or app", which
 * clears only when the account owner clicks a link in an email a third-party
 * submitter never receives. None of the three is a statement about whether
 * AllDebrid holds the content, and a retry cannot change any of them.
 */
export function isAlldebridRefusal(err: unknown): boolean {
  return (
    err instanceof alldebrid.AlldebridError &&
    (err.code === "NO_SERVER" || err.code.startsWith("AUTH_"))
  );
}

async function probeAlldebrid(
  jobId: string,
  magnetUri: string,
  progress: ProgressReporter,
  apiKey?: string,
): Promise<alldebrid.AlldebridMagnet | null> {
  const opts: alldebrid.AlldebridOptions = { apiKey };

  // The breaker spares the round trip, but the job still has to be told why
  // AllDebrid contributed nothing — swallowing it here is what turned a blocked
  // host into "uncached" for every job in the 30-minute window.
  if (Date.now() < alldebridBlockedUntil && alldebridBlockedReason) {
    throw alldebridBlockedReason;
  }

  progress.set("Checking AllDebrid cache...");

  let magnet: alldebrid.AlldebridMagnet;
  try {
    magnet = await alldebrid.uploadMagnet(magnetUri, opts);
  } catch (err) {
    if (String(err).includes("NO_SERVER")) {
      alldebridBlockedUntil = Date.now() + AD_BLOCKED_COOLOFF_MS;
      alldebridBlockedReason = err instanceof Error ? err : new Error(String(err));
      console.error(
        `[alldebrid] this host is blocked from magnet/upload (NO_SERVER) — the AllDebrid ` +
          `fallback is unavailable here until its IP is whitelisted at https://alldebrid.com/vpn. ` +
          `Skipping AllDebrid for ${AD_BLOCKED_COOLOFF_MS / 60_000} minutes.`,
      );
      throw err;
    }
    // Asking failed, which is not AllDebrid saying no. Returning null here made
    // every auth rejection read as a clean "not cached", and `uncached` is
    // terminal — so the submitter was told the release does not exist when the
    // truth was that their key was never accepted.
    console.warn(`[alldebrid] job=${jobId} cache probe failed: ${err}`);
    throw err;
  }

  if (magnet.ready) return magnet;

  // Upload deduplicates against the account's existing magnets. Even a cache
  // miss may be a held resource; the response does not prove we created it.
  console.log(`[alldebrid] job=${jobId} not cached, preserving unowned probe magnet`);
  return null;
}

/**
 * Choose what goes in the torrent's `url-list`.
 *
 * A single-file torrent can point straight at a TorBox CDN link, which takes
 * this host out of the data path entirely — RD fetches the bytes itself and we
 * carry none of them. Anything else, or any failure to mint a link, falls back
 * to our own webseed. The proxy session is registered either way so the webseed
 * still answers if RD ever asks; the source id does not prove cleanup ownership.
 */
async function pickWebseed(
  jobId: string,
  torboxTorrentId: number,
  info: torbox.TorboxTorrentInfo,
  torrentData: Buffer,
  tbOpts: torbox.TorboxOptions,
): Promise<string> {
  const proxied = proxyWebseedUrl(jobId);
  if (!config.torboxDirectWebseed) return proxied;
  if (!isSingleFileTorrent(torrentData)) {
    console.log(`[webseed] job=${jobId} multi-file, using the proxy`);
    return proxied;
  }
  try {
    const link = applyCdnEdge(
      await torbox.requestDownloadLink(torboxTorrentId, info.files[0]?.id ?? 0, tbOpts),
    );
    console.log(`[webseed] job=${jobId} direct CDN webseed, bytes bypass this host`);
    return link;
  } catch (err) {
    console.warn(`[webseed] job=${jobId} could not mint a direct link, proxying: ${err}`);
    return proxied;
  }
}

async function proxyViaTorbox(
  jobId: string,
  magnetUri: string,
  hash: string,
  imdbId: string,
  progress: ProgressReporter,
  destination: Destination,
  signal?: AbortSignal,
  torboxApiKey?: string,
): Promise<DownloadResult> {
  const tbOpts: torbox.TorboxOptions = { apiKey: torboxApiKey };

  // **Resolved before the provider add, and that ordering is load-bearing.**
  // The mirrors answer in milliseconds, but the swarm fallback behind them can
  // take minutes — and a TorBox slot is one of ten. Fetching after the add held
  // a scarce slot for the whole wait, on a job that may yet fail for want of
  // this very file. Nothing here needs the TorBox side: only the hash.
  progress.set("Fetching original torrent...");
  const torrentData = await resolveTorrentFile(hash);

  progress.set("Adding to TorBox...");
  const tb = await torbox.createDownload(magnetUri, tbOpts);

  // The response can identify an existing account torrent, including one shared
  // by another in-flight job. No authoritative creation flag means no deletion.
  progress.set("TorBox: cached, finishing...");
  const info = await waitForTorboxReady(tb.id, progress, signal, tbOpts);
  if (!info) throw new Error("TorBox download timed out or errored");

  if (info.name) progress.setName(info.name);

  const videoFiles = info.files.filter((f) => isVideoFile(f.name));
  if (videoFiles.length === 0) throw new Error("No video files found in torrent");

  // Resolve metadata, searching MDBList by the TorBox torrent name when no imdb
  // id was given, so an unidentified magnet still gets a proper title + tag.
  const resolved = await resolveMetadata(imdbId, info.name);
  const cleanName = buildCleanName(resolved.imdbId, info.name);
  const webseedUrl = await pickWebseed(jobId, tb.id, info, torrentData, tbOpts);

  progress.set("Rewriting torrent...");
  const rewritten = rewriteTorrent(torrentData, cleanName, webseedUrl, attemptSalt(jobId));

  const torrentDir = path.join(config.downloadsDir, jobId);
  ensureDir(torrentDir);
  const torrentPath = path.join(torrentDir, `${cleanName}.torrent`);
  fs.writeFileSync(torrentPath, rewritten.torrentData);

  const proxyMappings = rewritten.mappings.map((m) => {
    const tbFile = matchProviderFile(
      info.files,
      rewritten.originalName,
      info.name,
      m.originalPath,
      m.size,
    );
    const webdavPath = tbFile?.name ?? `${rewritten.originalName}/${m.originalPath}`;
    // Carry TorBox's own file id so the redirect path can mint a `requestdl`
    // link, which addresses files by id rather than by name.
    return {
      rewrittenPath: m.rewrittenPath,
      webdavPath,
      size: m.size,
      torboxFileId: tbFile?.id,
    };
  });

  // TorBox saying "cached" does not mean it will serve it. Checked here,
  // before registering, so `downloadJobFile` can still try AllDebrid —
  // after RD holds the torrent it is far too late, and the job dies as a
  // five-minute stall
  // naming the wrong cause. The torrent id lets the probe read the same CDN
  // link the proxy will stream through.
  await assertTorboxServable(jobId, proxyMappings, torboxApiKey, { torboxTorrentId: tb.id });

  registerProxySession(jobId, tb.id, proxyMappings, {
    source: "torbox",
    torboxApiKey,
    destination,
  });

  const totalSize = proxyMappings.reduce((sum, m) => sum + m.size, 0);
  console.log(
    `[proxy] job=${jobId} hash=${hash} -> ${rewritten.infoHash} name="${cleanName}" files=${proxyMappings.length} size=${totalSize}`,
  );

  return {
    filePath: torrentPath,
    webseedUrl,
    allFiles: rewritten.files,
    proxyInfoHash: rewritten.infoHash,
  };
}

/**
 * Find a provider's record for one file of the original torrent.
 *
 * Providers disagree about whether the path they report includes the torrent's
 * root folder, and about whether that folder keeps the torrent's own name — so
 * the candidates are tried in decreasing specificity, ending with a basename
 * match. Shared by the TorBox and AllDebrid paths because both have to solve
 * exactly this, against differently-shaped file lists.
 *
 * **TorBox also rewrites the names it stores.** A single-file torrent gains a
 * folder named after the file, and `&` in a file name becomes `and`, so no
 * spelling of the torrent's own path exists on its side. "Alpha (2026) Hindi"
 * (2026-11-04) failed 94 jobs for 59 people that way: unmatched, the file got
 * no TorBox id, the probe asked WebDAV for a path TorBox never had, and the
 * job died as "cached but serves 404". When the names disagree, the size
 * settles it as long as only one file has it, and failing that the names are
 * compared loosely. A match that is not unique is no match.
 */
export function matchProviderFile<T extends { name: string; size?: number }>(
  files: T[],
  originalName: string,
  providerRootName: string,
  originalPath: string,
  size?: number,
): T | undefined {
  const fullOrigPath = `${originalName}/${originalPath}`;
  const rootPath = providerRootName ? `${providerRootName}/${originalPath}` : null;
  const byPath =
    files.find((f) => f.name === fullOrigPath) ||
    files.find((f) => f.name === originalPath) ||
    (rootPath ? files.find((f) => f.name === rootPath) : undefined) ||
    files.find((f) => f.name.endsWith(`/${originalPath}`));
  if (byPath) return byPath;
  const bySize = size === undefined ? [] : files.filter((f) => f.size === size);
  if (bySize.length === 1) return bySize[0];
  const wanted = looseName(basename(originalPath));
  const byLooseName = files.filter((f) => looseName(basename(f.name)) === wanted);
  return byLooseName.length === 1 ? byLooseName[0] : undefined;
}

const basename = (p: string) => p.slice(p.lastIndexOf("/") + 1);
/** Lowercase, `&` as `and`, and nothing but letters and digits. */
const looseName = (s: string) =>
  s
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "");

/**
 * Serve a cached AllDebrid release through our own webseed.
 *
 * Structurally simpler than the TorBox path: AllDebrid hands back a per-file
 * link that is self-authenticating and honours `Range`, so there is no WebDAV
 * host, no Basic auth, and no CDN-edge selection — `proxy.ts` just unlocks a
 * link per file and reads ranges off it. Multi-file works here for the same
 * reason the TorBox *direct* webseed cannot do it: we stay in the data path, so
 * nothing has to compose a URL out of the torrent's paths.
 */
async function proxyViaAlldebrid(
  jobId: string,
  magnet: alldebrid.AlldebridMagnet,
  hash: string,
  imdbId: string,
  progress: ProgressReporter,
  destination: Destination,
  signal?: AbortSignal,
  alldebridApiKey?: string,
): Promise<DownloadResult> {
  const opts: alldebrid.AlldebridOptions = { apiKey: alldebridApiKey };

  // Upload deduplicates; this id is not proof of cleanup ownership.
  progress.set("AllDebrid: cached, finishing...");
  const status = await waitForAlldebridReady(magnet.id, progress, signal, opts);
  if (!status) throw new Error("AllDebrid magnet errored or timed out");

  const releaseName = status.filename || magnet.name;
  if (releaseName) progress.setName(releaseName);

  const files = await alldebrid.getMagnetFiles(magnet.id, opts);
  if (files.filter((f) => isVideoFile(f.path)).length === 0) {
    throw new Error("No video files found in torrent");
  }

  progress.set("Fetching original torrent...");
  const torrentData = await resolveTorrentFile(hash);

  const resolved = await resolveMetadata(imdbId, releaseName);
  const cleanName = buildCleanName(resolved.imdbId, releaseName);
  const webseedUrl = proxyWebseedUrl(jobId);

  progress.set("Rewriting torrent...");
  const rewritten = rewriteTorrent(torrentData, cleanName, webseedUrl, attemptSalt(jobId));

  const torrentDir = path.join(config.downloadsDir, jobId);
  ensureDir(torrentDir);
  const torrentPath = path.join(torrentDir, `${cleanName}.torrent`);
  fs.writeFileSync(torrentPath, rewritten.torrentData);

  const named = files.map((f) => ({ name: f.path, size: f.size, link: f.link }));
  const proxyMappings = rewritten.mappings.map((m) => {
    const adFile = matchProviderFile(
      named,
      rewritten.originalName,
      releaseName,
      m.originalPath,
      m.size,
    );
    return {
      rewrittenPath: m.rewrittenPath,
      webdavPath: adFile?.name ?? `${rewritten.originalName}/${m.originalPath}`,
      size: m.size,
      adLink: adFile?.link,
    };
  });

  // Fail here rather than at serve time. A mapping with no link 502s every
  // range RD asks for, and RD's response to a dead webseed is to keep
  // advertising a healthy speed while progress sits frozen — so the job would
  // burn the full stall window before failing with nothing pointing at the
  // cause. This names the cause immediately.
  const unmatched = proxyMappings.filter((m) => !m.adLink).length;
  if (unmatched > 0) {
    throw new Error(`AllDebrid returned no link for ${unmatched} of ${proxyMappings.length} files`);
  }

  registerProxySession(jobId, 0, proxyMappings, {
    source: "alldebrid",
    adMagnetId: magnet.id,
    alldebridApiKey,
    destination,
  });

  const totalSize = proxyMappings.reduce((sum, m) => sum + m.size, 0);
  console.log(
    `[proxy] job=${jobId} hash=${hash} -> ${rewritten.infoHash} name="${cleanName}" files=${proxyMappings.length} size=${totalSize} source=alldebrid`,
  );

  return {
    filePath: torrentPath,
    webseedUrl,
    allFiles: rewritten.files,
    proxyInfoHash: rewritten.infoHash,
  };
}

/**
 * Serve a release out of Real-Debrid through our own webseed.
 *
 * The mirror image of `proxyViaAlldebrid`, and structurally the same: RD hands
 * back a per-file restricted link; `/unrestrict/link` mints a seven-day,
 * account-specific URL. Downloads are IP-tracked even when a foreign IP gets
 * a successful response: mint and consume it from this account's one host.
 *
 * **A release the account already holds is used as-is and never deleted.** RD
 * has no by-hash lookup and `addMagnet` does not deduplicate, so adding blindly
 * would both create a second torrent and — because RD stalls forever on
 * duplicate content — leave that duplicate at 0% until the stall detector killed
 * the job. Looking first avoids the duplicate, and knowing we did not create it
 * is what stops cleanup deleting a library item the submitter owns.
 */
async function proxyViaRealdebrid(
  jobId: string,
  magnetUri: string,
  hash: string,
  imdbId: string,
  progress: ProgressReporter,
  destination: Destination,
  signal?: AbortSignal,
  realdebridApiKey?: string,
  realdebridAccount?: string,
  cancelled?: () => boolean,
): Promise<DownloadResult> {
  const opts: rd.RdOptions = { apiKey: realdebridApiKey, account: realdebridAccount };

  // Fetched before the add, not after it: RD judges an add on the torrent's
  // root name, and the bare-hash magnet DMM submits carries no name at all.
  progress.set("Fetching original torrent...");
  const torrentData = await resolveTorrentFile(hash);

  progress.set("Checking Real-Debrid...");
  const existing = await rd.findTorrentByHash(hash, opts);

  let torrentId: string;
  let addedByUs = false;
  if (existing) {
    console.log(`[realdebrid] job=${jobId} hash=${hash} already in the account, reusing`);
    torrentId = existing.id;
  } else {
    progress.set("Adding to Real-Debrid...");
    // A name RD filters is never sent; any other 451 is usually the account
    // being blocked for a few minutes, so the add waits that out before this
    // source gives up (`rd-account-block.ts`). The status update on each wait
    // also keeps the stall clock off it.
    torrentId = await rd.addMagnet(magnetUri, {
      ...opts,
      names: [torrentName(torrentData)],
      signal,
      cancelled,
      onHold: (hold) => progress.set(describeAddHold(hold)),
    });
    addedByUs = true;
    await rd.selectFiles(torrentId, undefined, opts);
  }

  // Until registration, only this stack frame records a newly created RD id.
  // Unlike deduplicating TB/AD adds, an RD add proves creation.
  let registered = false;
  try {
    return await (async () => {
      const info = await waitForRealdebridReady(torrentId, progress, signal, opts);
      if (!info) throw new Error("Real-Debrid torrent errored or timed out");

      const releaseName = info.filename;
      if (releaseName) progress.setName(releaseName);

      const selected = info.files.filter((f) => f.selected === 1);
      if (selected.filter((f) => isVideoFile(f.path)).length === 0) {
        throw new Error("No video files found in torrent");
      }
      // Only equal counts establish a per-file positional mapping. RD may
      // return one archive for the whole selection instead.
      if (selected.length !== info.links.length) {
        throw new Error("Real-Debrid returned bundled links rather than per-file links");
      }

      const resolved = await resolveMetadata(imdbId, releaseName);
      const cleanName = buildCleanName(resolved.imdbId, releaseName);
      const webseedUrl = proxyWebseedUrl(jobId);

      progress.set("Rewriting torrent...");
      const rewritten = rewriteTorrent(torrentData, cleanName, webseedUrl, attemptSalt(jobId));

      const torrentDir = path.join(config.downloadsDir, jobId);
      ensureDir(torrentDir);
      const torrentPath = path.join(torrentDir, `${cleanName}.torrent`);
      fs.writeFileSync(torrentPath, rewritten.torrentData);

      const named = selected.map((f, i) => ({
        // RD paths start with a leading slash; the torrent's do not.
        name: f.path.replace(/^\//, ""),
        size: f.bytes,
        link: info.links[i],
      }));
      const proxyMappings = rewritten.mappings.map((m) => {
        const rdFile = matchProviderFile(
          named,
          rewritten.originalName,
          releaseName,
          m.originalPath,
          m.size,
        );
        return {
          rewrittenPath: m.rewrittenPath,
          webdavPath: rdFile?.name ?? `${rewritten.originalName}/${m.originalPath}`,
          size: m.size,
          rdLink: rdFile?.link,
        };
      });

      // Fail here rather than at serve time, for the reason spelled out on the
      // AllDebrid path: a mapping with no link 502s every range, and the
      // destination answers a dead webseed by stalling with nothing naming why.
      const unmatched = proxyMappings.filter((m) => !m.rdLink).length;
      if (unmatched > 0) {
        throw new Error(
          `Real-Debrid returned no link for ${unmatched} of ${proxyMappings.length} files`,
        );
      }

      registerProxySession(jobId, 0, proxyMappings, {
        source: "realdebrid",
        realdebridApiKey,
        destination,
        // Only when we created it. A pre-existing torrent belongs to the
        // submitter and must survive this job.
        ...(addedByUs ? { rdSourceTorrentId: torrentId } : {}),
      });
      registered = true;

      const totalSize = proxyMappings.reduce((sum, m) => sum + m.size, 0);
      console.log(
        `[proxy] job=${jobId} hash=${hash} -> ${rewritten.infoHash} name="${cleanName}" files=${proxyMappings.length} size=${totalSize} source=realdebrid`,
      );

      return {
        filePath: torrentPath,
        webseedUrl,
        allFiles: rewritten.files,
        proxyInfoHash: rewritten.infoHash,
      };
    })();
  } catch (err) {
    if (!registered && addedByUs) {
      console.warn(`[realdebrid] job=${jobId} failed before registering, removing ${torrentId}`);
      await rd.deleteTorrent(torrentId, opts).catch((e) => {
        console.warn(`[realdebrid] job=${jobId} could not remove torrent ${torrentId}: ${e}`);
      });
    }
    throw err;
  }
}

/**
 * Wait for an RD torrent to reach `downloaded`.
 *
 * A no-op when the account already held the release, which is the case this path
 * is built around. When we added the magnet ourselves RD may genuinely have to
 * fetch it — there is no way left to ask in advance, since RD retired
 * `instantAvailability` — so the wait is bounded by the stage's stall timeout
 * and an uncached release simply fails rather than tying up a slot indefinitely.
 */
async function waitForRealdebridReady(
  torrentId: string,
  progress: ProgressReporter,
  signal?: AbortSignal,
  opts: rd.RdOptions = {},
): Promise<rd.TorrentInfo | null> {
  const deadline = Date.now() + config.stages.downloading.stallTimeoutMs;

  for (;;) {
    checkAborted(signal);
    const info = await rd.getTorrentInfo(torrentId, opts);

    if (info.status === "downloaded") return info;
    if (info.status === "error" || info.status === "dead" || info.status === "magnet_error") {
      return null;
    }
    if (Date.now() > deadline) return null;

    progress.set(`Real-Debrid: ${info.status} ${info.progress}%`);
    await sleep(config.pollIntervalMs);
  }
}

/**
 * Wait for a magnet to reach `Ready`.
 *
 * Normally a no-op — this path is only entered when `upload` already reported
 * `ready: true` — but that flag says AllDebrid holds the content, not that it
 * has finished unpacking it into servable files (status codes 2 and 3 are
 * "Compressing / Moving" and "Uploading"). Null means the magnet reached one of
 * the error states or stopped making progress.
 */
async function waitForAlldebridReady(
  magnetId: number,
  progress: ProgressReporter,
  signal?: AbortSignal,
  opts: alldebrid.AlldebridOptions = {},
): Promise<alldebrid.AlldebridStatus | null> {
  const deadline = Date.now() + config.stages.downloading.stallTimeoutMs;

  for (;;) {
    checkAborted(signal);
    const status = await alldebrid.getMagnetStatus(magnetId, opts);

    if (status.statusCode === alldebrid.AD_STATUS_READY) return status;
    if (alldebrid.isAlldebridError(status.statusCode)) return null;
    if (Date.now() > deadline) return null;

    progress.set(`AllDebrid: ${status.status}`);
    await sleep(config.pollIntervalMs);
  }
}

const QBIT_SAVE_PATH = process.env.QBIT_SAVE_PATH || "/opt/debrid/qbit-cache";
const qbit = new QbitClient();

async function proxyViaQbit(
  jobId: string,
  magnetUri: string,
  hash: string,
  imdbId: string,
  progress: ProgressReporter,
  signal?: AbortSignal,
): Promise<DownloadResult> {
  progress.set("Adding to qBittorrent...");
  await qbit.addMagnet(magnetUri, QBIT_SAVE_PATH, true);

  progress.set("Waiting for metadata...");
  const files = await waitForQbitMetadata(hash, signal);
  if (files.length === 0) throw new Error("No files found in torrent");

  const torrents = await qbit.getTorrents(hash);
  if (torrents[0]?.name) progress.setName(torrents[0].name);
  const torrentName = torrents[0]?.name ?? hash;

  const videoFiles = files.filter((f) => isVideoFile(f.name));
  if (videoFiles.length === 0) throw new Error("No video files found in torrent");

  progress.set("Fetching original torrent...");
  const torrentData = await fetchTorrentFile(hash);

  // Resolve metadata, searching MDBList by the qBittorrent torrent name when no
  // imdb id was given, so an unidentified magnet still gets a proper title + tag.
  const resolved = await resolveMetadata(imdbId, torrentName);
  const cleanName = buildCleanName(resolved.imdbId, torrentName);
  const webseedUrl = proxyWebseedUrl(jobId);

  progress.set("Rewriting torrent...");
  const rewritten = rewriteTorrent(torrentData, cleanName, webseedUrl, attemptSalt(jobId));

  const torrentDir = path.join(config.downloadsDir, jobId);
  ensureDir(torrentDir);
  const torrentPath = path.join(torrentDir, `${cleanName}.torrent`);
  fs.writeFileSync(torrentPath, rewritten.torrentData);

  const proxyMappings = rewritten.mappings.map((m) => {
    const localPath = path.join(QBIT_SAVE_PATH, torrentName, m.originalPath);
    const qbitIdx = files.findIndex(
      (f) => f.name === m.originalPath || f.name === `${torrentName}/${m.originalPath}`,
    );
    return {
      rewrittenPath: m.rewrittenPath,
      webdavPath: localPath,
      size: m.size,
      qbitFileIndex: qbitIdx >= 0 ? qbitIdx : undefined,
    };
  });

  registerProxySession(jobId, -1, proxyMappings, { source: "qbit", qbitHash: hash });

  const smallFileIds = proxyMappings
    .filter((m) => !isVideoFile(m.rewrittenPath) && m.qbitFileIndex !== undefined)
    .map((m) => m.qbitFileIndex as number);
  if (smallFileIds.length > 0) {
    await qbit.setFilePriority(hash, smallFileIds, 7).catch((err) => {
      console.warn(`[qbit] failed to prioritize small files: ${err}`);
    });
  }

  const totalSize = proxyMappings.reduce((sum, m) => sum + m.size, 0);
  console.log(
    `[qbit] job=${jobId} hash=${hash} -> ${rewritten.infoHash} name="${cleanName}" files=${proxyMappings.length} size=${totalSize}`,
  );

  return {
    filePath: torrentPath,
    webseedUrl,
    allFiles: rewritten.files,
    proxyInfoHash: rewritten.infoHash,
  };
}

async function waitForQbitMetadata(
  hash: string,
  signal?: AbortSignal,
): Promise<{ name: string; size: number }[]> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    checkAborted(signal);
    const files = await qbit.getFiles(hash);
    if (files.length > 0) return files;
    await sleep(2000);
  }
  throw new Error("qBit metadata timeout");
}

async function waitForTorboxReady(
  torrentId: number,
  progress: ProgressReporter,
  signal?: AbortSignal,
  opts: torbox.TorboxOptions = {},
): Promise<torbox.TorboxTorrentInfo | null> {
  const stallTimeout = config.stages.downloading.stallTimeoutMs;
  let lastProgress = -1;
  let lastMovedAt = Date.now();

  for (;;) {
    checkAborted(signal);
    const info = await torbox.getTorrentInfo(torrentId, opts);

    if (info.download_state === "completed" || info.progress >= 1) {
      return info;
    }
    if (info.download_state === "error") return null;

    if (info.progress > lastProgress) {
      lastProgress = info.progress;
      lastMovedAt = Date.now();
    } else if (Date.now() - lastMovedAt > stallTimeout) {
      return null;
    }

    const pct = (info.progress * 100).toFixed(0);
    progress.set(`TorBox: ${info.download_state} ${pct}%`);
    await sleep(config.pollIntervalMs);
  }
}

async function fetchMdbInfoIfConfigured(imdbId: string): Promise<MdbInfo | undefined> {
  // By accuracy: DMM's merged record, then the sources that give a film's
  // original release year, then OMDb, whose year is the US release.
  const sources: MetadataSource[] = [
    {
      key: config.dmmMetadataSecret,
      fn: (id, key, fetcher) => fetchDmmInfo(id, key, fetcher, config.dmmMetadataUrl),
    },
    { key: config.mdblistApiKey, fn: fetchMdbInfo },
    { key: config.tmdbApiKey, fn: fetchTmdbInfo },
    { key: config.omdbApiKey, fn: fetchOmdbInfo },
  ];
  if (!imdbId || sources.every((s) => !s.key)) return undefined;
  try {
    return await fetchMediaInfo(imdbId, sources);
  } catch {
    return undefined;
  }
}

/**
 * Resolve the imdb id and metadata for a job. If an imdb id was given and
 * resolves, use it. Otherwise identify the torrent from its parsed release title
 * and year — DMM's resolver first, MDBList's search if DMM cannot say — so a
 * magnet added without an imdb id still lands as `Saw IV (2007) {imdb-tt0890870}`.
 * Best-effort: any failure degrades to the next-best naming rather than
 * aborting the download.
 */
async function resolveMetadata(
  imdbId: string,
  releaseName: string,
): Promise<{ imdbId: string; info?: MdbInfo }> {
  if (imdbId) {
    const info = await fetchMdbInfoIfConfigured(imdbId);
    if (info) return { imdbId, info };
  }
  const parsed = parseRelease(releaseName);
  const parsedYear = parsed?.year ? Number(parsed.year) : undefined;
  if (parsed && config.dmmMetadataSecret) {
    const found = await resolveViaDmm(
      parsed.title,
      parsedYear,
      config.dmmMetadataSecret,
      fetch,
      config.dmmMetadataUrl,
    );
    if (found) return found;
  }
  if (config.mdblistApiKey) {
    if (parsed) {
      try {
        const found = await searchMedia(
          parsed.title,
          parsed.year ? Number(parsed.year) : undefined,
          config.mdblistApiKey,
        );
        if (found) return found;
      } catch {
        // best-effort; fall through to release-name naming
      }
    }
  }
  return { imdbId: imdbId || "unknown" };
}

function checkAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const reason = signal.reason instanceof Error ? signal.reason : new Error("Download aborted");
    throw reason;
  }
}
