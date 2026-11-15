/**
 * A FIFO concurrency gate.
 *
 * The service had none: `app.ts` and `index.ts` both call `processJob` without
 * awaiting it, so parallelism was simply however many jobs arrived or were
 * resumed at once — measured at 21 concurrent on debrid02. That is fine when
 * jobs trickle in and ruinous the moment a batch lands, because every in-flight
 * job holds a TorBox slot (ten on Pro), an API call budget, and a proxy stream
 * carrying full-size chunks. A bulk requeue would have hit all three limits at
 * once, and TorBox's abuse system treats exactly that burst shape as abuse.
 */
export class JobQueue {
  private readonly limit: number;
  private active: number;
  private readonly waiting: (() => void)[];

  /**
   * Fields are assigned here rather than as class field initializers: Bun
   * counts each initializer as an uncovered function and caps the file below
   * the 100% threshold. See the note in `metrics.ts`.
   */
  constructor(limit: number) {
    // A non-positive limit would deadlock every job forever rather than
    // disabling the gate, which is the more dangerous reading of a typo'd env.
    this.limit = Math.max(1, Math.floor(limit));
    this.active = 0;
    this.waiting = [];
  }

  /** Jobs running right now. */
  get running(): number {
    return this.active;
  }

  /** Jobs admitted but not yet started. */
  get queued(): number {
    return this.waiting.length;
  }

  /**
   * Run `fn` once a slot is free, releasing the slot however it settles.
   *
   * The slot is held for the whole of `fn`, retry backoff included — a job
   * sleeping between attempts is still in flight and should not let a fifth
   * job start. `retryOrFail` therefore re-enters the *inner* runner rather
   * than this gate, or a retrying job would wait on a slot it is itself
   * holding and deadlock at the cap.
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => {
      this.waiting.push(resolve);
    });
  }

  /**
   * Hand the slot to the next waiter *without* decrementing.
   *
   * Releasing and letting the waiter re-check would be a race: two waiters can
   * both observe `active < limit` before either increments, and the cap is
   * silently exceeded. Transferring the slot directly makes that impossible.
   */
  private release(): void {
    const next = this.waiting.shift();
    if (next) {
      next();
      return;
    }
    this.active--;
  }
}
