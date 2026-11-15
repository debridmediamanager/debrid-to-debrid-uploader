import { describe, expect, test } from "bun:test";
import { fetchMetadataFromSwarm, resolveTorrentFile } from "./torrent-source";

/** A minimal single-file torrent, so `computeInfoHash` has something real. */
function makeTorrent(name: string): Buffer {
  const info = `d6:lengthi1024e4:name${name.length}:${name}12:piece lengthi16384e6:pieces20:${"a".repeat(20)}e`;
  return Buffer.from(`d8:announce9:udp://x/y4:info${info}e`);
}

const TORRENT = makeTorrent("release.mkv");

/** The info hash of TORRENT, computed the same way the resolver checks it. */
import { computeInfoHash } from "./utils/torrent-info-hash";

const HASH = computeInfoHash(TORRENT).toLowerCase();

const noWait = async () => undefined;

/** A qBittorrent that reports `metaDL` for `stalls` polls, then resolves. */
function fakeClient(opts: { stalls?: number; exports?: Buffer; failAdd?: boolean } = {}) {
  const calls: string[] = [];
  let polls = 0;
  return {
    calls,
    client: {
      async addMagnetForMetadata(magnet: string) {
        calls.push(`add:${magnet}`);
        if (opts.failAdd) throw new Error("qBit metadata add failed: 409");
      },
      async getTorrents(hash: string) {
        polls++;
        calls.push(`poll:${hash}`);
        if (polls <= (opts.stalls ?? 0)) return [{ state: "metaDL", total_size: -1 } as never];
        return [{ state: "missingFiles", total_size: 1024 } as never];
      },
      async exportTorrent(hash: string) {
        calls.push(`export:${hash}`);
        return opts.exports ?? TORRENT;
      },
      async delete(hash: string, deleteFiles: boolean) {
        calls.push(`delete:${hash}:${deleteFiles}`);
      },
    },
  };
}

describe("resolveTorrentFile", () => {
  test("uses the mirrors and never touches a swarm when they answer", async () => {
    let swarmed = false;
    const data = await resolveTorrentFile(HASH, {
      fromMirrors: async () => TORRENT,
      fromSwarm: async () => {
        swarmed = true;
        return TORRENT;
      },
      enabled: true,
      trackers: async () => [],
    });

    expect(data).toBe(TORRENT);
    // The swarm costs minutes against the mirrors' milliseconds, so it must
    // stay strictly a fallback rather than a race.
    expect(swarmed).toBe(false);
  });

  test("leaves the mirror error alone when the fallback is off", async () => {
    // Off by default: joining a swarm changes what this host does on the
    // network, which is an operator's decision and not a default.
    expect(
      resolveTorrentFile(HASH, {
        fromMirrors: async () => {
          throw new Error("All torrent sources failed");
        },
        enabled: false,
      }),
    ).rejects.toThrow("All torrent sources failed");
  });

  test("falls back to the swarm once every mirror has missed", async () => {
    const seen: string[] = [];
    const data = await resolveTorrentFile(HASH, {
      fromMirrors: async () => {
        throw new Error("All torrent sources failed");
      },
      fromSwarm: async (hash, magnet) => {
        seen.push(hash, magnet);
        return TORRENT;
      },
      enabled: true,
      trackers: async () => ["udp://tracker.example:1337/announce"],
    });

    expect(data).toBe(TORRENT);
    expect(seen[0]).toBe(HASH);
    // The magnet is built here, so it must carry the trackers — a bare hash
    // leaves the swarm reachable only through the DHT.
    expect(seen[1]).toContain(`btih:${HASH}`);
    expect(seen[1]).toContain("tracker.example");
  });

  test("reports both causes when the swarm misses too", async () => {
    // The mirror list is the usual story; the swarm result is what says whether
    // the release is reachable at all. Dropping either half misdirects the next
    // person to look at it.
    expect(
      resolveTorrentFile(HASH, {
        fromMirrors: async () => {
          throw new Error("All torrent sources failed for abc");
        },
        fromSwarm: async () => {
          throw new Error("no peer offered metadata");
        },
        enabled: true,
        trackers: async () => [],
      }),
    ).rejects.toThrow(/All torrent sources failed for abc; swarm fallback also failed: no peer/);
  });
});

describe("fetchMetadataFromSwarm", () => {
  test("uses the configured qBittorrent when no client is given", async () => {
    const originalFetch = globalThis.fetch;
    const urls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      urls.push(String(url));
      return url.includes("auth/login")
        ? new Response("Ok.", { headers: { "set-cookie": "SID=abc; path=/" } })
        : new Response("nope", { status: 409 });
    }) as unknown as typeof fetch;
    try {
      await expect(fetchMetadataFromSwarm(HASH, "magnet:")).rejects.toThrow(
        "qBit metadata add failed: 409",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(urls.some((u) => u.includes("torrents/add"))).toBe(true);
  });

  test("adds, waits for the info dict, exports it and removes the torrent", async () => {
    const { client, calls } = fakeClient({ stalls: 2 });

    const data = await fetchMetadataFromSwarm(HASH, "magnet:?xt=urn:btih:" + HASH, {
      client,
      wait: noWait,
      pollMs: 1,
      timeoutMs: 100,
    });

    expect(data).toBe(TORRENT);
    expect(calls[0]).toStartWith("add:");
    expect(calls.filter((c) => c.startsWith("poll:"))).toHaveLength(3);
    expect(calls).toContain(`export:${HASH}`);
    // A metadata fetch that leaks a torrent leaves this host seeding, which is
    // the one outcome a metadata-only path must never produce.
    expect(calls.at(-1)).toBe(`delete:${HASH}:true`);
  });

  test("removes the torrent even when no peer ever answers", async () => {
    const { client, calls } = fakeClient({ stalls: 999 });

    expect(
      fetchMetadataFromSwarm(HASH, "magnet:", { client, wait: noWait, pollMs: 1, timeoutMs: 3 }),
    ).rejects.toThrow("no peer offered metadata");
    await Promise.resolve();
    expect(calls.at(-1)).toBe(`delete:${HASH}:true`);
  });

  test("removes the torrent when the add itself fails", async () => {
    const { client, calls } = fakeClient({ failAdd: true });

    expect(
      fetchMetadataFromSwarm(HASH, "magnet:", { client, wait: noWait, pollMs: 1, timeoutMs: 3 }),
    ).rejects.toThrow("qBit metadata add failed");
    // Nothing was added, so nothing is deleted — the guard is the `finally`
    // around the poll loop, not around the add.
    expect(calls).toEqual(["add:magnet:"]);
  });

  test("rejects a torrent that is not the one asked for", async () => {
    // A swarm cannot realistically substitute a different torrent the way
    // itorrents does, but this is the invariant `rewriteTorrent` depends on and
    // the check costs one SHA-1 over bytes already in memory.
    const { client } = fakeClient({ exports: makeTorrent("something.else.mkv") });

    expect(
      fetchMetadataFromSwarm(HASH, "magnet:", { client, wait: noWait, pollMs: 1, timeoutMs: 10 }),
    ).rejects.toThrow(/exported [0-9a-f]{40} when/);
  });

  test("keeps waiting while the torrent is unknown or still metaDL", async () => {
    let polls = 0;
    const calls: string[] = [];
    const client = {
      async addMagnetForMetadata() {},
      async getTorrents() {
        polls++;
        // Not listed yet, then metaDL, then a size but still metaDL, then done.
        if (polls === 1) return [];
        if (polls === 2) return [{ state: "metaDL", total_size: -1 } as never];
        if (polls === 3) return [{ state: "metaDL", total_size: 1024 } as never];
        return [{ state: "missingFiles", total_size: 1024 } as never];
      },
      async exportTorrent() {
        return TORRENT;
      },
      async delete(hash: string, files: boolean) {
        calls.push(`delete:${hash}:${files}`);
      },
    };

    const data = await fetchMetadataFromSwarm(HASH, "magnet:", {
      client,
      wait: noWait,
      pollMs: 1,
      timeoutMs: 100,
    });

    expect(data).toBe(TORRENT);
    expect(polls).toBe(4);
  });

  test("a torrent with no size is still waiting, whatever its state says", async () => {
    const calls: string[] = [];
    const client = {
      async addMagnetForMetadata() {},
      async getTorrents() {
        return [{ state: "missingFiles", total_size: undefined } as never];
      },
      async exportTorrent() {
        return TORRENT;
      },
      async delete(hash: string, files: boolean) {
        calls.push(`delete:${hash}:${files}`);
      },
    };

    expect(
      fetchMetadataFromSwarm(HASH, "magnet:", { client, wait: noWait, pollMs: 1, timeoutMs: 2 }),
    ).rejects.toThrow("no peer offered metadata");
  });

  test("survives a delete that fails, since the fetch already succeeded", async () => {
    const client = {
      async addMagnetForMetadata() {},
      async getTorrents() {
        return [{ state: "missingFiles", total_size: 1024 } as never];
      },
      async exportTorrent() {
        return TORRENT;
      },
      async delete() {
        throw new Error("qBit unreachable");
      },
    };

    expect(
      await fetchMetadataFromSwarm(HASH, "magnet:", {
        client,
        wait: noWait,
        pollMs: 1,
        timeoutMs: 10,
      }),
    ).toBe(TORRENT);
  });

  test("polls at least once even with a timeout below one interval", async () => {
    const { client, calls } = fakeClient();

    await fetchMetadataFromSwarm(HASH, "magnet:", {
      client,
      wait: noWait,
      pollMs: 5_000,
      timeoutMs: 0,
    });

    expect(calls.filter((c) => c.startsWith("poll:"))).toHaveLength(1);
  });
});
