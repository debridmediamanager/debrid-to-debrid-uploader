import fs from "node:fs";
import path from "node:path";
import { config } from "./config";
import {
  clearJobSecrets,
  destinationOf,
  getJob,
  getJobRealdebridApiKey,
  getJobTotalBytes,
  getRdSourceTorrentId,
  getTorrentFiles,
  insertTorrentFiles,
  type Job,
  type JobStatus,
  markJobStarted,
  TERMINAL_STATUSES,
  updateJob,
  updateTorrentFileRdLink,
} from "./db";
import {
  budgetMsFor,
  elapsedMs,
  exceedsSizeCap,
  hasExceededBudget,
  MaxDurationError,
  OversizeError,
  withExtendableTimeout,
} from "./deadline";
import { downloadMagnet } from "./downloads";
import { holdIdleClock, startIdleClock, tickIdleClock } from "./liveness";
import {
  formatAmplification,
  formatStageReport,
  type ResourceProbe,
  StageRecorder,
} from "./metrics";
import * as premiumize from "./premiumize";
import { proxyReachedBytes, proxyStats, removeProxySession } from "./proxy";
import { QbitClient } from "./qbittorrent";
import { describeAddHold } from "./rd-account-block";
import * as rd from "./realdebrid";
import { isShuttingDown } from "./shutdown";
import { assertNotTakenDown } from "./takedown";
import { isTerminalError } from "./terminal";
import * as torbox from "./torbox";
import { sleep } from "./utils/async";
import { JobQueue } from "./utils/job-queue";

const qbit = new QbitClient();

/**
 * The process-wide concurrency gate. Every externally triggered job goes
 * through it; the retry path deliberately does not (see `runJob`).
 */
const queue = new JobQueue(config.maxConcurrentJobs);

/** Jobs running and waiting, for the dashboard and logs. */
export function queueDepth(): { running: number; queued: number } {
  return { running: queue.running, queued: queue.queued };
}

type ActiveStage = "downloading" | "preparing" | "uploading";
const ACTIVE_STAGES = new Set<JobStatus>(["downloading", "preparing", "uploading"]);

// ------------------------------------------------------- stage measurement

/** How often the recorder samples RSS and measures its own tardiness. */
const SAMPLE_INTERVAL_MS = 250;

/** The real process. `metrics.ts` takes this injected so its tests stay pure. */
const processProbe: ResourceProbe = {
  now: () => performance.now(),
  cpuMicros: () => {
    const { user, system } = process.cpuUsage();
    return user + system;
  },
  rssBytes: () => process.memoryUsage.rss(),
};

/**
 * Runs one stage with measurement around it, and logs the report either way —
 * a stage that failed is exactly the one whose resource profile matters. This
 * is what turns the `rd.*`/`proxy.*`/`torbox.*` counters into something you can
 * read per stage instead of only as the `[serve]` line at the very end.
 *
 * The sampling timer is `unref`d so a stage never keeps the process alive, and
 * cleared in `finally` so a throw cannot leak it.
 */
/**
 * Throw if this job has already outlived its size-scaled budget.
 *
 * Checked at every stage boundary here, and again on each `monitorRd` poll —
 * `uploading` is a single stage that can legitimately run for hours, so a
 * boundary-only check would never fire during the one phase that needs it.
 */
/** Throw if this release is larger than the service will attempt. */
function assertWithinSizeCap(jobId: string): void {
  const bytes = getJobTotalBytes(jobId);
  if (!exceedsSizeCap(bytes, config.maxJobBytes)) return;
  throw new OversizeError(bytes as number, config.maxJobBytes);
}

function assertWithinBudget(jobId: string): void {
  const job = getJob(jobId);
  if (!job) return;
  const bytes = getJobTotalBytes(jobId);
  const now = Date.now();
  if (!hasExceededBudget(job.started_at, bytes, now, config.jobBudget)) return;
  throw new MaxDurationError(
    elapsedMs(job.started_at, now) ?? 0,
    budgetMsFor(bytes, config.jobBudget),
  );
}

async function measured<T>(jobId: string, stage: string, run: () => Promise<T>): Promise<T> {
  assertWithinBudget(jobId);
  const recorder = new StageRecorder(stage, processProbe, SAMPLE_INTERVAL_MS);
  const ticker = setInterval(() => recorder.sample(), SAMPLE_INTERVAL_MS);
  ticker.unref?.();

  try {
    const result = await run();
    console.log(formatStageReport(jobId, recorder.finish("ok")));
    return result;
  } catch (err) {
    console.log(formatStageReport(jobId, recorder.finish("failed")));
    throw err;
  } finally {
    clearInterval(ticker);
  }
}

/**
 * Public entry point: waits for a slot, then runs the job.
 *
 * Callers still fire this without awaiting — the gate is what bounds them now,
 * so a hundred simultaneous submissions become a hundred queued jobs rather
 * than a hundred concurrent ones.
 */
export async function processJob(jobId: string): Promise<void> {
  // Starting a job during the drain would create a provider torrent moments
  // before the process dies, leaking the slot with no row to clean it up from.
  // Left `pending`, boot recovery picks it up a second later.
  if (isShuttingDown()) {
    console.log(`[queue] job=${jobId} deferred, shutting down`);
    return;
  }
  const { running, queued } = queueDepth();
  if (running >= config.maxConcurrentJobs) {
    console.log(`[queue] job=${jobId} waiting (running=${running} queued=${queued})`);
  }
  return queue.run(() => runJob(jobId));
}

/**
 * The job itself, already holding a slot.
 *
 * `retryOrFail` re-enters *here* rather than `processJob`: a retrying job is
 * still holding its slot, so going back through the gate would have it wait on
 * itself and deadlock the whole service once four jobs were retrying.
 */
async function runJob(jobId: string): Promise<void> {
  const job = getJob(jobId);
  // `deleted` is checked here and again before every retry. `deleteJob` only
  // sets the flag and drops the proxy session — it cannot interrupt a stage
  // already in flight, so without this a deleted job keeps downloading, keeps
  // retrying, and still uploads to RD.
  if (!job || job.deleted === 1 || TERMINAL_STATUSES.has(job.status)) return;

  // Start the budget clock on the first attempt only. A retry re-enters here and
  // must inherit the elapsed time rather than win a fresh allowance.
  markJobStarted(jobId);

  try {
    // Re-checked on every start, retry and boot resume: the list can gain this
    // release while the job waits for a slot. Inside the try so `retryOrFail`
    // fails it (terminal) and releases whatever an earlier attempt holds.
    assertNotTakenDown(job);
    await runPipeline(job);
    updateJob(jobId, { status: "completed" });
    cleanupJobFiles(jobId);
    // Last, always: cleanup still needs the submitter's key to delete an owned
    // RD source or a failed destination.
    clearJobSecrets(jobId);
  } catch (err: unknown) {
    await retryOrFail(job, err);
  }
}

async function runPipeline(job: Job): Promise<void> {
  let current = job;

  if (current.status === "pending" || current.status === "downloading") {
    const job = current;
    const result = await measured(job.id, "downloading", () => downloadJobFile(job));

    updateJob(current.id, {
      status: "preparing",
      file_path: result.filePath,
      webseed_url: result.webseedUrl,
      info_hash: result.proxyInfoHash ?? null,
      retry_count: 0,
    });
    if (result.allFiles.length > 0) {
      insertTorrentFiles(current.id, result.allFiles);
    }
    // The one moment the size is known and the payload has not moved: the files
    // land 4-12s after the job starts, whichever size the release is, and the
    // bytes only flow later when the destination pulls through the webseed. A
    // release refused here therefore costs no transfer at all, which is the
    // entire point — see `exceedsSizeCap`.
    assertWithinSizeCap(current.id);
    current = requireJob(current.id);
    // The release name is first known here, from the source provider, and no
    // destination has been handed the torrent yet.
    assertNotTakenDown(current);
  }

  if (current.status === "preparing") {
    const job = current;
    const torrentPath = requireJobField(job.file_path, "file_path");
    // The rewritten torrent is destination-agnostic — it is the same file either
    // way, carrying our webseed in `url-list`. Only who is handed it differs.
    if (destinationOf(job) === "torbox") {
      const created = await measured(job.id, "preparing", () =>
        withTimeout(
          torbox.createTorrentFromFile(torrentPath, { apiKey: tbKeyFor(job) }),
          config.stages.preparing.timeoutMs,
        ),
      );
      updateJob(job.id, {
        status: "uploading",
        dest_torrent_id: String(created.id),
        retry_count: 0,
      });
    } else if (destinationOf(job) === "premiumize") {
      const created = await measured(job.id, "preparing", () =>
        withTimeout(
          premiumize.createTransferFromFile(torrentPath, { apiKey: pmKeyFor(job) }),
          config.stages.preparing.timeoutMs,
        ),
      );
      // Premiumize ids are opaque strings (`h-Y6kyaJw83KmhUCzi0AhA`), not
      // numbers, so this one goes into the column as it came out.
      updateJob(job.id, {
        status: "uploading",
        dest_torrent_id: created.id,
        retry_count: 0,
      });
    } else {
      const opts = rdOptsFor(job);
      // A 451 here is RD blocking the account, not refusing the release: the
      // name and file names were de-infringed and the info hash is fresh. The
      // add waits it out (`rd-account-block.ts`), and those waits extend the
      // stage's minute rather than spending it.
      const rdId = await measured(job.id, "preparing", () =>
        withExtendableTimeout(
          ({ extend, signal }) =>
            rd
              .addTorrent(torrentPath, {
                ...opts,
                names: [
                  path.basename(torrentPath, ".torrent"),
                  ...getTorrentFiles(job.id).map((f) => f.name),
                ],
                signal,
                cancelled: () => isDeleted(job.id),
                onHold: (hold) => {
                  extend(hold.waitMs);
                  updateJob(job.id, { status_message: describeAddHold(hold) });
                },
              })
              .then(async (id) => {
                const info = await rd.getTorrentInfo(id, opts);
                const streamable = info.files.filter((f) => rd.isRdStreamable(f.path));
                await rd.selectFiles(
                  id,
                  streamable.length > 0 ? streamable.map((f) => f.id) : undefined,
                  opts,
                );
                return id;
              }),
          config.stages.preparing.timeoutMs,
        ),
      );
      updateJob(job.id, { status: "uploading", rd_torrent_id: rdId, retry_count: 0 });
    }
    current = requireJob(current.id);
  }

  if (current.status === "uploading") {
    const job = current;
    if (destinationOf(job) === "torbox") {
      await measured(job.id, "uploading", () =>
        monitorTorboxDestination(
          job.id,
          Number(requireJobField(job.dest_torrent_id, "dest_torrent_id")),
          job.info_hash,
          { apiKey: tbKeyFor(job) },
        ),
      );
    } else if (destinationOf(job) === "premiumize") {
      await measured(job.id, "uploading", () =>
        monitorPremiumizeDestination(
          job.id,
          requireJobField(job.dest_torrent_id, "dest_torrent_id"),
          job.info_hash,
          { apiKey: pmKeyFor(job) },
        ),
      );
    } else {
      const rdInfo = await measured(job.id, "uploading", () =>
        monitorRd(job.id, requireJobField(job.rd_torrent_id, "rd_torrent_id"), rdOptsFor(job)),
      );
      saveRdLinks(job.id, rdInfo);
    }
    // Log what the destination's pass actually cost before the session (and its
    // totals) go.
    const stats = proxyStats(current.id);
    if (stats) console.log(formatAmplification(current.id, stats));
    endProxySession(current.id);
  }
}

/**
 * Watch a TorBox-destination transfer to completion.
 *
 * The counterpart to `monitorRd`, and it takes the same two liveness signals for
 * the same reasons: the destination's own `progress`, and `proxyReachedBytes` —
 * how far the destination has been served across our webseed. `servedBytes`
 * alone would not do, because a job spinning on one range keeps serving bytes
 * while getting nowhere.
 *
 * TorBox's failure mode for a webseed that has died is `stalled (no seeds)`,
 * which is exactly the state a torrent with no swarm *and* no working webseed
 * falls into — measured as the negative control when this direction was proven.
 * It is deliberately not treated as terminal on sight: TorBox reports it during
 * ordinary startup too, before the first webseed range lands, so the stall
 * window is what distinguishes a slow start from a dead seed.
 */
async function monitorTorboxDestination(
  jobId: string,
  torrentId: number,
  infoHash: string | null,
  opts: torbox.TorboxOptions,
): Promise<void> {
  const stallTimeoutMs = config.stages.uploading.stallTimeoutMs;
  let lastProgress = -1;
  let lastReached = -1;
  let lastProgressAt = Date.now();

  while (true) {
    assertWithinBudget(jobId);
    let info: torbox.TorboxTorrentInfo;
    try {
      info = await torbox.getTorrentInfo(torrentId, opts);
    } catch (err) {
      // **A vanished row is how a finished transfer often looks.** TorBox drops
      // the torrent once it is complete and not seeding (we ask for `seed: 3`),
      // after which `mylist?id=` answers `DATABASE_ERROR` indefinitely. Observed
      // live on a 12.4 GB job that had in fact completed: the content was in the
      // account, byte-identical to the source, while the monitor saw nothing but
      // errors and was heading for a stall failure — which would then have
      // deleted the delivered copy on the way out. So ask the cache, which is
      // keyed on the *rewritten* hash we handed TorBox.
      if (await torboxHasContent(infoHash, opts)) {
        console.log(`[uploading] job=${jobId} torrent gone from the list but cached, complete`);
        updateJob(jobId, { status_message: null });
        return;
      }
      // Otherwise the same policy as `monitorRd`: one bad poll must not kill a
      // live transfer, and TorBox answers `DATABASE_ERROR` often enough that it
      // would.
      if (Date.now() - lastProgressAt > stallTimeoutMs) {
        throw new StallError("uploading", stallTimeoutMs);
      }
      console.log(`[uploading] job=${jobId} poll failed, retrying: ${(err as Error).message}`);
      await sleep(config.pollIntervalMs);
      continue;
    }

    const pct = Math.round((info.progress ?? 0) * 100);
    updateJob(jobId, { status_message: `TorBox: ${info.download_state} ${pct}%` });

    if (info.download_state === "completed" || info.download_state === "cached") {
      updateJob(jobId, { status_message: null });
      return;
    }
    if (info.download_state === "error") {
      throw new Error(`TorBox torrent failed: ${info.download_state}`);
    }

    const reached = proxyReachedBytes(jobId) ?? lastReached;
    const advanced = info.progress > lastProgress || reached > lastReached;
    if (advanced) {
      lastProgress = info.progress;
      lastReached = reached;
      lastProgressAt = Date.now();
    } else if (Date.now() - lastProgressAt > stallTimeoutMs) {
      throw new StallError("uploading", stallTimeoutMs);
    }

    // **No two-minute idle clock here, deliberately.** `monitorRd` runs one
    // because RD reads the webseed steadily and a two-minute silence there says
    // something is wrong. TorBox does not behave that way: it pulls in bursts and
    // goes quiet for stretches while still reporting `downloading` — measured
    // repeatedly at ~1 minute mid-transfer, and **over two minutes at 92%** of a
    // 12.4 GB job that was otherwise healthy, which failed it on the spot. That
    // is the codebase's own rule turned against itself: a shorter window must
    // take the same signals as the longer one, or it can only ever condemn jobs
    // the longer one would have spared. Here it can only do that, so the
    // five-minute progress detector above and the size-scaled job budget are the
    // bounds — and both take `progress` *or* `reachedBytes`.
    await sleep(config.pollIntervalMs);
  }
}

/**
 * Whether TorBox holds the content for a rewritten hash.
 *
 * Only consulted when the torrent row has gone, so a `true` here means the
 * transfer landed rather than that some earlier copy happened to be cached —
 * every hash we hand TorBox is unique per attempt (`attemptSalt`), so nothing
 * else can have put it there.
 */
async function torboxHasContent(
  infoHash: string | null,
  opts: torbox.TorboxOptions,
): Promise<boolean> {
  if (!infoHash) return false;
  return torbox.checkCached(infoHash, opts);
}

/**
 * Watch a Premiumize-destination transfer to completion.
 *
 * The counterpart to `monitorTorboxDestination`, and it differs in one way that
 * matters: **Premiumize runs two phases and its `progress` resets between
 * them.** First it pulls from our webseed (`"38.93 MB/s from 0 peer, 143.2 MB of
 * 2.3 GB"`), then it moves the file into cloud storage under a fresh 0..1 count
 * (`"File 1 of 1: 339.88 MB of 2.32 GB uploaded"`). Measured 2026-08-29 on a
 * 2.49 GB release: ~60s for the first phase, ~40s for the second.
 *
 * So liveness cannot be `progress > lastProgress` the way it is for TorBox and
 * RD — that test reads the reset as "no progress" and would condemn a healthy
 * job during the phase change. Any *change* counts here instead, message
 * included, because the second phase is the one stretch where our own
 * `proxyReachedBytes` cannot help: Premiumize already holds every byte by then
 * and never asks the webseed for another.
 */
async function monitorPremiumizeDestination(
  jobId: string,
  transferId: string,
  infoHash: string | null,
  opts: premiumize.PremiumizeOptions,
): Promise<void> {
  const stallTimeoutMs = config.stages.uploading.stallTimeoutMs;
  let lastProgress: number | null = -1;
  let lastMessage: string | null = null;
  let lastReached = -1;
  let lastProgressAt = Date.now();

  while (true) {
    assertWithinBudget(jobId);
    let transfer: premiumize.PremiumizeTransfer | null;
    try {
      transfer = await premiumize.getTransfer(transferId, opts);
    } catch (err) {
      // One bad poll must not kill a live transfer, the same policy as the other
      // two monitors.
      if (Date.now() - lastProgressAt > stallTimeoutMs) {
        throw new StallError("uploading", stallTimeoutMs);
      }
      console.log(`[uploading] job=${jobId} poll failed, retrying: ${(err as Error).message}`);
      await sleep(config.pollIntervalMs);
      continue;
    }

    if (!transfer) {
      // A vanished row is not failure on its own: `transfer/clearfinished` drops
      // finished transfers, and the list is the only place a transfer's state
      // lives. Ask the cache, which is keyed on the rewritten hash we handed
      // Premiumize, before believing anything went wrong.
      if (await premiumizeHasContent(infoHash, opts)) {
        console.log(`[uploading] job=${jobId} transfer gone from the list but cached, complete`);
        updateJob(jobId, { status_message: null });
        return;
      }
      if (Date.now() - lastProgressAt > stallTimeoutMs) {
        throw new StallError("uploading", stallTimeoutMs);
      }
      await sleep(config.pollIntervalMs);
      continue;
    }

    const pct = Math.round((transfer.progress ?? 0) * 100);
    updateJob(jobId, { status_message: `Premiumize: ${transfer.status} ${pct}%` });

    // `seeding` counts as done: Premiumize has every byte by the time it reaches
    // that state, and the job asked for a copy in the account, not for the
    // transfer row to reach any particular resting place.
    if (transfer.status === "finished" || transfer.status === "seeding") {
      updateJob(jobId, { status_message: null });
      return;
    }
    if (transfer.status === "error") {
      throw new Error(`Premiumize transfer failed: ${transfer.message ?? transfer.status}`);
    }

    const reached = proxyReachedBytes(jobId) ?? lastReached;
    const advanced =
      transfer.progress !== lastProgress ||
      transfer.message !== lastMessage ||
      reached > lastReached;
    if (advanced) {
      lastProgress = transfer.progress;
      lastMessage = transfer.message;
      lastReached = reached;
      lastProgressAt = Date.now();
    } else if (Date.now() - lastProgressAt > stallTimeoutMs) {
      throw new StallError("uploading", stallTimeoutMs);
    }

    await sleep(config.pollIntervalMs);
  }
}

/** Whether Premiumize holds the content for a rewritten hash. */
async function premiumizeHasContent(
  infoHash: string | null,
  opts: premiumize.PremiumizeOptions,
): Promise<boolean> {
  if (!infoHash) return false;
  return premiumize.checkCached(infoHash, opts);
}

async function downloadJobFile(job: Job) {
  const progress = createStallProgress(job.id);
  updateJob(job.id, { status: "downloading" });

  try {
    const options = {
      ...(job.force_qbit ? { forceWebtorrent: true } : {}),
      torboxApiKey: tbKeyFor(job),
      alldebridApiKey: job.ad_api_key ?? undefined,
      realdebridApiKey: job.rd_api_key ?? undefined,
      realdebridAccount: job.rd_user_id ?? undefined,
      cancelled: () => isDeleted(job.id),
      destination: destinationOf(job),
    };
    return await downloadMagnet(
      job.id,
      job.input,
      job.imdb_id ?? "",
      progress,
      progress.signal,
      options,
    );
  } finally {
    progress.dispose();
  }
}

function createJobProgress(jobId: string) {
  return {
    set(statusMessage: string) {
      updateJob(jobId, { status_message: statusMessage });
    },
    setName(name: string) {
      updateJob(jobId, { name });
    },
    clear() {
      updateJob(jobId, { status_message: null });
    },
  };
}

export function createStallProgress(jobId: string) {
  const stallTimeoutMs = config.stages.downloading.stallTimeoutMs;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = setTimeout(
    () => controller.abort(new StallError("downloading", stallTimeoutMs)),
    stallTimeoutMs,
  );

  const base = createJobProgress(jobId);

  return {
    ...base,
    signal: controller.signal,
    set(statusMessage: string) {
      base.set(statusMessage);
      if (timer) clearTimeout(timer);
      timer = setTimeout(
        () => controller.abort(new StallError("downloading", stallTimeoutMs)),
        stallTimeoutMs,
      );
    },
    dispose() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}

async function retryOrFail(job: Job, err: unknown): Promise<void> {
  const current = getJob(job.id) ?? job;
  const message = err instanceof Error ? err.message : String(err);
  // Deleted mid-stage: the failure we are handling is most likely the deletion
  // pulling the files out from under the stage, so there is nothing to retry
  // and nothing to record.
  if (current.deleted === 1) {
    endProxySession(current.id);
    return;
  }
  if (!isActiveStage(current.status)) {
    failJob(current, message);
    return;
  }

  // A verdict is terminal; an outage is not. The list lives in `terminal.ts`
  // with the reasoning for each entry, because this file is excluded from
  // coverage and the decision has to be testable.
  if (isTerminalError(err)) {
    failJob(current, message);
    return;
  }

  const stage = current.status;
  const stageConfig = config.stages[stage];
  const maxRetries = stageConfig.maxRetries;
  const newRetry = current.retry_count + 1;

  if (newRetry < maxRetries) {
    console.log(
      `[retry] job=${job.id} stage=${stage} attempt=${newRetry}/${maxRetries} error=${message}`,
    );
    updateJob(current.id, { retry_count: newRetry, error: message });
    await sleep(Math.min(1000 * 2 ** newRetry, 30_000));
    return runJob(current.id);
  }

  failJob(current, message, newRetry);
}

/**
 * Put a job permanently to rest and reclaim resources this service owns.
 *
 * One function rather than three copies, because each copy has to remember the
 * *destination* torrent as well as the source resources — and a TorBox
 * destination left behind by a failed job holds one of only ten account slots
 * for the full seed window. The three call sites had already drifted once over
 * exactly this kind of cleanup (see the `DELETE /jobs/:id` note in CLAUDE.md).
 *
 * `cleanupJobFiles` releases only an authoritatively created RD source before
 * dropping the session rows holding its id. Failed destinations are read from
 * the job row; deduplicated TB/AD sources remain untouched.
 */
function failJob(job: Job, message: string, retryCount?: number): void {
  updateJob(job.id, {
    status: "failed",
    error: message,
    ...(retryCount === undefined ? {} : { retry_count: retryCount }),
  });
  releaseFailedTorboxDestination(job);
  releaseFailedPremiumizeDestination(job);
  cleanupJobFiles(job.id);
  // Only reached on permanent failure — a retry keeps the active stage and
  // never lands here, so the keys survive every attempt that still has one
  // left. Last, for the same reason as the completion path.
  clearJobSecrets(job.id);
}

/**
 * RD options for a job: its own key when the submitter provided one, otherwise
 * an empty object so `realdebrid.ts` falls back to the shared env key. This is
 * what routes each user's content into their own Real-Debrid account.
 *
 * `account` is the resolved RD account behind the key, which is what an
 * account-wide 451 block is held under, so two jobs on one account hold
 * together and jobs on different accounts never do.
 */
function rdOptsFor(job: Job): rd.RdOptions {
  if (!job.rd_api_key) return {};
  return { apiKey: job.rd_api_key, account: job.rd_user_id ?? undefined };
}

/**
 * The TorBox key for a job, on the same fall-back-to-env rule as `rdOptsFor`.
 * Undefined leaves the provider clients on the shared account, which is what
 * every operator-submitted job wants.
 */
function tbKeyFor(job: Job): string | undefined {
  return job.tb_api_key ?? undefined;
}

/** The Premiumize key for a job, on the same rule as `tbKeyFor`. */
function pmKeyFor(job: Job): string | undefined {
  return job.pm_api_key ?? undefined;
}

async function monitorRd(jobId: string, rdId: string, opts: rd.RdOptions): Promise<rd.TorrentInfo> {
  const stallTimeoutMs = config.stages.uploading.stallTimeoutMs;
  let lastProgress = -1;
  let lastReached = -1;
  let lastProgressAt = Date.now();
  // Traffic-based liveness, disarmed until the job moves its first byte.
  let idleClock = startIdleClock(Date.now());
  // When RD last entered a phase of its own (0 = it is downloading from us).
  let internalPhaseSince = 0;

  while (true) {
    // The stall detectors ask whether RD is *advancing*; a job can advance the
    // whole way and still outrun its total budget, so the ceiling needs its own
    // check on the poll that is already happening.
    assertWithinBudget(jobId);
    let info: rd.TorrentInfo;
    try {
      info = await rd.getTorrentInfo(rdId, opts);
    } catch (err) {
      // A revoked token or a torrent RD no longer has will answer the same way
      // on every poll, so riding it out only spends the stall window to arrive
      // at a worse error message. Surface it as itself, at once.
      if (rd.isPermanentRdError(err)) throw err;
      // A transient RD API failure (already retried inside getTorrentInfo) must
      // not kill a download that is otherwise progressing — a stray 429/5xx mid
      // poll would otherwise burn one of only two `uploading` stage retries and
      // fail the job near the finish, since retry_count never resets on
      // progress. Keep polling; only a sustained outage, i.e. no successful poll
      // for the whole stall window, escalates to a stage retry.
      if (Date.now() - lastProgressAt > stallTimeoutMs) {
        throw new StallError("uploading", stallTimeoutMs);
      }
      console.log(`[uploading] job=${jobId} poll failed, retrying: ${(err as Error).message}`);
      await sleep(config.pollIntervalMs);
      continue;
    }
    const speed = ((info.speed || 0) / 1024 / 1024).toFixed(1);
    updateJob(jobId, {
      // No `seeds=`: this is a webseed transfer with no swarm behind it, so the
      // figure was structurally 0 on every job and read as a problem.
      status_message: `RD: ${info.status} ${info.progress}% @ ${speed} MB/s`,
    });

    if (info.status === "downloaded") {
      updateJob(jobId, { status_message: null });
      return info;
    }
    if (info.status === "error" || info.status === "dead" || info.status === "magnet_error") {
      throw new Error(`RD torrent failed: ${info.status}`);
    }

    // Once RD leaves `downloading` it has all the bytes and is doing its own
    // internal work — `uploading` to its storage, `compressing`, or still
    // `queued` before it starts. Our webseed is not being read in any of those,
    // so neither liveness signal below *can* move and the stall window below
    // measures nothing. Applying it anyway threw away jobs that had already
    // transferred in full: observed 2026-08-07, a job sat at
    // `RD: uploading 100% @ 0.0 MB/s` and was killed at the five minute mark
    // with every byte already delivered. These phases get their own, far longer
    // budget so a genuinely wedged RD still fails eventually.
    if (info.status !== "downloading") {
      internalPhaseSince ||= Date.now();
      const waited = Date.now() - internalPhaseSince;
      if (waited > config.rdInternalPhaseTimeoutMs) {
        throw new StallError(`RD ${info.status}`, config.rdInternalPhaseTimeoutMs);
      }
      // Hold both windows open, so returning to `downloading` starts from a
      // clean clock rather than an already-expired one. The idle window needs
      // this most: RD moves no bytes at all through these phases, so an idle
      // timer left running would fire the instant `downloading` resumed.
      lastProgressAt = Date.now();
      idleClock = holdIdleClock(idleClock, Date.now());
      await sleep(config.pollIntervalMs);
      continue;
    }
    internalPhaseSince = 0;

    // Liveness is judged on two signals that can only move when the job really
    // is advancing: RD's own `progress`, and how far RD has been served across
    // the webseed. **Deliberately not `info.speed`.** That field counts the
    // overlap RD re-requests and discards, so it reads healthy on a job that is
    // getting nowhere: two jobs sat frozen at 99.9% and 100% for two hours
    // advertising a steady 11.6 MB/s while the host was moving 11 KB/s, and the
    // speed clause reset this timer on every poll so the stall never fired.
    // `reachedBytes` is the fix for what that clause was originally for — RD
    // sitting at 0% while genuinely pulling the front of a large multi-file
    // release — because it advances there and stays put on a wedged job, which
    // `servedBytes` would not (a re-requested range still counts as served).
    const reached = proxyReachedBytes(jobId) ?? lastReached;
    const advanced = info.progress > lastProgress || reached > lastReached;
    if (advanced) {
      lastProgress = info.progress;
      lastReached = reached;
      lastProgressAt = Date.now();
    } else if (Date.now() - lastProgressAt > stallTimeoutMs) {
      throw new StallError("uploading", stallTimeoutMs);
    }

    // The faster of the two signals: whether *anything* is happening. It takes
    // `advanced` as well as the byte totals so that a shorter window can never
    // condemn a job the five-minute one would spare — RD pauses its reads while
    // still `downloading`, and judging on bytes alone killed a job at 99.2%.
    const stats = proxyStats(jobId);
    const bytes = stats ? stats.servedBytes + stats.upstreamBytes : 0;
    const ticked = tickIdleClock(
      idleClock,
      { bytes, advanced },
      Date.now(),
      config.jobIdleTimeoutMs,
    );
    idleClock = ticked.clock;
    if (ticked.idle) throw new StallError("idle", config.jobIdleTimeoutMs);

    await sleep(config.pollIntervalMs);
  }
}

function trimRdLink(link: string): string {
  const match = link.match(/\/d\/([A-Za-z0-9]{13})/);
  return match ? `https://real-debrid.com/d/${match[1]}` : link;
}

function saveRdLinks(jobId: string, rdInfo: rd.TorrentInfo): void {
  const torrentFiles = getTorrentFiles(jobId);
  if (torrentFiles.length === 0 || rdInfo.links.length === 0) return;

  const selectedFiles = rdInfo.files.filter((f) => f.selected === 1);
  // A selection can be wrapped into one RAR. A shorter array is not a
  // partial mapping: none of its entries identifies an individual file.
  if (selectedFiles.length !== rdInfo.links.length) return;
  const assigned = new Set<number>();
  for (let i = 0; i < selectedFiles.length && i < rdInfo.links.length; i++) {
    const rdFile = selectedFiles[i];
    const rdBasename = rdFile.path.split("/").pop() ?? "";
    const match = torrentFiles.find(
      (tf) => !assigned.has(tf.id) && tf.name === rdBasename && tf.size === rdFile.bytes,
    );
    if (match) {
      updateTorrentFileRdLink(match.id, trimRdLink(rdInfo.links[i]));
      assigned.add(match.id);
    }
  }
}

export class StallError extends Error {
  constructor(stage: string, timeoutMs: number) {
    super(`${stage} stalled: no progress for ${Math.round(timeoutMs / 60_000)} minutes`);
    this.name = "StallError";
  }
}

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Stage timed out after ${Math.round(ms / 60_000)} minutes`)),
      ms,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function requireJob(id: string): Job {
  const job = getJob(id);
  if (!job) throw new Error(`Job disappeared while processing: ${id}`);
  return job;
}

function requireJobField(value: string | null, field: string): string {
  if (!value) throw new Error(`Job is missing required field: ${field}`);
  return value;
}

/** Whether the job has been deleted since it started; `deleteJob` only sets a flag. */
function isDeleted(jobId: string): boolean {
  return getJob(jobId)?.deleted === 1;
}

function isActiveStage(status: JobStatus): status is ActiveStage {
  return ACTIVE_STAGES.has(status);
}

/**
 * Release only source resources whose creation is authoritative.
 * TorBox and AllDebrid adds deduplicate, so their ids (including old sessions)
 * are not ownership evidence. Retain them rather than delete a user's library
 * item or a resource another job is still using.
 */
function releaseOwnedSource(jobId: string): void {
  // And the RD *source* torrent, but **only one this service added**. The getter
  // returns undefined for a release the submitter already had, so a job that
  // merely borrowed an existing library item can never delete it — the failure
  // mode here is somebody's own content disappearing, which no amount of slot
  // hygiene is worth.
  const rdSourceId = getRdSourceTorrentId(jobId);
  if (rdSourceId !== undefined) {
    rd.deleteTorrent(rdSourceId, { apiKey: getJobRealdebridApiKey(jobId) }).catch((err) => {
      console.warn(`[cleanup] job=${jobId} realdebrid source delete failed: ${err}`);
    });
  }
}

/**
 * Hand back the slot held by a *destination* TorBox torrent that will never
 * finish.
 *
 * Only on permanent failure. A completed one is the whole point of the job — it
 * is the copy the submitter asked for — so unlike every other resource here, the
 * success path deliberately leaves it in place.
 */
function releaseFailedTorboxDestination(job: Job): void {
  if (destinationOf(job) !== "torbox" || !job.dest_torrent_id) return;
  torbox.deleteTorrent(Number(job.dest_torrent_id), { apiKey: tbKeyFor(job) }).catch((err) => {
    console.warn(`[cleanup] job=${job.id} torbox destination delete failed: ${err}`);
  });
}

/**
 * The Premiumize counterpart, and it carries the same hazard for a stronger
 * reason: `transfer/delete` removes the **files** as well as the transfer row,
 * whatever the vendor documentation says. So this may only ever run on a job
 * that actually failed — on a delivered one it would destroy the copy it just
 * made, which is the exact mistake the TorBox path had to be taught not to
 * repeat.
 */
function releaseFailedPremiumizeDestination(job: Job): void {
  if (destinationOf(job) !== "premiumize" || !job.dest_torrent_id) return;
  premiumize.deleteTransfer(job.dest_torrent_id, { apiKey: pmKeyFor(job) }).catch((err) => {
    console.warn(`[cleanup] job=${job.id} premiumize destination delete failed: ${err}`);
  });
}

/**
 * End a job's proxy session, releasing any owned RD source first.
 *
 * The source id and ownership marker live in the session rows. Release before
 * removing them, on successful upload as well as failure and cancellation.
 */
function endProxySession(jobId: string): void {
  releaseOwnedSource(jobId);
  removeProxySession(jobId);
}

export function cleanupJobFiles(jobId: string): void {
  const job = getJob(jobId);
  if (!job) return;

  endProxySession(job.id);

  // Keyed off `input`, not `info_hash`: qBittorrent holds the *original* hash,
  // while `info_hash` is the rewritten one and is only assigned once downloading
  // has already succeeded. Gating on it meant a job that died mid-download — the
  // one case where qBittorrent is definitely still holding the torrent — left it
  // there forever. Observed live: a failed job sat in `metaDL` indefinitely.
  const hash = job.input.match(/btih:([0-9a-fA-F]+)/i)?.[1]?.toLowerCase();
  if (config.qbitEnabled && hash) {
    qbit.delete(hash, true).catch((err) => {
      console.warn(`[cleanup] job=${job.id} qbit delete failed: ${err}`);
    });
  }

  if (!job.file_path) return;
  const jobDir = path.dirname(job.file_path);
  if (!jobDir || jobDir === config.downloadsDir) return;
  try {
    fs.rmSync(jobDir, { recursive: true, force: true });
    console.log(`[cleanup] job=${job.id} removed ${jobDir}`);
  } catch (err) {
    console.warn(`[cleanup] job=${job.id} failed to remove ${jobDir}: ${err}`);
  }
}
