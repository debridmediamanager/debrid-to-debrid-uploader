import { afterEach, describe, expect, mock, test } from "bun:test";
import * as alldebrid from "./alldebrid";
import { AlldebridError, RateLimitError } from "./alldebrid";
import { config } from "./config";
import { MissingCredentialError } from "./credentials";

/** Every call now needs its own credential; there is no operator fallback. */
const AD = { apiKey: "AD_KEY" };

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Answer with `data` wrapped in AllDebrid's success envelope. */
function respondData(data: unknown) {
  globalThis.fetch = mock(async () =>
    Response.json({ status: "success", data }),
  ) as unknown as typeof fetch;
}

/** Answer with a verbatim envelope, for the envelope-level cases. */
function respondRaw(envelope: unknown) {
  globalThis.fetch = mock(async () => Response.json(envelope)) as unknown as typeof fetch;
}

/** Capture what each client function sends, and answer with `data`. */
function captureRequest(data: unknown) {
  const seen: { url: string; auth: string | null; method?: string; body: string }[] = [];
  globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    seen.push({
      url: String(url),
      auth: headers.get("authorization"),
      method: init?.method,
      body: init?.body ? String(init.body) : "",
    });
    return Response.json({ status: "success", data });
  }) as unknown as typeof fetch;
  return seen;
}

const READY_MAGNET = {
  magnets: [{ id: 667750156, hash: "757da0", name: "Some.Release", size: 8336920832, ready: true }],
};

describe("envelope handling", () => {
  test("maps 429 and 503 to RateLimitError", async () => {
    for (const status of [429, 503]) {
      globalThis.fetch = mock(
        async () => new Response("limited", { status }),
      ) as unknown as typeof fetch;
      await expect(alldebrid.uploadMagnet("magnet:?xt=urn:btih:abc", AD)).rejects.toThrow(
        RateLimitError,
      );
    }
  });

  test("surfaces a genuine HTTP failure", async () => {
    globalThis.fetch = mock(
      async () => new Response("boom", { status: 500 }),
    ) as unknown as typeof fetch;
    await expect(alldebrid.uploadMagnet("magnet:?xt=urn:btih:abc", AD)).rejects.toThrow(
      "AllDebrid /v4/magnet/upload failed: 500 boom",
    );
  });

  test("rejects an HTTP 200 that carries status:error", async () => {
    // The trap this envelope handling exists for: AllDebrid answers a rejected
    // key with 200, so `res.ok` says the call succeeded.
    globalThis.fetch = mock(async () =>
      Response.json({
        status: "error",
        error: { code: "AUTH_BAD_APIKEY", message: "The auth apikey is invalid" },
      }),
    ) as unknown as typeof fetch;

    const err = await alldebrid.uploadMagnet("magnet:?xt=urn:btih:abc", AD).catch((e) => e);
    expect(err).toBeInstanceOf(AlldebridError);
    expect(err.code).toBe("AUTH_BAD_APIKEY");
    expect(err.message).toContain("The auth apikey is invalid");
  });

  test("defaults a malformed error envelope rather than throwing on it", async () => {
    respondRaw({ status: "error" });
    const err = await alldebrid.uploadMagnet("magnet:?xt=urn:btih:abc", AD).catch((e) => e);
    expect(err).toBeInstanceOf(AlldebridError);
    expect(err.code).toBe("UNKNOWN");
  });

  test("rejects a non-JSON body", async () => {
    globalThis.fetch = mock(async () => new Response("<html>nope")) as unknown as typeof fetch;
    await expect(alldebrid.uploadMagnet("magnet:?xt=urn:btih:abc", AD)).rejects.toThrow(
      "returned non-JSON",
    );
  });

  test("rejects a success envelope with no data", async () => {
    respondRaw({ status: "success" });
    await expect(alldebrid.uploadMagnet("magnet:?xt=urn:btih:abc", AD)).rejects.toThrow(
      "returned no data",
    );
  });
});

describe("uploadMagnet", () => {
  test("reports a cached magnet as ready", async () => {
    const seen = captureRequest(READY_MAGNET);
    expect(await alldebrid.uploadMagnet("magnet:?xt=urn:btih:757da0", AD)).toEqual({
      id: 667750156,
      hash: "757da0",
      name: "Some.Release",
      size: 8336920832,
      ready: true,
    });
    expect(seen[0].method).toBe("POST");
    expect(seen[0].body).toContain("magnets%5B%5D=magnet");
  });

  test("reports an uncached magnet as not ready", async () => {
    respondData({ magnets: [{ id: 1, ready: false }] });
    const magnet = await alldebrid.uploadMagnet("magnet:?xt=urn:btih:abc", AD);
    expect(magnet.ready).toBe(false);
    // Absent optional fields fall back rather than landing as undefined.
    expect(magnet).toMatchObject({ hash: "", name: "", size: 0 });
  });

  test("throws when the response carries no magnet", async () => {
    respondData({ magnets: [] });
    await expect(alldebrid.uploadMagnet("magnet:?xt=urn:btih:abc", AD)).rejects.toThrow(
      "returned no magnet",
    );
  });

  test("throws on a per-magnet error nested in a success envelope", async () => {
    // `call` cannot see this one: the envelope says success.
    respondData({
      magnets: [{ error: { code: "MAGNET_INVALID_URI", message: "bad magnet" } }],
    });
    const err = await alldebrid.uploadMagnet("nonsense", AD).catch((e) => e);
    expect(err).toBeInstanceOf(AlldebridError);
    expect(err.code).toBe("MAGNET_INVALID_URI");
  });

  test("defaults a malformed per-magnet error", async () => {
    respondData({ magnets: [{ error: {} }] });
    const err = await alldebrid.uploadMagnet("nonsense", AD).catch((e) => e);
    expect(err.code).toBe("UNKNOWN");
  });

  test("throws when the magnet has no id", async () => {
    respondData({ magnets: [{ ready: true }] });
    await expect(alldebrid.uploadMagnet("magnet:?xt=urn:btih:abc", AD)).rejects.toThrow(
      "returned no magnet id",
    );
  });
});

describe("getMagnetStatus", () => {
  test("reads the single-magnet object form from v4.1", async () => {
    const seen = captureRequest({
      magnets: { id: 5, filename: "Rel", size: 10, status: "Ready", statusCode: 4 },
    });
    expect(await alldebrid.getMagnetStatus(5, AD)).toEqual({
      id: 5,
      filename: "Rel",
      size: 10,
      status: "Ready",
      statusCode: 4,
    });
    // v4 answers DISCONTINUED, so the version here is not incidental.
    expect(seen[0].url).toContain("/v4.1/magnet/status?id=5");
  });

  test("throws when no magnet comes back", async () => {
    respondData({ magnets: null });
    await expect(alldebrid.getMagnetStatus(5, AD)).rejects.toThrow("returned no magnet");
  });

  test("classifies status codes", () => {
    expect(alldebrid.AD_STATUS_READY).toBe(4);
    expect(alldebrid.isAlldebridError(4)).toBe(false);
    expect(alldebrid.isAlldebridError(1)).toBe(false);
    expect(alldebrid.isAlldebridError(5)).toBe(true);
    expect(alldebrid.isAlldebridError(15)).toBe(true);
  });
});

describe("flattenFiles", () => {
  test("keeps a root-level file at its bare name", () => {
    expect(alldebrid.flattenFiles([{ n: "movie.mkv", s: 10, l: "https://ad/f/a" }])).toEqual([
      { path: "movie.mkv", size: 10, link: "https://ad/f/a" },
    ]);
  });

  test("joins nested folders into torrent-style paths", () => {
    // The docs' own sub-sub-folder case: one level of handling is not enough.
    const files = alldebrid.flattenFiles([
      {
        n: "Release",
        e: [
          { n: "movie.mkv", s: 100, l: "https://ad/f/a" },
          { n: "Subs", e: [{ n: "en.srt", s: 5, l: "https://ad/f/b" }] },
        ],
      },
      { n: "readme.txt", s: 1, l: "https://ad/f/c" },
    ]);

    expect(files).toEqual([
      { path: "Release/movie.mkv", size: 100, link: "https://ad/f/a" },
      { path: "Release/Subs/en.srt", size: 5, link: "https://ad/f/b" },
      { path: "readme.txt", size: 1, link: "https://ad/f/c" },
    ]);
  });

  test("skips a node that is neither a folder nor a linked file", () => {
    expect(alldebrid.flattenFiles([{ n: "orphan", s: 10 }])).toEqual([]);
  });

  test("defaults a missing size to zero", () => {
    expect(alldebrid.flattenFiles([{ n: "x.mkv", l: "https://ad/f/a" }])[0].size).toBe(0);
  });
});

describe("getMagnetFiles", () => {
  test("returns the flattened file list", async () => {
    const seen = captureRequest({
      magnets: [
        {
          id: "667750156",
          files: [{ n: "Rel", e: [{ n: "movie.mkv", s: 8336920801, l: "https://ad/f/a" }] }],
        },
      ],
    });

    expect(await alldebrid.getMagnetFiles(667750156, AD)).toEqual([
      { path: "Rel/movie.mkv", size: 8336920801, link: "https://ad/f/a" },
    ]);
    expect(seen[0].body).toBe("id%5B%5D=667750156");
  });

  test("throws when no magnet comes back", async () => {
    respondData({ magnets: [] });
    await expect(alldebrid.getMagnetFiles(1, AD)).rejects.toThrow("returned no magnet");
  });

  test("throws on the per-magnet MAGNET_INVALID_ID error", async () => {
    respondData({
      magnets: [{ id: "1", error: { code: "MAGNET_INVALID_ID", message: "nope" } }],
    });
    const err = await alldebrid.getMagnetFiles(1, AD).catch((e) => e);
    expect(err).toBeInstanceOf(AlldebridError);
    expect(err.code).toBe("MAGNET_INVALID_ID");
  });

  test("defaults a malformed per-magnet error", async () => {
    respondData({ magnets: [{ id: "1", error: {} }] });
    await expect(alldebrid.getMagnetFiles(1, AD)).rejects.toThrow("AllDebrid UNKNOWN");
  });

  test("treats a magnet with no files as empty", async () => {
    respondData({ magnets: [{ id: "1" }] });
    expect(await alldebrid.getMagnetFiles(1, AD)).toEqual([]);
  });
});

describe("unlockLink", () => {
  test("returns the direct link", async () => {
    const seen = captureRequest({ link: "https://z2a3b4.debrid.it/dl/52aq/movie.mkv" });
    expect(await alldebrid.unlockLink("https://alldebrid.com/f/tok", AD)).toBe(
      "https://z2a3b4.debrid.it/dl/52aq/movie.mkv",
    );
    expect(seen[0].url).toContain("/v4/link/unlock");
    expect(seen[0].body).toContain("alldebrid.com%2Ff%2Ftok");
  });

  test("throws when no link comes back", async () => {
    respondData({ link: "" });
    await expect(alldebrid.unlockLink("https://alldebrid.com/f/tok", AD)).rejects.toThrow(
      "returned no link",
    );
  });
});

describe("deleteMagnet", () => {
  test("posts the magnet id", async () => {
    const seen = captureRequest({ message: "Magnet was successfully deleted" });
    await alldebrid.deleteMagnet(667750156, AD);
    expect(seen[0].url).toContain("/v4/magnet/delete");
    expect(seen[0].body).toBe("id=667750156");
  });

  test("surfaces a delete failure", async () => {
    respondRaw({ status: "error", error: { code: "MAGNET_INVALID_ID", message: "nope" } });
    await expect(alldebrid.deleteMagnet(1, AD)).rejects.toThrow(AlldebridError);
  });
});

describe("per-job AllDebrid API key", () => {
  test("authenticates with the supplied key", async () => {
    const seen = captureRequest(READY_MAGNET);
    await alldebrid.uploadMagnet("magnet:?xt=urn:btih:abc", { apiKey: "USER_AD_KEY" });
    expect(seen[0].auth).toBe("Bearer USER_AD_KEY");
  });

  test("refuses to call AllDebrid with no key rather than using the operator's", async () => {
    // There is no shared env key any more. A job that reaches here without one
    // is a row predating that rule, and it must fail loudly — the fallback it
    // replaces spent the operator's account without saying so.
    const seen = captureRequest(READY_MAGNET);
    await expect(alldebrid.uploadMagnet("magnet:?xt=urn:btih:abc")).rejects.toThrow(
      MissingCredentialError,
    );
    expect(seen).toHaveLength(0);
  });

  test("carries the key onto every other endpoint", async () => {
    const seen = captureRequest({
      magnets: { id: 1, filename: "f", size: 1, status: "Ready", statusCode: 4 },
    });
    await alldebrid.getMagnetStatus(1, { apiKey: "USER_AD_KEY" });
    expect(seen[0].auth).toBe("Bearer USER_AD_KEY");

    const seenFiles = captureRequest({ magnets: [{ id: "1", files: [] }] });
    await alldebrid.getMagnetFiles(1, { apiKey: "USER_AD_KEY" });
    expect(seenFiles[0].auth).toBe("Bearer USER_AD_KEY");

    const seenUnlock = captureRequest({ link: "https://dl" });
    await alldebrid.unlockLink("https://alldebrid.com/f/tok", { apiKey: "USER_AD_KEY" });
    expect(seenUnlock[0].auth).toBe("Bearer USER_AD_KEY");

    const seenDelete = captureRequest({ message: "ok" });
    await alldebrid.deleteMagnet(1, { apiKey: "USER_AD_KEY" });
    expect(seenDelete[0].auth).toBe("Bearer USER_AD_KEY");
  });
});

describe("getUser", () => {
  test("reads the username out of the nested envelope", async () => {
    const seen = captureRequest({ user: { username: "someuser", email: "x@y.z" } });

    expect(await alldebrid.getUser(AD)).toEqual({ username: "someuser" });
    expect(seen[0].url).toContain("/v4/user");
    expect(seen[0].auth).toBe("Bearer AD_KEY");
  });

  test("refuses a response with no username rather than inventing an identity", async () => {
    // The username *is* the account id here, so a blank one would collapse two
    // people into one owner — the direction the whole `owners.ts` design avoids.
    respondData({ user: {} });
    expect(alldebrid.getUser(AD)).rejects.toThrow("no username");
  });

  test("needs a credential like every other call", () => {
    expect(alldebrid.getUser({})).rejects.toBeInstanceOf(MissingCredentialError);
  });
});
