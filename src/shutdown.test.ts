import { afterEach, describe, expect, test } from "bun:test";
import { _resetShutdown, gracefulShutdown, isShuttingDown, type Stoppable } from "./shutdown";

afterEach(() => {
  _resetShutdown();
});

/** A server whose stop resolves when the test says so. */
function controllableServer() {
  let release!: () => void;
  const stopped = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const server: Stoppable = {
    stop: () => {
      calls++;
      return stopped;
    },
  };
  return { server, release, stops: () => calls };
}

/** Never elapses unless a test wants it to. */
const neverDelay = () => new Promise<void>(() => {});

describe("gracefulShutdown", () => {
  test("waits for in-flight requests, then reports drained", async () => {
    const { server, release, stops } = controllableServer();
    const log: string[] = [];

    const pending = gracefulShutdown("SIGINT", server, {
      timeoutMs: 25_000,
      log: (m) => log.push(m),
      delay: neverDelay,
    });
    release();

    expect(await pending).toBe("drained");
    expect(stops()).toBe(1);
    expect(log[0]).toContain("SIGINT");
    expect(log.at(-1)).toContain("drained");
  });

  test("gives up at the timeout rather than waiting to be SIGKILLed", async () => {
    // systemd's TimeoutStopSec would kill us anyway, and that kill severs the
    // very responses the drain exists to protect — so exiting deliberately, and
    // saying so, beats being cut off silently.
    const { server } = controllableServer();
    const log: string[] = [];

    const outcome = await gracefulShutdown("SIGTERM", server, {
      timeoutMs: 25_000,
      log: (m) => log.push(m),
      delay: async () => {},
    });

    expect(outcome).toBe("timeout");
    expect(log.at(-1)).toContain("still busy");
  });

  test("is idempotent, because systemd may signal more than once", async () => {
    const { server, release, stops } = controllableServer();

    const first = gracefulShutdown("SIGINT", server, {
      timeoutMs: 1,
      delay: neverDelay,
      log: () => {},
    });
    const second = await gracefulShutdown("SIGINT", server, {
      timeoutMs: 1,
      delay: neverDelay,
      log: () => {},
    });
    release();

    expect(second).toBe("already");
    expect(await first).toBe("drained");
    // A second drain would race the first over the same connections.
    expect(stops()).toBe(1);
  });

  test("announces itself so the worker stops admitting jobs", async () => {
    const { server, release } = controllableServer();
    expect(isShuttingDown()).toBe(false);

    const pending = gracefulShutdown("SIGINT", server, {
      timeoutMs: 1,
      delay: neverDelay,
      log: () => {},
    });

    // Set before the drain finishes, not after: the whole point is to stop
    // starting work during the window, not to record it afterwards.
    expect(isShuttingDown()).toBe(true);
    release();
    await pending;
    expect(isShuttingDown()).toBe(true);
  });

  test("uses a real timer when no delay is injected", async () => {
    // Exercises the production default rather than the test seam: a 1ms budget
    // against a stop that never resolves must still come back promptly.
    const { server } = controllableServer();

    const outcome = await gracefulShutdown("SIGINT", server, { timeoutMs: 1, log: () => {} });

    expect(outcome).toBe("timeout");
  });

  test("tolerates a synchronous stop", async () => {
    // `Bun.serve().stop()` is typed as possibly void; treating it as a promise
    // unconditionally would reject on a runtime that returns nothing.
    let stopped = false;
    const server: Stoppable = {
      stop: () => {
        stopped = true;
      },
    };

    expect(
      await gracefulShutdown("SIGINT", server, { timeoutMs: 1, delay: neverDelay, log: () => {} }),
    ).toBe("drained");
    expect(stopped).toBe(true);
  });
});
