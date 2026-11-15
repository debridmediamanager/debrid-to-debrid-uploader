import { describe, expect, test } from "bun:test";
import { fetchTorrentFile } from "./itorrents";

// Genuinely well-formed: `pieces` declares 20 bytes and supplies exactly 20,
// and the dict terminators balance. It previously carried 21 `x` and a spare
// `e`, which nothing noticed because these tests never parsed it — the fetcher
// only checked the length and the leading `d`. It is parsed now.
const VALID_TORRENT =
  "d4:infod4:name5:hello6:lengthi100e12:piece lengthi262144e6:pieces20:xxxxxxxxxxxxxxxxxxxxee";
// The fixture's *real* info hash. It used to be an unrelated constant, which
// passed only because nothing checked that a mirror returned the torrent that
// was asked for — the very hole the decoy exploited.
const HASH = "3f086b1fa638a1ead7718513fc85e044009f0e49";

function mockFetcher(
  fn: (
    url: string,
    init?: { signal: AbortSignal },
  ) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }>,
) {
  return fn;
}

describe("mirror timeouts", () => {
  test("a mirror that never answers is abandoned rather than held open", async () => {
    // `Promise.any` waits for every attempt before rejecting, and Bun's fetch
    // has no default timeout — so one stalled mirror used to hold the whole
    // metadata stage open until the stage timeout fired minutes later, with a
    // concurrency slot held the whole time.
    const fetcher = mockFetcher(() => new Promise(() => {}));
    const started = Date.now();
    await expect(fetchTorrentFile(HASH, fetcher, 40)).rejects.toThrow(/timed out after 40ms/);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test("a fast mirror still wins without waiting for a stalled one", async () => {
    // The timeout must not cost latency in the good case: a source that answers
    // immediately should resolve the race well before the stalled one expires.
    const fetcher = mockFetcher(async (url) => {
      if (url.includes("itorrents")) return new Promise(() => {}) as never;
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => Buffer.from(VALID_TORRENT).buffer as ArrayBuffer,
      };
    });
    const started = Date.now();
    const result = await fetchTorrentFile(HASH, fetcher, 30_000);
    expect(result[0]).toBe(0x64);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test("passes an abort signal so a real fetch drops its socket", async () => {
    // Racing alone would leave the connection open; the signal is what actually
    // releases it.
    let seen: AbortSignal | undefined;
    const fetcher = mockFetcher(async (_url, init) => {
      seen = init?.signal;
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => Buffer.from(VALID_TORRENT).buffer as ArrayBuffer,
      };
    });
    await fetchTorrentFile(HASH, fetcher, 5_000);
    expect(seen).toBeInstanceOf(AbortSignal);
  });
});

describe("fetchTorrentFile", () => {
  test("returns buffer from first successful source", async () => {
    const fetcher = mockFetcher(async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => Buffer.from(VALID_TORRENT).buffer as ArrayBuffer,
    }));

    const result = await fetchTorrentFile(HASH, fetcher);
    expect(result).toBeInstanceOf(Buffer);
    expect(result[0]).toBe(0x64);
  });

  test("falls back when first sources fail", async () => {
    let callCount = 0;
    const fetcher = mockFetcher(async () => {
      callCount++;
      if (callCount <= 3)
        return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => Buffer.from(VALID_TORRENT).buffer as ArrayBuffer,
      };
    });

    const result = await fetchTorrentFile(HASH, fetcher);
    expect(result[0]).toBe(0x64);
    expect(callCount).toBe(4);
  });

  test("skips sources returning invalid torrent data", async () => {
    let callCount = 0;
    const fetcher = mockFetcher(async () => {
      callCount++;
      if (callCount <= 2) {
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () => Buffer.from("not a torrent").buffer as ArrayBuffer,
        };
      }
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => Buffer.from(VALID_TORRENT).buffer as ArrayBuffer,
      };
    });

    const result = await fetchTorrentFile(HASH, fetcher);
    expect(result[0]).toBe(0x64);
  });

  test("throws when all sources fail", async () => {
    const fetcher = mockFetcher(async () => ({
      ok: false,
      status: 404,
      arrayBuffer: async () => new ArrayBuffer(0),
    }));

    await expect(fetchTorrentFile(HASH, fetcher)).rejects.toThrow("All torrent sources failed");
  });

  test("uses uppercase hash in URLs", async () => {
    const urls: string[] = [];
    const fetcher = mockFetcher(async (url: string) => {
      urls.push(url);
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => Buffer.from(VALID_TORRENT).buffer as ArrayBuffer,
      };
    });

    await fetchTorrentFile(HASH, fetcher);
    expect(urls.every((u) => u.includes(HASH.toUpperCase()))).toBe(true);
  });
});

describe("truncated mirrors", () => {
  // A torrent cut short still starts with `d` and clears the 50-byte floor, so
  // the old length/prefix check passed it. Under `Promise.any` the truncated
  // copy could win the race against mirrors holding the whole file, and the
  // parser then hung the process on it.
  const TRUNCATED = `${VALID_TORRENT.slice(0, VALID_TORRENT.length - 12)}9999:AAAA`;

  test("rejects a truncated torrent and falls through to a healthy mirror", async () => {
    const fetcher = mockFetcher(async (url: string) => ({
      ok: true,
      status: 200,
      arrayBuffer: async () =>
        new TextEncoder().encode(url.includes("itorrents.org") ? TRUNCATED : VALID_TORRENT).buffer,
    }));

    const out = await fetchTorrentFile(HASH, fetcher);
    expect(out.toString()).toBe(VALID_TORRENT);
  });

  test("fails clearly when every mirror is truncated", async () => {
    const fetcher = mockFetcher(async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => new TextEncoder().encode(TRUNCATED).buffer,
    }));

    await expect(fetchTorrentFile(HASH, fetcher)).rejects.toThrow(/truncated or malformed/);
  });
});

describe("mirrors that answer with the wrong torrent", () => {
  /**
   * A different, entirely valid torrent — the shape of the decoy itorrents
   * serves for a hash it does not index.
   *
   * Measured live 2026-08-16: both `itorrents.org` and `itorrents.net` answer an
   * unknown hash with the same 40789-byte file (info hash `E22D048D…`, named
   * `001FF871FB8B9348FCD8ECBFDAACC85D3CCAB00F.exe`) instead of a 404. It is
   * valid bencode, so the length check, the leading-`d` check and
   * `isWellFormedTorrent` all passed it.
   */
  const DECOY =
    "d4:infod4:name9:decoy.exe6:lengthi40e12:piece lengthi262144e6:pieces20:yyyyyyyyyyyyyyyyyyyyee";

  test("rejects a well-formed torrent whose info hash is not the one requested", async () => {
    const fetcher = mockFetcher(async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => Buffer.from(DECOY).buffer as ArrayBuffer,
    }));

    // Every source returns the decoy, so the job fails outright rather than
    // silently rewriting somebody else's 40 KB executable and handing it to the
    // destination — which surfaces hours later as a stall naming nothing.
    expect(fetchTorrentFile(HASH, fetcher)).rejects.toThrow("All torrent sources failed");
  });

  test("falls through to a mirror that has the real torrent", async () => {
    let calls = 0;
    const fetcher = mockFetcher(async () => {
      calls++;
      const body = calls <= 2 ? DECOY : VALID_TORRENT;
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => Buffer.from(body).buffer as ArrayBuffer,
      };
    });

    // The sources race under `Promise.any`, so a decoy that answers first must
    // lose rather than win — the same failure mode as the truncated copy that
    // beat the healthy mirrors before `isWellFormedTorrent` existed.
    const result = await fetchTorrentFile(HASH, fetcher);
    expect(result.toString()).toBe(VALID_TORRENT);
  });

  test("matches the hash case-insensitively", async () => {
    const fetcher = mockFetcher(async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => Buffer.from(VALID_TORRENT).buffer as ArrayBuffer,
    }));

    // Callers pass lower-case hashes; the URL is upper-cased and `computeInfoHash`
    // returns lower-case, so a naive comparison would reject every good mirror.
    expect((await fetchTorrentFile(HASH.toUpperCase(), fetcher)).toString()).toBe(VALID_TORRENT);
  });
});
