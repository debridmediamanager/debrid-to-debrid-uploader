import { describe, expect, test } from "bun:test";
import { config, parseCacheSources, parseUnlimitedOwners } from "./config";

describe("parseUnlimitedOwners", () => {
  test("exempts nobody by default", () => {
    expect(parseUnlimitedOwners(undefined)).toEqual(new Set());
    expect(parseUnlimitedOwners("")).toEqual(new Set());
    expect(config.unlimitedOwners.size).toBe(0);
  });

  test("reads a list of owner ids across providers", () => {
    expect(parseUnlimitedOwners("rd:100001,tb:200002,ad:someuser")).toEqual(
      new Set(["rd:100001", "tb:200002", "ad:someuser"]),
    );
  });

  test("tolerates whitespace and trailing separators", () => {
    // A hand-edited .env picks these up constantly, and an empty entry would
    // otherwise match the `""` sentinel for "this job brought no key".
    expect(parseUnlimitedOwners(" rd:100001 , , tb:200002,")).toEqual(
      new Set(["rd:100001", "tb:200002"]),
    );
  });

  test("keeps an unrecognised entry rather than refusing to boot", () => {
    // It exempts nobody, which is the harmless outcome. Validating here would
    // turn a typo in the operator's env into a service that will not start.
    expect(parseUnlimitedOwners("nonsense")).toEqual(new Set(["nonsense"]));
  });
});

describe("parseCacheSources", () => {
  test("defaults to TorBox before AllDebrid", () => {
    // Order matters and is not alphabetical: TorBox's cache probe is free and
    // read-only, while AllDebrid's only way to answer is to add the magnet.
    expect(parseCacheSources(undefined)).toEqual(["torbox", "alldebrid"]);
    expect(config.cacheSources).toEqual(["torbox", "alldebrid"]);
  });

  test("honours an explicit order", () => {
    expect(parseCacheSources("alldebrid,torbox")).toEqual(["alldebrid", "torbox"]);
  });

  test("allows narrowing to a single source", () => {
    expect(parseCacheSources("alldebrid")).toEqual(["alldebrid"]);
  });

  test("tolerates whitespace and drops unknown names", () => {
    expect(parseCacheSources(" alldebrid , premiumize ,torbox ")).toEqual(["alldebrid", "torbox"]);
  });

  test("falls back to the default rather than disabling every cached source", () => {
    // An all-garbage value is far more likely a typo than a deliberate request
    // to send every job down the slow qBittorrent path.
    expect(parseCacheSources("nonsense")).toEqual(["torbox", "alldebrid"]);
    expect(parseCacheSources("")).toEqual(["torbox", "alldebrid"]);
  });

  test("keeps a chunk size for each metered source", () => {
    expect(config.torboxChunkSize).toBe(8 * 1024 * 1024);
    expect(config.alldebridChunkSize).toBe(8 * 1024 * 1024);
  });
});
