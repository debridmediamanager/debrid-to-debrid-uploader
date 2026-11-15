/**
 * A job that has used its whole wall-clock budget.
 *
 * `retryOrFail` fails it on sight rather than sending it round the retry ladder.
 * A retry re-enters with the budget *already spent*, so three attempts would
 * turn a 6h ceiling into an 18h one while holding a concurrency slot, a TorBox
 * slot and a share of the API budget the entire time.
 */
export class MaxDurationError extends Error {
  constructor(elapsedMs: number, budgetMs: number) {
    super(
      `job exceeded its ${Math.round(budgetMs / 60_000)} minute budget ` +
        `(ran ${Math.round(elapsedMs / 60_000)} minutes)`,
    );
    this.name = "MaxDurationError";
  }
}

/**
 * A release too large to be worth starting.
 *
 * Terminal, like `MaxDurationError`, and for a stronger reason: a release does
 * not shrink between attempts, so the ladder could only re-derive the same size
 * three times while re-creating the provider torrent each round.
 */
export class OversizeError extends Error {
  constructor(totalBytes: number, capBytes: number) {
    super(
      `release is ${(totalBytes / 1e9).toFixed(1)} GB, ` +
        `over the ${Math.round(capBytes / 1e9)} GB limit`,
    );
    this.name = "OversizeError";
  }
}

/**
 * Whether this release is past the size the service will attempt at all.
 *
 * Every byte here is paid for twice — in from the provider, out to the
 * destination — and only the outbound half is billed, so a job that fails after
 * moving most of a release costs exactly as much as one that succeeds. Measured
 * across 30 days on both hosts, **0 of 14 releases above 200 GB ever completed**
 * while burning 6.05 TB, and the largest success on record is 186.1 GB. A 100 GB
 * cap refuses 29 magnets carrying 8.76 TB — 35% of all egress — at the price of
 * 7 that would have succeeded.
 *
 * The refusal is free because the size arrives long before the payload does:
 * a job's `torrent_files` rows are written **4-12 seconds** after it starts,
 * whether the release is 0.4 GB or 651 GB, and the bytes only move later when
 * the destination pulls through the webseed.
 *
 * A cap of `0` disables the limit rather than refusing everything, so the
 * feature can be turned off with an env var without failing every job.
 */
export function exceedsSizeCap(totalBytes: number | null, capBytes: number): boolean {
  if (capBytes <= 0) return false;
  if (totalBytes === null || totalBytes <= 0) return false;
  return totalBytes > capBytes;
}

/** The knobs a budget is derived from. See `config.jobBudget`. */
export type BudgetConfig = {
  /** Never less than this, however small the release. */
  minMs: number;
  /**
   * The budget for a job whose size is not known yet — and *only* that.
   *
   * It used to clamp the scaled budget too, which silently stopped the scaling
   * at `maxMs / bytesPerSec`: 45 GB on the production numbers. See
   * `budgetMsFor`.
   */
  maxMs: number;
  /** Assumed end-to-end throughput used to scale the budget by size. */
  bytesPerSec: number;
};

/**
 * How long this job may run, scaled by how much data it has to move.
 *
 * A flat cap cannot separate "stuck" from "big", because both produce the same
 * wall clock — and here they are genuinely different populations. Measured
 * across 370 real completions, the jobs a flat 2h cap would have killed had a
 * **median size of 54 GiB against a 10 GiB median overall**: almost purely large
 * releases moving at TorBox's ordinary 4-6 MB/s, not stuck ones. Scaling by size
 * spares those while still catching a small job that has gone nowhere.
 *
 * `bytesPerSec` is an outer bound rather than a target. Observed effective
 * throughput is p10 2.7 MB/s and p50 6.3 MB/s, so the 2 MB/s default sits below
 * the slowest healthy decile and only bites something slower than anything that
 * has ever succeeded here.
 *
 * **An unknown size yields the ceiling, never the floor.** Size is only known
 * once the torrent's files are recorded, so a job is legitimately sizeless
 * early on, and missing metadata must never be grounds for killing it. That is
 * the one thing `maxMs` is still for.
 *
 * **A known size is no longer clamped to `maxMs`.** It used to be, which meant
 * the scaling silently stopped at `maxMs / bytesPerSec` — 45 GB on the
 * production numbers — and past that the budget was frozen while the size kept
 * growing. The throughput a job needed to survive therefore climbed with its
 * size: measured 2026-08-29, the 13 jobs pinned at the 360-minute ceiling
 * needed between 4.2 and 32.0 MB/s against an observed p90 of 12.8, so the
 * large ones were arithmetically doomed and still spent 4285 GB proving it.
 * `exceedsSizeCap` bounds the budget now — refusing a release outright, before
 * any bytes move, rather than giving it a deadline it cannot meet.
 */
export function budgetMsFor(totalBytes: number | null, cfg: BudgetConfig): number {
  if (totalBytes === null || totalBytes <= 0) return cfg.maxMs;
  const scaled = (totalBytes / cfg.bytesPerSec) * 1000;
  return Math.max(cfg.minMs, scaled);
}

/**
 * Milliseconds this job has left, or `null` when it has no recorded start.
 *
 * A null `started_at` means it has never run — it is queued behind
 * `MAX_CONCURRENT_JOBS`, or predates the column — and a queued job must not burn
 * budget it is not using. This is why the cap keys on `started_at` rather than
 * `created_at`, which includes queue wait.
 */
export function remainingMs(
  startedAt: string | null,
  totalBytes: number | null,
  nowMs: number,
  cfg: BudgetConfig,
): number | null {
  if (!startedAt) return null;
  // SQLite stores naive UTC (`YYYY-MM-DD HH:MM:SS`); the `Z` is what stops the
  // host's local zone being applied and shifting the budget by hours.
  const started = new Date(`${startedAt}Z`).getTime();
  if (Number.isNaN(started)) return null;
  return budgetMsFor(totalBytes, cfg) - (nowMs - started);
}

/** Whether this job has outlived its budget. */
export function hasExceededBudget(
  startedAt: string | null,
  totalBytes: number | null,
  nowMs: number,
  cfg: BudgetConfig,
): boolean {
  const left = remainingMs(startedAt, totalBytes, nowMs, cfg);
  return left !== null && left <= 0;
}

/** Elapsed run time in ms, or null when the job has no recorded start. */
export function elapsedMs(startedAt: string | null, nowMs: number): number | null {
  if (!startedAt) return null;
  const started = new Date(`${startedAt}Z`).getTime();
  return Number.isNaN(started) ? null : nowMs - started;
}

/** What a stage running under `withExtendableTimeout` can do with its deadline. */
export type ExtendableTimeout = {
  /** Push the deadline back by `ms`, for a wait the stage chose rather than suffered. */
  extend(ms: number): void;
  /** Aborts when the deadline passes, so a deliberate wait stops with the stage. */
  signal: AbortSignal;
};

/**
 * A stage wall clock that does not count the waits the stage chooses.
 *
 * `preparing` gets one minute to add a torrent and select its files, which is
 * plenty for the requests and nowhere near the ~7 minutes an add may now spend
 * waiting out an account block on Real-Debrid (`rd-account-block.ts`). Those
 * waits are reported through `extend`, so the minute still bounds a hung
 * request without condemning a job for being patient on purpose.
 *
 * The timeout also aborts `signal`. A plain race would reject and leave the
 * losing work running, and an add still waiting on its ladder would then wake
 * minutes later and create a torrent nobody records, while the retried stage
 * creates another.
 */
export function withExtendableTimeout<T>(
  run: (timeout: ExtendableTimeout) => Promise<T>,
  ms: number,
): Promise<T> {
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    let deadline = Date.now() + ms;
    const expire = () => {
      const err = new Error(`Stage timed out after ${Math.round(ms / 60_000)} minutes`);
      controller.abort(err);
      reject(err);
    };
    let timer = setTimeout(expire, ms);
    const extend = (more: number) => {
      deadline += more;
      clearTimeout(timer);
      timer = setTimeout(expire, deadline - Date.now());
    };
    run({ extend, signal: controller.signal }).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
