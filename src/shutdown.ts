/**
 * Drain in-flight requests on shutdown instead of severing them.
 *
 * The service had no signal handling at all, and systemd sends `SIGINT` on every
 * `systemctl restart` — so a deploy killed the process mid-response and every
 * webseed range RD was reading died with it. Measured on Bun 1.3.14 against a
 * streaming response: with no handler the client got 5120 of 15360 bytes and a
 * closed socket; with `await server.stop()` it got all 15360.
 *
 * That matters more than a truncated read usually would. The bytes already sent
 * were pulled from the submitter's TorBox account and billed to them, so a
 * severed range spends their quota on nothing — and RD's Transmission client
 * treats a dead webseed as a reason to back off, which is how a deploy turns
 * into a stalled job rather than a brief pause.
 *
 * Jobs themselves need no draining: they live in SQLite and `resumeIncompleteJobs`
 * picks them up on boot. Verified live 2026-08-08 — a job interrupted at 48.6%
 * resumed and carried on to 59.7% with its retry count untouched. What was
 * missing was only the courtesy of finishing the response already in flight.
 */
export type Stoppable = {
  /** `Bun.serve`'s stop. Unforced, it resolves once in-flight requests finish. */
  stop: () => Promise<void> | void;
};

export type ShutdownOutcome = "drained" | "timeout" | "already";

let shuttingDown = false;

/**
 * Whether a shutdown is under way.
 *
 * The worker checks this before starting a queued job: admitting one during the
 * drain would create a TorBox torrent moments before the process dies, leaking
 * the slot with no row to clean it up from. A job left `pending` costs nothing —
 * boot recovery starts it a second later.
 */
export function isShuttingDown(): boolean {
  return shuttingDown;
}

/** Test seam: clear the flag between cases. */
export function _resetShutdown(): void {
  shuttingDown = false;
}

/**
 * Stop accepting connections, let in-flight responses finish, and report how it
 * went.
 *
 * Bounded by `timeoutMs` because a slow range must not hold the restart open
 * indefinitely — systemd's `TimeoutStopSec` would `SIGKILL` us anyway, which is
 * the severing this exists to avoid, so we would rather give up deliberately and
 * say so. Idempotent: systemd is entitled to send the signal more than once, and
 * a second drain would race the first.
 */
export async function gracefulShutdown(
  signal: string,
  server: Stoppable,
  opts: {
    timeoutMs: number;
    log?: (message: string) => void;
    delay?: (ms: number) => Promise<void>;
  },
): Promise<ShutdownOutcome> {
  if (shuttingDown) return "already";
  shuttingDown = true;

  const log = opts.log ?? console.log;
  const delay = opts.delay ?? ((ms: number) => Bun.sleep(ms));
  log(`[shutdown] ${signal}: draining in-flight requests`);

  const timedOut = Symbol("timeout");
  const race = await Promise.race([
    Promise.resolve(server.stop()).then(() => "drained" as const),
    delay(opts.timeoutMs).then(() => timedOut),
  ]);

  if (race === timedOut) {
    log(`[shutdown] still busy after ${opts.timeoutMs}ms, exiting anyway`);
    return "timeout";
  }
  log("[shutdown] drained");
  return "drained";
}
