import { describe, expect, test } from "bun:test";
import {
  budgetMsFor,
  elapsedMs,
  exceedsSizeCap,
  hasExceededBudget,
  MaxDurationError,
  OversizeError,
  remainingMs,
  withExtendableTimeout,
} from "./deadline";

const GiB = 1024 ** 3;
const MIN = 60_000;
// The production shape: a 2h floor (debrid's observed p90) and a 2 MB/s rate,
// which sits below the p10 of effective throughput measured across 370 jobs.
const CFG = { minMs: 120 * MIN, maxMs: 360 * MIN, bytesPerSec: 2 * 1024 * 1024 };

describe("budgetMsFor", () => {
  // 20 GiB at 2 MB/s is ~171 min: past the floor, short of the ceiling.
  test("scales with size between the floor and the ceiling", () => {
    const b = budgetMsFor(20 * GiB, CFG);
    expect(b).toBeGreaterThan(CFG.minMs);
    expect(b).toBeLessThan(CFG.maxMs);
    expect(budgetMsFor(30 * GiB, CFG)).toBeGreaterThan(budgetMsFor(20 * GiB, CFG));
  });

  // debrid's median release is 10 GiB and its p50 runtime 16 min, so ordinary
  // work must sit comfortably inside the floor rather than near a limit.
  test("ordinary releases get the floor", () => {
    expect(budgetMsFor(1 * GiB, CFG)).toBe(CFG.minMs);
    expect(budgetMsFor(10 * GiB, CFG)).toBe(CFG.minMs);
  });

  // The 54 GiB median of the set a flat 2h cap would have killed: these are the
  // jobs the scaling exists to spare.
  test("a 54 GiB release earns well past the floor", () => {
    expect(budgetMsFor(54 * GiB, CFG)).toBeGreaterThan(4 * 60 * MIN);
  });

  // The regression. `maxMs` used to clamp the scaled budget too, which silently
  // stopped the scaling at maxMs/bytesPerSec — 45 GB on the production numbers.
  // Past that the budget was frozen while the size kept growing, so the
  // throughput a job had to hit to survive climbed with its size: measured
  // 2026-08-29, the 13 jobs pinned at the 360-minute ceiling needed between 4.2
  // and 32.0 MB/s against an observed p90 of 12.8, and 0 of 14 releases above
  // 200 GB ever completed. The size cap bounds the budget now.
  test("a known size scales past the ceiling instead of being frozen at it", () => {
    expect(budgetMsFor(500 * GiB, CFG)).toBeGreaterThan(CFG.maxMs);
    expect(budgetMsFor(500 * GiB, CFG)).toBe(((500 * GiB) / CFG.bytesPerSec) * 1000);
  });

  test("the budget keeps growing with size at every scale", () => {
    expect(budgetMsFor(200 * GiB, CFG)).toBeGreaterThan(budgetMsFor(100 * GiB, CFG));
    expect(budgetMsFor(400 * GiB, CFG)).toBeGreaterThan(budgetMsFor(200 * GiB, CFG));
  });

  // `maxMs` survives for exactly one job: the one that has not said how big it
  // is yet. Missing metadata must never be grounds for killing something.
  test("an unknown size yields the ceiling, never the floor", () => {
    expect(budgetMsFor(null, CFG)).toBe(CFG.maxMs);
    expect(budgetMsFor(0, CFG)).toBe(CFG.maxMs);
    expect(budgetMsFor(-1, CFG)).toBe(CFG.maxMs);
  });
});

describe("remainingMs", () => {
  const START = "2026-08-16 00:00:00";
  const at = (iso: string) => new Date(iso).getTime();

  test("counts down from the start", () => {
    expect(remainingMs(START, 1 * GiB, at("2026-08-16T00:30:00Z"), CFG)).toBe(90 * MIN);
  });

  test("goes negative once the budget is spent", () => {
    expect(remainingMs(START, 1 * GiB, at("2026-08-16T02:30:00Z"), CFG)).toBe(-30 * MIN);
  });

  // Parsing the stored timestamp without the `Z` would apply the host's local
  // zone and shift every budget by the UTC offset.
  test("reads the stored timestamp as UTC", () => {
    expect(remainingMs(START, 1 * GiB, at("2026-08-16T00:00:00Z"), CFG)).toBe(CFG.minMs);
  });

  // A job queued behind MAX_CONCURRENT_JOBS has not started, so it must not be
  // spending budget — the whole reason the cap keys on started_at.
  test("a job that has not started has no deadline", () => {
    expect(remainingMs(null, 1 * GiB, Date.now(), CFG)).toBeNull();
  });

  test("an unparseable timestamp has no deadline rather than an instant one", () => {
    expect(remainingMs("not a date", 1 * GiB, Date.now(), CFG)).toBeNull();
  });
});

describe("hasExceededBudget", () => {
  const at = (iso: string) => new Date(iso).getTime();
  const START = "2026-08-16 00:00:00";

  test("false inside the budget, true once past it", () => {
    expect(hasExceededBudget(START, 1 * GiB, at("2026-08-16T01:59:00Z"), CFG)).toBe(false);
    expect(hasExceededBudget(START, 1 * GiB, at("2026-08-16T02:01:00Z"), CFG)).toBe(true);
  });

  test("a never-started job is never over budget", () => {
    expect(hasExceededBudget(null, 1 * GiB, Date.now(), CFG)).toBe(false);
  });

  // The regression this whole feature is calibrated against: a 74 GiB release
  // legitimately runs past the floor and must not be killed at 2h.
  test("a big release outlives the floor a small one gets", () => {
    const big = 74 * GiB;
    expect(hasExceededBudget(START, big, at("2026-08-16T02:30:00Z"), CFG)).toBe(false);
    expect(hasExceededBudget(START, big, at("2026-08-16T11:00:00Z"), CFG)).toBe(true);
  });

  // A release this size cannot be submitted at all now, but if one is already in
  // flight it gets the time its size earns rather than dying at the old ceiling.
  test("a huge release is no longer killed at the old ceiling", () => {
    expect(hasExceededBudget(START, 5000 * GiB, at("2026-08-16T06:01:00Z"), CFG)).toBe(false);
  });
});

describe("elapsedMs", () => {
  test("measures from the recorded start", () => {
    expect(elapsedMs("2026-08-16 00:00:00", new Date("2026-08-16T00:05:00Z").getTime())).toBe(
      5 * MIN,
    );
  });

  test("is null without a usable start", () => {
    expect(elapsedMs(null, Date.now())).toBeNull();
    expect(elapsedMs("nonsense", Date.now())).toBeNull();
  });
});

describe("MaxDurationError", () => {
  test("names both the budget and what was actually spent", () => {
    const err = new MaxDurationError(7 * 60 * MIN, 6 * 60 * MIN);
    expect(err.message).toBe("job exceeded its 360 minute budget (ran 420 minutes)");
    expect(err.name).toBe("MaxDurationError");
    expect(err).toBeInstanceOf(Error);
  });
});

describe("OversizeError", () => {
  test("names the release size and the cap, both in GB", () => {
    const err = new OversizeError(482.9e9, 100e9);
    expect(err.message).toBe("release is 482.9 GB, over the 100 GB limit");
    expect(err.name).toBe("OversizeError");
    expect(err).toBeInstanceOf(Error);
  });
});

describe("exceedsSizeCap", () => {
  // Measured across 30 days of both hosts: 0 of 14 releases above 200 GB ever
  // completed, and the largest success on record is 186.1 GB. A 100 GB cap
  // refuses 29 magnets carrying 8.76 TB, of which 7 had succeeded — the
  // deliberate trade, since the size is known within 4-12s of a job starting
  // and refusing it therefore costs no transfer at all.
  test("refuses a release over the cap", () => {
    expect(exceedsSizeCap(101e9, 100e9)).toBe(true);
    expect(exceedsSizeCap(482.9e9, 100e9)).toBe(true);
  });

  test("admits everything up to and including the cap", () => {
    expect(exceedsSizeCap(100e9, 100e9)).toBe(false);
    expect(exceedsSizeCap(99e9, 100e9)).toBe(false);
    expect(exceedsSizeCap(1, 100e9)).toBe(false);
  });

  // Size is only known once the torrent's files are recorded, so a sizeless job
  // is legitimately early rather than suspect — the same reason `budgetMsFor`
  // hands an unknown size the ceiling instead of the floor.
  test("an unknown size is never oversize", () => {
    expect(exceedsSizeCap(null, 100e9)).toBe(false);
    expect(exceedsSizeCap(0, 100e9)).toBe(false);
    expect(exceedsSizeCap(-1, 100e9)).toBe(false);
  });

  // A cap of 0 is how the limit is turned off, not how everything is refused.
  test("a zero cap disables the limit", () => {
    expect(exceedsSizeCap(5000e9, 0)).toBe(false);
  });
});

describe("withExtendableTimeout", () => {
  test("returns what the stage returns", async () => {
    expect(await withExtendableTimeout(async () => "rd-1", 1_000)).toBe("rd-1");
  });

  test("passes the stage's own failure through", async () => {
    await expect(
      withExtendableTimeout(async () => {
        throw new Error("RD addTorrent failed: 400 bad");
      }, 1_000),
    ).rejects.toThrow("RD addTorrent failed: 400 bad");
  });

  test("times a stage out in the old message and aborts its signal", async () => {
    let seen: AbortSignal | undefined;
    const err = await withExtendableTimeout(({ signal }) => {
      seen = signal;
      return new Promise<never>(() => {});
    }, 20).catch((e: Error) => e);

    expect(err.message).toBe("Stage timed out after 0 minutes");
    expect(seen?.aborted).toBe(true);
    expect(seen?.reason).toBe(err);
  });

  test("does not count a wait the stage reported", async () => {
    const value = await withExtendableTimeout(async ({ extend }) => {
      extend(200);
      await new Promise((r) => setTimeout(r, 60));
      return "patient";
    }, 20);
    expect(value).toBe("patient");
  });
});
