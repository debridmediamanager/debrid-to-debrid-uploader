import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import { createJob, getJob, updateJob } from "./db";
import { takedown } from "./takedown";
import { processJob } from "./worker";

let originalFetch: typeof globalThis.fetch;
const calls: string[] = [];

beforeAll(() => {
  originalFetch = globalThis.fetch;
  // Any provider call would mean the job ran; record rather than answer.
  globalThis.fetch = (async (url: unknown) => {
    calls.push(String(url));
    return new Response("unexpected", { status: 500 });
  }) as unknown as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  takedown.accept({ version: "empty", hashes: [], releases: [] });
  calls.length = 0;
});

// A job can wait for a slot, or across a restart, while DMM adds its release
// to the list. The re-check on start is what stops it running anyway.
describe("processJob takedown re-check", () => {
  function queuedJob(hash: string): string {
    const id = `takedown-${crypto.randomUUID()}`;
    createJob(id, `magnet:?xt=urn:btih:${hash}`, "tt1234567", false, {
      rdApiKey: "RD_KEY",
      tbApiKey: "TB_KEY",
    });
    return id;
  }

  test("fails a queued job whose hash was listed after submission", async () => {
    const hash = "1".repeat(40);
    const id = queuedJob(hash);
    takedown.accept({ version: "v1", hashes: [hash], releases: [] });

    await processJob(id);

    const job = getJob(id);
    expect(job?.status).toBe("failed");
    expect(job?.error).toBe("blocked by a copyright notice");
    expect(calls).toEqual([]);
  });

  test("fails a resumed job whose recorded name is a listed release", async () => {
    const id = queuedJob("2".repeat(40));
    updateJob(id, { status: "downloading", name: "Listed.Release.2024.1080p-GRP" });
    takedown.accept({ version: "v1", hashes: [], releases: ["listed.release.2024.1080p.grp"] });

    await processJob(id);

    const job = getJob(id);
    expect(job?.status).toBe("failed");
    expect(job?.error).toBe("blocked by a copyright notice");
    expect(calls).toEqual([]);
  });
});
