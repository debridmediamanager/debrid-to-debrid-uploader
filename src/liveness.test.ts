import { describe, expect, test } from "bun:test";
import { holdIdleClock, startIdleClock, tickIdleClock } from "./liveness";

const TIMEOUT = 2 * 60_000;

describe("idle clock", () => {
  test("stays disarmed while a job has never moved a byte", () => {
    // The direct-webseed path registers a session and then serves none of the
    // bytes itself, for the whole life of a perfectly healthy job. Arming from
    // zero would kill every one of them at the timeout.
    let clock = startIdleClock(0);
    for (const now of [TIMEOUT, TIMEOUT * 10, TIMEOUT * 100]) {
      const ticked = tickIdleClock(clock, { bytes: 0, advanced: false }, now, TIMEOUT);
      expect(ticked.idle).toBe(false);
      clock = ticked.clock;
    }
  });

  test("arms once the first byte moves", () => {
    const armed = tickIdleClock(startIdleClock(0), { bytes: 1, advanced: false }, 10, TIMEOUT);
    expect(armed.idle).toBe(false);
    expect(armed.clock).toEqual({ bytes: 1, since: 10 });

    expect(
      tickIdleClock(armed.clock, { bytes: 1, advanced: false }, 10 + TIMEOUT + 1, TIMEOUT).idle,
    ).toBe(true);
  });

  test("does not fire until the timeout has fully elapsed", () => {
    const { clock } = tickIdleClock(startIdleClock(0), { bytes: 500, advanced: false }, 0, TIMEOUT);

    expect(tickIdleClock(clock, { bytes: 500, advanced: false }, TIMEOUT - 1, TIMEOUT).idle).toBe(
      false,
    );
    // Strictly greater than, so the boundary itself is still alive.
    expect(tickIdleClock(clock, { bytes: 500, advanced: false }, TIMEOUT, TIMEOUT).idle).toBe(
      false,
    );
    expect(tickIdleClock(clock, { bytes: 500, advanced: false }, TIMEOUT + 1, TIMEOUT).idle).toBe(
      true,
    );
  });

  test("any movement in either direction resets the deadline", () => {
    let { clock } = tickIdleClock(startIdleClock(0), { bytes: 100, advanced: false }, 0, TIMEOUT);

    // A single byte at the last moment is enough to keep the job alive, which is
    // the point: this detects *nothing happening*, not slowness.
    const nudged = tickIdleClock(clock, { bytes: 101, advanced: false }, TIMEOUT, TIMEOUT);
    expect(nudged.idle).toBe(false);
    clock = nudged.clock;

    expect(tickIdleClock(clock, { bytes: 101, advanced: false }, TIMEOUT + 1, TIMEOUT).idle).toBe(
      false,
    );
    expect(
      tickIdleClock(clock, { bytes: 101, advanced: false }, TIMEOUT * 2 + 1, TIMEOUT).idle,
    ).toBe(true);
  });

  test("a byte total that goes backwards does not reset the deadline", () => {
    // A rehydrated session restarts its counters at zero. That is not activity,
    // and treating it as such would hand a wedged job a fresh window on every
    // restart.
    const { clock } = tickIdleClock(startIdleClock(0), { bytes: 900, advanced: false }, 0, TIMEOUT);

    const shrunk = tickIdleClock(clock, { bytes: 0, advanced: false }, TIMEOUT + 1, TIMEOUT);
    expect(shrunk.idle).toBe(true);
    expect(shrunk.clock.bytes).toBe(900);
  });

  test("holding the clock keeps the job alive without disarming it", () => {
    // RD's own `uploading`/`compressing`/`queued` phases read nothing from us,
    // so zero traffic is expected and must not be fatal — the 2026-08-07 bug.
    const { clock } = tickIdleClock(startIdleClock(0), { bytes: 100, advanced: false }, 0, TIMEOUT);

    const held = holdIdleClock(clock, TIMEOUT * 5);
    expect(
      tickIdleClock(held, { bytes: 100, advanced: false }, TIMEOUT * 5 + 1, TIMEOUT).idle,
    ).toBe(false);

    // Still armed, so it fires again once the phase ends and nothing moves.
    expect(
      tickIdleClock(held, { bytes: 100, advanced: false }, TIMEOUT * 6 + 1, TIMEOUT).idle,
    ).toBe(true);
    expect(held.bytes).toBe(100);
  });

  test("holding a never-active clock leaves it disarmed", () => {
    const held = holdIdleClock(startIdleClock(0), 1000);
    expect(
      tickIdleClock(held, { bytes: 0, advanced: false }, 1000 + TIMEOUT * 3, TIMEOUT).idle,
    ).toBe(false);
  });
});

describe("RD progress counts as activity", () => {
  // The regression this exists to prevent: on 2026-08-08 the detector judged
  // liveness on proxy bytes alone and killed four advancing jobs, one at 99.2%.
  // RD stops reading the webseed for stretches while still reporting
  // `downloading` — verifying pieces, flushing, buffering — and comes back.
  test("an advancing job survives indefinitely without serving a byte", () => {
    let { clock } = tickIdleClock(startIdleClock(0), { bytes: 500, advanced: true }, 0, TIMEOUT);

    for (let i = 1; i <= 20; i++) {
      const ticked = tickIdleClock(clock, { bytes: 500, advanced: true }, i * TIMEOUT, TIMEOUT);
      expect(ticked.idle).toBe(false);
      clock = ticked.clock;
    }
  });

  test("it still fires once RD stops advancing too", () => {
    // Both signals dead is the condition worth acting on.
    const { clock } = tickIdleClock(startIdleClock(0), { bytes: 500, advanced: true }, 0, TIMEOUT);

    expect(tickIdleClock(clock, { bytes: 500, advanced: false }, TIMEOUT, TIMEOUT).idle).toBe(
      false,
    );
    expect(tickIdleClock(clock, { bytes: 500, advanced: false }, TIMEOUT + 1, TIMEOUT).idle).toBe(
      true,
    );
  });

  test("advancing does not arm a clock that has never moved a byte", () => {
    // A direct-webseed job advances on RD's side while serving nothing here, and
    // must stay immune rather than becoming eligible the moment RD progresses.
    const { clock } = tickIdleClock(startIdleClock(0), { bytes: 0, advanced: true }, 0, TIMEOUT);
    expect(tickIdleClock(clock, { bytes: 0, advanced: false }, TIMEOUT * 9, TIMEOUT).idle).toBe(
      false,
    );
  });

  test("an advance keeps the byte high-water mark", () => {
    // Otherwise a rehydrated session reporting 0 bytes would reset the mark and
    // silently disarm a job that had already been serving.
    const { clock } = tickIdleClock(startIdleClock(0), { bytes: 900, advanced: false }, 0, TIMEOUT);
    const after = tickIdleClock(clock, { bytes: 0, advanced: true }, 10, TIMEOUT);

    expect(after.clock.bytes).toBe(900);
    expect(
      tickIdleClock(after.clock, { bytes: 0, advanced: false }, 10 + TIMEOUT + 1, TIMEOUT).idle,
    ).toBe(true);
  });
});
