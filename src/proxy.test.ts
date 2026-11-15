import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setSystemTime,
  test,
} from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "./config";
import { MissingCredentialError } from "./credentials";
import { createJob, insertProxyMappings } from "./db";
import rawFun from "./fixtures/raw-fun.json";
import alpha from "./fixtures/torbox/cached-webdav-404-cdn-206-alpha-2026-11-04.json";
import requestdlFailures from "./fixtures/torbox/requestdl-failures-2026-10-24.json";
import { counters } from "./metrics";
import {
  _clearAdLinks,
  _clearCdnLinks,
  applyCdnEdge,
  assertTorboxServable,
  chunkSizeFor,
  DISK_CHUNK_SIZE,
  getProxySession,
  handleProxyRequest,
  proxyReachedBytes,
  proxyStats,
  proxyWebseedUrl,
  registerProxySession,
  removeProxySession,
  sessionsForTest,
  waitForBytes,
} from "./proxy";

let originalFetch: typeof globalThis.fetch;

beforeAll(() => {
  originalFetch = globalThis.fetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

function mockFetch(fn: (...args: unknown[]) => Promise<Response>) {
  globalThis.fetch = fn as unknown as typeof fetch;
}

/** Sessions carry their own TorBox key now; there is no operator fallback. */
const TB_KEY = "SESSION_TB_KEY";

function registerSingleFile(jobId: string, fileSize: number) {
  registerProxySession(
    jobId,
    100,
    [{ rewrittenPath: "movie.mkv", webdavPath: "Original.Release.mkv", size: fileSize }],
    { torboxApiKey: TB_KEY },
  );
}

describe("proxy sessions", () => {
  test("register and retrieve session", () => {
    registerProxySession(
      "job-1",
      123,
      [{ rewrittenPath: "Clean/file.mkv", webdavPath: "Root/file.mkv", size: 5000 }],
      { torboxApiKey: TB_KEY },
    );
    const session = getProxySession("job-1");
    expect(session).toBeDefined();
    expect(session?.torboxTorrentId).toBe(123);
    expect(session?.files.size).toBe(1);
    expect(session?.files.get("Clean/file.mkv")?.size).toBe(5000);
    expect(session?.files.get("Clean/file.mkv")?.webdavPath).toBe("Root/file.mkv");
    removeProxySession("job-1");
  });

  test("register multi-file session", () => {
    registerProxySession(
      "job-multi",
      200,
      [
        { rewrittenPath: "Root/video.mkv", webdavPath: "Orig/video.mkv", size: 3000 },
        { rewrittenPath: "Root/subs.srt", webdavPath: "Orig/subs.srt", size: 100 },
      ],
      { torboxApiKey: TB_KEY },
    );
    const session = getProxySession("job-multi");
    expect(session?.files.size).toBe(2);
    expect(session?.files.get("Root/video.mkv")?.webdavPath).toBe("Orig/video.mkv");
    expect(session?.files.get("Root/subs.srt")?.webdavPath).toBe("Orig/subs.srt");
    removeProxySession("job-multi");
  });

  test("remove session", () => {
    registerProxySession(
      "job-2",
      456,
      [{ rewrittenPath: "f.mkv", webdavPath: "o.mkv", size: 9000 }],
      { torboxApiKey: TB_KEY },
    );
    removeProxySession("job-2");
    expect(getProxySession("job-2")).toBeUndefined();
  });

  test("restores session from DB when not in memory", () => {
    insertProxyMappings("job-db", 789, [
      { rewrittenPath: "Clean/restored.mkv", webdavPath: "Orig/restored.mkv", size: 12000 },
    ]);
    const session = getProxySession("job-db");
    expect(session).toBeDefined();
    expect(session?.torboxTorrentId).toBe(789);
    expect(session?.files.get("Clean/restored.mkv")?.size).toBe(12000);
    expect(session?.files.get("Clean/restored.mkv")?.webdavPath).toBe("Orig/restored.mkv");
    removeProxySession("job-db");
  });

  test("restores multi-file session from DB", () => {
    insertProxyMappings("job-db-multi", 300, [
      { rewrittenPath: "Root/a.mkv", webdavPath: "dir/a.mkv", size: 1000 },
      { rewrittenPath: "Root/b.srt", webdavPath: "dir/b.srt", size: 50 },
    ]);
    const session = getProxySession("job-db-multi");
    expect(session?.files.size).toBe(2);
    removeProxySession("job-db-multi");
  });
});

describe("handleProxyRequest", () => {
  test("returns 404 for unknown job", async () => {
    const res = await handleProxyRequest("nonexistent", "file.mkv", null);
    expect(res.status).toBe(404);
  });

  test("returns 404 for unknown file path", async () => {
    registerSingleFile("job-nofile", 1000);
    const res = await handleProxyRequest("job-nofile", "wrong.mkv", null);
    expect(res.status).toBe(404);
    removeProxySession("job-nofile");
  });

  test("expands a metered range to the TorBox chunk, not the disk chunk", async () => {
    let capturedHeaders = new Headers();
    mockFetch(async (_url: unknown, init: unknown) => {
      const opts = init as { headers?: HeadersInit };
      capturedHeaders = new Headers(opts?.headers);
      return new Response(Buffer.alloc(1024), { status: 206 });
    });

    registerSingleFile("job-range", 5_000_000_000);
    const res = await handleProxyRequest("job-range", "movie.mkv", "bytes=0-2097151");

    const end = config.torboxChunkSize - 1;
    expect(res.status).toBe(206);
    expect(capturedHeaders.get("range")).toBe(`bytes=0-${end}`);
    expect(res.headers.get("content-range")).toBe(`bytes 0-${end}/5000000000`);
    removeProxySession("job-range");
  });

  test("clamps expanded range to file size", async () => {
    let capturedRange = "";
    mockFetch(async (_url: unknown, init: unknown) => {
      const opts = init as { headers?: HeadersInit };
      capturedRange = new Headers(opts?.headers).get("range") ?? "";
      return new Response(Buffer.alloc(100), { status: 206 });
    });

    registerSingleFile("job-clamp", 1000);
    await handleProxyRequest("job-clamp", "movie.mkv", "bytes=500-999");

    expect(capturedRange).toBe("bytes=500-999");
    removeProxySession("job-clamp");
  });

  test("returns 416 when range starts beyond file size", async () => {
    let fetchCalled = false;
    mockFetch(async () => {
      fetchCalled = true;
      return new Response(Buffer.alloc(100), { status: 206 });
    });

    registerSingleFile("job-range-too-large", 1000);
    const res = await handleProxyRequest("job-range-too-large", "movie.mkv", "bytes=1000-");

    expect(res.status).toBe(416);
    expect(res.headers.get("content-range")).toBe("bytes */1000");
    expect(fetchCalled).toBe(false);
    removeProxySession("job-range-too-large");
  });

  test("returns full file without range", async () => {
    mockFetch(async () => new Response(Buffer.alloc(50), { status: 200 }));

    registerSingleFile("job-full", 50);
    const res = await handleProxyRequest("job-full", "movie.mkv", null);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe("50");
    removeProxySession("job-full");
  });

  test("returns 502 on upstream error for ranged request", async () => {
    mockFetch(async () => new Response("error", { status: 500 }));

    registerSingleFile("job-err", 1000);
    const res = await handleProxyRequest("job-err", "movie.mkv", "bytes=0-100");

    expect(res.status).toBe(502);
    removeProxySession("job-err");
  });

  test("returns 502 on upstream error for full request", async () => {
    mockFetch(async () => new Response("error", { status: 500 }));

    registerSingleFile("job-err2", 1000);
    const res = await handleProxyRequest("job-err2", "movie.mkv", null);

    expect(res.status).toBe(502);
    removeProxySession("job-err2");
  });

  test("encodes path segments individually for WebDAV URL", async () => {
    let capturedUrl = "";
    mockFetch(async (url: unknown) => {
      capturedUrl = String(url);
      return new Response(Buffer.alloc(10), { status: 200 });
    });

    registerProxySession(
      "job-enc",
      100,
      [{ rewrittenPath: "movie.mkv", webdavPath: "Release #1/file?name.mkv", size: 500 }],
      { torboxApiKey: TB_KEY },
    );
    await handleProxyRequest("job-enc", "movie.mkv", null);

    expect(capturedUrl).toBe("https://webdav.torbox.app/Release%20%231/file%3Fname.mkv");
    removeProxySession("job-enc");
  });

  test("sends WebDAV auth header", async () => {
    let capturedAuth = "";
    mockFetch(async (_url: unknown, init: unknown) => {
      const opts = init as { headers?: HeadersInit };
      capturedAuth = new Headers(opts?.headers).get("authorization") ?? "";
      return new Response(Buffer.alloc(10), { status: 200 });
    });

    registerSingleFile("job-auth", 500);
    await handleProxyRequest("job-auth", "movie.mkv", null);

    expect(capturedAuth).toMatch(/^Basic /);
    removeProxySession("job-auth");
  });

  test("handles malformed range header gracefully", async () => {
    mockFetch(async () => new Response(Buffer.alloc(50), { status: 200 }));

    registerSingleFile("job-badrange", 5000);
    const res = await handleProxyRequest("job-badrange", "movie.mkv", "invalid-range");

    expect(res.status).toBe(200);
    removeProxySession("job-badrange");
  });

  test("logs on every 100th request", async () => {
    mockFetch(async () => new Response(Buffer.alloc(10), { status: 206 }));

    registerSingleFile("job-log", 1_000_000);
    const session = getProxySession("job-log");
    if (session) session.requestCount = 99;

    const res = await handleProxyRequest("job-log", "movie.mkv", "bytes=0-1023");
    expect(res.status).toBe(206);
    removeProxySession("job-log");
  });

  test("resolves correct file in multi-file session", async () => {
    let capturedUrl = "";
    mockFetch(async (url: unknown) => {
      capturedUrl = String(url);
      return new Response(Buffer.alloc(10), { status: 200 });
    });

    registerProxySession(
      "job-mf",
      500,
      [
        { rewrittenPath: "Root/video.mkv", webdavPath: "Orig/big.mkv", size: 3000 },
        { rewrittenPath: "Root/subs.srt", webdavPath: "Orig/sub.srt", size: 100 },
      ],
      { torboxApiKey: TB_KEY },
    );

    await handleProxyRequest("job-mf", "Root/subs.srt", null);
    expect(capturedUrl).toBe("https://webdav.torbox.app/Orig/sub.srt");

    await handleProxyRequest("job-mf", "Root/video.mkv", null);
    expect(capturedUrl).toBe("https://webdav.torbox.app/Orig/big.mkv");
    removeProxySession("job-mf");
  });

  test("uses correct file size for range expansion per file", async () => {
    let capturedRange = "";
    mockFetch(async (_url: unknown, init: unknown) => {
      const opts = init as { headers?: HeadersInit };
      capturedRange = new Headers(opts?.headers).get("range") ?? "";
      return new Response(Buffer.alloc(10), { status: 206 });
    });

    registerProxySession(
      "job-mfr",
      500,
      [
        { rewrittenPath: "Root/big.mkv", webdavPath: "big.mkv", size: 5_000_000_000 },
        { rewrittenPath: "Root/small.srt", webdavPath: "small.srt", size: 200 },
      ],
      { torboxApiKey: TB_KEY },
    );

    await handleProxyRequest("job-mfr", "Root/small.srt", "bytes=0-500");
    expect(capturedRange).toBe("bytes=0-199");

    removeProxySession("job-mfr");
  });
});

describe("local file proxy (qBit)", () => {
  let tmpDir: string;
  let tmpFile: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-test-"));
    tmpFile = path.join(tmpDir, "movie.mkv");
    const data = Buffer.alloc(2000);
    for (let i = 0; i < data.length; i++) data[i] = i % 256;
    fs.writeFileSync(tmpFile, data);
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function registerQbitFile(jobId: string, filePath: string, size: number) {
    registerProxySession(jobId, -1, [{ rewrittenPath: "movie.mkv", webdavPath: filePath, size }]);
  }

  test("serves range from local file", async () => {
    registerQbitFile("qbit-range", tmpFile, 2000);
    const res = await handleProxyRequest("qbit-range", "movie.mkv", "bytes=0-99");
    expect(res.status).toBe(206);
    expect(res.headers.get("content-length")).toBe("2000");
    expect(res.headers.get("content-range")).toBe("bytes 0-1999/2000");
    const body = new Uint8Array(await res.arrayBuffer());
    expect(body.length).toBe(2000);
    expect(body[0]).toBe(0);
    expect(body[99]).toBe(99);
    removeProxySession("qbit-range");
  });

  test("returns 416 for out-of-range request", async () => {
    registerQbitFile("qbit-416", tmpFile, 2000);
    const res = await handleProxyRequest("qbit-416", "movie.mkv", "bytes=2000-");
    expect(res.status).toBe(416);
    expect(res.headers.get("content-range")).toBe("bytes */2000");
    removeProxySession("qbit-416");
  });

  test("serves full file without range", async () => {
    registerQbitFile("qbit-full", tmpFile, 2000);
    const res = await handleProxyRequest("qbit-full", "movie.mkv", null);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe("2000");
    // The body is an `fs.createReadStream`, which opens the file lazily. Leaving
    // it unconsumed lets that open land after `afterAll` has removed `tmpDir`,
    // surfacing as an unhandled ENOENT between tests — reproducible in CI.
    expect((await res.arrayBuffer()).byteLength).toBe(2000);
    removeProxySession("qbit-full");
  });

  test("clamps range to file size", async () => {
    registerQbitFile("qbit-clamp", tmpFile, 2000);
    const res = await handleProxyRequest("qbit-clamp", "movie.mkv", "bytes=1900-9999");
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 1900-1999/2000");
    expect(res.headers.get("content-length")).toBe("100");
    removeProxySession("qbit-clamp");
  });

  test("handles malformed range gracefully", async () => {
    registerQbitFile("qbit-bad", tmpFile, 2000);
    const res = await handleProxyRequest("qbit-bad", "movie.mkv", "garbage");
    expect(res.status).toBe(200);
    removeProxySession("qbit-bad");
  });

  test("logs on every 100th request", async () => {
    registerQbitFile("qbit-log", tmpFile, 2000);
    const session = getProxySession("qbit-log");
    if (session) session.requestCount = 99;
    const res = await handleProxyRequest("qbit-log", "movie.mkv", "bytes=0-99");
    expect(res.status).toBe(206);
    removeProxySession("qbit-log");
  });

  test("waits for bytes when file is incomplete", async () => {
    const growingFile = path.join(tmpDir, "growing.mkv");
    fs.writeFileSync(growingFile, Buffer.alloc(500));
    registerQbitFile("qbit-grow", growingFile, 2000);

    setTimeout(() => {
      fs.writeFileSync(growingFile, Buffer.alloc(2000));
    }, 600);

    const res = await handleProxyRequest("qbit-grow", "movie.mkv", "bytes=0-99");
    expect(res.status).toBe(206);
    removeProxySession("qbit-grow");
  });

  test("times out when bytes never arrive", async () => {
    const tinyFile = path.join(tmpDir, "tiny.mkv");
    fs.writeFileSync(tinyFile, Buffer.alloc(10));

    try {
      await waitForBytes(tinyFile, 10000, 1500);
      expect(true).toBe(false);
    } catch (err) {
      expect((err as Error).message).toContain("Timed out");
    }
  }, 5000);

  test("restores qbit session from DB", async () => {
    insertProxyMappings("qbit-db", -1, [
      { rewrittenPath: "movie.mkv", webdavPath: tmpFile, size: 2000 },
    ]);
    const session = getProxySession("qbit-db");
    expect(session?.torboxTorrentId).toBe(-1);
    const res = await handleProxyRequest("qbit-db", "movie.mkv", "bytes=0-9");
    expect(res.status).toBe(206);
    removeProxySession("qbit-db");
  });

  test("restores qbit session with file indices from DB", async () => {
    insertProxyMappings(
      "qbit-idx",
      -1,
      [{ rewrittenPath: "movie.mkv", webdavPath: tmpFile, size: 2000, qbitFileIndex: 5 }],
      { qbitHash: "abc123hash" },
    );
    const session = getProxySession("qbit-idx");
    expect(session?.qbitHash).toBe("abc123hash");
    expect(session?.files.get("movie.mkv")?.qbitFileIndex).toBe(5);
    removeProxySession("qbit-idx");
  });

  test("prioritizes qbit file when file does not exist yet", async () => {
    const missingFile = path.join(tmpDir, "missing-prio.mkv");

    registerProxySession(
      "qbit-missing",
      -1,
      [{ rewrittenPath: "movie.mkv", webdavPath: missingFile, size: 2000, qbitFileIndex: 1 }],
      { qbitHash: "fakehash000" },
    );

    setTimeout(() => {
      fs.writeFileSync(missingFile, Buffer.alloc(2000));
    }, 600);

    const res = await handleProxyRequest("qbit-missing", "movie.mkv", "bytes=0-99");
    expect(res.status).toBe(206);
    removeProxySession("qbit-missing");
  });

  test("prioritizes qbit file when bytes not available", async () => {
    const growFile = path.join(tmpDir, "prio.mkv");
    fs.writeFileSync(growFile, Buffer.alloc(500));

    registerProxySession(
      "qbit-prio",
      -1,
      [{ rewrittenPath: "movie.mkv", webdavPath: growFile, size: 2000, qbitFileIndex: 3 }],
      { qbitHash: "fakehash123" },
    );

    setTimeout(() => {
      fs.writeFileSync(growFile, Buffer.alloc(2000));
    }, 600);

    const res = await handleProxyRequest("qbit-prio", "movie.mkv", "bytes=0-99");
    expect(res.status).toBe(206);
    removeProxySession("qbit-prio");
  });

  test("serves full file and prioritizes when bytes not available", async () => {
    const growFile = path.join(tmpDir, "prio-full.mkv");
    fs.writeFileSync(growFile, Buffer.alloc(500));

    registerProxySession(
      "qbit-prio-full",
      -1,
      [{ rewrittenPath: "movie.mkv", webdavPath: growFile, size: 2000, qbitFileIndex: 7 }],
      { qbitHash: "fakehash456" },
    );

    // Cancelled below: if the request resolves before this fires, the timer
    // would otherwise write into `tmpDir` after `afterAll` has removed it and
    // throw an unhandled ENOENT between tests.
    const grow = setTimeout(() => {
      fs.writeFileSync(growFile, Buffer.alloc(2000));
    }, 600);

    try {
      const res = await handleProxyRequest("qbit-prio-full", "movie.mkv", null);
      expect(res.status).toBe(200);
      // Drain the lazy read stream before the temp directory can go away.
      expect((await res.arrayBuffer()).byteLength).toBe(2000);
    } finally {
      clearTimeout(grow);
    }
    removeProxySession("qbit-prio-full");
  });
});

describe("proxyWebseedUrl", () => {
  test("builds correct URL with trailing slash", () => {
    const url = proxyWebseedUrl("abc-123");
    expect(url).toContain("/webseed/abc-123/");
    expect(url).toEndWith("/");
  });
});

describe("chunkSizeFor", () => {
  test("expands a metered TorBox read to the configured chunk", () => {
    registerProxySession(
      "chunk-tb",
      55,
      [{ rewrittenPath: "a.mkv", webdavPath: "x.mkv", size: 10 }],
      { torboxApiKey: TB_KEY },
    );
    const session = getProxySession("chunk-tb");
    expect(session).toBeDefined();
    if (session) expect(chunkSizeFor(session)).toBe(config.torboxChunkSize);
    removeProxySession("chunk-tb");
  });

  test("keeps the wide window for free local disk reads", () => {
    registerProxySession(
      "chunk-qbit",
      -1,
      [{ rewrittenPath: "a.mkv", webdavPath: "/tmp/x.mkv", size: 10 }],
      { qbitHash: "hash" },
    );
    const session = getProxySession("chunk-qbit");
    expect(session).toBeDefined();
    if (session) expect(chunkSizeFor(session)).toBe(DISK_CHUNK_SIZE);
    removeProxySession("chunk-qbit");
  });

  test("the metered window is the smaller of the two", () => {
    expect(config.torboxChunkSize).toBeLessThan(DISK_CHUNK_SIZE);
  });
});

describe("proxyStats", () => {
  test("reports the payload size registered for a job", () => {
    registerProxySession(
      "stats-1",
      9,
      [
        { rewrittenPath: "a.mkv", webdavPath: "x.mkv", size: 1000 },
        { rewrittenPath: "b.mkv", webdavPath: "y.mkv", size: 500 },
      ],
      { torboxApiKey: TB_KEY },
    );

    expect(proxyStats("stats-1")).toEqual({
      requests: 0,
      servedBytes: 0,
      upstreamBytes: 0,
      payloadBytes: 1500,
    });
    removeProxySession("stats-1");
  });

  test("accumulates served bytes as ranges are answered", async () => {
    registerProxySession(
      "stats-2",
      9,
      [{ rewrittenPath: "movie.mkv", webdavPath: "Orig.mkv", size: 4000 }],
      { torboxApiKey: TB_KEY },
    );
    mockFetch(async () => new Response(Buffer.alloc(100), { status: 206 }));

    await handleProxyRequest("stats-2", "movie.mkv", "bytes=0-99");

    const stats = proxyStats("stats-2");
    expect(stats?.requests).toBe(1);
    // The whole file is smaller than a chunk, so the window is clamped to it.
    expect(stats?.servedBytes).toBe(4000);
    // Counted separately from what RD is handed, so a job that pulls bytes it
    // never gets to serve still registers as moving traffic.
    expect(stats?.upstreamBytes).toBe(4000);
    removeProxySession("stats-2");
  });

  test("returns undefined for an unknown job", () => {
    expect(proxyStats("no-such-job")).toBeUndefined();
  });
});

describe("proxyReachedBytes", () => {
  const CHUNK = config.torboxChunkSize;
  // Comfortably more than one chunk, so a range is not clamped to the file.
  const BIG = CHUNK * 5;

  test("returns undefined for an unknown job", () => {
    expect(proxyReachedBytes("no-such-job")).toBeUndefined();
  });

  test("advances as RD covers new ground", async () => {
    registerProxySession(
      "reach-1",
      9,
      [{ rewrittenPath: "movie.mkv", webdavPath: "Orig.mkv", size: BIG }],
      { torboxApiKey: TB_KEY },
    );
    mockFetch(async () => new Response(Buffer.alloc(10), { status: 206 }));

    await handleProxyRequest("reach-1", "movie.mkv", "bytes=0-99");
    expect(proxyReachedBytes("reach-1")).toBe(CHUNK);

    await handleProxyRequest("reach-1", "movie.mkv", `bytes=${CHUNK}-${CHUNK + 99}`);
    expect(proxyReachedBytes("reach-1")).toBe(CHUNK * 2);

    removeProxySession("reach-1");
  });

  test("stays put when RD re-requests ground it already has", async () => {
    // The wedged-job signature: RD spins on one range forever. `servedBytes`
    // keeps climbing, which is why it cannot be the stall detector's signal;
    // this must not move, so the detector can tell the difference.
    registerProxySession(
      "reach-2",
      9,
      [{ rewrittenPath: "movie.mkv", webdavPath: "Orig.mkv", size: BIG }],
      { torboxApiKey: TB_KEY },
    );
    mockFetch(async () => new Response(Buffer.alloc(10), { status: 206 }));

    for (let i = 0; i < 3; i++) {
      await handleProxyRequest("reach-2", "movie.mkv", "bytes=0-99");
    }

    expect(proxyReachedBytes("reach-2")).toBe(CHUNK);
    expect(proxyStats("reach-2")?.servedBytes).toBe(CHUNK * 3);
    removeProxySession("reach-2");
  });

  test("does not go backwards when an earlier range is re-fetched", async () => {
    registerProxySession(
      "reach-3",
      9,
      [{ rewrittenPath: "movie.mkv", webdavPath: "Orig.mkv", size: BIG }],
      { torboxApiKey: TB_KEY },
    );
    mockFetch(async () => new Response(Buffer.alloc(10), { status: 206 }));

    await handleProxyRequest("reach-3", "movie.mkv", `bytes=${CHUNK * 2}-${CHUNK * 2 + 99}`);
    expect(proxyReachedBytes("reach-3")).toBe(CHUNK * 3);

    await handleProxyRequest("reach-3", "movie.mkv", "bytes=0-99");
    expect(proxyReachedBytes("reach-3")).toBe(CHUNK * 3);

    removeProxySession("reach-3");
  });

  test("sums the high-water mark across files", async () => {
    registerProxySession(
      "reach-4",
      9,
      [
        { rewrittenPath: "a.mkv", webdavPath: "x.mkv", size: BIG },
        { rewrittenPath: "b.mkv", webdavPath: "y.mkv", size: BIG },
      ],
      { torboxApiKey: TB_KEY },
    );
    mockFetch(async () => new Response(Buffer.alloc(10), { status: 206 }));

    await handleProxyRequest("reach-4", "a.mkv", "bytes=0-99");
    await handleProxyRequest("reach-4", "b.mkv", "bytes=0-99");

    expect(proxyReachedBytes("reach-4")).toBe(CHUNK * 2);
    removeProxySession("reach-4");
  });

  test("is zero for a session that has served nothing", () => {
    registerProxySession(
      "reach-5",
      9,
      [{ rewrittenPath: "a.mkv", webdavPath: "x.mkv", size: BIG }],
      { torboxApiKey: TB_KEY },
    );
    expect(proxyReachedBytes("reach-5")).toBe(0);
    removeProxySession("reach-5");
  });
});

describe("per-job TorBox WebDAV key", () => {
  /** Capture the Basic auth header the WebDAV fetch sends upstream. */
  function captureAuth() {
    const seen: string[] = [];
    mockFetch(async (_url, init) => {
      seen.push(new Headers((init as RequestInit)?.headers).get("authorization") ?? "");
      return new Response(Buffer.alloc(16), {
        status: 206,
        headers: { "content-range": "bytes 0-15/16" },
      });
    });
    return seen;
  }

  function decode(header: string): string {
    return Buffer.from(header.replace("Basic ", ""), "base64").toString();
  }

  test("authenticates WebDAV as torbox:<the job's own key>", async () => {
    registerProxySession(
      "job-webdav-custom",
      900,
      [{ rewrittenPath: "movie.mkv", webdavPath: "Release/movie.mkv", size: 16 }],
      { torboxApiKey: "USER_TB_KEY" },
    );
    const seen = captureAuth();
    await handleProxyRequest("job-webdav-custom", "movie.mkv", "bytes=0-15");
    // The fixed username is TorBox's documented scheme; the key goes in the
    // password field, where TorBox actually validates it.
    expect(decode(seen[0])).toBe("torbox:USER_TB_KEY");
  });

  test("serves an error rather than the operator's key when the job carries none", async () => {
    // A session with no TorBox key used to authenticate as the operator, so the
    // bytes came out of their account and their abuse threshold.
    registerProxySession("job-webdav-shared", 901, [
      { rewrittenPath: "movie.mkv", webdavPath: "Release/movie.mkv", size: 16 },
    ]);
    const seen = captureAuth();

    await expect(
      handleProxyRequest("job-webdav-shared", "movie.mkv", "bytes=0-15"),
    ).rejects.toThrow(MissingCredentialError);

    expect(seen).toHaveLength(0);
  });

  test("recovers the job's key when the session is rehydrated from the DB", async () => {
    // The in-memory session is gone after a restart, but a resumed custom-key
    // job must still read from the submitter's account rather than falling back
    // to the operator's and 404ing on every byte.
    const jobId = "job-webdav-rehydrated";
    createJob(jobId, "magnet:?xt=urn:btih:rehydrate", "tt1", false, {
      tbApiKey: "REHYDRATED_KEY",
    });
    // Written straight to the DB, never through `registerProxySession`, so the
    // in-memory map has no entry and `getProxySession` must rebuild it.
    insertProxyMappings(jobId, 902, [
      { rewrittenPath: "movie.mkv", webdavPath: "Release/movie.mkv", size: 16 },
    ]);

    const seen = captureAuth();
    await handleProxyRequest(jobId, "movie.mkv", "bytes=0-15");
    expect(decode(seen[0])).toBe("torbox:REHYDRATED_KEY");
  });
});

describe("CDN redirect path (WEBSEED_REDIRECT)", () => {
  // `torboxCdnEdge` defaults to `hare`, which rewrites the minted host. These
  // tests are about what happens to a CDN link, not which edge serves it, so
  // they pin the rewrite off and assert against the host `requestdl` returned.
  const originalEdge = config.torboxCdnEdge;
  beforeEach(() => {
    (config as { torboxCdnEdge: string }).torboxCdnEdge = "";
  });
  afterEach(() => {
    (config as { torboxCdnEdge: string }).torboxCdnEdge = originalEdge;
  });
  const originalFlag = config.webseedRedirect;

  afterEach(() => {
    (config as { webseedRedirect: boolean }).webseedRedirect = originalFlag;
    _clearCdnLinks();
  });

  function enable() {
    (config as { webseedRedirect: boolean }).webseedRedirect = true;
    _clearCdnLinks();
  }

  test("redirects RD to a minted CDN link with 307, preserving its Range", async () => {
    enable();
    let minted = 0;
    mockFetch(async (url) => {
      minted++;
      expect(String(url)).toContain("/torrents/requestdl");
      return Response.json({ data: "https://nexus-1.ceur.tb-cdn.st/dl/movie.mkv?token=x" });
    });
    registerProxySession(
      "job-redir",
      700,
      [{ rewrittenPath: "movie.mkv", webdavPath: "Orig/movie.mkv", size: 5000, torboxFileId: 3 }],
      { torboxApiKey: TB_KEY },
    );

    const res = await handleProxyRequest("job-redir", "movie.mkv", "bytes=0-1023");
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://nexus-1.ceur.tb-cdn.st/dl/movie.mkv?token=x");
    // No range expansion and no upstream body fetch — that is the whole point.
    expect(minted).toBe(1);
  });

  test("caches the link across requests rather than minting per range", async () => {
    enable();
    let minted = 0;
    mockFetch(async () => {
      minted++;
      return Response.json({ data: "https://cdn.example/f?token=x" });
    });
    registerProxySession(
      "job-redir-cache",
      701,
      [{ rewrittenPath: "movie.mkv", webdavPath: "Orig/movie.mkv", size: 5000, torboxFileId: 4 }],
      { torboxApiKey: TB_KEY },
    );

    for (let i = 0; i < 5; i++) {
      const res = await handleProxyRequest("job-redir-cache", "movie.mkv", `bytes=${i * 100}-`);
      expect(res.status).toBe(307);
    }
    // 12,961 range requests on one job against TorBox's ~300/min limit is why
    // this must not mint per request.
    expect(minted).toBe(1);
  });

  test("falls back to proxying when the link cannot be minted", async () => {
    enable();
    let call = 0;
    mockFetch(async () => {
      call++;
      // First call is requestdl (fails); second is the WebDAV fallback fetch.
      if (call === 1) return new Response("boom", { status: 500 });
      return new Response(Buffer.alloc(1024), {
        status: 206,
        headers: { "content-range": "bytes 0-1023/5000" },
      });
    });
    registerProxySession(
      "job-redir-fail",
      702,
      [{ rewrittenPath: "movie.mkv", webdavPath: "Orig/movie.mkv", size: 5000, torboxFileId: 5 }],
      { torboxApiKey: TB_KEY },
    );

    const res = await handleProxyRequest("job-redir-fail", "movie.mkv", "bytes=0-1023");
    expect(res.status).toBe(206);
    expect(call).toBe(2);
  });

  test("proxies normally for a job with no TorBox file id recorded", async () => {
    enable();
    mockFetch(
      async () =>
        new Response(Buffer.alloc(1024), {
          status: 206,
          headers: { "content-range": "bytes 0-1023/5000" },
        }),
    );
    // Older sessions predate the column, so the redirect must not engage.
    registerProxySession(
      "job-redir-nofid",
      703,
      [{ rewrittenPath: "movie.mkv", webdavPath: "Orig/movie.mkv", size: 5000 }],
      { torboxApiKey: TB_KEY },
    );
    const res = await handleProxyRequest("job-redir-nofid", "movie.mkv", "bytes=0-1023");
    expect(res.status).toBe(206);
  });

  test("stays on the proxy path while the flag is off", async () => {
    _clearCdnLinks();
    mockFetch(
      async () =>
        new Response(Buffer.alloc(1024), {
          status: 206,
          headers: { "content-range": "bytes 0-1023/5000" },
        }),
    );
    registerProxySession(
      "job-redir-off",
      704,
      [{ rewrittenPath: "movie.mkv", webdavPath: "Orig/movie.mkv", size: 5000, torboxFileId: 6 }],
      { torboxApiKey: TB_KEY },
    );
    const res = await handleProxyRequest("job-redir-off", "movie.mkv", "bytes=0-1023");
    expect(res.status).toBe(206);
  });
});

describe("CDN upstream mode (TORBOX_UPSTREAM=cdn)", () => {
  // `torboxCdnEdge` defaults to `hare`, which rewrites the minted host. These
  // tests are about what happens to a CDN link, not which edge serves it, so
  // they pin the rewrite off and assert against the host `requestdl` returned.
  const originalEdge = config.torboxCdnEdge;
  beforeEach(() => {
    (config as { torboxCdnEdge: string }).torboxCdnEdge = "";
  });
  afterEach(() => {
    (config as { torboxCdnEdge: string }).torboxCdnEdge = originalEdge;
  });
  const originalMode = config.torboxUpstream;

  afterEach(() => {
    (config as { torboxUpstream: string }).torboxUpstream = originalMode;
    _clearCdnLinks();
  });

  function useCdn() {
    (config as { torboxUpstream: string }).torboxUpstream = "cdn";
    _clearCdnLinks();
  }

  for (const status of [400, 404]) {
    for (const recovered of [true, false]) {
      test(`stale TorBox CDN ${status} remints once, recovered=${recovered}`, async () => {
        useCdn();
        let minted = 0;
        let reads = 0;
        let webdav = 0;
        mockFetch(async (url) => {
          const u = String(url);
          if (u.includes("requestdl")) {
            minted++;
            return Response.json({ data: `https://cdn.example/generation-${minted}` });
          }
          if (u.includes("cdn.example")) {
            reads++;
            if (u.endsWith("generation-1") || !recovered) {
              return new Response(status === 400 ? "Invalid Presigned Token" : null, { status });
            }
            return new Response(Buffer.alloc(5000), { status: 206 });
          }
          webdav++;
          return new Response(Buffer.alloc(5000), { status: 206 });
        });
        const jobId = `job-stale-cdn-${status}-${recovered}`;
        registerProxySession(
          jobId,
          800,
          [
            {
              rewrittenPath: "movie.mkv",
              webdavPath: "Orig/movie.mkv",
              size: 5000,
              torboxFileId: 2,
            },
          ],
          { torboxApiKey: TB_KEY },
        );
        expect((await handleProxyRequest(jobId, "movie.mkv", "bytes=0-1023")).status).toBe(206);
        expect(minted).toBe(2);
        expect(reads).toBe(2);
        expect(webdav).toBe(recovered ? 0 : 1);
        if (recovered) {
          expect((await handleProxyRequest(jobId, "movie.mkv", "bytes=1024-2047")).status).toBe(
            206,
          );
          expect(minted).toBe(2);
        }
        removeProxySession(jobId);
      });
    }
  }

  test("fetches the range from the CDN link, with no Authorization header", async () => {
    useCdn();
    const seen: { url: string; auth: string | null; range: string | null }[] = [];
    mockFetch(async (url, init) => {
      const h = new Headers((init as RequestInit)?.headers);
      seen.push({ url: String(url), auth: h.get("authorization"), range: h.get("range") });
      if (String(url).includes("requestdl")) {
        return Response.json({ data: "https://nexus-1.ceur.tb-cdn.st/dl/movie.mkv?token=x" });
      }
      return new Response(Buffer.alloc(1024), {
        status: 206,
        headers: { "content-range": "bytes 0-1023/5000" },
      });
    });
    registerProxySession(
      "job-cdn-up",
      800,
      [{ rewrittenPath: "movie.mkv", webdavPath: "Orig/movie.mkv", size: 5000, torboxFileId: 2 }],
      { torboxApiKey: TB_KEY },
    );

    const res = await handleProxyRequest("job-cdn-up", "movie.mkv", "bytes=0-1023");
    expect(res.status).toBe(206);
    const fetchCall = seen[seen.length - 1];
    expect(fetchCall.url).toContain("tb-cdn.st");
    // A self-authenticating link must not also carry WebDAV Basic auth.
    expect(fetchCall.auth).toBeNull();
    // Range expansion still applies — it is what controls amplification, and it
    // must not be lost by swapping the upstream. RD asked for 1KB; the chunk
    // size expands that to the whole 5000-byte fixture.
    expect(fetchCall.range).toBe("bytes=0-4999");
  });

  test("falls back to WebDAV when no link can be minted", async () => {
    useCdn();
    const urls: string[] = [];
    mockFetch(async (url) => {
      urls.push(String(url));
      if (String(url).includes("requestdl")) return new Response("nope", { status: 500 });
      return new Response(Buffer.alloc(1024), {
        status: 206,
        headers: { "content-range": "bytes 0-1023/5000" },
      });
    });
    registerProxySession(
      "job-cdn-fb",
      801,
      [{ rewrittenPath: "movie.mkv", webdavPath: "Orig/movie.mkv", size: 5000, torboxFileId: 9 }],
      { torboxApiKey: TB_KEY },
    );

    const res = await handleProxyRequest("job-cdn-fb", "movie.mkv", "bytes=0-1023");
    expect(res.status).toBe(206);
    expect(urls[urls.length - 1]).toContain("webdav.torbox.app");
  });

  test("uses WebDAV when the mode is not enabled", async () => {
    const urls: string[] = [];
    mockFetch(async (url) => {
      urls.push(String(url));
      return new Response(Buffer.alloc(1024), {
        status: 206,
        headers: { "content-range": "bytes 0-1023/5000" },
      });
    });
    registerProxySession(
      "job-cdn-off",
      802,
      [{ rewrittenPath: "movie.mkv", webdavPath: "Orig/movie.mkv", size: 5000, torboxFileId: 1 }],
      { torboxApiKey: TB_KEY },
    );
    await handleProxyRequest("job-cdn-off", "movie.mkv", "bytes=0-1023");
    expect(urls[0]).toContain("webdav.torbox.app");
  });
});

/**
 * Regression for Fizzy #586, from debrid02's journal. A failed `requestdl` was
 * not remembered, so every RD range read minted again on the user's key: one
 * job made 7,783 failed calls in 2.5 h, 7,781 of them DATABASE_ERROR, while
 * WebDAV served the bytes. A transient DATABASE_ERROR right after an add must
 * still recover, which is why only a persisting one ends CDN use.
 */
describe("a failed CDN mint is remembered (TORBOX_UPSTREAM=cdn)", () => {
  const originalMode = config.torboxUpstream;
  const originalEdge = config.torboxCdnEdge;
  const t0 = new Date("2026-10-24T21:46:55Z").getTime();
  beforeEach(() => {
    (config as { torboxUpstream: string }).torboxUpstream = "cdn";
    (config as { torboxCdnEdge: string }).torboxCdnEdge = "";
    _clearCdnLinks();
    setSystemTime(t0);
  });
  afterEach(() => {
    (config as { torboxUpstream: string }).torboxUpstream = originalMode;
    (config as { torboxCdnEdge: string }).torboxCdnEdge = originalEdge;
    _clearCdnLinks();
    setSystemTime();
  });
  const at = (seconds: number) => setSystemTime(t0 + seconds * 1000);

  const recorded = (name: keyof typeof requestdlFailures.bodies) => {
    const { status, body } = requestdlFailures.bodies[name];
    return () => new Response(body, { status });
  };

  /** requestdl answers `mint()`; the CDN link and WebDAV both serve. */
  function torbox(mint: () => Response) {
    const calls = { mint: 0, cdn: 0, webdav: 0 };
    mockFetch(async (url) => {
      const u = String(url);
      if (u.includes("/torrents/requestdl")) {
        calls.mint++;
        return mint();
      }
      if (u.startsWith("https://cdn.example/")) calls.cdn++;
      else calls.webdav++;
      return new Response(Buffer.alloc(1024), {
        status: 206,
        headers: { "content-range": "bytes 0-1023/5000" },
      });
    });
    return calls;
  }

  function register(jobId: string, torrentId: number) {
    registerProxySession(
      jobId,
      torrentId,
      [{ rewrittenPath: "movie.mkv", webdavPath: "Orig/movie.mkv", size: 5000, torboxFileId: 1 }],
      { torboxApiKey: TB_KEY },
    );
  }

  /** RD's shape: ranges back to back and several at once. */
  async function rdReads(jobId: string, n = 10) {
    const read = (i: number) => handleProxyRequest(jobId, "movie.mkv", `bytes=${i}-${i + 99}`);
    for (let i = 0; i < n; i++) expect((await read(i)).status).toBe(206);
    const parallel = await Promise.all(Array.from({ length: n }, (_, i) => read(i)));
    for (const res of parallel) expect(res.status).toBe(206);
  }

  test("one requestdl call per backoff window, WebDAV serving meanwhile", async () => {
    const calls = torbox(recorded("gateway_timeout"));
    register("job-586-window", 586001);

    await rdReads("job-586-window");
    expect(calls.mint).toBe(1);
    expect(calls.webdav).toBe(20);

    at(29);
    await rdReads("job-586-window");
    expect(calls.mint).toBe(1);

    at(31);
    await rdReads("job-586-window");
    expect(calls.mint).toBe(2);
    removeProxySession("job-586-window");
  });

  test("a persisting DATABASE_ERROR is not retried for the rest of the attempt", async () => {
    const calls = torbox(recorded("database_error"));
    register("job-586-gone", 586002);

    // Windows double from 30 s: calls at 0, 31, 92, 213 s, then never again.
    for (const s of [0, 31, 92, 213, 3600, requestdlFailures.persistent.last_failure_at_s]) {
      at(s);
      await rdReads("job-586-gone");
    }
    expect(calls.mint).toBe(4);
    expect(calls.cdn).toBe(0);
    removeProxySession("job-586-gone");
  });

  test("other failures keep backing off up to ten minutes, never giving up", async () => {
    let answers = [recorded("auth_error"), recorded("database_error"), recorded("database_error")];
    answers = [...answers, recorded("database_error"), recorded("gateway_timeout")];
    let i = 0;
    const calls = torbox(() => answers[Math.min(i++, answers.length - 1)]());
    register("job-586-mixed", 586003);

    for (const s of [0, 31, 92, 213, 454, 935, 1536, 2137]) {
      at(s);
      await rdReads("job-586-mixed", 2);
    }
    // Three DATABASE_ERRORs then a 504 is not persistence; 10-min cap from 935 s.
    expect(calls.mint).toBe(8);
    removeProxySession("job-586-mixed");
  });

  test("a transient DATABASE_ERROR at add recovers onto the CDN", async () => {
    const { database_error_at_s, minted_at_s } = requestdlFailures.transient_at_add;
    let failing = true;
    const calls = torbox(() =>
      failing
        ? recorded("database_error")()
        : Response.json({ data: "https://cdn.example/movie.mkv?token=x" }),
    );
    register("job-586-transient", 586004);

    at(database_error_at_s[0]);
    await rdReads("job-586-transient");
    failing = false;
    at(minted_at_s);
    await rdReads("job-586-transient");
    expect(calls.cdn).toBe(0);

    at(database_error_at_s[0] + 31);
    await rdReads("job-586-transient");
    expect(calls.mint).toBe(2);
    expect(calls.cdn).toBe(20);
    removeProxySession("job-586-transient");
  });

  test("a new attempt on the same held torrent mints again", async () => {
    const calls = torbox(recorded("database_error"));
    register("job-586-reattempt", 586005);
    for (const s of [0, 31, 92, 213]) {
      at(s);
      await rdReads("job-586-reattempt", 1);
    }
    expect(calls.mint).toBe(4);

    const mappings = [{ webdavPath: "Orig/movie.mkv", size: 5000, torboxFileId: 1 }];
    await assertTorboxServable("job-586-reattempt", mappings, TB_KEY, {
      graceMs: 0,
      torboxTorrentId: 586005,
    });
    expect(calls.mint).toBe(5);
    removeProxySession("job-586-reattempt");
  });

  test("a refused link still re-mints after a failure has cleared", async () => {
    let mintAnswer = recorded("gateway_timeout");
    const cdnStatus = [400, 206];
    const calls = { mint: 0, cdn: 0, webdav: 0 };
    mockFetch(async (url) => {
      const u = String(url);
      if (u.includes("/torrents/requestdl")) {
        calls.mint++;
        return mintAnswer();
      }
      if (u.startsWith("https://cdn.example/")) {
        const status = cdnStatus[calls.cdn++] ?? 206;
        return status === 206
          ? new Response(Buffer.alloc(1024), { status })
          : new Response(null, { status });
      }
      calls.webdav++;
      return new Response(Buffer.alloc(1024), { status: 206 });
    });
    register("job-586-refresh", 586006);

    await rdReads("job-586-refresh", 1);
    mintAnswer = () => Response.json({ data: `https://cdn.example/gen-${calls.mint}` });
    at(31);
    // Mints, the CDN refuses 400, the refresh re-mints and the new link serves.
    expect((await handleProxyRequest("job-586-refresh", "movie.mkv", "bytes=0-99")).status).toBe(
      206,
    );
    expect(calls.mint).toBe(3);
    expect(calls.cdn).toBe(2);
    removeProxySession("job-586-refresh");
  });
});

describe("torbox file id survives persistence", () => {
  // `torboxCdnEdge` defaults to `hare`, which rewrites the minted host. These
  // tests are about what happens to a CDN link, not which edge serves it, so
  // they pin the rewrite off and assert against the host `requestdl` returned.
  const originalEdge = config.torboxCdnEdge;
  beforeEach(() => {
    (config as { torboxCdnEdge: string }).torboxCdnEdge = "";
  });
  afterEach(() => {
    (config as { torboxCdnEdge: string }).torboxCdnEdge = originalEdge;
  });
  afterEach(() => {
    (config as { torboxUpstream: string }).torboxUpstream = "webdav";
    _clearCdnLinks();
  });

  test("a rehydrated session still knows its TorBox file ids", async () => {
    // Registered in memory, then dropped as a restart would — the file id has
    // to come back from `proxy_sessions`, or the CDN upstream silently degrades
    // to WebDAV for the rest of the job. This is exactly what a mid-job deploy
    // did in production on 2026-08-05.
    createJob("job-persist", "magnet:?xt=urn:btih:persist", "tt1", false, { tbApiKey: TB_KEY });
    registerProxySession(
      "job-persist",
      900,
      [{ rewrittenPath: "movie.mkv", webdavPath: "Orig/movie.mkv", size: 5000, torboxFileId: 42 }],
      { torboxApiKey: TB_KEY },
    );
    sessionsForTest().delete("job-persist");

    (config as { torboxUpstream: string }).torboxUpstream = "cdn";
    _clearCdnLinks();
    const urls: string[] = [];
    mockFetch(async (url) => {
      urls.push(String(url));
      if (String(url).includes("requestdl")) {
        return Response.json({ data: "https://cdn.example/f?token=x" });
      }
      return new Response(Buffer.alloc(1024), {
        status: 206,
        headers: { "content-range": "bytes 0-1023/5000" },
      });
    });

    const res = await handleProxyRequest("job-persist", "movie.mkv", "bytes=0-1023");
    expect(res.status).toBe(206);
    expect(urls.some((u) => u.includes("file_id=42"))).toBe(true);
    expect(urls[urls.length - 1]).toContain("cdn.example");
  });
});

describe("CDN upstream survives a refused connection", () => {
  // `torboxCdnEdge` defaults to `hare`, which rewrites the minted host. These
  // tests are about what happens to a CDN link, not which edge serves it, so
  // they pin the rewrite off and assert against the host `requestdl` returned.
  const originalEdge = config.torboxCdnEdge;
  beforeEach(() => {
    (config as { torboxCdnEdge: string }).torboxCdnEdge = "";
  });
  afterEach(() => {
    (config as { torboxCdnEdge: string }).torboxCdnEdge = originalEdge;
  });
  afterEach(() => {
    (config as { torboxUpstream: string }).torboxUpstream = "webdav";
    _clearCdnLinks();
  });

  test("falls back to WebDAV when the CDN node refuses the connection", async () => {
    // TorBox CDN nodes answer ConnectionRefused once a multi-file job opens too
    // many at once. Before this was caught, the throw escaped the handler, RD
    // saw a dead webseed and stopped after ~400 ranges with the job at 3.9%.
    (config as { torboxUpstream: string }).torboxUpstream = "cdn";
    _clearCdnLinks();
    const urls: string[] = [];
    mockFetch(async (url) => {
      const u = String(url);
      urls.push(u);
      if (u.includes("requestdl")) return Response.json({ data: "https://cdn.example/f?token=x" });
      if (u.includes("cdn.example")) throw new Error("Unable to connect. ConnectionRefused");
      return new Response(Buffer.alloc(1024), {
        status: 206,
        headers: { "content-range": "bytes 0-1023/5000" },
      });
    });
    registerProxySession(
      "job-refused",
      950,
      [{ rewrittenPath: "movie.mkv", webdavPath: "Orig/movie.mkv", size: 5000, torboxFileId: 3 }],
      { torboxApiKey: TB_KEY },
    );

    const res = await handleProxyRequest("job-refused", "movie.mkv", "bytes=0-1023");
    expect(res.status).toBe(206);
    expect(urls.some((u) => u.includes("cdn.example"))).toBe(true);
    expect(urls[urls.length - 1]).toContain("webdav.torbox.app");
  });

  test("falls back to WebDAV when the CDN refuses with a status rather than a throw", async () => {
    // Measured live on debrid02 2026-08-17 with TORBOX_UPSTREAM=cdn under four
    // concurrent jobs: the nexus node answered 45 ranges with `503` in one
    // window, plus a `400` carrying an HTML error page. Those are responses,
    // not throws, so the ConnectionRefused fallback above never saw them and
    // the refusal went straight back to RD as a dead range.
    (config as { torboxUpstream: string }).torboxUpstream = "cdn";
    _clearCdnLinks();
    const urls: string[] = [];
    mockFetch(async (url) => {
      const u = String(url);
      urls.push(u);
      if (u.includes("requestdl")) return Response.json({ data: "https://cdn.example/f?token=x" });
      if (u.includes("cdn.example")) return new Response("upstream busy", { status: 503 });
      return new Response(Buffer.alloc(1024), {
        status: 206,
        headers: { "content-range": "bytes 0-1023/5000" },
      });
    });
    registerProxySession(
      "job-503",
      951,
      [{ rewrittenPath: "movie.mkv", webdavPath: "Orig/movie.mkv", size: 5000, torboxFileId: 3 }],
      { torboxApiKey: TB_KEY },
    );

    const res = await handleProxyRequest("job-503", "movie.mkv", "bytes=0-1023");
    expect(res.status).toBe(206);
    expect(urls[urls.length - 1]).toContain("webdav.torbox.app");
  });

  test("a 416 from the CDN is an answer, not a refusal, so it stands", async () => {
    // Range Not Satisfiable is the CDN correctly answering an out-of-range ask.
    // Retrying that against WebDAV would spend a second request to be told the
    // same thing.
    (config as { torboxUpstream: string }).torboxUpstream = "cdn";
    _clearCdnLinks();
    const urls: string[] = [];
    mockFetch(async (url) => {
      const u = String(url);
      urls.push(u);
      if (u.includes("requestdl")) return Response.json({ data: "https://cdn.example/f?token=x" });
      if (u.includes("cdn.example")) return new Response(null, { status: 416 });
      return new Response(Buffer.alloc(1024), { status: 206 });
    });
    registerProxySession(
      "job-416",
      952,
      [{ rewrittenPath: "movie.mkv", webdavPath: "Orig/movie.mkv", size: 5000, torboxFileId: 3 }],
      { torboxApiKey: TB_KEY },
    );

    const res = await handleProxyRequest("job-416", "movie.mkv", "bytes=0-1023");
    // The webseed handler maps upstream refusals to 502, but must not remint
    // or fall back for the CDN's definitive 416.
    expect(res.status).toBe(502);
    expect(urls.filter((url) => url.includes("requestdl"))).toHaveLength(1);
    expect(urls.filter((url) => url.includes("cdn.example"))).toHaveLength(1);
    expect(urls.some((u) => u.includes("webdav.torbox.app"))).toBe(false);
  });

  test("falls back on a refused full-file request too", async () => {
    (config as { torboxUpstream: string }).torboxUpstream = "cdn";
    _clearCdnLinks();
    const urls: string[] = [];
    mockFetch(async (url) => {
      const u = String(url);
      urls.push(u);
      if (u.includes("requestdl")) return Response.json({ data: "https://cdn.example/f?token=x" });
      if (u.includes("cdn.example")) throw new Error("ConnectionRefused");
      return new Response(Buffer.alloc(50), { status: 200 });
    });
    registerProxySession(
      "job-refused-full",
      951,
      [{ rewrittenPath: "movie.mkv", webdavPath: "Orig/movie.mkv", size: 50, torboxFileId: 4 }],
      { torboxApiKey: TB_KEY },
    );

    const res = await handleProxyRequest("job-refused-full", "movie.mkv", null);
    expect(res.status).toBe(200);
    expect(urls[urls.length - 1]).toContain("webdav.torbox.app");
  });
});

describe("ranged upstream must be partial", () => {
  test("rejects a 200 answer to a ranged request instead of relabelling it", async () => {
    // A 200 means the upstream ignored the Range and is sending from byte 0.
    // Passing it through as a 206 for an arbitrary offset feeds RD corrupt
    // pieces, which is silent and only shows up as a stalled torrent.
    mockFetch(async () => new Response(Buffer.alloc(4096), { status: 200 }));
    registerProxySession(
      "job-not-partial",
      960,
      [{ rewrittenPath: "movie.mkv", webdavPath: "Orig/movie.mkv", size: 5_000_000 }],
      { torboxApiKey: TB_KEY },
    );
    const res = await handleProxyRequest("job-not-partial", "movie.mkv", "bytes=1000000-1001000");
    expect(res.status).toBe(502);
    removeProxySession("job-not-partial");
  });
});

describe("applyCdnEdge", () => {
  const original = config.torboxCdnEdge;
  afterEach(() => {
    (config as { torboxCdnEdge: string }).torboxCdnEdge = original;
  });
  function setEdge(v: string) {
    (config as { torboxCdnEdge: string }).torboxCdnEdge = v;
  }
  const minted = "https://nexus-070.ceur.tb-cdn.st/dld/uuid-here?token=abc123";

  test("rewrites only the host onto the Cloudflare edge", () => {
    setEdge("erth");
    expect(applyCdnEdge(minted)).toBe("https://nexus.erth.tb-cdn.earth/dld/uuid-here?token=abc123");
  });

  test("supports the Bunny edge", () => {
    setEdge("hare");
    expect(applyCdnEdge(minted)).toContain("nexus.hare.tb-cdn.earth");
  });

  test("leaves the link alone when unset or unknown", () => {
    setEdge("");
    expect(applyCdnEdge(minted)).toBe(minted);
    setEdge("nonsense");
    expect(applyCdnEdge(minted)).toBe(minted);
  });

  test("preserves the token, which is what authenticates the fetch", () => {
    setEdge("erth");
    expect(applyCdnEdge(minted)).toContain("?token=abc123");
    expect(applyCdnEdge(minted)).toContain("/dld/uuid-here");
  });
});

describe("applyCdnEdge with multiple edges", () => {
  const original = config.torboxCdnEdge;
  afterEach(() => {
    (config as { torboxCdnEdge: string }).torboxCdnEdge = original;
  });
  const minted = "https://nexus-070.ceur.tb-cdn.st/dld/uuid-here?token=abc123";

  test("picks only from the configured edges, and uses both over many mints", () => {
    (config as { torboxCdnEdge: string }).torboxCdnEdge = "erth,hare";
    const hosts = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const out = applyCdnEdge(minted);
      hosts.add(new URL(out).host);
      // Whichever is chosen, the authenticating parts must survive untouched.
      expect(out).toContain("/dld/uuid-here?token=abc123");
    }
    expect(hosts).toEqual(new Set(["nexus.erth.tb-cdn.earth", "nexus.hare.tb-cdn.earth"]));
  });

  test("tolerates whitespace and drops unknown names from the list", () => {
    (config as { torboxCdnEdge: string }).torboxCdnEdge = " erth , bogus ";
    for (let i = 0; i < 20; i++) {
      expect(new URL(applyCdnEdge(minted)).host).toBe("nexus.erth.tb-cdn.earth");
    }
  });

  test("leaves the link alone when every name is unknown", () => {
    (config as { torboxCdnEdge: string }).torboxCdnEdge = "nope,alsonope";
    expect(applyCdnEdge(minted)).toBe(minted);
  });
});

describe("AllDebrid upstream", () => {
  /**
   * An AllDebrid session: no WebDAV path, no TorBox file id, just a locked
   * `alldebrid.com/f/…` link per file. `torboxTorrentId` is 0 rather than -1 —
   * -1 would mark it as local disk — and the source is stated outright.
   */
  // Defaulted because an AllDebrid session with no key can no longer fall back
  // to the operator's; tests that care about a specific key still pass one.
  function registerAdSession(jobId: string, size = 5000, apiKey = "AD_KEY") {
    registerProxySession(
      jobId,
      0,
      [
        {
          rewrittenPath: "movie.mkv",
          webdavPath: "Rel/Original.Release.mkv",
          size,
          adLink: "https://alldebrid.com/f/tok",
        },
      ],
      { source: "alldebrid", adMagnetId: 667750156, alldebridApiKey: apiKey },
    );
  }

  test("dead AD token is resolved once across concurrent and subsequent ranges", async () => {
    _clearAdLinks();
    let unlocks = 0;
    mockFetch(async () => {
      unlocks++;
      await Promise.resolve();
      return Response.json(rawFun.ad_unlock_dead_token.body, {
        status: rawFun.ad_unlock_dead_token.http,
      });
    });
    registerAdSession("job-ad-dead-token");
    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        handleProxyRequest("job-ad-dead-token", "movie.mkv", "bytes=0-1023"),
      ),
    );
    expect(responses.map((res) => res.status)).toEqual([502, 502, 502, 502, 502]);
    expect(
      (await handleProxyRequest("job-ad-dead-token", "movie.mkv", "bytes=1024-2047")).status,
    ).toBe(502);
    expect(unlocks).toBe(1);
    removeProxySession("job-ad-dead-token");
  });

  test("transient AD unlock failure can recover on the next range", async () => {
    _clearAdLinks();
    let unlocks = 0;
    mockFetch(async (url) => {
      if (String(url).includes("/link/unlock")) {
        unlocks++;
        if (unlocks === 1) return new Response(null, { status: 503 });
        return Response.json({ status: "success", data: { link: "https://dl.example/live" } });
      }
      return new Response(Buffer.alloc(5000), { status: 206 });
    });
    registerAdSession("job-ad-transient-token");
    expect(
      (await handleProxyRequest("job-ad-transient-token", "movie.mkv", "bytes=0-1023")).status,
    ).toBe(502);
    expect(
      (await handleProxyRequest("job-ad-transient-token", "movie.mkv", "bytes=0-1023")).status,
    ).toBe(206);
    expect(unlocks).toBe(2);
    removeProxySession("job-ad-transient-token");
  });

  /** Answer an unlock with a direct link, and any other fetch with a 206. */
  function mockUnlockThenBytes(seen: { url: string; auth: string | null; range: string | null }[]) {
    mockFetch(async (url, init) => {
      const h = new Headers((init as RequestInit | undefined)?.headers);
      seen.push({ url: String(url), auth: h.get("authorization"), range: h.get("range") });
      if (String(url).includes("/link/unlock")) {
        return Response.json({
          status: "success",
          data: { link: "https://z2a3b4.debrid.it/dl/52aq/movie.mkv" },
        });
      }
      return new Response(Buffer.alloc(1024), {
        status: 206,
        headers: { "content-range": "bytes 0-4999/5000" },
      });
    });
  }

  afterEach(() => {
    _clearAdLinks();
  });

  test("unlocks a link and serves the expanded range from it", async () => {
    const seen: { url: string; auth: string | null; range: string | null }[] = [];
    mockUnlockThenBytes(seen);
    registerAdSession("job-ad");

    const res = await handleProxyRequest("job-ad", "movie.mkv", "bytes=0-1023");
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 0-4999/5000");

    const fetched = seen[seen.length - 1];
    expect(fetched.url).toBe("https://z2a3b4.debrid.it/dl/52aq/movie.mkv");
    // The unlocked link carries its own token in the path. Sending TorBox's
    // WebDAV Basic auth to an unrelated host would be a credential leak.
    expect(fetched.auth).toBeNull();
    // Range expansion still applies: RD asked for 1KB, the chunk size widens it.
    expect(fetched.range).toBe("bytes=0-4999");

    removeProxySession("job-ad");
  });

  test("uses the AllDebrid chunk size, not the TorBox one", () => {
    registerAdSession("job-ad-chunk");
    const session = getProxySession("job-ad-chunk");
    expect(session).toBeDefined();
    if (session) expect(chunkSizeFor(session)).toBe(config.alldebridChunkSize);
    removeProxySession("job-ad-chunk");
  });

  test("unlocks once per file and reuses the link across ranges", async () => {
    const seen: { url: string; auth: string | null; range: string | null }[] = [];
    mockUnlockThenBytes(seen);
    registerAdSession("job-ad-cache");

    await handleProxyRequest("job-ad-cache", "movie.mkv", "bytes=0-1023");
    await handleProxyRequest("job-ad-cache", "movie.mkv", "bytes=1024-2047");

    // RD issues thousands of ranges per job against a 600/min API budget, so
    // one unlock has to serve the whole file.
    expect(seen.filter((s) => s.url.includes("/link/unlock"))).toHaveLength(1);
    removeProxySession("job-ad-cache");
  });

  test("re-unlocks once when a stale link stops answering 206", async () => {
    let unlocks = 0;
    let served = 0;
    mockFetch(async (url) => {
      if (String(url).includes("/link/unlock")) {
        unlocks++;
        return Response.json({
          status: "success",
          data: { link: `https://z2a3b4.debrid.it/dl/gen${unlocks}/movie.mkv` },
        });
      }
      // The first link has aged out: AllDebrid does not document a lifetime, so
      // the proxy cannot pre-empt this by TTL alone.
      served++;
      if (String(url).includes("gen1")) return new Response("gone", { status: 404 });
      return new Response(Buffer.alloc(1024), {
        status: 206,
        headers: { "content-range": "bytes 0-4999/5000" },
      });
    });
    registerAdSession("job-ad-stale");

    const res = await handleProxyRequest("job-ad-stale", "movie.mkv", "bytes=0-1023");
    expect(res.status).toBe(206);
    expect(unlocks).toBe(2);
    expect(served).toBe(2);
    removeProxySession("job-ad-stale");
  });

  test("502s when even the refreshed link will not serve the range", async () => {
    mockFetch(async (url) => {
      if (String(url).includes("/link/unlock")) {
        return Response.json({ status: "success", data: { link: "https://dl.example/x.mkv" } });
      }
      return new Response("gone", { status: 404 });
    });
    registerAdSession("job-ad-dead");

    const res = await handleProxyRequest("job-ad-dead", "movie.mkv", "bytes=0-1023");
    expect(res.status).toBe(502);
    removeProxySession("job-ad-dead");
  });

  test("502s rather than serving nothing when the unlock fails outright", async () => {
    mockFetch(async () =>
      Response.json({ status: "error", error: { code: "MUST_BE_PREMIUM", message: "no" } }),
    );
    registerAdSession("job-ad-nounlock");

    const res = await handleProxyRequest("job-ad-nounlock", "movie.mkv", "bytes=0-1023");
    // AllDebrid has no second host to fall back to, unlike TorBox's WebDAV.
    expect(res.status).toBe(502);
    removeProxySession("job-ad-nounlock");
  });

  test("502s when the session has no locked link to unlock", async () => {
    registerProxySession(
      "job-ad-nolink",
      0,
      [{ rewrittenPath: "movie.mkv", webdavPath: "Rel/movie.mkv", size: 5000 }],
      { source: "alldebrid", adMagnetId: 1, alldebridApiKey: "AD_KEY" },
    );
    const res = await handleProxyRequest("job-ad-nolink", "movie.mkv", "bytes=0-1023");
    expect(res.status).toBe(502);
    removeProxySession("job-ad-nolink");
  });

  test("serves a whole-file request from the unlocked link", async () => {
    mockFetch(async (url) => {
      if (String(url).includes("/link/unlock")) {
        return Response.json({
          status: "success",
          data: { link: "https://z2a3b4.debrid.it/dl/52aq/movie.mkv" },
        });
      }
      return new Response(Buffer.alloc(5000), { status: 200 });
    });
    registerAdSession("job-ad-full");

    const res = await handleProxyRequest("job-ad-full", "movie.mkv", null);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe("5000");
    removeProxySession("job-ad-full");
  });

  test("unlocks with the job's own key", async () => {
    const seen: { url: string; auth: string | null; range: string | null }[] = [];
    mockUnlockThenBytes(seen);
    registerAdSession("job-ad-key", 5000, "USER_AD_KEY");

    await handleProxyRequest("job-ad-key", "movie.mkv", "bytes=0-1023");
    const unlock = seen.find((s) => s.url.includes("/link/unlock"));
    expect(unlock?.auth).toBe("Bearer USER_AD_KEY");
    removeProxySession("job-ad-key");
  });

  test("a rehydrated session keeps its source, link and key", async () => {
    const jobId = "job-ad-rehydrate";
    createJob(jobId, "magnet:?xt=urn:btih:adrehydrate", "tt1", false, {
      adApiKey: "USER_AD_KEY",
    });
    // Written straight to the DB, never through `registerProxySession`, so the
    // only way to answer a range is to reload all of it from `proxy_sessions`.
    insertProxyMappings(
      jobId,
      0,
      [
        {
          rewrittenPath: "movie.mkv",
          webdavPath: "Rel/movie.mkv",
          size: 5000,
          adLink: "https://alldebrid.com/f/tok",
        },
      ],
      { source: "alldebrid", adMagnetId: 667750156 },
    );

    const session = getProxySession(jobId);
    expect(session?.source).toBe("alldebrid");
    expect(session?.alldebridApiKey).toBe("USER_AD_KEY");
    expect(session?.files.get("movie.mkv")?.adLink).toBe("https://alldebrid.com/f/tok");
    removeProxySession(jobId);
  });
});

describe("a delivery host that can never answer", () => {
  /**
   * AllDebrid mints a delivery hostname per `/link/unlock`, and a slice of those
   * hostnames DNS-resolve to `0.0.0.0` and `::` globally. They are null-routed:
   * the connect never completes, so `fetch` throws instead of answering, and
   * nothing before the byte read can tell — the unlock succeeds and the URL
   * looks entirely ordinary. Measured 2026-08-23, three hosts
   * (`l4m5n6.debrid.it`, `o7p8q9.debrid.it`, `c1uw74.debrid.it`) carried 15.6%
   * of resolved links, across unrelated files.
   *
   * Only the response was ever inspected, so the throw escaped `fetchUpstream`
   * and with it the re-unlock that would have fixed it — the exact mirror of the
   * TorBox bug two describes up, where a refusal that was not a throw went
   * uncaught.
   */
  const DEAD = "https://l4m5n6.debrid.it/dl/dead/movie.mkv";
  const LIVE = "https://z2a3b4.debrid.it/dl/52aq/movie.mkv";

  /** What a connect to the unspecified address surfaces as. */
  function nullRouted(): never {
    throw new Error("Unable to connect. connect ECONNREFUSED 0.0.0.0:443");
  }

  function registerAdSession(jobId: string) {
    registerProxySession(
      jobId,
      0,
      [
        {
          rewrittenPath: "movie.mkv",
          webdavPath: "Rel/Original.Release.mkv",
          size: 5000,
          adLink: "https://alldebrid.com/f/tok",
        },
      ],
      { source: "alldebrid", adMagnetId: 667750156, alldebridApiKey: "AD_KEY" },
    );
  }

  afterEach(() => {
    _clearAdLinks();
  });

  test("re-unlocks a range when the delivery host cannot be dialled at all", async () => {
    let unlocks = 0;
    const dialled: string[] = [];
    mockFetch(async (url) => {
      const u = String(url);
      if (u.includes("/link/unlock")) {
        unlocks++;
        return Response.json({
          status: "success",
          data: { link: unlocks === 1 ? DEAD : LIVE },
        });
      }
      dialled.push(u);
      if (u === DEAD) nullRouted();
      return new Response(Buffer.alloc(1024), {
        status: 206,
        headers: { "content-range": "bytes 0-4999/5000" },
      });
    });
    registerAdSession("job-ad-nullroute");
    const dials = counters.get("proxy.ad_link_dial_failures");
    const refreshes = counters.get("proxy.ad_link_refreshes");

    const res = await handleProxyRequest("job-ad-nullroute", "movie.mkv", "bytes=0-1023");

    // A fresh unlock usually draws a different, live host, so this is a fact
    // about the node rather than the file — and it 502'd before, because the
    // throw never reached the re-unlock that a non-206 answer already triggered.
    expect(res.status).toBe(206);
    expect(unlocks).toBe(2);
    expect(dialled).toEqual([DEAD, LIVE]);
    expect(counters.get("proxy.ad_link_dial_failures") - dials).toBe(1);
    expect(counters.get("proxy.ad_link_refreshes") - refreshes).toBe(1);
    removeProxySession("job-ad-nullroute");
  });

  test("502s a range when the fresh unlock draws another dead host", async () => {
    let unlocks = 0;
    mockFetch(async (url) => {
      if (String(url).includes("/link/unlock")) {
        unlocks++;
        return Response.json({ status: "success", data: { link: DEAD } });
      }
      return nullRouted();
    });
    registerAdSession("job-ad-nullroute-twice");
    const unreachable = counters.get("proxy.upstream_unreachable");
    const statuses = counters.get("proxy.upstream_status_502");

    const res = await handleProxyRequest("job-ad-nullroute-twice", "movie.mkv", "bytes=0-1023");

    // One retry, never a loop: a file whose every host is null-routed has to
    // fail, and it fails after exactly two unlocks.
    expect(res.status).toBe(502);
    expect(unlocks).toBe(2);
    expect(counters.get("proxy.upstream_unreachable") - unreachable).toBe(1);
    // `proxy.upstream_status_<n>` means a status the upstream actually sent.
    // Nothing was sent here, so synthesising a 502 into it would corrupt the one
    // number every diagnosis of this path starts from.
    expect(counters.get("proxy.upstream_status_502") - statuses).toBe(0);
    removeProxySession("job-ad-nullroute-twice");
  });

  test("re-unlocks a whole-file read too, where the throw escaped the handler", async () => {
    let unlocks = 0;
    mockFetch(async (url) => {
      const u = String(url);
      if (u.includes("/link/unlock")) {
        unlocks++;
        return Response.json({
          status: "success",
          data: { link: unlocks === 1 ? DEAD : LIVE },
        });
      }
      if (u === DEAD) nullRouted();
      return new Response(Buffer.alloc(5000), { status: 200 });
    });
    registerAdSession("job-ad-nullroute-full");

    const res = await handleProxyRequest("job-ad-nullroute-full", "movie.mkv", null);

    // This path had no retry at all, so the throw did not merely skip one — it
    // left `handleProxyRequest` and reached the client as a bare 500 from Hono.
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe("5000");
    expect(unlocks).toBe(2);
    removeProxySession("job-ad-nullroute-full");
  });

  test("502s a whole-file read when no host answers", async () => {
    mockFetch(async (url) => {
      if (String(url).includes("/link/unlock")) {
        return Response.json({ status: "success", data: { link: DEAD } });
      }
      return nullRouted();
    });
    registerAdSession("job-ad-nullroute-full-dead");
    const before = counters.get("proxy.upstream_unreachable");

    const res = await handleProxyRequest("job-ad-nullroute-full-dead", "movie.mkv", null);

    expect(res.status).toBe(502);
    expect(counters.get("proxy.upstream_unreachable") - before).toBe(1);
    removeProxySession("job-ad-nullroute-full-dead");
  });

  test("Real-Debrid recovers the same way, since both share LINK_SOURCES", async () => {
    // RD has not been measured doing this, but its direct links are minted per
    // unrestrict against a pool of download servers exactly as AllDebrid's are,
    // and the recovery costs one API call. Sharing it keeps the property true
    // for both by construction rather than by remembering to copy it.
    let unrestricts = 0;
    const live = "https://23-4.download.real-debrid.com/d/XYZ/movie.mkv";
    mockFetch(async (url) => {
      const u = String(url);
      if (u.includes("/unrestrict/link")) {
        unrestricts++;
        return Response.json({ download: unrestricts === 1 ? DEAD : live });
      }
      if (u === DEAD) nullRouted();
      return new Response(Buffer.alloc(1024), {
        status: 206,
        headers: { "content-range": "bytes 0-4999/5000" },
      });
    });
    registerProxySession(
      "job-rd-nullroute",
      0,
      [
        {
          rewrittenPath: "movie.mkv",
          webdavPath: "Rel/Original.Release.mkv",
          size: 5000,
          rdLink: "https://real-debrid.com/d/LOCKED",
        },
      ],
      { source: "realdebrid", realdebridApiKey: "RD_KEY", rdSourceTorrentId: "RDT" },
    );

    const res = await handleProxyRequest("job-rd-nullroute", "movie.mkv", "bytes=0-1023");
    expect(res.status).toBe(206);
    expect(unrestricts).toBe(2);
    removeProxySession("job-rd-nullroute");
  });

  test("leaves TorBox alone: a WebDAV throw still propagates", async () => {
    // Deliberately unchanged. WebDAV sits behind Cloudflare and is not minted
    // per read, so a throw there is real infrastructure failing and there is no
    // second link to draw — swallowing it into a 502 would hide that.
    mockFetch(async () => {
      throw new Error("ECONNRESET");
    });
    registerSingleFile("job-tb-throw", 5000);

    await expect(handleProxyRequest("job-tb-throw", "movie.mkv", "bytes=0-1023")).rejects.toThrow(
      "ECONNRESET",
    );
    removeProxySession("job-tb-throw");
  });
});

describe("upstream refusals are named, not just counted", () => {
  // The count of non-206 answers was always recorded but never the status behind
  // it, so diagnosing the dominant failure mode meant probing WebDAV by hand. On
  // 2026-08-08 a job served 4.0GB and then died with 2 of 2 reads refused, and
  // the logs could not say whether TorBox answered 429, 404 or 503.
  test("records the upstream status for a refused range", async () => {
    registerSingleFile("job-status-429", 5000);
    mockFetch(async () => new Response("slow down", { status: 429 }));
    const before = counters.get("proxy.upstream_status_429");

    const res = await handleProxyRequest("job-status-429", "movie.mkv", "bytes=0-99");

    expect(res.status).toBe(502);
    expect(counters.get("proxy.upstream_status_429") - before).toBe(1);
    removeProxySession("job-status-429");
  });

  test("records it for a whole-file read too", async () => {
    // This branch returned a bare 502 with no counter and no log at all.
    registerSingleFile("job-status-whole", 5000);
    mockFetch(async () => new Response("gone", { status: 404 }));
    const before = counters.get("proxy.upstream_whole_file_failed");

    const res = await handleProxyRequest("job-status-whole", "movie.mkv", null);

    expect(res.status).toBe(502);
    expect(counters.get("proxy.upstream_whole_file_failed") - before).toBe(1);
    expect(counters.get("proxy.upstream_status_404")).toBeGreaterThan(0);
    removeProxySession("job-status-whole");
  });

  test("does not drain a refused body that is actually the whole file", async () => {
    // A refused range can come back 200 carrying the entire release; reading it
    // to print 160 characters would pull the lot into memory.
    registerSingleFile("job-status-200", 5000);
    let cancelled = false;
    mockFetch(
      async () =>
        new Response(
          new ReadableStream({
            pull(c) {
              c.enqueue(new Uint8Array(64 * 1024));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { status: 200 },
        ),
    );

    const res = await handleProxyRequest("job-status-200", "movie.mkv", "bytes=0-99");

    expect(res.status).toBe(502);
    expect(cancelled).toBe(true);
    removeProxySession("job-status-200");
  });

  test("still answers 502 when the error body itself fails to read", async () => {
    registerSingleFile("job-status-broken", 5000);
    mockFetch(
      async () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.error(new Error("stream died"));
            },
          }),
          { status: 503 },
        ),
    );

    const res = await handleProxyRequest("job-status-broken", "movie.mkv", "bytes=0-99");

    expect(res.status).toBe(502);
    expect(counters.get("proxy.upstream_status_503")).toBeGreaterThan(0);
    removeProxySession("job-status-broken");
  });
});

describe("assertTorboxServable", () => {
  const mappings = [
    { rewrittenPath: "a.nfo", webdavPath: "Release/a.nfo", size: 1326 },
    { rewrittenPath: "movie.mkv", webdavPath: "Release/movie.mkv", size: 8833194294 },
    { rewrittenPath: "b.txt", webdavPath: "Release/b.txt", size: 127 },
  ];

  test("passes when WebDAV serves the range", async () => {
    mockFetch(async () => new Response("x", { status: 206 }));
    await assertTorboxServable("job-s1", mappings, TB_KEY);
  });

  test("passes on a plain 200 as well", async () => {
    // A ranged request answered 200 is legal, and this probe only asks whether
    // the path resolves.
    mockFetch(async () => new Response("x", { status: 200 }));
    await assertTorboxServable("job-s2", mappings, TB_KEY);
  });

  test("rejects when TorBox 404s the path it said it had", async () => {
    // The live case: `checkcached` yes, `download_present: true`, and the item
    // absent from WebDAV entirely — every RD range 404s and the job used to die
    // five minutes later as a stall, naming the wrong cause.
    mockFetch(async () => new Response("There was no item found at this path.", { status: 404 }));

    await expect(assertTorboxServable("job-s3", mappings, TB_KEY, { graceMs: 0 })).rejects.toThrow(
      /cached but serves 404/,
    );
  });

  // Regression. `createtorrent` answers `Found Cached Torrent` and returns an id
  // straight away, but the item takes seconds to appear under WebDAV — measured
  // absent at 3s and present at 6s. Probing once, ~2s after the add, killed
  // three healthy releases in six minutes on 2026-08-16, and every stage retry
  // re-added and lost the identical race.
  test("waits out a 404 while a fresh add materialises", async () => {
    let call = 0;
    mockFetch(async () => {
      call++;
      return call < 3
        ? new Response("no item at this path", { status: 404 })
        : new Response("x", { status: 206 });
    });
    await assertTorboxServable("job-s-race", mappings, TB_KEY, {
      sleepFor: async () => {},
      graceMs: 60_000,
    });
    expect(call).toBe(3);
  });

  test("still gives up on a 404 that never clears", async () => {
    let call = 0;
    mockFetch(async () => {
      call++;
      return new Response("no item at this path", { status: 404 });
    });
    // The deadline is real wall clock (`Date.now() + graceMs`), so the retry
    // budget has to be spent by something that really takes time. A no-op
    // `sleepFor` with a 1ms grace used to stand in for that, and the probe count
    // it produced depended on whether the first mocked fetch resolved inside that
    // millisecond: 2 on a warm laptop, 1 on the CI runner, where it failed. Let
    // the backoff burn past a grace it cannot beat instead, which pins the count.
    await expect(
      assertTorboxServable("job-s-forever", mappings, TB_KEY, {
        sleepFor: async () => {
          await new Promise((resolve) => setTimeout(resolve, 250));
        },
        graceMs: 100,
      }),
    ).rejects.toThrow(/cached but serves 404/);
    // Probe, 404, grace still open, sleep past it, probe again, give up.
    expect(call).toBe(2);
  });

  // A bad key reads the same in twenty seconds, so waiting only holds a slot.
  test("does not wait on a 401", async () => {
    let call = 0;
    mockFetch(async () => {
      call++;
      return new Response("unauthorized", { status: 401 });
    });
    await expect(
      assertTorboxServable("job-s-401", mappings, TB_KEY, {
        sleepFor: async () => {},
        graceMs: 60_000,
      }),
    ).rejects.toThrow(/TorBox/);
    expect(call).toBe(1);
  });

  test("names the failing path in the error", async () => {
    mockFetch(async () => new Response("nope", { status: 404 }));
    await expect(assertTorboxServable("job-s4", mappings, TB_KEY, { graceMs: 0 })).rejects.toThrow(
      /Release\/movie\.mkv/,
    );
  });

  // Job 470954d9 on debrid02, 2026-10-13: the original torrent's three files,
  // of which TorBox's listing (checkcached list_files) held only the mkv. RD
  // pulled the mkv and then asked for the 71-byte ad file for half an hour,
  // 404 every time, until the job died as `uploading stalled`.
  test("rejects a release whose small files TorBox does not keep", async () => {
    const release = "Fast.Charlie.2023.2160p.WEB-DL.DDP5.1.H.265-FLUX[TGx]";
    const fastCharlie = [
      {
        webdavPath: `${release}/Fast.Charlie.2023.2160p.WEB-DL.DDP5.1.H.265-FLUX.mkv`,
        size: 8392571172,
        torboxFileId: 0,
      },
      {
        webdavPath: `${release}/NEW upcoming releases by Xclusive.txt`,
        size: 71,
        torboxFileId: undefined,
      },
      {
        webdavPath: `${release}/[TGx]Downloaded from torrentgalaxy.to .txt`,
        size: 718,
        torboxFileId: undefined,
      },
    ];
    mockFetch(async (url: unknown) =>
      decodeURIComponent(String(url)).endsWith(".mkv")
        ? new Response("x", { status: 206 })
        : new Response(
            "There was no item found at this path. Please check the path and try again.",
            {
              status: 404,
            },
          ),
    );

    await expect(
      assertTorboxServable("job-470954d9", fastCharlie, TB_KEY, { graceMs: 0 }),
    ).rejects.toThrow(/serves 404 for .*Xclusive\.txt/);
  });

  test("does not probe the files TorBox listed", async () => {
    const asked: string[] = [];
    mockFetch(async (url: unknown) => {
      asked.push(String(url));
      return new Response("x", { status: 206 });
    });
    await assertTorboxServable(
      "job-s5-listed",
      mappings.map((m, i) => ({ ...m, torboxFileId: i })),
      TB_KEY,
    );
    expect(asked).toHaveLength(1);
  });

  test("probes the largest file, the one RD actually pulls", async () => {
    const asked: string[] = [];
    mockFetch(async (url: unknown) => {
      asked.push(String(url));
      return new Response("x", { status: 206 });
    });

    await assertTorboxServable("job-s5", mappings, TB_KEY);

    expect(asked).toHaveLength(1);
    expect(decodeURIComponent(asked[0])).toContain("Release/movie.mkv");
  });

  test("asks for a single byte, not the file", async () => {
    // `torboxInit` normalises headers into a `Headers`, and it must be used at
    // all: a bare fetch to TorBox leaves the shared egress and User-Agent off,
    // which is the one thing the WARP seam exists to prevent.
    let range: string | undefined;
    let userAgent: string | undefined;
    mockFetch(async (_url: unknown, init: unknown) => {
      const headers = (init as { headers?: Headers })?.headers;
      range = headers?.get("Range") ?? undefined;
      userAgent = headers?.get("User-Agent") ?? undefined;
      return new Response("x", { status: 206 });
    });

    await assertTorboxServable("job-s6", mappings, TB_KEY);

    expect(range).toBe("bytes=0-0");
    expect(userAgent).toBeTruthy();
  });

  test("fails open when the probe itself cannot run", async () => {
    // A network blip says nothing about whether the item exists, and taking
    // TorBox out of rotation over one would cost far more than it saves.
    mockFetch(async () => {
      throw new Error("ECONNRESET");
    });
    await assertTorboxServable("job-s7", mappings, TB_KEY);
  });

  test("does nothing when there are no files to check", async () => {
    let called = false;
    mockFetch(async () => {
      called = true;
      return new Response("x", { status: 206 });
    });

    await assertTorboxServable("job-s8", [], TB_KEY);

    expect(called).toBe(false);
  });

  test("refuses to probe without a key rather than using someone else's", async () => {
    mockFetch(async () => new Response("x", { status: 206 }));
    await expect(assertTorboxServable("job-s9", mappings, undefined)).rejects.toBeInstanceOf(
      MissingCredentialError,
    );
  });

  test("counts the refusal by status, so the cause is visible in the stage report", async () => {
    const before = counters.snapshot()["proxy.unservable_404"] ?? 0;
    mockFetch(async () => new Response("nope", { status: 404 }));

    await expect(
      assertTorboxServable("job-s10", mappings, TB_KEY, { graceMs: 0 }),
    ).rejects.toThrow();

    expect((counters.snapshot()["proxy.unservable_404"] ?? 0) - before).toBe(1);
  });
});

/**
 * Regression, from the recorded fixture. "Alpha (2026) Hindi" sat on DMM's
 * request board for 65 days as "TorBox reports the release cached but serves
 * 404" after 94 fulfil attempts by 59 TorBox users. On 2026-11-04 the same
 * release served byte 0 through a `requestdl` CDN link at once, while WebDAV
 * 404'd it for 31.6 s — past the 25 s grace. The proxy streams through the CDN
 * link, so WebDAV was the wrong path to judge the release on.
 */
describe("assertTorboxServable reads the CDN link first (TORBOX_UPSTREAM=cdn)", () => {
  const originalMode = config.torboxUpstream;
  const originalEdge = config.torboxCdnEdge;
  beforeEach(() => {
    (config as { torboxUpstream: string }).torboxUpstream = "cdn";
    // Pin the edge rewrite off so the probe hits the host `requestdl` returned.
    (config as { torboxCdnEdge: string }).torboxCdnEdge = "";
    _clearCdnLinks();
  });
  afterEach(() => {
    (config as { torboxUpstream: string }).torboxUpstream = originalMode;
    (config as { torboxCdnEdge: string }).torboxCdnEdge = originalEdge;
    _clearCdnLinks();
  });

  const torrent = alpha.mylist.body.data;
  const link = alpha.requestdl.body.data;
  const mappings = torrent.files.map((f) => ({
    rewrittenPath: "Alpha.2026.mkv",
    webdavPath: f.name,
    size: f.size,
    torboxFileId: f.id,
  }));
  const probe = { graceMs: 0, torboxTorrentId: torrent.id };

  /** TorBox as recorded, with each answer replaceable. Returns the URLs asked. */
  function torboxAsRecorded(
    answer: { mint?: () => Response; cdn?: () => Response; webdav?: () => Response } = {},
  ) {
    const asked: { url: string; init: RequestInit | undefined }[] = [];
    mockFetch(async (url, init) => {
      const u = String(url);
      asked.push({ url: u, init: init as RequestInit | undefined });
      if (u.includes("/torrents/requestdl")) {
        return answer.mint?.() ?? Response.json(alpha.requestdl.body);
      }
      if (u.startsWith(link)) {
        return (
          answer.cdn?.() ??
          new Response("x", { status: alpha.cdn_probe.status, headers: alpha.cdn_probe.headers })
        );
      }
      return (
        answer.webdav?.() ??
        new Response(alpha.webdav_probe.body, { status: alpha.webdav_probe.status })
      );
    });
    return asked;
  }
  const webdavOk = () => new Response("x", { status: 206 });

  test("passes the release when the CDN link serves and WebDAV still 404s", async () => {
    const asked = torboxAsRecorded();
    const before = counters.snapshot()["proxy.servable_via_cdn"] ?? 0;

    await assertTorboxServable("job-alpha", mappings, TB_KEY, probe);

    expect(asked.map((a) => a.url)).toEqual([expect.stringContaining("/torrents/requestdl"), link]);
    expect((counters.snapshot()["proxy.servable_via_cdn"] ?? 0) - before).toBe(1);
  });

  test("asks the link for one byte through torboxInit, without WebDAV's Basic auth", async () => {
    const asked = torboxAsRecorded();

    await assertTorboxServable("job-alpha-headers", mappings, TB_KEY, probe);

    const headers = new Headers(asked[1].init?.headers);
    expect(headers.get("Range")).toBe("bytes=0-0");
    expect(headers.get("User-Agent")).toBeTruthy();
    expect(headers.get("Authorization")).toBeNull();
  });

  test("still rejects when the CDN refuses and WebDAV 404s", async () => {
    torboxAsRecorded({ cdn: () => new Response("<html>bad request</html>", { status: 400 }) });

    await expect(assertTorboxServable("job-alpha-400", mappings, TB_KEY, probe)).rejects.toThrow(
      /cached but serves 404/,
    );
  });

  test("falls back to the WebDAV probe when no link can be minted", async () => {
    const asked = torboxAsRecorded({
      mint: () => new Response("DATABASE_ERROR", { status: 500 }),
      webdav: webdavOk,
    });

    await assertTorboxServable("job-alpha-nomint", mappings, TB_KEY, probe);

    expect(asked.map((a) => a.url)).toEqual([
      expect.stringContaining("/torrents/requestdl"),
      expect.stringContaining("webdav.torbox.app"),
    ]);
  });

  test("treats an unreachable CDN node as a refusal and goes on to WebDAV", async () => {
    const asked = torboxAsRecorded({
      cdn: () => {
        throw new Error("ECONNREFUSED");
      },
      webdav: webdavOk,
    });

    await assertTorboxServable("job-alpha-cdn-down", mappings, TB_KEY, probe);

    expect(asked.at(-1)?.url).toContain("webdav.torbox.app");
  });

  test("retries the link while a fresh add materialises, the same as WebDAV", async () => {
    let cdnCalls = 0;
    torboxAsRecorded({
      cdn: () => {
        cdnCalls++;
        return cdnCalls < 2 ? new Response("not yet", { status: 404 }) : webdavOk();
      },
    });

    await assertTorboxServable("job-alpha-race", mappings, TB_KEY, {
      ...probe,
      graceMs: 60_000,
      sleepFor: async () => {},
    });

    expect(cdnCalls).toBe(2);
  });

  test("leaves the probe on WebDAV when the upstream is WebDAV", async () => {
    (config as { torboxUpstream: string }).torboxUpstream = "webdav";
    const asked = torboxAsRecorded({ webdav: webdavOk });

    await assertTorboxServable("job-alpha-webdav-mode", mappings, TB_KEY, probe);

    expect(asked.map((a) => a.url)).toEqual([expect.stringContaining("webdav.torbox.app")]);
  });

  test("cannot mint without the torrent id or TorBox's file id", async () => {
    const asked = torboxAsRecorded({ webdav: webdavOk });

    await assertTorboxServable("job-alpha-no-tid", mappings, TB_KEY, { graceMs: 0 });
    await assertTorboxServable(
      "job-alpha-no-fid",
      mappings.map((m) => ({ ...m, torboxFileId: undefined })),
      TB_KEY,
      probe,
    );

    expect(asked.some((a) => a.url.includes("/torrents/requestdl"))).toBe(false);
  });
});

describe("Real-Debrid upstream", () => {
  /**
   * An RD-sourced session: no WebDAV path and no TorBox file id, just a
   * restricted `real-debrid.com/d/…` link per file. Structurally identical to
   * the AllDebrid one, which is why both share `LINK_SOURCES`.
   */
  function registerRdSession(jobId: string, size = 5000, apiKey = "RD_KEY") {
    registerProxySession(
      jobId,
      0,
      [
        {
          rewrittenPath: "movie.mkv",
          webdavPath: "Rel/Original.Release.mkv",
          size,
          rdLink: "https://real-debrid.com/d/LOCKED",
        },
      ],
      { source: "realdebrid", realdebridApiKey: apiKey, rdSourceTorrentId: "RDT" },
    );
  }

  /** Answer an unrestrict with a direct link, and any other fetch with a 206. */
  function mockUnrestrictThenBytes(
    seen: { url: string; auth: string | null; range: string | null }[],
    direct = "https://23-4.download.real-debrid.com/d/XYZ/movie.mkv",
  ) {
    mockFetch(async (url, init) => {
      const h = new Headers((init as RequestInit | undefined)?.headers);
      seen.push({ url: String(url), auth: h.get("authorization"), range: h.get("range") });
      if (String(url).includes("/unrestrict/link")) {
        return Response.json({ download: direct });
      }
      return new Response(Buffer.alloc(1024), {
        status: 206,
        headers: { "content-range": "bytes 0-4999/5000" },
      });
    });
  }

  afterEach(() => {
    _clearAdLinks();
  });

  test("unrestricts a link and serves the expanded range from it", async () => {
    const seen: { url: string; auth: string | null; range: string | null }[] = [];
    mockUnrestrictThenBytes(seen);
    registerRdSession("job-rd");

    const res = await handleProxyRequest("job-rd", "movie.mkv", "bytes=0-1023");
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 0-4999/5000");

    const fetched = seen[seen.length - 1];
    expect(fetched.url).toBe("https://23-4.download.real-debrid.com/d/XYZ/movie.mkv");
    // RD's direct link authenticates itself through the path; sending TorBox's
    // WebDAV Basic auth to an unrelated host would leak a credential.
    expect(fetched.auth).toBeNull();
    expect(fetched.range).toBe("bytes=0-4999");

    removeProxySession("job-rd");
  });

  test("unrestricts once per file and reuses the direct link", async () => {
    // TorBox's client asks in 16 MiB ranges but still issues many per file, and
    // `/unrestrict/link` is an API call — one per range would be hopeless.
    const seen: { url: string; auth: string | null; range: string | null }[] = [];
    mockUnrestrictThenBytes(seen);
    registerRdSession("job-rd-cache");

    await handleProxyRequest("job-rd-cache", "movie.mkv", "bytes=0-1023");
    await handleProxyRequest("job-rd-cache", "movie.mkv", "bytes=1024-2047");

    expect(seen.filter((s) => s.url.includes("/unrestrict/link")).length).toBe(1);
    removeProxySession("job-rd-cache");
  });

  test("re-unrestricts once when a link has aged out mid-job", async () => {
    // RD documents no lifetime for a direct link, so a long transfer would
    // otherwise start 502ing partway through with a healthy torrent behind it.
    let unrestricts = 0;
    let served = 0;
    mockFetch(async (url) => {
      if (String(url).includes("/unrestrict/link")) {
        unrestricts++;
        return Response.json({ download: `https://dl.example/${unrestricts}/movie.mkv` });
      }
      served++;
      // The first byte fetch fails as an expired link would; the retry succeeds.
      if (served === 1) return new Response("gone", { status: 404 });
      return new Response(Buffer.alloc(16), {
        status: 206,
        headers: { "content-range": "bytes 0-4999/5000" },
      });
    });
    registerRdSession("job-rd-expired");

    const res = await handleProxyRequest("job-rd-expired", "movie.mkv", "bytes=0-1023");
    expect(res.status).toBe(206);
    expect(unrestricts).toBe(2);
    removeProxySession("job-rd-expired");
  });

  test("502s rather than serving nothing when the link cannot be resolved", async () => {
    mockFetch(async () => new Response("bad token", { status: 401 }));
    registerRdSession("job-rd-dead");

    const res = await handleProxyRequest("job-rd-dead", "movie.mkv", "bytes=0-1023");
    expect(res.status).toBe(502);
    removeProxySession("job-rd-dead");
  });

  test("uses the Real-Debrid chunk size for its range expansion", () => {
    registerRdSession("job-rd-chunk");
    const session = sessionsForTest().get("job-rd-chunk");
    expect(session).toBeDefined();
    if (session) expect(chunkSizeFor(session)).toBe(config.realdebridChunkSize);
    removeProxySession("job-rd-chunk");
  });

  test("a rehydrated session recovers both the link and the submitter's key", async () => {
    // After a restart nothing is in memory: the locked link comes back from
    // `proxy_sessions` and the key from the job row. Reading the operator's key
    // here would unrestrict against the wrong account and 401 every byte.
    const jobId = `job-rd-rehydrate-${Date.now()}`;
    createJob(jobId, "magnet:?xt=urn:btih:rd", undefined, undefined, { rdApiKey: "OWNER_RD_KEY" });
    insertProxyMappings(
      jobId,
      0,
      [
        {
          rewrittenPath: "movie.mkv",
          webdavPath: "Rel/Original.mkv",
          size: 5000,
          rdLink: "https://real-debrid.com/d/LOCKED",
        },
      ],
      { source: "realdebrid", rdSourceTorrentId: "RDT" },
    );
    sessionsForTest().delete(jobId);

    const seenAuth: string[] = [];
    mockFetch(async (url, init) => {
      if (String(url).includes("/unrestrict/link")) {
        const h = new Headers((init as RequestInit | undefined)?.headers);
        seenAuth.push(h.get("authorization") ?? "");
        return Response.json({ download: "https://dl.example/movie.mkv" });
      }
      return new Response(Buffer.alloc(16), {
        status: 206,
        headers: { "content-range": "bytes 0-4999/5000" },
      });
    });

    const res = await handleProxyRequest(jobId, "movie.mkv", "bytes=0-1023");
    expect(res.status).toBe(206);
    expect(seenAuth[0]).toBe("Bearer OWNER_RD_KEY");
    removeProxySession(jobId);
  });
});

describe("range expansion never truncates a larger request", () => {
  /**
   * The chunk size is a floor for widening a small request, not a ceiling.
   *
   * Applying it as a ceiling broke the TorBox destination outright: its client
   * (`qBittorrent/5.1.4`) asks in 16 MiB ranges, our 8 MiB chunk answered half of
   * each, and after a few short 206s it stopped using the webseed and sat at
   * `stalled (no seeds)` with `total_downloaded: 0`. Nothing looked wrong here —
   * a short 206 is legal, and the bytes served were hash-verified against the
   * torrent's own pieces.
   */
  function registerBigFile(jobId: string, size: number) {
    registerProxySession(
      jobId,
      0,
      [
        {
          rewrittenPath: "movie.mkv",
          webdavPath: "orig.mkv",
          size,
          adLink: "https://alldebrid.com/f/t",
        },
      ],
      { source: "alldebrid", alldebridApiKey: "AD_KEY" },
    );
  }

  function mockRangedUpstream(seen: string[], size: number) {
    mockFetch(async (url, init) => {
      if (String(url).includes("/link/unlock")) {
        return Response.json({ status: "success", data: { link: "https://dl.example/movie.mkv" } });
      }
      const asked = new Headers((init as RequestInit | undefined)?.headers).get("range") ?? "";
      seen.push(asked);
      const m = /bytes=(\d+)-(\d+)/.exec(asked);
      const start = Number(m?.[1] ?? 0);
      const end = Number(m?.[2] ?? size - 1);
      return new Response(Buffer.alloc(8), {
        status: 206,
        headers: { "content-range": `bytes ${start}-${end}/${size}` },
      });
    });
  }

  const SIZE = 100 * 1024 * 1024;

  test("serves the whole range when the client asks for more than the chunk", async () => {
    const seen: string[] = [];
    mockRangedUpstream(seen, SIZE);
    registerBigFile("job-big-ask", SIZE);

    // 16 MiB asked, against an 8 MiB chunk.
    const res = await handleProxyRequest("job-big-ask", "movie.mkv", "bytes=67108864-83886079");
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe(`bytes 67108864-83886079/${SIZE}`);
    expect(seen[seen.length - 1]).toBe("bytes=67108864-83886079");

    removeProxySession("job-big-ask");
  });

  test("still widens a request smaller than the chunk", async () => {
    // The behaviour the chunk size exists for: RD's Transmission asks ~426 KB
    // and would otherwise cost one upstream round trip per ask.
    const seen: string[] = [];
    mockRangedUpstream(seen, SIZE);
    registerBigFile("job-small-ask", SIZE);

    const res = await handleProxyRequest("job-small-ask", "movie.mkv", "bytes=0-425983");
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe(`bytes 0-8388607/${SIZE}`);

    removeProxySession("job-small-ask");
  });

  test("widens an open-ended request to the chunk rather than the whole file", async () => {
    const seen: string[] = [];
    mockRangedUpstream(seen, SIZE);
    registerBigFile("job-open-ask", SIZE);

    const res = await handleProxyRequest("job-open-ask", "movie.mkv", "bytes=0-");
    expect(res.headers.get("content-range")).toBe(`bytes 0-8388607/${SIZE}`);

    removeProxySession("job-open-ask");
  });

  test("clamps a request that runs past the end of the file", async () => {
    const small = 1000;
    const seen: string[] = [];
    mockRangedUpstream(seen, small);
    registerBigFile("job-past-end", small);

    const res = await handleProxyRequest("job-past-end", "movie.mkv", "bytes=0-99999");
    expect(res.headers.get("content-range")).toBe(`bytes 0-999/${small}`);

    removeProxySession("job-past-end");
  });
});

describe("over-serving is destination-aware", () => {
  function register(jobId: string, destination: "rd" | "torbox", size = 100 * 1024 * 1024) {
    registerProxySession(
      jobId,
      0,
      [
        {
          rewrittenPath: "movie.mkv",
          webdavPath: "orig.mkv",
          size,
          adLink: "https://alldebrid.com/f/t",
        },
      ],
      { source: "alldebrid", alldebridApiKey: "AD_KEY", destination },
    );
  }

  function mockUpstream(seen: string[]) {
    mockFetch(async (url, init) => {
      if (String(url).includes("/link/unlock")) {
        return Response.json({ status: "success", data: { link: "https://dl.example/m.mkv" } });
      }
      const asked = new Headers((init as RequestInit | undefined)?.headers).get("range") ?? "";
      seen.push(asked);
      const m = /bytes=(\d+)-(\d+)/.exec(asked);
      return new Response(Buffer.alloc(8), {
        status: 206,
        headers: { "content-range": `bytes ${m?.[1]}-${m?.[2]}/${100 * 1024 * 1024}` },
      });
    });
  }

  test("answers a TorBox destination exactly what it asked for", async () => {
    // qBittorrent re-requests an identical range when the 206 is wider than the
    // request, then gives up on the webseed and reports `stalled (no seeds)` —
    // observed ~11 MB into a live transfer.
    const seen: string[] = [];
    mockUpstream(seen);
    register("job-tb-exact", "torbox");

    const res = await handleProxyRequest("job-tb-exact", "movie.mkv", "bytes=1000-2000");
    expect(res.headers.get("content-range")).toBe(`bytes 1000-2000/${100 * 1024 * 1024}`);
    expect(seen[seen.length - 1]).toBe("bytes=1000-2000");

    removeProxySession("job-tb-exact");
  });

  test("still widens for an RD destination, which is what the chunk is for", async () => {
    // Transmission tolerates the wider 206, and the expansion is why the proxy
    // beats a direct CDN webseed (133s against 234s on the same file).
    const seen: string[] = [];
    mockUpstream(seen);
    register("job-rd-wide", "rd");

    const res = await handleProxyRequest("job-rd-wide", "movie.mkv", "bytes=1000-2000");
    expect(res.headers.get("content-range")).toBe(`bytes 1000-8389607/${100 * 1024 * 1024}`);

    removeProxySession("job-rd-wide");
  });

  test("a TorBox destination still gets a full large range, not a truncated one", async () => {
    const seen: string[] = [];
    mockUpstream(seen);
    register("job-tb-large", "torbox");

    const res = await handleProxyRequest("job-tb-large", "movie.mkv", "bytes=67108864-83886079");
    expect(res.headers.get("content-range")).toBe(`bytes 67108864-83886079/${100 * 1024 * 1024}`);

    removeProxySession("job-tb-large");
  });

  test("defaults to the RD behaviour when no destination was recorded", () => {
    register("job-default-dest", "rd");
    const session = sessionsForTest().get("job-default-dest");
    expect(session?.destination).toBe("rd");
    removeProxySession("job-default-dest");
  });
});

describe("response framing is destination-aware", () => {
  function register(jobId: string, destination: "rd" | "torbox") {
    registerProxySession(
      jobId,
      0,
      [
        {
          rewrittenPath: "movie.mkv",
          webdavPath: "orig.mkv",
          size: 100 * 1024 * 1024,
          adLink: "https://alldebrid.com/f/t",
        },
      ],
      { source: "alldebrid", alldebridApiKey: "AD_KEY", destination },
    );
  }

  function mockUpstream() {
    mockFetch(async (url, init) => {
      if (String(url).includes("/link/unlock")) {
        return Response.json({ status: "success", data: { link: "https://dl.example/m.mkv" } });
      }
      const asked = new Headers((init as RequestInit | undefined)?.headers).get("range") ?? "";
      const m = /bytes=(\d+)-(\d+)/.exec(asked);
      const len = Number(m?.[2]) - Number(m?.[1]) + 1;
      return new Response(Buffer.alloc(len), {
        status: 206,
        headers: { "content-range": `bytes ${m?.[1]}-${m?.[2]}/${100 * 1024 * 1024}` },
      });
    });
  }

  test("a TorBox destination gets a sized body it can measure", async () => {
    // libtorrent needs to know where the response ends. Streaming makes Bun
    // answer chunked and drop the header, and that wedged a live transfer at
    // 74%: the same 48,961-byte piece tail re-requested 167 times in 3 minutes.
    mockUpstream();
    register("job-framing-tb", "torbox");

    const res = await handleProxyRequest("job-framing-tb", "movie.mkv", "bytes=1000-2000");
    expect(res.status).toBe(206);
    const body = await res.arrayBuffer();
    expect(body.byteLength).toBe(1001);
    expect(res.headers.get("content-length")).toBe("1001");

    removeProxySession("job-framing-tb");
  });

  test("an RD destination keeps the streaming path", async () => {
    // Transmission is happy with chunked, and buffering a whole chunk per
    // in-flight request is real memory on a small host.
    mockUpstream();
    register("job-framing-rd", "rd");

    const res = await handleProxyRequest("job-framing-rd", "movie.mkv", "bytes=1000-2000");
    expect(res.status).toBe(206);
    expect(await res.arrayBuffer()).toBeDefined();

    removeProxySession("job-framing-rd");
  });
});
