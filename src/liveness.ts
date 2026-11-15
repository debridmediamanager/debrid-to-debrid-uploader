/**
 * Liveness judged by traffic: is this job moving any bytes at all?
 *
 * The stall detector in `worker.ts` asks whether a job is *advancing*, off RD's
 * `progress` and the webseed high-water mark, and gives it five minutes. This
 * asks the weaker and much faster question — whether anything is moving in
 * either direction — because a job RD has stopped reading holds a concurrency
 * slot, a TorBox slot and a share of the API budget while achieving nothing, and
 * there is no information to gain by waiting out the longer window.
 *
 * Kept here rather than inline in `monitorRd` because `worker.ts` is excluded
 * from coverage: the arming rule below is the whole subtlety of the feature and
 * it needs tests holding it in place.
 */
export type IdleClock = {
  /** Total bytes moved in either direction as of the last observation. */
  bytes: number;
  /** When that total last grew. */
  since: number;
};

export function startIdleClock(now: number): IdleClock {
  return { bytes: 0, since: now };
}

/** What the job has done since the last observation. */
export type IdleSignals = {
  /** Bytes moved in either direction, as a running total. */
  bytes: number;
  /**
   * Whether RD itself advanced — its `progress`, or the webseed high-water mark.
   *
   * **Load-bearing, and its absence shipped a regression.** The first version
   * judged liveness on proxy bytes alone, on the reasoning that a job RD has
   * stopped reading is a job doing nothing. That is false: RD stops reading our
   * webseed for stretches while still reporting `downloading` — verifying
   * pieces, flushing to disk, buffering — and comes back. On 2026-08-08 that
   * killed four jobs which were plainly advancing, including one at **99.2%**
   * with RD reporting 2.2 MB/s. The five-minute stall detector never had this
   * flaw because it always reset on `progress` *or* `reachedBytes`; this is the
   * same signal, so that a shorter window cannot condemn a job the longer one
   * would spare.
   */
  advanced: boolean;
};

/**
 * Fold the job's current activity into the clock.
 *
 * **The clock is disarmed until the job moves its first byte**, and that is a
 * correctness requirement rather than an optimisation. On the direct-webseed
 * path (`TORBOX_DIRECT_WEBSEED`) a proxy session is registered but RD fetches
 * from the CDN itself, so this box serves none of the bytes for the whole life
 * of a perfectly healthy job. An armed-from-zero clock would kill every one of
 * them at the timeout. The same holds in the gap between a session being
 * registered and RD issuing its first range.
 */
export function tickIdleClock(
  clock: IdleClock,
  { bytes, advanced }: IdleSignals,
  now: number,
  timeoutMs: number,
): { clock: IdleClock; idle: boolean } {
  if (advanced || bytes > clock.bytes) {
    // The high-water mark, not the reading: a rehydrated session restarts its
    // counters at zero, and that must not look like the job going backwards.
    return { clock: { bytes: Math.max(bytes, clock.bytes), since: now }, idle: false };
  }
  return { clock, idle: clock.bytes > 0 && now - clock.since > timeoutMs };
}

/**
 * Push the deadline out without touching the arming state.
 *
 * For the stretches when RD is doing internal work of its own — `uploading` to
 * its storage, `compressing`, `queued` — where it reads nothing from us and zero
 * traffic is the *expected* state. Killing a job on that is exactly the bug that
 * threw away finished transfers on 2026-08-07, so those phases hold the clock
 * open and get their own far longer budget instead.
 */
export function holdIdleClock(clock: IdleClock, now: number): IdleClock {
  return { bytes: clock.bytes, since: now };
}
