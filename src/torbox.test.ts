import { afterEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "./config";
import { MissingCredentialError } from "./credentials";
import * as torbox from "./torbox";
import { PlanRestrictedError, RateLimitError } from "./torbox";
import type { TorboxRequestInit } from "./torbox-http";

/** Every call now needs its own credential; there is no operator fallback. */
const TB = { apiKey: "TB_KEY" };

const originalFetch = globalThis.fetch;
let destTempDirs: string[] = [];

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const dir of destTempDirs) fs.rmSync(dir, { recursive: true, force: true });
  destTempDirs = [];
});

describe("TorBox client", () => {
  test("creates torrent downloads", async () => {
    globalThis.fetch = mock(async () =>
      Response.json({ success: true, data: { torrent_id: 7, hash: "abc" } }),
    ) as unknown as typeof fetch;

    expect(await torbox.createDownload("magnet:?xt=urn:btih:abc", TB)).toEqual({
      id: 7,
      hash: "abc",
    });
  });

  test("maps create rate limits to RateLimitError", async () => {
    globalThis.fetch = mock(
      async () => new Response("limited", { status: 429 }),
    ) as unknown as typeof fetch;

    await expect(torbox.createDownload("magnet:?xt=urn:btih:abc", TB)).rejects.toThrow(
      RateLimitError,
    );
  });

  test("surfaces create failures and unsuccessful responses", async () => {
    globalThis.fetch = mock(
      async () => new Response("bad", { status: 500 }),
    ) as unknown as typeof fetch;
    await expect(torbox.createDownload("magnet:?xt=urn:btih:abc", TB)).rejects.toThrow(
      "TorBox create failed: 500 bad",
    );

    globalThis.fetch = mock(async () =>
      Response.json({ success: false, data: {} }),
    ) as unknown as typeof fetch;
    await expect(torbox.createDownload("magnet:?xt=urn:btih:abc", TB)).rejects.toThrow(
      "TorBox create returned success=false",
    );
  });

  test("gets torrent info", async () => {
    const info = {
      id: 7,
      hash: "abc",
      name: "movie",
      download_state: "completed",
      progress: 1,
      files: [{ id: 1, name: "movie.mkv", size: 10 }],
    };
    globalThis.fetch = mock(async () => Response.json({ data: info })) as unknown as typeof fetch;

    expect(await torbox.getTorrentInfo(7, TB)).toEqual(info);
  });

  test("surfaces info failures", async () => {
    globalThis.fetch = mock(
      async () => new Response("bad", { status: 502 }),
    ) as unknown as typeof fetch;

    await expect(torbox.getTorrentInfo(7, TB)).rejects.toThrow("TorBox info failed: 502 bad");
  });

  test("requests download links with optional file ids", async () => {
    const fetchMock = mock(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ data: "https://download.example/file" }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    expect(await torbox.requestDownloadLink(7, 2, TB)).toBe("https://download.example/file");
    expect(String(fetchMock.mock.calls[0][0])).toContain("file_id=2");
  });

  test("checks cached status", async () => {
    globalThis.fetch = mock(async () =>
      Response.json({ data: [{ size: 5368709120, hash: "abc", name: "movie" }] }),
    ) as unknown as typeof fetch;
    expect(await torbox.checkCached("abc", TB)).toBe(true);
  });

  test("returns false when not cached", async () => {
    globalThis.fetch = mock(async () => Response.json({ data: [] })) as unknown as typeof fetch;
    expect(await torbox.checkCached("abc", TB)).toBe(false);
  });

  test.each([401, 500, 503])("cache check HTTP %i is not a cache miss", async (status) => {
    globalThis.fetch = mock(
      async () => new Response("provider unavailable", { status }),
    ) as unknown as typeof fetch;
    await expect(torbox.checkCached("abc", TB)).rejects.toThrow(
      `TorBox cache check failed: ${status}`,
    );
  });

  test("cache check rate limits retain their retry classification", async () => {
    globalThis.fetch = mock(
      async () => new Response("limited", { status: 429 }),
    ) as unknown as typeof fetch;
    await expect(torbox.checkCached("abc", TB)).rejects.toBeInstanceOf(RateLimitError);
  });

  test("cache check network failures are not cache misses", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    await expect(torbox.checkCached("abc", TB)).rejects.toThrow("network down");
  });

  test("cache check business failures are not cache misses", async () => {
    globalThis.fetch = mock(async () =>
      Response.json({ success: false, detail: "DATABASE_ERROR", data: null }),
    ) as unknown as typeof fetch;
    await expect(torbox.checkCached("abc", TB)).rejects.toThrow(
      "TorBox cache check rejected: DATABASE_ERROR",
    );
  });

  test("maps request download rate limits and failures", async () => {
    globalThis.fetch = mock(
      async () => new Response("limited", { status: 429 }),
    ) as unknown as typeof fetch;
    await expect(torbox.requestDownloadLink(7, undefined, TB)).rejects.toThrow(RateLimitError);

    globalThis.fetch = mock(
      async () => new Response("bad", { status: 500 }),
    ) as unknown as typeof fetch;
    await expect(torbox.requestDownloadLink(7, undefined, TB)).rejects.toThrow(
      "TorBox requestdl failed: 500 bad",
    );
  });
});

describe("deleteTorrent", () => {
  test("posts a delete operation for the torrent id", async () => {
    const fetchMock = mock(
      async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 200 }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await torbox.deleteTorrent(7, TB);

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/torrents/controltorrent");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual({ torrent_id: 7, operation: "delete" });
  });

  test("surfaces delete failures", async () => {
    globalThis.fetch = mock(
      async () => new Response("nope", { status: 500 }),
    ) as unknown as typeof fetch;

    await expect(torbox.deleteTorrent(7, TB)).rejects.toThrow("TorBox delete failed: 500 nope");
  });

  test("rejects a 200 that carries success=false", async () => {
    // TorBox answers a logical failure with HTTP 200; treating that as a
    // released slot is how the leak stays invisible.
    globalThis.fetch = mock(async () =>
      Response.json({ success: false, error: "…", detail: "DATABASE_ERROR", data: null }),
    ) as unknown as typeof fetch;

    await expect(torbox.deleteTorrent(7, TB)).rejects.toThrow("TorBox delete rejected");
  });

  test("accepts an explicit success=true", async () => {
    globalThis.fetch = mock(async () =>
      Response.json({ success: true, detail: "ok" }),
    ) as unknown as typeof fetch;

    await expect(torbox.deleteTorrent(7, TB)).resolves.toBeUndefined();
  });

  test("accepts a 2xx with a non-JSON body", async () => {
    globalThis.fetch = mock(
      async () => new Response("", { status: 204 }),
    ) as unknown as typeof fetch;

    await expect(torbox.deleteTorrent(7, TB)).resolves.toBeUndefined();
  });
});

describe("per-job TorBox API key", () => {
  /** Capture the Authorization header (or URL) each client function sends. */
  function captureRequest(body: unknown = { success: true, data: { torrent_id: 1, hash: "h" } }) {
    const seen: { url: string; auth: string | null }[] = [];
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      seen.push({ url: String(url), auth: headers.get("authorization") });
      return Response.json(body);
    }) as unknown as typeof fetch;
    return seen;
  }

  test("createDownload authenticates with the supplied key", async () => {
    const seen = captureRequest();
    await torbox.createDownload("magnet:?xt=urn:btih:abc", { apiKey: "USER_TB_KEY" });
    expect(seen[0].auth).toBe("Bearer USER_TB_KEY");
  });

  test("getTorrentInfo authenticates with the supplied key", async () => {
    const seen = captureRequest({ data: { id: 1, files: [] } });
    await torbox.getTorrentInfo(1, { apiKey: "USER_TB_KEY" });
    expect(seen[0].auth).toBe("Bearer USER_TB_KEY");
  });

  test("checkCached authenticates with the supplied key", async () => {
    const seen = captureRequest({ data: [{ size: 1 }] });
    expect(await torbox.checkCached("abc", { apiKey: "USER_TB_KEY" })).toBe(true);
    expect(seen[0].auth).toBe("Bearer USER_TB_KEY");
  });

  test("deleteTorrent releases the slot on the account that holds it", async () => {
    const seen = captureRequest({ success: true });
    await torbox.deleteTorrent(1, { apiKey: "USER_TB_KEY" });
    expect(seen[0].auth).toBe("Bearer USER_TB_KEY");
  });

  test("requestDownloadLink passes the supplied key as the token param", async () => {
    const seen = captureRequest({ data: "https://download.example/file" });
    await torbox.requestDownloadLink(7, 2, { apiKey: "USER_TB_KEY" });
    expect(seen[0].url).toContain("token=USER_TB_KEY");
  });

  test("refuses to call TorBox with no key rather than using the operator's", async () => {
    const seen = captureRequest({ data: { id: 1, files: [] } });
    await expect(torbox.getTorrentInfo(1)).rejects.toThrow(MissingCredentialError);
    // Refused before the request is built, so nothing reached the network.
    expect(seen).toHaveLength(0);
  });
});

describe("TorBox API egress", () => {
  // The REST client used to be exempt from the proxy while the data path went
  // through it, so a single job announced this host's address on `checkcached`
  // and a WARP address on the ranges that followed — under one API key, which
  // joins them straight back together. These guard against that returning.
  const originalProxy = config.torboxProxyUrl;
  const originalUserAgent = config.torboxUserAgent;

  afterEach(() => {
    config.torboxProxyUrl = originalProxy;
    config.torboxUserAgent = originalUserAgent;
  });

  /** Capture the full init each client function sends. */
  function captureInit() {
    const seen: TorboxRequestInit[] = [];
    globalThis.fetch = mock(async (_url: string | URL | Request, init: TorboxRequestInit) => {
      seen.push(init);
      return Response.json({ success: true, data: { torrent_id: 1, hash: "h" } });
    }) as unknown as typeof fetch;
    return seen;
  }

  test("control-plane calls egress through the same proxy as the data path", async () => {
    config.torboxProxyUrl = "http://127.0.0.1:8118";
    const seen = captureInit();

    await torbox.createDownload("magnet:?xt=urn:btih:abc", TB);

    expect(seen[0].proxy).toBe("http://127.0.0.1:8118");
  });

  test("every REST call carries the shared User-Agent", async () => {
    config.torboxUserAgent = "rclone/v1.74.1";
    const seen = captureInit();

    await torbox.createDownload("magnet:?xt=urn:btih:abc", TB);
    await torbox.checkCached("h", TB);
    await torbox.requestDownloadLink(7, undefined, TB);
    await torbox.getTorrentInfo(1, TB);

    expect(seen).toHaveLength(4);
    for (const init of seen) {
      expect(new Headers(init.headers).get("User-Agent")).toBe("rclone/v1.74.1");
    }
  });
});

describe("getCurrentUser", () => {
  test("returns the account behind a key", async () => {
    globalThis.fetch = mock(async () =>
      Response.json({ success: true, data: { id: 777 } }),
    ) as unknown as typeof fetch;

    expect(await torbox.getCurrentUser(TB)).toEqual({ id: 777 });
  });

  test("rejects a 200 that carries no id", async () => {
    // TorBox's `success: false` shape in another costume. Returning undefined
    // here would collapse every account onto one owner string.
    globalThis.fetch = mock(async () =>
      Response.json({ success: false, data: null }),
    ) as unknown as typeof fetch;

    await expect(torbox.getCurrentUser(TB)).rejects.toThrow("no id");
  });

  test("surfaces a failed lookup", async () => {
    globalThis.fetch = mock(
      async () => new Response("nope", { status: 403 }),
    ) as unknown as typeof fetch;

    await expect(torbox.getCurrentUser(TB)).rejects.toThrow("TorBox user lookup failed: 403");
  });
});

describe("plan restrictions", () => {
  const BODY = JSON.stringify({
    success: false,
    error: "PLAN_RESTRICTED_FEATURE",
    detail: "API feature not available on your plan. Please upgrade to a paid plan.",
    data: null,
  });

  test("a 403 naming the restriction is its own terminal error", async () => {
    // Distinct from a generic failure so `retryOrFail` can fail it on sight: a
    // free account does not become paid between retries, and the ladder holds a
    // concurrency slot while it finds that out three times.
    globalThis.fetch = mock(
      async () => new Response(BODY, { status: 403 }),
    ) as unknown as typeof fetch;

    await expect(torbox.createDownload("magnet:?xt=urn:btih:abc", TB)).rejects.toThrow(
      PlanRestrictedError,
    );
  });

  test("other 403s stay generic, and so stay retryable", async () => {
    globalThis.fetch = mock(
      async () => new Response("forbidden for some other reason", { status: 403 }),
    ) as unknown as typeof fetch;

    const err = await torbox.createDownload("magnet:?xt=urn:btih:abc", TB).catch((e) => e);
    expect(err).not.toBeInstanceOf(PlanRestrictedError);
    expect(err.message).toContain("TorBox create failed: 403");
  });

  test("a rate limit is still a rate limit", async () => {
    // 429 is checked before the body is read, so the new branch must not shadow it.
    globalThis.fetch = mock(
      async () => new Response(BODY, { status: 429 }),
    ) as unknown as typeof fetch;

    await expect(torbox.createDownload("magnet:?xt=urn:btih:abc", TB)).rejects.toThrow(
      RateLimitError,
    );
  });
});

describe("TorBox as a destination", () => {
  /** A real file on disk, since `createTorrentFromFile` reads one. */
  function tempTorrent(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "debrid-tbdest-"));
    destTempDirs.push(dir);
    const filePath = path.join(dir, "Movie (2024) {imdb-tt1}.torrent");
    fs.writeFileSync(filePath, "d4:infod4:name5:movieee");
    return filePath;
  }

  test("uploads a rewritten torrent and returns the new TorBox id", async () => {
    const fetchMock = mock(async (_url: string, _init?: TorboxRequestInit) =>
      Response.json({ success: true, data: { torrent_id: 77784684, hash: "307c3b" } }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const created = await torbox.createTorrentFromFile(tempTorrent(), TB);
    expect(created).toEqual({ id: 77784684, hash: "307c3b" });

    const body = fetchMock.mock.calls[0][1]?.body as FormData;
    expect(body.get("file")).toBeInstanceOf(Blob);
    // "do not seed": seeding is outgoing traffic billed at full file size
    // against the threshold whose fourth strike is a permanent ban.
    expect(body.get("seed")).toBe("3");
  });

  test("rejects a 200 that carries success:false", async () => {
    // TorBox reports logical failure with an HTTP 200, so trusting the status
    // would have the uploading stage monitor an id that does not exist for the
    // whole stall window before failing as the wrong thing entirely.
    globalThis.fetch = mock(async () =>
      Response.json({ success: false, detail: "DATABASE_ERROR", data: null }),
    ) as unknown as typeof fetch;

    expect(torbox.createTorrentFromFile(tempTorrent(), TB)).rejects.toThrow(
      "TorBox createtorrent rejected: DATABASE_ERROR",
    );
  });

  test("rejects a 200 whose success is true but carries no data", async () => {
    globalThis.fetch = mock(async () =>
      Response.json({ success: true }),
    ) as unknown as typeof fetch;

    expect(torbox.createTorrentFromFile(tempTorrent(), TB)).rejects.toThrow(
      "TorBox createtorrent rejected: success=false",
    );
  });

  test("maps a 429 to RateLimitError so the ladder backs off", async () => {
    globalThis.fetch = mock(
      async () => new Response("slow down", { status: 429 }),
    ) as unknown as typeof fetch;

    expect(torbox.createTorrentFromFile(tempTorrent(), TB)).rejects.toBeInstanceOf(RateLimitError);
  });

  test("maps a plan restriction to the terminal error, not a retryable one", async () => {
    // Every torrent sent here is uncached by construction, so a free account
    // fails at exactly this call — and a plan does not become paid between
    // attempts, so retrying only spends a slot to re-derive the same 403.
    globalThis.fetch = mock(
      async () => new Response('{"error":"PLAN_RESTRICTED_FEATURE"}', { status: 403 }),
    ) as unknown as typeof fetch;

    expect(torbox.createTorrentFromFile(tempTorrent(), TB)).rejects.toBeInstanceOf(
      PlanRestrictedError,
    );
  });

  test("surfaces any other HTTP failure with its status", async () => {
    globalThis.fetch = mock(
      async () => new Response("boom", { status: 500 }),
    ) as unknown as typeof fetch;

    expect(torbox.createTorrentFromFile(tempTorrent(), TB)).rejects.toThrow(
      "TorBox createtorrent failed: 500 boom",
    );
  });
});

describe("a torrent TorBox has stopped listing", () => {
  test("a 200 carrying no row is reported as gone, not as a broken shape", async () => {
    // TorBox drops the row once a transfer is complete and not seeding, and then
    // answers `mylist?id=` with `DATABASE_ERROR` forever. Reading `undefined`
    // off that produced a TypeError deep in the monitor; naming it lets the
    // caller ask the cache whether the content actually arrived.
    globalThis.fetch = mock(async () =>
      Response.json({ success: false, detail: "DATABASE_ERROR", data: null }),
    ) as unknown as typeof fetch;

    expect(torbox.getTorrentInfo(77937457, TB)).rejects.toBeInstanceOf(
      torbox.TorboxTorrentGoneError,
    );
    expect(torbox.getTorrentInfo(77937457, TB)).rejects.toThrow("no longer lists torrent 77937457");
  });

  test("a row that is present is still returned", async () => {
    globalThis.fetch = mock(async () =>
      Response.json({ success: true, data: { id: 1, download_state: "completed", progress: 1 } }),
    ) as unknown as typeof fetch;

    expect((await torbox.getTorrentInfo(1, TB)).download_state).toBe("completed");
  });
});

describe("torrent info freshness", () => {
  test("asks TorBox to bypass its own cache", async () => {
    // Without this the destination monitor reads a stale snapshot: a completed
    // 12.4 GB transfer kept reporting `downloading 79%` long after the last byte
    // was served, so the job could only end by stalling — and a stalled
    // destination job deletes the copy it had just delivered.
    const fetchMock = mock(async (_url: string, _init?: TorboxRequestInit) =>
      Response.json({
        success: true,
        data: { id: 5, download_state: "downloading", progress: 0.5 },
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await torbox.getTorrentInfo(5, TB);
    expect(String(fetchMock.mock.calls[0][0])).toContain("bypass_cache=true");
  });
});
