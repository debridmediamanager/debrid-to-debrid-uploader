import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import { createApp } from "./app";
import { config } from "./config";
import { createJob, getJob, getTorboxTorrentId, insertProxyMappings, listJobs } from "./db";
import freeTorboxUser from "./fixtures/torbox-free-user.json";
import { _clearOwnerCache } from "./owners";
import { _resetShutdown, gracefulShutdown } from "./shutdown";
import { takedown } from "./takedown";

let originalFetch: typeof globalThis.fetch;

beforeAll(() => {
  originalFetch = globalThis.fetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

/** Record every outbound call so the TorBox delete is observable. */
function recordFetch(): { calls: { url: string; body: string }[] } {
  const calls: { url: string; body: string }[] = [];
  globalThis.fetch = (async (url: unknown, init: unknown) => {
    const opts = init as { body?: string } | undefined;
    calls.push({ url: String(url), body: String(opts?.body ?? "") });
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  }) as unknown as typeof fetch;
  return { calls };
}

const uid = () => `cancel-${crypto.randomUUID()}`;

/** A job that has reached the point of holding a TorBox torrent. */
function jobHoldingSlot(torboxId: number): string {
  const id = uid();
  createJob(
    id,
    "magnet:?xt=urn:btih:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "tt1234567",
    false,
    {
      tbApiKey: "TB_KEY",
    },
  );
  insertProxyMappings(
    id,
    torboxId,
    [{ rewrittenPath: "Clean/movie.mkv", webdavPath: "Orig/movie.mkv", size: 100 }],
    { source: "torbox" },
  );
  return id;
}

describe("DELETE /jobs/:id", () => {
  test("preserves the caller's TorBox torrent when cancelling a source job", async () => {
    // A provider add can return a pre-existing library id or one shared by
    // another job. Session membership is not permission to delete that id.
    const app = createApp();
    const { calls } = recordFetch();
    const id = jobHoldingSlot(4242);

    expect(getTorboxTorrentId(id)).toBe(4242);

    const res = await app.request(`/jobs/${id}`, { method: "DELETE" });
    expect(res.status).toBe(200);

    const deletes = calls.filter((c) => c.url.includes("controltorrent"));
    expect(deletes).toHaveLength(0);
    expect(getTorboxTorrentId(id)).toBeUndefined();
  });

  test("still marks the job deleted and clears the session", async () => {
    const app = createApp();
    recordFetch();
    const id = jobHoldingSlot(77);

    await app.request(`/jobs/${id}`, { method: "DELETE" });
    await Bun.sleep(5);

    expect(getJob(id)?.deleted).toBe(1);
    // The session rows are gone, so a webseed read can no longer resolve.
    expect(getTorboxTorrentId(id)).toBeUndefined();
  });

  test("cancelling a job that never reached a provider releases nothing", async () => {
    // A job cancelled while still `pending` holds no slot; firing a delete at
    // TorBox anyway would be a wasted call against a rate-limited API.
    const app = createApp();
    const { calls } = recordFetch();
    const id = uid();
    createJob(id, "magnet:?xt=urn:btih:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");

    const res = await app.request(`/jobs/${id}`, { method: "DELETE" });
    await Bun.sleep(5);

    expect(res.status).toBe(200);
    expect(calls.filter((c) => c.url.includes("controltorrent"))).toHaveLength(0);
  });

  test("an unknown job is a 404 and touches nothing", async () => {
    const app = createApp();
    const { calls } = recordFetch();

    const res = await app.request("/jobs/no-such-job", { method: "DELETE" });

    expect(res.status).toBe(404);
    expect(calls).toHaveLength(0);
  });
});

// The per-user limit is what stops one submitter occupying the pipeline, and at
// the default of 1 it applies to the operator as hard as to anyone else — so
// running your own service means one job at a time on your own box. The
// exemption is the way out, and it is checked against every provider on the job
// because which side carries the operator's account depends on the direction.
describe("POST /jobs job-limit exemption", () => {
  const originalUnlimited = config.unlimitedOwners;

  afterEach(() => {
    config.unlimitedOwners = originalUnlimited;
    _clearOwnerCache();
    _resetShutdown();
  });

  /**
   * Answer both identity lookups: RD reads `id`, TorBox reads `data.id`.
   *
   * The worker is deliberately kept out of it. What is under test is the route's
   * admission decision; letting an admitted job actually start would fire the
   * whole pipeline at this stub and poison module caches other test files read —
   * `getTrackers` caches its answer for 24 hours, so one stubbed response there
   * fails `trackers.test.ts` from across the suite. The drain flag is the
   * existing seam for "accept the submission, admit no new work".
   */
  async function stubIdentities() {
    globalThis.fetch = (async () =>
      Response.json({ id: 222, data: { id: 111 } })) as unknown as typeof fetch;
    await gracefulShutdown("TEST", { stop: () => {} }, { timeoutMs: 0, log: () => {} });
  }

  /** An in-flight job already occupying `rd:222`'s single slot. */
  function occupySlot(): void {
    createJob(
      uid(),
      "magnet:?xt=urn:btih:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "tt1234567",
      false,
      { rdApiKey: "RD_KEY", tbApiKey: "TB_KEY" },
      { tbUserId: "tb:111", rdUserId: "rd:222", pmUserId: "" },
    );
  }

  const submit = (rdKey: string) =>
    createApp().request("/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        input: "magnet:?xt=urn:btih:cccccccccccccccccccccccccccccccccccccccc",
        imdb_id: "tt7654321",
        rd_api_key: rdKey,
        tb_api_key: "TB_KEY_2",
      }),
    });

  test("still refuses a second job for an account that is not exempt", async () => {
    await stubIdentities();
    config.unlimitedOwners = new Set(["rd:999"]);
    occupySlot();

    const res = await submit("RD_LIMITED");

    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: string }).error).toBe("job limit reached");
  });

  test("admits a second job for an exempt account", async () => {
    await stubIdentities();
    config.unlimitedOwners = new Set(["rd:222"]);
    occupySlot();

    const res = await submit("RD_EXEMPT");

    expect(res.status).toBe(201);
  });
});

describe("POST /jobs takedown blocklist", () => {
  const BLOCKED = "dddddddddddddddddddddddddddddddddddddddd";

  afterEach(() => {
    takedown.accept({ version: "empty", hashes: [], releases: [] });
  });

  const submit = (input: string) =>
    createApp().request("/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        input,
        imdb_id: "tt7654321",
        rd_api_key: "RD_KEY",
        tb_api_key: "TB_KEY",
      }),
    });

  test("refuses a listed hash with 451 before resolving owners or inserting", async () => {
    const { calls } = recordFetch();
    takedown.accept({ version: "v1", hashes: [BLOCKED], releases: [] });
    const before = listJobs().length;

    for (const input of [BLOCKED.toUpperCase(), `magnet:?xt=urn:btih:${BLOCKED}&dn=x`]) {
      const res = await submit(input);
      expect(res.status).toBe(451);
      expect(await res.json()).toEqual({ error: "blocked by a copyright notice" });
    }
    expect(listJobs().length).toBe(before);
    expect(calls).toHaveLength(0);
  });

  test("refuses a magnet whose display name is a listed release", async () => {
    recordFetch();
    takedown.accept({ version: "v1", hashes: [], releases: ["some.movie.2024.1080p"] });
    const res = await submit(
      "magnet:?xt=urn:btih:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee&dn=Some%20Movie%20(2024)%201080p",
    );
    expect(res.status).toBe(451);
  });
});

describe("POST /jobs TorBox plan gate", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    _clearOwnerCache();
    _resetShutdown();
  });

  const submit = (destination: string) =>
    createApp().request("/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        input: "abcdefabcdefabcdefabcdefabcdefabcdefabcd",
        imdb_id: "tt7654321",
        rd_api_key: "RD_PLAN_GATE",
        tb_api_key: "TB_PLAN_GATE",
        destination,
      }),
    });

  test.each(["rd", "torbox"])(
    "refuses a free TorBox key before creating a %s job",
    async (destination) => {
      await gracefulShutdown("TEST", { stop: () => {} }, { timeoutMs: 0, log: () => {} });
      globalThis.fetch = (async (url: unknown) =>
        String(url).includes("api.torbox.app")
          ? Response.json(freeTorboxUser.body, { status: freeTorboxUser.status })
          : Response.json({ id: 87654321 })) as unknown as typeof fetch;
      const before = listJobs().length;

      const res = await submit(destination);

      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({
        error: expect.stringContaining("paid TorBox plan"),
      });
      expect(listJobs().length).toBe(before);
    },
  );

  test("rechecks the plan after a paid key's owner has been cached", async () => {
    await gracefulShutdown("TEST", { stop: () => {} }, { timeoutMs: 0, log: () => {} });
    config.unlimitedOwners.add("rd:87654321");
    let plan = 2;
    globalThis.fetch = (async (url: unknown) =>
      String(url).includes("api.torbox.app")
        ? Response.json({
            ...freeTorboxUser.body,
            data: { ...freeTorboxUser.body.data, plan },
          })
        : Response.json({ id: 87654321 })) as unknown as typeof fetch;
    try {
      expect((await submit("rd")).status).toBe(201);
      plan = 0;
      expect((await submit("rd")).status).toBe(400);
    } finally {
      config.unlimitedOwners.delete("rd:87654321");
    }
  });
});
