export type WallClockStage = { timeoutMs: number; maxRetries: number };
export type StallStage = { stallTimeoutMs: number; maxRetries: number };

/** The cached-source providers, in the order `downloads.ts` will try them. */
export type CacheSource = "torbox" | "alldebrid";
const CACHE_SOURCES: CacheSource[] = ["torbox", "alldebrid"];

/**
 * Which cached sources to try, and in what order. `CACHE_SOURCES`.
 *
 * The default puts TorBox first for a specific reason: its `checkCached` is a
 * free read-only probe, whereas AllDebrid retired both `/magnet/instant` and
 * v4 `/magnet/status`, so the only way to ask AllDebrid whether it holds a
 * release is to *add* it and read `ready` off the response. Probing AllDebrid
 * therefore can start a real download, and deduplication means we cannot safely
 * delete the returned id. Skip that mutation when TorBox already answered yes.
 * Unknown names are dropped rather than guessed at.
 */
/**
 * Accounts the per-user job limit does not apply to. `UNLIMITED_OWNERS`.
 *
 * Holds resolved *owner ids* — `rd:<id>`, `tb:<id>`, `ad:<username>` — in the same
 * `<provider>:<id>` form `owners.ts` produces, never API keys. Three reasons,
 * and each has bitten something here already: an id is not a secret, so this can
 * live in a deploy script or a config-management repo where a key could not; a
 * TorBox key is rotated on every abuse warning, which would silently drop an
 * exemption written against it; and one person holds several keys per account,
 * so a key list is a list that is never quite complete.
 *
 * Empty by default. Unknown or malformed entries are kept rather than validated
 * — an id that matches nothing simply exempts nobody, and rejecting them would
 * turn a typo in the operator's env into a service that will not boot.
 */
export function parseUnlimitedOwners(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((owner) => owner.trim())
      .filter((owner) => owner.length > 0),
  );
}

export function parseCacheSources(raw: string | undefined): CacheSource[] {
  if (!raw) return CACHE_SOURCES;
  const parsed = raw
    .split(",")
    .map((name) => name.trim())
    .filter((name): name is CacheSource => (CACHE_SOURCES as string[]).includes(name));
  return parsed.length > 0 ? parsed : CACHE_SOURCES;
}

export const config = {
  port: Number(process.env.PORT || 3100),
  host: process.env.HOST || "0.0.0.0",
  baseUrl: process.env.BASE_URL || `http://localhost:${Number(process.env.PORT || 3100)}`,
  downloadsDir: process.env.DOWNLOADS_DIR || new URL("../downloads", import.meta.url).pathname,
  torboxEmail: process.env.TORBOX_EMAIL || "",
  torboxPassword: process.env.TORBOX_PASSWORD || "",
  /**
   * Whether the qBittorrent disk-cache route is available at all. `QBIT_ENABLED`.
   *
   * **Off by default.** It was the fallback for a release no cached source
   * holds: pull the swarm to local disk and serve RD from there. That works,
   * but it makes the slowest, most bandwidth-hungry jobs the ones this host
   * carries end to end, and a job that has to leech a full release before RD
   * sees a byte is rarely worth the wait. With it off, `downloadMagnet` throws
   * `UncachedError` instead — the answer arrives in seconds rather than hours.
   *
   * The route and its tests are kept intact behind this flag rather than
   * deleted, so re-enabling is one environment variable.
   */
  qbitEnabled: process.env.QBIT_ENABLED === "true",
  /**
   * How many jobs may be in flight at once. `MAX_CONCURRENT_JOBS`.
   *
   * There was no limit at all before: both `POST /jobs` and the boot recovery
   * loop fire `processJob` without awaiting, so parallelism was whatever
   * arrived at once — 21 concurrent measured on debrid02. Every in-flight job
   * holds a TorBox slot (ten on Pro), a share of the API rate limit, and a
   * proxy stream pulling full chunks, so a batch requeue would breach all
   * three at once. TorBox's abuse system reads that burst shape as abuse, and
   * the account is already one warning in.
   */
  maxConcurrentJobs: Number(process.env.MAX_CONCURRENT_JOBS) || 4,
  qbitUrl: process.env.QBIT_URL || "http://localhost:8080",
  qbitUsername: process.env.QBIT_USERNAME || "admin",
  qbitPassword: process.env.QBIT_PASSWORD || "",
  /**
   * Last-resort metadata source when every torrent-cache mirror misses.
   * `QBIT_METADATA_FALLBACK`, **off by default**.
   *
   * A rewrite needs the original `info` dict — above all its piece hashes,
   * which nothing else can supply: not a magnet (an info hash is a
   * fingerprint), not the file list TorBox and AllDebrid return, and not DMM's
   * database, which catalogues releases without ever recording how their bytes
   * are chunked. Providers cannot help either, re-verified 2026-08-17 after
   * TorBox's v9.1 API rewrite: AllDebrid has no export endpoint at all, and
   * TorBox's `exportdata` answers `null` for **every** torrent on the account,
   * cached and completed alike, on both of its valid types (`magnet`, `file` —
   * `torrent` is rejected outright, so an older test written against that value
   * proved nothing). The reason is visible in `mylist` rather than the endpoint:
   * every torrent carries `torrent_file: false`, and `magnet` is null for cached
   * ones. TorBox keeps the bytes, not the metadata file, so no parameter will
   * ever make that endpoint answer.
   *
   * So the mirrors were a hard dependency, and as of 2026-08-17 **all four are
   * dead** — confirmed against Big Buck Bunny and Sintel, not obscure releases.
   * Both itorrents domains redirect to one hardcoded decoy (see `itorrents.ts`),
   * btcache.me serves an HTML page, and torrage.info 403s without a browser
   * agent and 404s with one. This is therefore no longer a fallback: it is the
   * only path to a piece-hash list that exists.
   *
   * BEP 9 is the protocol's own answer, and qBittorrent already speaks it. This
   * asks a swarm for metadata **only**: the magnet is added, the `info` dict is
   * exported the moment it arrives, and the torrent is removed. No payload is
   * ever written — a resolved torrent sits in `missingFiles`, which is the
   * intended end state, not an error.
   *
   * **Off by default because it changes what this host does on the network.**
   * Every other route here is a client of an API; this one briefly joins a
   * swarm, announces to trackers and is visible to peers. That is precisely the
   * exposure `QBIT_ENABLED=false` avoids, and it is an operator's decision
   * rather than a default.
   */
  qbitMetadataFallback: process.env.QBIT_METADATA_FALLBACK === "true",
  /**
   * How long to let a swarm answer. `QBIT_METADATA_TIMEOUT_MS`, default 3 min.
   *
   * Measured on debrid02: a heavily-seeded release answered in **3 seconds**, a
   * real 4K scene release in **125 seconds** — one transient leecher appeared
   * at t+120s and handed the `info` dict over. So the useful window is minutes,
   * not seconds. It is only ever spent on a job that would otherwise have
   * failed outright, which is what makes a wait this long the right trade.
   *
   * **Raised from 3 to 5 minutes on 2026-08-17, when the mirrors stopped being
   * a fallback at all.** With all four dead this is no longer the second of two
   * chances — it is the only source of piece hashes the service has, so the 55
   * seconds of margin the old default left over that 125s observation was far
   * too thin. The wait is unusually cheap to extend: a metadata fetch transfers
   * **no payload and writes nothing to disk** (verified — `downloaded: 0` and
   * qBittorrent's save path is never even created), so the only costs are a
   * concurrency slot and a longer window of swarm visibility.
   */
  qbitMetadataTimeoutMs: Number(process.env.QBIT_METADATA_TIMEOUT_MS) || 300_000,
  /**
   * How long any one torrent-cache mirror may take. `TORRENT_MIRROR_TIMEOUT_MS`,
   * default 10s.
   *
   * `fetchTorrentFile` races the mirrors with `Promise.any`, which resolves on
   * the first success but waits for *every* attempt before it rejects. Nothing
   * bounded those calls and Bun's `fetch` has no default timeout, so one mirror
   * that stalled mid-response held the metadata stage open indefinitely. Now
   * that all four mirrors are dead, every job takes the reject path, so this is
   * the ceiling on how long a job waits before the swarm is asked at all.
   */
  torrentMirrorTimeoutMs: Number(process.env.TORRENT_MIRROR_TIMEOUT_MS) || 10_000,
  r2Bucket: process.env.R2_BUCKET || "dbrd",
  r2PublicUrl: process.env.R2_PUBLIC_URL || "https://upload.debridmediamanager.com",
  r2MountPath: process.env.R2_MOUNT_PATH || "",
  /**
   * Range expansion for the TorBox path, where every byte is billable egress.
   *
   * RD asks for ~1MB and accepts an oversized 206, but it does not remember
   * that an earlier oversized response already covered the range it asks for
   * next — so most of the surplus is re-requested rather than reused, and the
   * expansion multiplies straight into TorBox's rolling bandwidth threshold,
   * whose fourth strike is a permanent ban. The sibling `nzb2rd` measured the
   * read amplification of the same 6.4GB release at 2.4x with 64MB chunks
   * against 1.44x at 8MiB.
   *
   * That measurement came from a local cache-resident source, where a request
   * costs nothing and only the byte count matters. TorBox adds a real HTTPS
   * round trip per request, so the wall-clock optimum here may sit higher than
   * 8MiB — but the bandwidth direction is not in doubt. Time a job before
   * raising it, and watch `proxy.upstream_bytes`.
   */
  torboxChunkSize: Number(process.env.TORBOX_CHUNK_SIZE) || 8 * 1024 * 1024,
  /**
   * HTTP proxy for every TorBox-bound request. `TORBOX_PROXY_URL`.
   *
   * Set to an HTTP proxy and everything this box sends TorBox — the REST API in
   * `torbox.ts` as much as each range pulled from a CDN link or WebDAV —
   * egresses through it, so TorBox sees the proxy's address rather than this
   * host's. In production that is Cloudflare WARP, reached through a local
   * privoxy bridge (`http://127.0.0.1:8118`) purely because WARP offers SOCKS5
   * and Bun's `fetch` supports only `http(s)` proxies.
   *
   * **The API used to be exempt, and that defeated the point.** Only the data
   * path was proxied, so `checkcached` and `createtorrent` announced this host's
   * address seconds before the *same API key* pulled bytes from a WARP one —
   * two halves of one job, joinable on the credential they share, which left the
   * proxy hiding nothing from the only party it was meant to hide from.
   * Verified 2026-08-07 that the API answers `200` through WARP: TorBox keys are
   * not IP-bound the way AllDebrid's are, so both planes can agree.
   *
   * **Scoped to TorBox on purpose.** AllDebrid binds a key to the IPs it has
   * been confirmed from and answers `AUTH_BLOCKED` from anywhere else — needing
   * a human to click a link in an email — so routing that path through a shared
   * WARP address would break it on the first request. Real-Debrid is the other
   * side of the webseed and never fetched from here at all.
   *
   * Empty disables it, which restores the previous direct behaviour.
   * Measured 2026-08-06 on debrid02, 8MiB ranges against TorBox WebDAV: 3.73s
   * direct against 3.74s through WARP, i.e. no measurable cost.
   */
  torboxProxyUrl: process.env.TORBOX_PROXY_URL || "",
  /**
   * `User-Agent` sent on every TorBox-bound request. `TORBOX_USER_AGENT`.
   *
   * Nothing used to set one, so Bun supplied `Bun/<version>` — naming both the
   * runtime and its exact patch level on every API call and every range. That is
   * a stable identifier which survives a change of egress address entirely, so
   * proxying the bytes while still announcing the runtime would have been half a
   * fix. privoxy does not rewrite it either (checked 2026-08-07: a `curl` probe
   * arrived at the far end still calling itself `curl`), so it has to be set
   * here.
   *
   * rclone is the default because it is what this traffic already looks like —
   * sequential ranged reads against `webdav.torbox.app`, which is how most
   * people mount TorBox — and the version tracks the rclone actually installed
   * on these hosts for the R2 upload.
   */
  torboxUserAgent: process.env.TORBOX_USER_AGENT || "rclone/v1.74.1",
  /**
   * How long a job may move **zero bytes in either direction** before it counts
   * as stalled. `JOB_IDLE_TIMEOUT_MS`, default 2 minutes.
   *
   * This is a second, faster liveness signal sitting alongside the five-minute
   * `progress`/`reachedBytes` window, and it asks a strictly weaker question:
   * not "is this job advancing" but "is it doing anything at all". A job whose
   * webseed RD has stopped reading moves no bytes, and there is nothing to wait
   * five minutes to learn — it is holding a concurrency slot, a TorBox slot and
   * a share of the API budget while achieving nothing.
   *
   * **It arms only after the job has moved its first byte**, which is what keeps
   * it off the direct-webseed path: with `TORBOX_DIRECT_WEBSEED` the session is
   * registered but RD fetches from the CDN itself, so this box legitimately
   * serves nothing for the whole job and an unarmed clock never fires.
   *
   * It is also suspended whenever RD is in a phase of its own — see
   * `rdInternalPhaseTimeoutMs`. Zero traffic is the *expected* state there, and
   * killing on it is precisely the bug that threw away completed transfers on
   * 2026-08-07.
   */
  jobIdleTimeoutMs: Number(process.env.JOB_IDLE_TIMEOUT_MS) || 2 * 60_000,
  /**
   * How many jobs one account may have in the pipeline at once.
   * `MAX_JOBS_PER_USER`, default 1.
   *
   * Counted over `pending` *and* the active stages together, so this is not a
   * concurrency limit — it is a limit on how much of the queue one account may
   * occupy. A submission over the limit is rejected outright rather than
   * queued, because a queue is what the limit exists to stop.
   *
   * Applied to the TorBox account and the Real-Debrid account independently,
   * whichever is hit first, and to the *resolved account* rather than the key
   * (see `owners.ts`).
   *
   * **The shared operator keys are one account.** Every job submitted without
   * its own credentials resolves to the same pair, so at the default of 1 this
   * host accepts one operator job at a time and rejects the rest — a large
   * change for anything that submits in bulk. Raise it here if that is not what
   * you want; it is the one number that decides.
   */
  maxJobsPerUser: Number(process.env.MAX_JOBS_PER_USER) || 1,
  /**
   * The same limit for a sponsor. `MAX_JOBS_PER_USER_SPONSOR`, default 3.
   *
   * This is the sponsor perk on this service, and it is deliberately *not* the
   * "skip the queue" that nzb2rd got: there is no queue here to skip. A
   * submission over `maxJobsPerUser` is refused with a 429 rather than parked,
   * so what a sponsor actually feels is being refused less often — the pipeline
   * itself is still gated by `maxConcurrentJobs`, which nobody bypasses.
   *
   * Kept well under that gate on purpose. Every in-flight job holds a TorBox
   * slot, and the shared account's 10 (plan 2 is Pro) are shared with
   * rd-uploader and every other consumer; a sponsor tier that could outrun
   * `maxConcurrentJobs` would spend slots this host does not have.
   */
  maxJobsPerUserSponsor: Number(process.env.MAX_JOBS_PER_USER_SPONSOR) || 3,
  unlimitedOwners: parseUnlimitedOwners(process.env.UNLIMITED_OWNERS),
  /**
   * How long a restart may wait for in-flight responses. `SHUTDOWN_DRAIN_MS`.
   *
   * Under systemd's `TimeoutStopSec=30`, so the drain gives up and exits before
   * systemd loses patience and `SIGKILL`s us — which would sever exactly the
   * responses this exists to protect. An 8MiB range at the ~2.5MB/s these hosts
   * see finishes in about three seconds, so the cap is slack, not a budget.
   */
  shutdownDrainMs: Number(process.env.SHUTDOWN_DRAIN_MS) || 25_000,
  /**
   * Serve the TorBox path by redirecting RD straight to a CDN link instead of
   * proxying the bytes through this box.
   *
   * The proxy currently carries every byte twice — in from TorBox, out to RD —
   * so a 45GB release moved 101GB across this NIC. A `requestdl` link is
   * self-authenticating (the token is in the query string), honours ranges, and
   * measured 67.8 MB/s from here against WebDAV's 23-31 MB/s, so handing RD the
   * URL should be both cheaper and faster. Two things are unproven and are why
   * this is a flag rather than the default: whether RD follows a 302 on a
   * webseed fetch at all, and whether the CDN URL's *original* filename trips
   * the DMCA filter that the whole torrent-rewrite exists to dodge.
   */
  webseedRedirect: process.env.WEBSEED_REDIRECT === "true",
  /**
   * Where the TorBox path fetches bytes from. `TORBOX_UPSTREAM`.
   *
   * - `webdav` — `webdav.torbox.app` with Basic auth. The original path.
   * - `cdn`    — a cached `requestdl` link, which is self-authenticating.
   *
   * Measured on debrid02 2026-08-05, three concurrent ranged reads of one
   * chunk, which is the pattern RD drives through this proxy:
   *
   * | chunk  | webdav | cdn  |
   * |--------|--------|------|
   * | 8MiB   |  7.1   | 37.2 |
   * | 16MiB  | 12.4   | 53.4 |
   * | 32MiB  | 25.9   | 71.0 |
   * | 64MiB  | 44.2   | 83.4 |
   *
   * The CDN link wins everywhere — 5.2x at the 8MiB default. Both scale hard
   * with chunk size, so the real tax at 8MiB is per-request overhead, not
   * bandwidth. Note this is orthogonal to read amplification: that is set by
   * how far a range is expanded, so switching upstream buys the speed without
   * spending another byte of billable TorBox egress.
   */
  torboxUpstream: process.env.TORBOX_UPSTREAM === "cdn" ? "cdn" : "webdav",
  /**
   * Rewrite a minted CDN link onto one of TorBox's global edges.
   * `TORBOX_CDN_EDGE` — `erth` (Cloudflare), `hare` (BunnyCDN), a comma-separated
   * list to pick from at random per link, or empty to use whatever host
   * `requestdl` returned.
   *
   * This is not a speed knob, it is what makes the CDN upstream usable at all
   * for a multi-file release. `requestdl` hands back a single-origin node
   * (`nexus-NNN.<region>.tb-cdn.st`) chosen by our IP, and those nodes fall over
   * under concurrency: 12 parallel ranged reads — what a 12-file torrent
   * produces — measured **0/12 succeeding on `ceur`** against 12/12 on both
   * `erth` (34.9 MB/s) and `hare` (35.3 MB/s). That is the `ConnectionRefused`
   * storm which stalled the 42.1GB Librarians job twice.
   *
   * Only the two global edges can be substituted this way; swapping the region
   * inside a `nexus-NNN` hostname does not resolve to a working host.
   *
   * **Defaults to `hare` as of 2026-08-23, having previously defaulted to off.**
   * A gradual-ramp measurement put a number on "fall over under concurrency":
   * a `nexus-NNN` node serves **exactly 20** concurrent connections and answers
   * every one above that with HTTP 429 — 20/24, 20/32, 20/40, 20/48, the
   * refusals rising to absorb the surplus. It is a per-host ceiling, not per
   * object and not per IP: two different files on one node share the single
   * budget of 20, while the same workload spread over two nodes runs clean.
   * Both global edges ramped to **64 concurrent with zero refusals**, so
   * substituting one does not raise the ceiling, it removes it.
   *
   * `hare` rather than the `erth,hare` spread the paragraph above would
   * suggest, because the two paths disagree and only `hare` is good on both:
   * they are indistinguishable here (64/64 each), but on the direct-webseed
   * path below the ranking inverts and `erth` collapses to 0.22 MB/s. A random
   * pick would quietly break half of those transfers. Set `erth,hare`
   * explicitly to spread across both if `TORBOX_DIRECT_WEBSEED` is off.
   *
   * Note this only bites when `TORBOX_UPSTREAM=cdn`, since nothing mints a CDN
   * link otherwise — the default WebDAV upstream is unaffected either way.
   */
  torboxCdnEdge: process.env.TORBOX_CDN_EDGE || "hare",
  /**
   * Hand RD a TorBox CDN link as the torrent's webseed, so the bytes never
   * touch this box at all. `TORBOX_DIRECT_WEBSEED`.
   *
   * **Single-file torrents only** — see `isSingleFileTorrent`. BEP19 composes
   * `<url-list><info.name>/<path>` for multi-file, and CDN links are opaque
   * per-file UUIDs with nothing to compose against. The one URL scheme that
   * would compose is WebDAV, and that needs the *original* names, which RD
   * rejects outright with `451 infringing_file`. Multi-file therefore stays on
   * the proxy; this is a structural limit, not a tuning problem.
   *
   * Verified 2026-08-05 against real RD jobs: a 4.55GB file completed at
   * 12.05 MB/s and a 1.63GB file in 240s, both with **0.005 MB/s** crossing
   * this host. Do not use a redirect to achieve the same thing — RD's webseed
   * client (Transmission/4.1.1) drops its `Range` header across both 302 and
   * 307, and silently re-fetches byte 0 forever.
   *
   * The edge matters more than anything else here: on the same 300s window,
   * `hare` completed while `erth` managed 0.22 MB/s and `ceur` stalled dead.
   * That ranking is the *inverse* of a debrid02-side benchmark, because this
   * path is CDN->RD and never touches us. Pin `TORBOX_CDN_EDGE=hare`.
   */
  torboxDirectWebseed: process.env.TORBOX_DIRECT_WEBSEED === "true",
  /**
   * Range expansion for the AllDebrid path. `ALLDEBRID_CHUNK_SIZE`.
   *
   * Separate from `torboxChunkSize` because the two are metered differently.
   * TorBox counts every outgoing byte against a rolling bandwidth threshold
   * whose fourth strike is a permanent ban, so 8MiB there is a deliberately
   * conservative number. AllDebrid is a flat unlimited premium plan with no
   * strike system, so over-fetching costs wall clock and this host's NIC
   * rather than the account — the ceiling is fair-use, not a countdown.
   *
   * It still defaults to the same 8MiB: RD does not reuse an earlier oversized
   * 206, so every byte of expansion is re-requested surplus either way. Raise
   * this before raising the TorBox one if you are trading bandwidth for speed.
   */
  alldebridChunkSize: Number(process.env.ALLDEBRID_CHUNK_SIZE) || 8 * 1024 * 1024,

  /**
   * Range expansion when Real-Debrid is the *source*. `REALDEBRID_CHUNK_SIZE`.
   *
   * RD premium is unmetered, so like AllDebrid the surplus costs wall clock and
   * this host's NIC rather than the account. It gets its own knob anyway,
   * because the consumer on the far end is different: a TorBox-destination job
   * is read by TorBox's client, which asks in 16 MiB ranges rather than RD
   * Transmission's ~426 KB, so the expansion that helps here is not the same
   * number that helps there. Defaults to 8 MiB until that is measured.
   */
  realdebridChunkSize: Number(process.env.REALDEBRID_CHUNK_SIZE) || 8 * 1024 * 1024,
  cacheSources: parseCacheSources(process.env.CACHE_SOURCES),
  fileSuffix: process.env.FILE_SUFFIX || "",
  /**
   * DMM's internal metadata API secret (`METADATA_API_SECRET` on DMM). When set,
   * DMM's merged, cached record is the first metadata source and its resolver
   * identifies torrents added without an imdb id; the direct provider keys below
   * remain the fallback when DMM is unreachable.
   */
  dmmMetadataSecret: process.env.DMM_METADATA_SECRET || "",
  dmmMetadataUrl: process.env.DMM_METADATA_URL || "https://debridmediamanager.com",
  mdblistApiKey: process.env.MDBLIST_KEY || "",
  omdbApiKey: process.env.OMDB_API_KEY || "",
  tmdbApiKey: process.env.TMDB_API_KEY || "",
  pollIntervalMs: 5000,
  /**
   * How long RD may sit in a phase of its own before the job is failed.
   * `RD_INTERNAL_PHASE_TIMEOUT_MS`.
   *
   * Separate from `stages.uploading.stallTimeoutMs` because it measures a
   * different thing. That window watches our webseed being read; once RD reports
   * `uploading`, `compressing` or `queued` it already has the bytes and is
   * working internally, so nothing we can observe moves and the five minute
   * window fires on a job that has in fact fully transferred. Generous on
   * purpose — this is only here so a permanently wedged RD still terminates.
   */
  rdInternalPhaseTimeoutMs: Number(process.env.RD_INTERNAL_PHASE_TIMEOUT_MS) || 30 * 60_000,
  stages: {
    downloading: { stallTimeoutMs: 30 * 60_000, maxRetries: 3 } satisfies StallStage,
    preparing: { timeoutMs: 1 * 60_000, maxRetries: 3 } satisfies WallClockStage,
    uploading: { stallTimeoutMs: 5 * 60_000, maxRetries: 2 } satisfies StallStage,
  },
  /**
   * Total wall-clock budget for one job, scaled by release size.
   *
   * The stall detectors above bound *inactivity* and the stage timeouts bound a
   * *stage*; nothing bounded the job. A job chains three stages and retries
   * within each, so every individual limit can be satisfied while the whole
   * thing runs for hours holding a concurrency slot and a TorBox slot.
   *
   * Calibrated against 370 real completions on both hosts. Effective throughput
   * is p10 2.74 MB/s / p50 6.27 MB/s, so 2 MB/s is below the slowest healthy
   * decile — an outer bound, not a target. The floor is debrid's observed p90
   * (1.7h, rounded to 2h) so scaling only begins to bind above ~13 GiB, and the
   * ceiling sits above the historical maximum of 7.8h.
   *
   * Why scaled rather than flat: the jobs a flat 2h cap would have killed had a
   * median size of 54 GiB against a 10 GiB median overall — they were large, not
   * stuck, and a flat cap cannot tell those apart.
   */
  /**
   * How long a freshly-added TorBox item may take to appear under WebDAV before
   * `assertTorboxServable` believes the 404.
   *
   * Not a guess: `createtorrent` returns `Found Cached Torrent` with an id
   * immediately, but the item was measured absent from `mylist`/WebDAV at 3s and
   * present at 6s (2026-08-16). The probe ran ~2s after the add and killed three
   * healthy releases in six minutes, each burning all three stage retries on the
   * same race. 25s is ~4x the observed materialisation time while staying far
   * below the genuine failure this probe exists for — an item still missing
   * *nine minutes* after being added.
   */
  torboxServableGraceMs: Number(process.env.TORBOX_SERVABLE_GRACE_MS) || 25_000,
  jobBudget: {
    minMs: Number(process.env.JOB_BUDGET_MIN_MS) || 120 * 60_000,
    // The budget for a job that has not reported its size yet, and nothing else
    // — a known size scales past this now. See `budgetMsFor`.
    maxMs: Number(process.env.JOB_BUDGET_MAX_MS) || 6 * 60 * 60_000,
    bytesPerSec: Number(process.env.JOB_BUDGET_BYTES_PER_SEC) || 2 * 1024 * 1024,
  },

  /**
   * The largest release this service will attempt, in bytes.
   *
   * Bandwidth is the whole cost of running these hosts — the servers are $5.91
   * and €4.35 a month against a 1 TB and a 20 TB egress allowance — and every
   * byte is paid twice, in from the provider and out to the destination.
   * Measured over 30 days on both hosts, **54% of all egress went to jobs that
   * failed**, and the largest single category was releases too big to finish:
   * 0 of 14 above 200 GB ever completed while burning 6.05 TB.
   *
   * 100 GB refuses 29 magnets carrying 8.76 TB a month and costs 7 successes —
   * chosen over the break-even 200 GB deliberately, to buy the extra 2.7 TB.
   * Set `MAX_JOB_BYTES=0` to disable the limit.
   */
  maxJobBytes: Number(process.env.MAX_JOB_BYTES ?? 100 * 1e9),
};
