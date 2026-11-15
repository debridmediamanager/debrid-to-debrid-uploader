import { describe, expect, test } from "bun:test";
import { sleep, sleepUnlessAborted } from "./async";

describe("sleep", () => {
  test("resolves after the requested delay", async () => {
    await expect(sleep(0)).resolves.toBeUndefined();
  });
});

describe("sleepUnlessAborted", () => {
  test("is a plain sleep without a signal", async () => {
    await expect(sleepUnlessAborted(0)).resolves.toBeUndefined();
  });

  test("resolves when the signal never fires", async () => {
    const controller = new AbortController();
    await expect(sleepUnlessAborted(1, controller.signal)).resolves.toBeUndefined();
    // The listener went with the timer, so a later abort reaches nothing.
    controller.abort(new Error("late"));
  });

  test("rejects at once with the reason of a signal that already fired", async () => {
    const controller = new AbortController();
    const reason = new Error("deleted");
    controller.abort(reason);
    await expect(sleepUnlessAborted(60_000, controller.signal)).rejects.toBe(reason);
  });

  test("stops a long wait when the signal fires", async () => {
    const controller = new AbortController();
    const reason = new Error("stalled");
    const started = Date.now();
    const waiting = sleepUnlessAborted(60_000, controller.signal);
    setTimeout(() => controller.abort(reason), 5);
    await expect(waiting).rejects.toBe(reason);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
