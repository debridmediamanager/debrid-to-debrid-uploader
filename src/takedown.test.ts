import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assertNotTakenDown,
  BLOCKLIST_POLL_MS,
  base32ToHex,
  DEFAULT_BLOCKLIST_URL,
  infoHashesOf,
  magnetDisplayName,
  normalizeRelease,
  parseBlocklist,
  TAKEDOWN_MESSAGE,
  TakedownBlockedError,
  TakedownList,
  takedown,
} from "./takedown";

const HASH = "0123456789abcdef0123456789abcdef01234567";
// Base32 of the same 20 bytes, so a magnet using either encoding names one hash.
const HASH_B32 = "AERUKZ4JVPG66AJDIVTYTK6N54ASGRLH";

const payload = (over: Record<string, unknown> = {}) => ({
  version: "v1",
  hashes: [HASH.toUpperCase()],
  releases: ["some.movie.2024.1080p.web.h264.group"],
  ...over,
});

function listWith(
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>,
  statePath: string | null = null,
) {
  const warnings: string[] = [];
  const list = new TakedownList({
    url: "https://dmm.test/api/takedown/blocklist",
    statePath,
    fetch: fetchImpl,
    warn: (m) => warnings.push(m),
  });
  return { list, warnings };
}

const ifNoneMatch = (init?: RequestInit): string | undefined =>
  (init?.headers as Record<string, string> | undefined)?.["if-none-match"];

const tmpDirs: string[] = [];
function tmpState(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "takedown-"));
  tmpDirs.push(dir);
  return path.join(dir, "sub", "takedown-blocklist.json");
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("normalizeRelease", () => {
  test("implements DMM's normalization exactly", () => {
    expect(normalizeRelease("Some Movie (2024) [1080p] WEB-DL H.264-GROUP")).toBe(
      "some.movie.2024.1080p.web.dl.h.264.group",
    );
    expect(normalizeRelease("Some.Movie.2024.1080p.WEB.H264-GROUP.nzb")).toBe(
      "some.movie.2024.1080p.web.h264.group",
    );
    expect(normalizeRelease("..__Leading & trailing__..")).toBe("leading.trailing");
    // Only a trailing `.nzb` goes, after lowercasing, and only once.
    expect(normalizeRelease("Name.NZB")).toBe("name");
    expect(normalizeRelease("nzb.name")).toBe("nzb.name");
    expect(normalizeRelease("Ünïcode—name")).toBe("n.code.name");
    expect(normalizeRelease("---")).toBe("");
  });
});

describe("hash extraction", () => {
  test("decodes a base32 BTIH to hex", () => {
    expect(base32ToHex(HASH_B32)).toBe(HASH);
    expect(base32ToHex(HASH_B32.toLowerCase())).toBe(HASH);
    expect(base32ToHex("tooshort")).toBeNull();
    expect(base32ToHex("1".repeat(32))).toBeNull();
  });

  test("finds hex, base32 and bare hashes, case-insensitively", () => {
    expect(infoHashesOf(`magnet:?xt=urn:btih:${HASH.toUpperCase()}&dn=x`)).toEqual([HASH]);
    expect(infoHashesOf(`magnet:?xt=urn:btih:${HASH_B32}`)).toEqual([HASH]);
    expect(infoHashesOf(HASH)).toEqual([HASH]);
    const other = "f".repeat(40);
    expect(infoHashesOf(`magnet:?xt=urn:btih:${other}&xt=urn:btih:${HASH_B32}`).sort()).toEqual(
      [HASH, other].sort(),
    );
    // A 41-char run is not a hash.
    expect(infoHashesOf(`${HASH}a`)).toEqual([]);
  });

  test("reads a magnet's display name", () => {
    expect(magnetDisplayName(`magnet:?xt=urn:btih:${HASH}&dn=Some+Movie.2024`)).toBe(
      "Some Movie.2024",
    );
    expect(magnetDisplayName(`magnet:?xt=urn:btih:${HASH}`)).toBeNull();
    expect(magnetDisplayName(HASH)).toBeNull();
  });
});

describe("parseBlocklist", () => {
  test("accepts the contract's shape and normalizes it", () => {
    const list = parseBlocklist(
      payload({ releases: ["Some Movie 2024", ""], hashes: [" ", HASH] }),
    );
    expect(list?.version).toBe("v1");
    expect([...(list?.hashes ?? [])]).toEqual([HASH]);
    expect([...(list?.releases ?? [])]).toEqual(["some.movie.2024"]);
  });

  test("rejects anything else rather than installing an empty list", () => {
    for (const bad of [
      null,
      "x",
      {},
      payload({ version: 1 }),
      payload({ hashes: "x" }),
      payload({ releases: null }),
      payload({ hashes: [1] }),
      payload({ releases: [null] }),
    ]) {
      expect(parseBlocklist(bad)).toBeNull();
    }
  });
});

describe("TakedownList.check", () => {
  const { list } = listWith(async () => new Response(null, { status: 500 }));

  test("passes everything until a list is loaded", () => {
    expect(list.version).toBeNull();
    expect(list.check({ input: HASH })).toBeNull();
  });

  test("refuses a listed hash in any encoding, and a listed release name", () => {
    expect(list.accept(payload())).toBe(true);
    expect(list.version).toBe("v1");
    expect(list.check({ input: `magnet:?xt=urn:btih:${HASH}` })?.reason).toBe("hash");
    expect(list.check({ input: `magnet:?xt=urn:btih:${HASH_B32}` })?.reason).toBe("hash");
    const other = `magnet:?xt=urn:btih:${"e".repeat(40)}`;
    expect(list.check({ input: other })).toBeNull();
    expect(list.check({ input: other, name: "Some.Movie.2024.1080p.WEB.H264-GROUP" })?.reason).toBe(
      "release",
    );
    expect(list.check({ input: `${other}&dn=Some Movie 2024 1080p WEB H264 GROUP` })?.reason).toBe(
      "release",
    );
    expect(list.check({ input: other, name: "Other.Movie.2024" })).toBeNull();
    expect(list.check({ input: other, name: "---" })).toBeNull();
  });

  test("a malformed payload leaves the current list in place", () => {
    expect(list.accept({ nope: true })).toBe(false);
    expect(list.version).toBe("v1");
  });

  test("the error carries the notice message", () => {
    const err = new TakedownBlockedError("hash");
    expect(err.message).toBe(TAKEDOWN_MESSAGE);
    expect(err.message).toBe("blocked by a copyright notice");
    expect(err.name).toBe("TakedownBlockedError");
  });
});

describe("TakedownList.refresh", () => {
  test("installs, persists and then revalidates with If-None-Match", async () => {
    const statePath = tmpState();
    const seen: (string | undefined)[] = [];
    let status = 200;
    const { list, warnings } = listWith(async (_url, init) => {
      seen.push(ifNoneMatch(init));
      if (status === 304) return new Response(null, { status: 304 });
      return Response.json(payload(), { headers: { etag: '"v1"' } });
    }, statePath);

    await list.refresh();
    expect(list.version).toBe("v1");
    expect(JSON.parse(fs.readFileSync(statePath, "utf8"))).toEqual(payload());

    status = 304;
    await list.refresh();
    expect(seen).toEqual([undefined, '"v1"']);
    expect(list.version).toBe("v1");
    expect(warnings).toEqual([]);
  });

  test("uses the version as the validator when no ETag is sent", async () => {
    const seen: (string | undefined)[] = [];
    const { list } = listWith(async (_url, init) => {
      seen.push(ifNoneMatch(init));
      return Response.json(payload({ version: "v7" }));
    });
    await list.refresh();
    await list.refresh();
    expect(seen).toEqual([undefined, '"v7"']);
  });

  test("fails open: errors keep the last good list and warn", async () => {
    let mode = "ok";
    const { list, warnings } = listWith(async () => {
      if (mode === "throw") throw new Error("ECONNREFUSED");
      if (mode === "500") return new Response("down", { status: 500 });
      if (mode === "bad") return Response.json({ version: "v2" });
      return Response.json(payload());
    });

    mode = "500";
    await list.refresh();
    expect(list.version).toBeNull();
    expect(warnings[0]).toContain("no list loaded");

    mode = "ok";
    await list.refresh();
    for (const m of ["throw", "500", "bad"]) {
      mode = m;
      await list.refresh();
      expect(list.version).toBe("v1");
      expect(list.check({ input: HASH })).not.toBeNull();
    }
    expect(warnings.slice(1).every((w) => w.includes("keeping version v1"))).toBe(true);
    expect(warnings).toHaveLength(4);
  });

  test("an empty URL disables fetching and checking", async () => {
    let calls = 0;
    const list = new TakedownList({
      url: "",
      statePath: null,
      fetch: async () => {
        calls++;
        return Response.json(payload());
      },
    });
    expect(list.enabled).toBe(false);
    await list.refresh();
    list.start()();
    list.accept(payload());
    expect(list.check({ input: HASH })).toBeNull();
    expect(calls).toBe(0);
  });

  test("a persist failure warns but still installs the list", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "takedown-"));
    tmpDirs.push(dir);
    const blocker = path.join(dir, "file");
    fs.writeFileSync(blocker, "");
    const { list, warnings } = listWith(async () => Response.json(payload()), `${blocker}/x.json`);
    await list.refresh();
    expect(list.version).toBe("v1");
    expect(warnings[0]).toContain("could not persist");
  });
});

describe("TakedownList persistence and polling", () => {
  test("a new process loads the last good copy before its first fetch lands", async () => {
    const statePath = tmpState();
    const first = listWith(async () => Response.json(payload()), statePath).list;
    await first.refresh();

    // DMM is down for the restarted process: it must still refuse.
    const { list, warnings } = listWith(async () => {
      throw new Error("down");
    }, statePath);
    const stop = list.start(60_000);
    expect(list.version).toBe("v1");
    expect(list.check({ input: HASH })).not.toBeNull();
    await Bun.sleep(1);
    stop();
    expect(warnings[0]).toContain("keeping version v1");
  });

  test("a missing, malformed or unreadable state file is tolerated", () => {
    const statePath = tmpState();
    const { list, warnings } = listWith(async () => Response.json(payload()), statePath);
    list.loadPersisted();
    expect(list.version).toBeNull();

    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify({ version: 3 }));
    list.loadPersisted();
    fs.writeFileSync(statePath, "{not json");
    list.loadPersisted();
    expect(list.version).toBeNull();
    expect(warnings[0]).toContain("ignoring malformed");
    expect(warnings[1]).toContain("could not read");

    listWith(async () => Response.json(payload()), null).list.loadPersisted();
  });

  test("polls on the interval", async () => {
    let calls = 0;
    const { list } = listWith(async () => {
      calls++;
      return Response.json(payload());
    });
    const stop = list.start(5);
    await Bun.sleep(30);
    stop();
    expect(calls).toBeGreaterThan(1);
    expect(BLOCKLIST_POLL_MS).toBe(600_000);
  });

  test("the default fetch and warn reach the globals", async () => {
    const originalFetch = globalThis.fetch;
    const originalWarn = console.warn;
    const logged: string[] = [];
    globalThis.fetch = (async () => new Response(null, { status: 503 })) as unknown as typeof fetch;
    console.warn = (m: string) => logged.push(m);
    try {
      await new TakedownList({ url: "https://dmm.test/x", statePath: null }).refresh();
    } finally {
      globalThis.fetch = originalFetch;
      console.warn = originalWarn;
    }
    expect(logged[0]).toContain("HTTP 503");
  });
});

describe("process-wide list", () => {
  afterEach(() => {
    takedown.accept({ version: "empty", hashes: [], releases: [] });
  });

  test("points at DMM by default and keeps nothing on disk under test", () => {
    expect(DEFAULT_BLOCKLIST_URL).toBe("https://debridmediamanager.com/api/takedown/blocklist");
    expect(takedown.enabled).toBe(true);
  });

  test("assertNotTakenDown throws the terminal error for a listed job", () => {
    takedown.accept(payload());
    expect(() => assertNotTakenDown({ input: HASH })).toThrow(TakedownBlockedError);
    expect(() => assertNotTakenDown({ input: "f".repeat(40) })).not.toThrow();
  });
});
