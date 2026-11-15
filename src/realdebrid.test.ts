import { afterEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RdRefusalError } from "./rd-account-block";
import * as rd from "./realdebrid";

/** Every call now needs its own credential; there is no operator fallback. */
const RD = { apiKey: "RD_KEY" };

const originalFetch = globalThis.fetch;
let tempDirs: string[] = [];

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

function tempFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "debrid-rd-"));
  tempDirs.push(dir);
  const filePath = path.join(dir, "file.torrent");
  fs.writeFileSync(filePath, "torrent");
  return filePath;
}

/** Records what the retry loop would have slept, without sleeping. */
function fakeSleep(): ((ms: number) => Promise<void>) & { delays: number[] } {
  const delays: number[] = [];
  const fn = async (ms: number) => {
    delays.push(ms);
  };
  return Object.assign(fn, { delays });
}

/** Responds from a queue, so a test can script "fail, fail, then succeed". */
function queuedFetcher(responses: (Response | Error)[]) {
  const calls: string[] = [];
  const fetcher = async (url: string) => {
    calls.push(url);
    const next = responses.shift();
    if (next === undefined) throw new Error("fetcher called more often than scripted");
    if (next instanceof Error) throw next;
    return next;
  };
  return Object.assign(fetcher, { calls });
}

describe("Real-Debrid client", () => {
  test("uploads torrents and returns the RD id", async () => {
    const fetchMock = mock(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ id: "rd-1" }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    expect(await rd.addTorrent(tempFile(), RD)).toBe("rd-1");
    expect(fetchMock.mock.calls[0][1]?.method).toBe("PUT");
  });

  test("uses a per-call RD key when one is given, over the env key", async () => {
    let seenAuth = "";
    const fetcher = async (_url: string, init?: RequestInit) => {
      seenAuth = ((init as RequestInit).headers as Record<string, string>).Authorization;
      return Response.json({ id: "rd-1" });
    };
    await rd.addTorrent(tempFile(), { fetcher, apiKey: "PER_JOB_KEY" });
    expect(seenAuth).toBe("Bearer PER_JOB_KEY");
  });

  test("falls back to the env key when no per-call key is given", async () => {
    let seenAuth = "";
    const fetcher = async (_url: string, init?: RequestInit) => {
      seenAuth = ((init as RequestInit).headers as Record<string, string>).Authorization;
      return Response.json({ id: "rd-1" });
    };
    await rd.addTorrent(tempFile(), { fetcher, apiKey: "RD_KEY" });
    expect(seenAuth).toBe("Bearer RD_KEY");
  });

  test("surfaces addTorrent failures", async () => {
    globalThis.fetch = mock(
      async () => new Response("bad", { status: 400 }),
    ) as unknown as typeof fetch;

    await expect(rd.addTorrent(tempFile(), RD)).rejects.toThrow("RD addTorrent failed: 400 bad");
  });

  test("selects all files when no IDs given", async () => {
    const fetchMock = mock(
      async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 204 }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await rd.selectFiles("rd-1", undefined, RD);
    const body = fetchMock.mock.calls[0][1]?.body as string;
    expect(body).toBe("files=all");
  });

  test("selects specific file IDs", async () => {
    const fetchMock = mock(
      async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 204 }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await rd.selectFiles("rd-1", [3, 5, 7], RD);
    const body = fetchMock.mock.calls[0][1]?.body as string;
    expect(body).toBe("files=3,5,7");
  });

  test("gets torrent info", async () => {
    const info = {
      id: "rd-1",
      status: "downloaded",
      progress: 100,
      filename: "movie.mkv",
      speed: 0,
      seeders: 0,
      links: ["https://real-debrid.com/d/ABC123"],
      files: [{ id: 1, path: "/movie.mkv", bytes: 1000, selected: 1 }],
    };
    globalThis.fetch = mock(async () => Response.json(info)) as unknown as typeof fetch;

    expect(await rd.getTorrentInfo("rd-1", RD)).toEqual(info);
  });

  test("surfaces info failures", async () => {
    globalThis.fetch = mock(
      async () => new Response("missing", { status: 404 }),
    ) as unknown as typeof fetch;

    await expect(rd.getTorrentInfo("rd-1", RD)).rejects.toThrow(rd.RdMissingTorrentError);
  });
});

describe("transient failure retries", () => {
  test("retries a 429 and returns the eventual success", async () => {
    const fetcher = queuedFetcher([
      new Response("slow down", { status: 429 }),
      Response.json({ id: "rd-9" }),
    ]);
    const sleepFor = fakeSleep();

    expect(await rd.addTorrent(tempFile(), { fetcher, sleepFor, ...RD })).toBe("rd-9");
    expect(fetcher.calls).toHaveLength(2);
    expect(sleepFor.delays).toEqual([rd.RD_RETRY_BASE_MS]);
  });

  test("retries any 5xx", async () => {
    const fetcher = queuedFetcher([
      new Response("bad gateway", { status: 502 }),
      new Response(null, { status: 204 }),
    ]);
    const sleepFor = fakeSleep();

    await rd.selectFiles("rd-1", undefined, { fetcher, sleepFor, ...RD });
    expect(fetcher.calls).toHaveLength(2);
  });

  test("retries the unknown_ressource 404 that follows a fresh addTorrent", async () => {
    const fetcher = queuedFetcher([
      new Response(`{"error":"unknown_ressource","error_code":7}`, { status: 404 }),
      new Response(null, { status: 204 }),
    ]);
    const sleepFor = fakeSleep();

    await rd.selectFiles("rd-1", [1], { fetcher, sleepFor, ...RD });
    expect(fetcher.calls).toHaveLength(2);
  });

  test("does not retry any other 404", async () => {
    const fetcher = queuedFetcher([new Response("no such torrent", { status: 404 })]);
    const sleepFor = fakeSleep();

    await expect(rd.getTorrentInfo("rd-1", { fetcher, sleepFor, ...RD })).rejects.toThrow(
      rd.RdMissingTorrentError,
    );
    expect(fetcher.calls).toHaveLength(1);
    expect(sleepFor.delays).toEqual([]);
  });

  test("hands a 451 back at once and typed, leaving its meaning to the caller", async () => {
    // Never on this ladder: on an add it is usually an account block of 21 s
    // to ~5 min, and five tries in ~15 s would only be fired into it.
    const body = '{ "error": "infringing_file", "error_code": 35 }';
    const fetcher = queuedFetcher([new Response(body, { status: 451 })]);
    const sleepFor = fakeSleep();

    const err = await rd
      .unrestrictLink("https://real-debrid.com/d/ABC", { fetcher, sleepFor, ...RD })
      .catch((e) => e);

    expect(err).toBeInstanceOf(RdRefusalError);
    expect(err.message).toBe(`RD unrestrictLink failed: 451 ${body}`);
    expect(rd.isPermanentRdError(err)).toBe(false);
    expect(fetcher.calls).toHaveLength(1);
    expect(sleepFor.delays).toEqual([]);
  });

  test("does not retry a permanent 4xx", async () => {
    const fetcher = queuedFetcher([new Response("nope", { status: 403 })]);

    await expect(
      rd.getTorrentInfo("rd-1", { fetcher, sleepFor: fakeSleep(), ...RD }),
    ).rejects.toThrow(rd.RdAuthError);
    expect(fetcher.calls).toHaveLength(1);
  });

  test("retries a network throw and backs off exponentially", async () => {
    const fetcher = queuedFetcher([
      new Error("ECONNRESET"),
      new Error("ECONNRESET"),
      Response.json({ id: "rd-3" }),
    ]);
    const sleepFor = fakeSleep();

    expect(await rd.addTorrent(tempFile(), { fetcher, sleepFor, ...RD })).toBe("rd-3");
    expect(sleepFor.delays).toEqual([500, 1000]);
  });

  test("gives up on a network throw after the attempt budget, keeping the cause", async () => {
    const fetcher = queuedFetcher(
      Array.from({ length: rd.RD_RETRY_ATTEMPTS }, () => new Error("ECONNRESET")),
    );
    const sleepFor = fakeSleep();

    await expect(rd.getTorrentInfo("rd-1", { fetcher, sleepFor, ...RD })).rejects.toThrow(
      "RD getTorrentInfo failed: ECONNRESET",
    );
    expect(fetcher.calls).toHaveLength(rd.RD_RETRY_ATTEMPTS);
    expect(sleepFor.delays).toEqual([500, 1000, 2000, 4000]);
  });

  test("gives up on a sustained 5xx and reports the last status", async () => {
    const fetcher = queuedFetcher(
      Array.from({ length: rd.RD_RETRY_ATTEMPTS }, () => new Response("down", { status: 503 })),
    );

    await expect(
      rd.getTorrentInfo("rd-1", { fetcher, sleepFor: fakeSleep(), ...RD }),
    ).rejects.toThrow("RD getTorrentInfo failed: 503 down");
    expect(fetcher.calls).toHaveLength(rd.RD_RETRY_ATTEMPTS);
  });

  test("stringifies a non-Error throw", async () => {
    const fetcher = async () => {
      throw "socket vanished";
    };

    await expect(
      rd.getTorrentInfo("rd-1", {
        fetcher: fetcher as unknown as rd.Fetcher,
        sleepFor: fakeSleep(),
        ...RD,
      }),
    ).rejects.toThrow("RD getTorrentInfo failed: socket vanished");
  });
});

describe("isRdStreamable", () => {
  test("accepts video extensions", () => {
    for (const ext of [".mkv", ".mp4", ".avi", ".flv", ".m2ts", ".m4v", ".mov", ".webm", ".wmv"]) {
      expect(rd.isRdStreamable(`/movie${ext}`)).toBe(true);
    }
  });

  test("accepts audio extensions", () => {
    for (const ext of [".mp3", ".flac", ".m4a"]) {
      expect(rd.isRdStreamable(`/track${ext}`)).toBe(true);
    }
  });

  test("rejects non-streamable extensions", () => {
    for (const ext of [".nfo", ".txt", ".srt", ".sub", ".jpg", ".rar"]) {
      expect(rd.isRdStreamable(`/file${ext}`)).toBe(false);
    }
  });

  test("is case insensitive", () => {
    expect(rd.isRdStreamable("/Movie.MKV")).toBe(true);
  });
});

describe("getUser", () => {
  test("returns the account behind a key", async () => {
    globalThis.fetch = mock(async () =>
      Response.json({ id: 4242, username: "someone" }),
    ) as unknown as typeof fetch;

    expect(await rd.getUser(RD)).toEqual({ id: 4242, username: "someone" });
  });

  test("authenticates with the supplied key", async () => {
    const seen: (string | null)[] = [];
    globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get("authorization"));
      return Response.json({ id: 1, username: "u" });
    }) as unknown as typeof fetch;

    await rd.getUser({ apiKey: "USER_RD_KEY" });

    expect(seen[0]).toBe("Bearer USER_RD_KEY");
  });
});

describe("permanent versus transient RD failures", () => {
  // `monitorRd` rides out a failed poll rather than killing a live download, but
  // it used to absorb *every* error that way — so a revoked token or a torrent RD
  // had lost spent the whole five-minute stall window and then reported
  // "uploading stalled" as the cause. Of 16 failures sampled on 2026-08-08, 3
  // were a dead token and 6 a missing torrent; all were recorded as stalls.
  test("a rejected token is permanent and named as such", async () => {
    const fetcher = queuedFetcher([new Response("bad_token", { status: 401 })]);

    const err = await rd
      .getTorrentInfo("rd-1", { fetcher, sleepFor: fakeSleep(), ...RD })
      .catch((e) => e);

    expect(err).toBeInstanceOf(rd.RdAuthError);
    expect(rd.isPermanentRdError(err)).toBe(true);
    expect(fetcher.calls).toHaveLength(1);
  });

  test("an unknown_ressource that survives the whole ladder is a missing torrent", async () => {
    // Inside the ladder this is the post-addTorrent race and is retried; what
    // comes out the far end is a torrent that is genuinely gone.
    const fetcher = queuedFetcher(
      Array.from(
        { length: 5 },
        () => new Response('{"error":"unknown_ressource"}', { status: 404 }),
      ),
    );
    const sleepFor = fakeSleep();

    const err = await rd.getTorrentInfo("rd-1", { fetcher, sleepFor, ...RD }).catch((e) => e);

    expect(err).toBeInstanceOf(rd.RdMissingTorrentError);
    expect(rd.isPermanentRdError(err)).toBe(true);
    // It really did ride the ladder before concluding that.
    expect(fetcher.calls).toHaveLength(5);
    expect(sleepFor.delays).toHaveLength(4);
  });

  test("other failures stay generic, so the caller keeps riding them out", async () => {
    const fetcher = queuedFetcher([new Response("bad request", { status: 400 })]);

    const err = await rd
      .getTorrentInfo("rd-1", { fetcher, sleepFor: fakeSleep(), ...RD })
      .catch((e) => e);

    expect(rd.isPermanentRdError(err)).toBe(false);
    expect(err.message).toBe("RD getTorrentInfo failed: 400 bad request");
  });

  test("a 5xx is neither permanent nor given up on early", async () => {
    const fetcher = queuedFetcher([
      new Response("boom", { status: 503 }),
      Response.json({ id: "rd-1", status: "downloading" }),
    ]);

    const info = await rd.getTorrentInfo("rd-1", { fetcher, sleepFor: fakeSleep(), ...RD });

    expect(info.status).toBe("downloading");
    expect(fetcher.calls).toHaveLength(2);
  });
});

describe("Real-Debrid as a byte source", () => {
  test("finds a downloaded release already in the account, by hash", async () => {
    const fetchMock = mock(async () =>
      Response.json([
        { id: "other", hash: "AAAA", status: "downloaded" },
        { id: "wanted", hash: "BBBB", status: "downloaded" },
      ]),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    // Matched case-insensitively: RD lower-cases hashes and callers do not.
    const found = await rd.findTorrentByHash("bbbb", RD);
    expect(found?.id).toBe("wanted");
  });

  test("ignores a matching torrent that has not finished downloading", async () => {
    // A torrent still fetching has no usable links, so treating it as a source
    // would hand the proxy a half-empty file and stall the destination.
    globalThis.fetch = mock(async () =>
      Response.json([{ id: "partial", hash: "CCCC", status: "downloading" }]),
    ) as unknown as typeof fetch;

    expect(await rd.findTorrentByHash("cccc", RD)).toBeUndefined();
  });

  test("returns undefined when the account holds nothing matching", async () => {
    globalThis.fetch = mock(async () => Response.json([])) as unknown as typeof fetch;
    expect(await rd.findTorrentByHash("dddd", RD)).toBeUndefined();
  });

  test("adds a magnet and returns the new id", async () => {
    const fetchMock = mock(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ id: "rd-added" }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    expect(await rd.addMagnet("magnet:?xt=urn:btih:abc", RD)).toBe("rd-added");
    const init = fetchMock.mock.calls[0][1];
    expect(init?.method).toBe("POST");
    expect(String(init?.body)).toContain("magnet%3A%3Fxt");
  });

  test("unrestricts a link into a direct URL", async () => {
    const fetchMock = mock(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ download: "https://23-4.download.real-debrid.com/d/x/file.mkv" }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const url = await rd.unrestrictLink("https://real-debrid.com/d/ABC", RD);
    expect(url).toBe("https://23-4.download.real-debrid.com/d/x/file.mkv");
    expect(String(fetchMock.mock.calls[0][1]?.body)).toContain("link=");
  });

  test("treats an unrestrict with no download field as a failure", async () => {
    // A 200 carrying no link would otherwise become `undefined` in a mapping and
    // 502 every range hours later, with nothing naming the cause.
    globalThis.fetch = mock(async () => Response.json({})) as unknown as typeof fetch;
    expect(rd.unrestrictLink("https://real-debrid.com/d/ABC", RD)).rejects.toThrow(
      "RD unrestrict returned no download link",
    );
  });

  test("deletes a source torrent", async () => {
    const fetchMock = mock(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({}, { status: 204 }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await rd.deleteTorrent("rd-9", RD);
    expect(String(fetchMock.mock.calls[0][0])).toContain("/torrents/delete/rd-9");
    expect(fetchMock.mock.calls[0][1]?.method).toBe("DELETE");
  });

  test("treats deleting an already-gone torrent as success", async () => {
    // Cleanup must not fail a finished job because the thing it was tidying up
    // had already been removed.
    globalThis.fetch = queuedFetcher([
      new Response("nope", { status: 404 }),
    ]) as unknown as typeof fetch;

    expect(await rd.deleteTorrent("rd-gone", { ...RD, sleepFor: fakeSleep() })).toBeUndefined();
  });

  test("still surfaces a non-404 delete failure", async () => {
    globalThis.fetch = queuedFetcher([
      new Response("denied", { status: 403 }),
    ]) as unknown as typeof fetch;

    expect(rd.deleteTorrent("rd-x", { ...RD, sleepFor: fakeSleep() })).rejects.toThrow(
      "RD credentials rejected",
    );
  });
});
