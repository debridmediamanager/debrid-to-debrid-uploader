import { describe, expect, test } from "bun:test";
import {
  DEFAULT_PAGE_LIMIT,
  extractInfoHash,
  MAX_PAGE_LIMIT,
  parseDestination,
  parseJobInput,
  parsePageParams,
  parseTorboxApiKey,
  ValidationError,
} from "./job-input";

describe("parseJobInput", () => {
  test("normalizes raw info hashes into magnet URIs", () => {
    const parsed = parseJobInput({
      input: "ABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCD",
      imdb_id: "tt1234567",
      rd_api_key: "RD",
      tb_api_key: "TB",
    });

    expect(parsed).toEqual({
      input: "magnet:?xt=urn:btih:abcdefabcdefabcdefabcdefabcdefabcdefabcd",
      imdbId: "tt1234567",
      rdApiKey: "RD",
      torboxApiKey: "TB",
      alldebridApiKey: undefined,
      destination: "rd",
    });
  });

  test("accepts magnet inputs and preserves trackers", () => {
    const magnet = "magnet:?xt=urn:btih:abc&tr=udp%3A%2F%2Ftracker.example.com";
    expect(
      parseJobInput({ input: magnet, imdb_id: "tt7654321", rd_api_key: "RD", ad_api_key: "AD" }),
    ).toEqual({
      input: magnet,
      imdbId: "tt7654321",
      rdApiKey: "RD",
      torboxApiKey: undefined,
      alldebridApiKey: "AD",
      destination: "rd",
    });
  });

  test("extracts hash from URL with embedded hash", () => {
    const parsed = parseJobInput({
      input: "https://example.com/torrent/aabbccdd00112233445566778899aabbccddeeff/details",
      imdb_id: "tt1234567",
      rd_api_key: "RD",
      tb_api_key: "TB",
    });
    expect(parsed.input).toBe("magnet:?xt=urn:btih:aabbccdd00112233445566778899aabbccddeeff");
  });

  test("rejects URL with no hash", () => {
    expect(() =>
      parseJobInput({
        input: "https://example.com/file.mkv",
        imdb_id: "tt1111111",
        rd_api_key: "RD",
        tb_api_key: "TB",
      }),
    ).toThrow(new ValidationError("input must contain a 40-char info hash or magnet URI"));
  });

  test("rejects missing input", () => {
    expect(() => parseJobInput({ imdb_id: "tt1234567" })).toThrow(
      new ValidationError("input is required"),
    );
  });

  test("rejects invalid imdb IDs", () => {
    expect(() => parseJobInput({ input: "magnet:?xt=urn:btih:abc", imdb_id: "123" })).toThrow(
      new ValidationError("imdb_id is required (format: tt1234567)"),
    );
  });

  test("rejects plain text without a hash", () => {
    expect(() =>
      parseJobInput({
        input: "not a magnet",
        imdb_id: "tt1234567",
        rd_api_key: "RD",
        tb_api_key: "TB",
      }),
    ).toThrow(new ValidationError("input must contain a 40-char info hash or magnet URI"));
  });

  test("carries a TorBox key through a magnet input", () => {
    const parsed = parseJobInput({
      input: "magnet:?xt=urn:btih:abc",
      imdb_id: "tt1234567",
      rd_api_key: "RD",
      tb_api_key: "KEY",
    });
    expect(parsed.torboxApiKey).toBe("KEY");
  });

  test("carries a TorBox key through a raw hash input", () => {
    const parsed = parseJobInput({
      input: "ABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCD",
      imdb_id: "tt1234567",
      rd_api_key: "RD",
      tb_api_key: "KEY",
    });
    expect(parsed.input).toBe("magnet:?xt=urn:btih:abcdefabcdefabcdefabcdefabcdefabcdefabcd");
    expect(parsed.torboxApiKey).toBe("KEY");
  });

  test("refuses a job with no Real-Debrid key", () => {
    // Real-Debrid is the destination. Without a key the content lands in
    // whoever's account the operator configured, which is a silent
    // data-placement error rather than a failure anyone would notice.
    expect(() =>
      parseJobInput({ input: "magnet:?xt=urn:btih:abc", imdb_id: "tt1234567", tb_api_key: "TB" }),
    ).toThrow(new ValidationError("rd_api_key is required"));
  });

  test("refuses a job with no cache-source key", () => {
    expect(() =>
      parseJobInput({ input: "magnet:?xt=urn:btih:abc", imdb_id: "tt1234567", rd_api_key: "RD" }),
    ).toThrow(new ValidationError("tb_api_key or ad_api_key is required"));
  });

  test("accepts either cache source on its own", () => {
    const base = { input: "magnet:?xt=urn:btih:abc", imdb_id: "tt1234567", rd_api_key: "RD" };
    expect(parseJobInput({ ...base, tb_api_key: "TB" }).torboxApiKey).toBe("TB");
    expect(parseJobInput({ ...base, ad_api_key: "AD" }).alldebridApiKey).toBe("AD");
  });

  test("a blank key does not satisfy the requirement", () => {
    // Whitespace trims to undefined, so this must be refused rather than
    // stored as a key that authenticates as nobody.
    expect(() =>
      parseJobInput({
        input: "magnet:?xt=urn:btih:abc",
        imdb_id: "tt1234567",
        rd_api_key: "  ",
        tb_api_key: "TB",
      }),
    ).toThrow(new ValidationError("rd_api_key is required"));
  });

  test("treats a blank TorBox key as absent", () => {
    const parsed = parseJobInput({
      input: "magnet:?xt=urn:btih:abc",
      imdb_id: "tt1234567",
      rd_api_key: "RD",
      tb_api_key: "  ",
      ad_api_key: "AD",
    });
    expect(parsed.torboxApiKey).toBeUndefined();
  });
});

describe("parseTorboxApiKey", () => {
  test("returns undefined when no key is supplied", () => {
    expect(parseTorboxApiKey({})).toBeUndefined();
  });

  test("trims the supplied key", () => {
    expect(parseTorboxApiKey({ tb_api_key: " KEY " })).toBe("KEY");
  });
});

describe("extractInfoHash", () => {
  test("extracts hash from btih in magnet URI", () => {
    expect(
      extractInfoHash("magnet:?xt=urn:btih:AABBCCDD00112233445566778899AABBCCDDEEFF&tr=x"),
    ).toBe("aabbccdd00112233445566778899aabbccddeeff");
  });

  test("extracts hash from raw 40-char hex string", () => {
    expect(extractInfoHash("aabbccdd00112233445566778899aabbccddeeff")).toBe(
      "aabbccdd00112233445566778899aabbccddeeff",
    );
  });

  test("extracts hash embedded in a URL", () => {
    expect(
      extractInfoHash("https://example.com/torrent/AABBCCDD00112233445566778899AABBCCDDEEFF"),
    ).toBe("aabbccdd00112233445566778899aabbccddeeff");
  });

  test("returns null when no 40-char hex is present", () => {
    expect(extractInfoHash("no hash here")).toBeNull();
    expect(extractInfoHash("abcdef1234")).toBeNull();
  });
});

describe("destinations", () => {
  const BASE = { input: "a".repeat(40), imdb_id: "tt1234567" };

  test("defaults to Real-Debrid when unspecified", () => {
    expect(parseDestination(undefined)).toBe("rd");
    expect(parseDestination("")).toBe("rd");
  });

  test("accepts both spellings of each destination", () => {
    expect(parseDestination("rd")).toBe("rd");
    expect(parseDestination("realdebrid")).toBe("rd");
    expect(parseDestination("torbox")).toBe("torbox");
    expect(parseDestination(" TB ")).toBe("torbox");
    expect(parseDestination("premiumize")).toBe("premiumize");
    expect(parseDestination(" PM ")).toBe("premiumize");
  });

  test("refuses AllDebrid as a destination, naming why", () => {
    // AD ignores BEP19 webseeds outright — measured against a control where it
    // took the same file over BitTorrent from the host whose webseed it never
    // requested. A job pointed at it could only sit at zero until the stall
    // detector killed it, so the door is the cheapest place to say no.
    expect(() => parseDestination("alldebrid")).toThrow(ValidationError);
    expect(() => parseDestination("ad")).toThrow("ignores webseeds");
  });

  test("refuses an unknown destination", () => {
    expect(() => parseDestination("dropbox")).toThrow("unknown destination: dropbox");
  });

  test("a TorBox destination needs its own key plus a source key", () => {
    expect(() => parseJobInput({ ...BASE, destination: "torbox", rd_api_key: "RD" })).toThrow(
      "tb_api_key is required for destination=torbox",
    );

    expect(() => parseJobInput({ ...BASE, destination: "torbox", tb_api_key: "TB" })).toThrow(
      "rd_api_key or ad_api_key is required for destination=torbox",
    );
  });

  test("a TorBox destination may source from RD alone", () => {
    const parsed = parseJobInput({
      ...BASE,
      destination: "torbox",
      tb_api_key: "TB",
      rd_api_key: "RD",
    });
    expect(parsed.destination).toBe("torbox");
    expect(parsed.torboxApiKey).toBe("TB");
    expect(parsed.rdApiKey).toBe("RD");
  });

  test("a TorBox destination may source from AllDebrid with no RD key at all", () => {
    // The case that breaks an RD-keyed per-user limit, hence
    // `getActiveJobsForDestinationOwner`.
    const parsed = parseJobInput({
      ...BASE,
      destination: "torbox",
      tb_api_key: "TB",
      ad_api_key: "AD",
    });
    expect(parsed.rdApiKey).toBeUndefined();
    expect(parsed.alldebridApiKey).toBe("AD");
  });

  test("a Premiumize destination needs its own key plus any one source key", () => {
    expect(() => parseJobInput({ ...BASE, destination: "premiumize", rd_api_key: "RD" })).toThrow(
      "pm_api_key is required for destination=premiumize",
    );

    expect(() => parseJobInput({ ...BASE, destination: "premiumize", pm_api_key: "PM" })).toThrow(
      "rd_api_key, tb_api_key or ad_api_key is required for destination=premiumize",
    );
  });

  test.each([["rd_api_key"], ["tb_api_key"], ["ad_api_key"]])(
    "a Premiumize destination accepts %s alone as its source",
    (sourceKey) => {
      // Three sources rather than two, because Premiumize is the only
      // destination that is not also a cache source here — nothing has to be
      // held back to stop a job sourcing from its own destination account.
      const parsed = parseJobInput({
        ...BASE,
        destination: "premiumize",
        pm_api_key: "PM",
        [sourceKey]: "SRC",
      });
      expect(parsed.destination).toBe("premiumize");
      expect(parsed.premiumizeApiKey).toBe("PM");
    },
  );

  test("the RD destination still demands an RD key and a cache source", () => {
    expect(() => parseJobInput({ ...BASE, tb_api_key: "TB" })).toThrow("rd_api_key is required");
    expect(() => parseJobInput({ ...BASE, rd_api_key: "RD" })).toThrow(
      "tb_api_key or ad_api_key is required",
    );
  });
});

describe("parsePageParams", () => {
  test("defaults when the caller names no bound", () => {
    expect(parsePageParams(undefined, undefined)).toEqual({
      limit: DEFAULT_PAGE_LIMIT,
      offset: 0,
    });
  });

  test("falls back rather than throwing on junk", () => {
    // The caller is a polling UI: a 400 here turns a mistyped query into a
    // broken Transfers page, while a default keeps it working.
    expect(parsePageParams("abc", "abc")).toEqual({ limit: DEFAULT_PAGE_LIMIT, offset: 0 });
    expect(parsePageParams("", "")).toEqual({ limit: DEFAULT_PAGE_LIMIT, offset: 0 });
    expect(parsePageParams("Infinity", "-Infinity")).toEqual({
      limit: DEFAULT_PAGE_LIMIT,
      offset: 0,
    });
  });

  test("caps the limit, which is the whole point of the ceiling", () => {
    // Without this, `?limit=999999` re-opens the unbounded listing that scoping
    // the query was meant to close.
    expect(parsePageParams("999999", undefined).limit).toBe(MAX_PAGE_LIMIT);
  });

  test("clamps a nonsensical low end instead of returning an empty page", () => {
    expect(parsePageParams("0", "-5")).toEqual({ limit: 1, offset: 0 });
  });

  test("truncates a fractional page", () => {
    expect(parsePageParams("10.9", "5.9")).toEqual({ limit: 10, offset: 5 });
  });

  test("passes a sane page through untouched", () => {
    expect(parsePageParams("25", "50")).toEqual({ limit: 25, offset: 50 });
  });
});
