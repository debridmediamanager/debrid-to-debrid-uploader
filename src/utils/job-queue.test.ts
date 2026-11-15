import { describe, expect, test } from "bun:test";
import { JobQueue } from "./job-queue";

/** A promise plus the handle to settle it from the test. */
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("JobQueue", () => {
  test("runs work and returns its value", async () => {
    const q = new JobQueue(4);
    expect(await q.run(async () => 42)).toBe(42);
    expect(q.running).toBe(0);
    expect(q.queued).toBe(0);
  });

  test("never exceeds the limit, and admits the rest as slots free", async () => {
    const q = new JobQueue(4);
    const gates = Array.from({ length: 10 }, () => deferred());
    let concurrent = 0;
    let peak = 0;

    const runs = gates.map((g) =>
      q.run(async () => {
        concurrent++;
        peak = Math.max(peak, concurrent);
        await g.promise;
        concurrent--;
      }),
    );

    // Ten submitted, four admitted — the cap this exists to enforce.
    await Promise.resolve();
    expect(q.running).toBe(4);
    expect(q.queued).toBe(6);

    for (const g of gates) g.resolve();
    await Promise.all(runs);

    expect(peak).toBe(4);
    expect(q.running).toBe(0);
    expect(q.queued).toBe(0);
  });

  test("releases the slot when the work throws", async () => {
    const q = new JobQueue(1);
    await expect(
      q.run(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    // A failed job must not strand its slot, or the cap ratchets down to zero
    // and the service silently stops processing anything.
    expect(q.running).toBe(0);
    expect(await q.run(async () => "next")).toBe("next");
  });

  test("hands a freed slot to the next waiter in FIFO order", async () => {
    const q = new JobQueue(1);
    const order: number[] = [];
    const first = deferred();

    const a = q.run(async () => {
      order.push(1);
      await first.promise;
    });
    const b = q.run(async () => {
      order.push(2);
    });
    const c = q.run(async () => {
      order.push(3);
    });

    // A slot is claimed synchronously, but the work itself only starts after
    // `await acquire()` yields — so let the microtask queue drain first.
    await new Promise((r) => setTimeout(r, 0));
    expect(order).toEqual([1]);

    first.resolve();
    await Promise.all([a, b, c]);
    expect(order).toEqual([1, 2, 3]);
  });

  test("a limit below one is clamped rather than deadlocking", async () => {
    // A typo'd MAX_CONCURRENT_JOBS=0 must not wedge every job forever.
    for (const bad of [0, -5]) {
      const q = new JobQueue(bad);
      expect(await q.run(async () => "ran")).toBe("ran");
    }
  });

  test("a fractional limit floors to whole slots", async () => {
    const q = new JobQueue(2.9);
    const gates = Array.from({ length: 3 }, () => deferred());
    const runs = gates.map((g) => q.run(() => g.promise));
    await Promise.resolve();
    expect(q.running).toBe(2);
    for (const g of gates) g.resolve();
    await Promise.all(runs);
  });
});
