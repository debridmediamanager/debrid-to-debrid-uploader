import { describe, expect, test } from "bun:test";
import {
  BencodeError,
  isSingleFileTorrent,
  isWellFormedTorrent,
  rewriteTorrent,
  torrentName,
} from "./torrent-rewrite";

function buildMinimalTorrent(name: string, fileName: string, fileSize: number): Buffer {
  const nameEnc = `${name.length}:${name}`;
  const fileNameEnc = `${fileName.length}:${fileName}`;
  const piecesEnc = `6:pieces20:${"A".repeat(20)}`;
  const infoDict =
    `d5:filesl` +
    `d6:lengthi${fileSize}e4:pathl${fileNameEnc}eee` +
    `4:name${nameEnc}12:piece lengthi262144e${piecesEnc}e`;
  const torrent = `d4:info${infoDict}e`;
  return Buffer.from(torrent);
}

function buildMultiFileTorrent(name: string, files: { path: string[]; size: number }[]): Buffer {
  const nameEnc = `${name.length}:${name}`;
  const piecesEnc = `6:pieces20:${"A".repeat(20)}`;
  const filesEnc = files
    .map((f) => {
      const pathEnc = f.path.map((p) => `${p.length}:${p}`).join("");
      return `d6:lengthi${f.size}e4:pathl${pathEnc}ee`;
    })
    .join("");
  const infoDict = `d5:filesl${filesEnc}e4:name${nameEnc}12:piece lengthi262144e${piecesEnc}e`;
  const torrent = `d4:info${infoDict}e`;
  return Buffer.from(torrent);
}

function buildSingleFileTorrent(name: string, fileSize: number): Buffer {
  const nameEnc = `${name.length}:${name}`;
  const piecesEnc = `6:pieces20:${"A".repeat(20)}`;
  const infoDict = `d6:lengthi${fileSize}e4:name${nameEnc}12:piece lengthi262144e${piecesEnc}e`;
  const torrent = `d4:info${infoDict}e`;
  return Buffer.from(torrent);
}

describe("rewriteTorrent", () => {
  test("renames root, keeps the file's own name (de-infringed), injects webseed", () => {
    const original = buildMinimalTorrent("Original.Name.WEB-DL", "Original.Name.WEB-DL.mkv", 1000);
    const result = rewriteTorrent(original, "clean", "http://proxy:3200");

    expect(result.infoHash).toMatch(/^[0-9a-f]{40}$/);
    expect(result.originalName).toBe("Original.Name.WEB-DL");
    expect(result.files[0].name).toBe("Original.Name.WEB.DL.mkv");
    expect(result.files[0].size).toBe(1000);
    const data = result.torrentData.toString();
    expect(data).toContain("url-list");
    expect(data).toContain("http://proxy:3200");
    // The root is renamed to "clean"; the file keeps its own name, de-infringed.
    expect(data).toContain("4:name5:clean");
    expect(data).toContain("Original.Name.WEB.DL.mkv");
    expect(data).not.toContain("WEB-DL");
  });

  test("produces different info hash from original", () => {
    const original = buildMinimalTorrent("blocked", "blocked.mkv", 5000);
    const result = rewriteTorrent(original, "safe", "http://example.com");
    const original2 = rewriteTorrent(original, "safe2", "http://example.com");

    expect(result.infoHash).not.toBe(original2.infoHash);
  });

  test("handles single-file torrent (no files list)", () => {
    const original = buildSingleFileTorrent("movie.mkv", 2000);
    const result = rewriteTorrent(original, "renamed", "http://ws:3200");

    expect(result.originalName).toBe("movie.mkv");
    expect(result.files[0].name).toBe("renamed.mkv");
    expect(result.files[0].size).toBe(2000);
    expect(result.infoHash).toMatch(/^[0-9a-f]{40}$/);
    expect(result.torrentData.toString()).toContain(`${"renamed.mkv".length}:renamed.mkv`);
  });

  test("preserves file size in metadata", () => {
    const size = 12094275574;
    const original = buildMinimalTorrent("big", "big.mkv", size);
    const result = rewriteTorrent(original, "x", "http://ws");

    expect(result.files[0].size).toBe(size);
  });

  test("returns mappings with root prefix for files-list torrent", () => {
    const original = buildMinimalTorrent("Orig", "Orig.mkv", 1000);
    const result = rewriteTorrent(original, "Clean", "http://ws");

    expect(result.mappings).toHaveLength(1);
    expect(result.mappings[0].originalPath).toBe("Orig.mkv");
    expect(result.mappings[0].rewrittenPath).toBe("Clean/Orig.mkv");
    expect(result.mappings[0].size).toBe(1000);
    expect(result.files[0].name).toBe("Orig.mkv");
  });

  test("returns mappings for single-file torrent without files list", () => {
    const original = buildSingleFileTorrent("movie.mkv", 2000);
    const result = rewriteTorrent(original, "renamed", "http://ws");

    expect(result.mappings).toHaveLength(1);
    expect(result.mappings[0].originalPath).toBe("movie.mkv");
    expect(result.mappings[0].rewrittenPath).toBe("renamed.mkv");
    expect(result.mappings[0].size).toBe(2000);
  });

  test("multi-file torrent keeps filenames and maps with root", () => {
    const original = buildMultiFileTorrent("Release.WEB-DL", [
      { path: ["video.mkv"], size: 5000 },
      { path: ["subs.srt"], size: 100 },
    ]);
    const result = rewriteTorrent(original, "Clean Name", "http://ws");

    expect(result.originalName).toBe("Release.WEB-DL");
    expect(result.files).toHaveLength(2);
    expect(result.files[0].name).toBe("video.mkv");
    expect(result.files[1].name).toBe("subs.srt");

    expect(result.mappings).toHaveLength(2);
    expect(result.mappings[0].originalPath).toBe("video.mkv");
    expect(result.mappings[0].rewrittenPath).toBe("Clean Name/video.mkv");
    expect(result.mappings[0].size).toBe(5000);
    expect(result.mappings[1].originalPath).toBe("subs.srt");
    expect(result.mappings[1].rewrittenPath).toBe("Clean Name/subs.srt");
    expect(result.mappings[1].size).toBe(100);

    const data = result.torrentData.toString();
    // The original root name is replaced; the files keep their own names.
    expect(data).not.toContain("Release.WEB-DL");
    expect(data).toContain(`${"video.mkv".length}:video.mkv`);
    expect(data).toContain(`${"subs.srt".length}:subs.srt`);
    expect(data).toContain("url-list");
    expect(data).toContain("http://ws");
  });

  test("multi-file torrent injects webseed and changes hash", () => {
    const original = buildMultiFileTorrent("Dir", [
      { path: ["a.mkv"], size: 1000 },
      { path: ["b.mkv"], size: 2000 },
    ]);
    const result = rewriteTorrent(original, "New", "http://proxy/ws");

    expect(result.torrentData.toString()).toContain("url-list");
    expect(result.torrentData.toString()).toContain("http://proxy/ws");
    expect(result.infoHash).toMatch(/^[0-9a-f]{40}$/);
  });

  test("nested path: preserves parent dirs in rewritten path", () => {
    const original = buildMultiFileTorrent("Show.WEB-DL", [
      { path: ["Season 1", "episode.WEB-DL.mkv"], size: 8000 },
      { path: ["Season 1", "subs.srt"], size: 200 },
      { path: ["Season 2", "episode.WEB-DL.mkv"], size: 9000 },
    ]);
    const result = rewriteTorrent(original, "Clean Show", "http://ws");

    expect(result.originalName).toBe("Show.WEB-DL");
    expect(result.files).toHaveLength(3);
    expect(result.files[0].name).toBe("episode.WEB.DL.mkv");
    expect(result.files[1].name).toBe("subs.srt");
    expect(result.files[2].name).toBe("episode.WEB.DL.mkv");

    // originalPath is the real source (kept); rewrittenPath is what RD sees (de-infringed).
    expect(result.mappings[0].originalPath).toBe("Season 1/episode.WEB-DL.mkv");
    expect(result.mappings[0].rewrittenPath).toBe("Clean Show/Season 1/episode.WEB.DL.mkv");
    expect(result.mappings[1].originalPath).toBe("Season 1/subs.srt");
    expect(result.mappings[1].rewrittenPath).toBe("Clean Show/Season 1/subs.srt");
    expect(result.mappings[2].originalPath).toBe("Season 2/episode.WEB-DL.mkv");
    expect(result.mappings[2].rewrittenPath).toBe("Clean Show/Season 2/episode.WEB.DL.mkv");

    const data = result.torrentData.toString();
    // The root name and the blocked WEB-DL pattern are both gone from the torrent;
    // the files keep their own names (de-infringed) and their parent directories.
    expect(data).not.toContain("WEB-DL");
    expect(data).toContain("episode.WEB.DL.mkv");
    expect(data).toContain("Season 1");
    expect(data).toContain("Season 2");
  });

  test("preserves binary piece hashes through round-trip", () => {
    const pieces = Buffer.from([
      0x00, 0x80, 0xff, 0xfe, 0xc0, 0xa8, 0x01, 0x01, 0xde, 0xad, 0xbe, 0xef, 0xca, 0xfe, 0xba,
      0xbe, 0x12, 0x34, 0x56, 0x78,
    ]);
    const name = "test";
    const nameEnc = `${name.length}:${name}`;
    const piecesEnc = `6:pieces${pieces.length}:`;
    const infoDict = `d6:lengthi5000e4:name${nameEnc}12:piece lengthi262144e${piecesEnc}`;
    const torrent = Buffer.concat([Buffer.from(`d4:info${infoDict}`), pieces, Buffer.from("ee")]);
    const result = rewriteTorrent(torrent, "clean", "http://ws");

    const output = result.torrentData;
    const piecesMarker = Buffer.from("6:pieces20:");
    const idx = output.indexOf(piecesMarker);
    expect(idx).toBeGreaterThan(-1);
    const extracted = output.subarray(idx + piecesMarker.length, idx + piecesMarker.length + 20);
    expect(Buffer.compare(extracted, pieces)).toBe(0);
  });

  test("salt produces unique info hash for same input", () => {
    const original = buildMinimalTorrent("Name", "Name.mkv", 1000);
    const a = rewriteTorrent(original, "clean", "http://ws", "job-aaa");
    const b = rewriteTorrent(original, "clean", "http://ws", "job-bbb");
    const noSalt = rewriteTorrent(original, "clean", "http://ws");

    expect(a.infoHash).not.toBe(b.infoHash);
    expect(a.infoHash).not.toBe(noSalt.infoHash);
    expect(a.torrentData.toString()).toContain("x-salt");
    expect(noSalt.torrentData.toString()).not.toContain("x-salt");
  });

  test("duplicate basenames in different dirs are each rewritten independently", () => {
    const original = buildMultiFileTorrent("Torrent", [
      { path: ["dir-a", "file.mkv"], size: 1000 },
      { path: ["dir-b", "file.mkv"], size: 2000 },
    ]);
    const result = rewriteTorrent(original, "Clean", "http://ws");

    expect(result.files[0].name).toBe("file.mkv");
    expect(result.files[1].name).toBe("file.mkv");

    expect(result.mappings[0].originalPath).toBe("dir-a/file.mkv");
    expect(result.mappings[0].rewrittenPath).toBe("Clean/dir-a/file.mkv");
    expect(result.mappings[1].originalPath).toBe("dir-b/file.mkv");
    expect(result.mappings[1].rewrittenPath).toBe("Clean/dir-b/file.mkv");

    const data = result.torrentData.toString();
    // File names are kept (each disambiguated by its own parent dir).
    expect(data).toContain(`${"file.mkv".length}:file.mkv`);
    expect(data).toContain("dir-a");
    expect(data).toContain("dir-b");
  });
});

describe("isSingleFileTorrent", () => {
  function bencode(v: unknown): Buffer {
    if (typeof v === "number") return Buffer.from(`i${v}e`);
    if (typeof v === "string") return Buffer.from(`${Buffer.byteLength(v)}:${v}`);
    if (Array.isArray(v))
      return Buffer.concat([Buffer.from("l"), ...v.map(bencode), Buffer.from("e")]);
    const d = v as Record<string, unknown>;
    return Buffer.concat([
      Buffer.from("d"),
      ...Object.keys(d)
        .sort()
        .flatMap((k) => [bencode(k), bencode(d[k])]),
      Buffer.from("e"),
    ]);
  }

  test("true when the torrent has no info.files", () => {
    const t = bencode({
      info: { name: "movie.mkv", length: 100, "piece length": 16384, pieces: "" },
    });
    expect(isSingleFileTorrent(t)).toBe(true);
  });

  test("false for a multi-file torrent", () => {
    const t = bencode({
      info: {
        name: "Release",
        files: [{ length: 100, path: ["a.mkv"] }],
        "piece length": 16384,
        pieces: "",
      },
    });
    // Even a single *entry* is multi-file: BEP19 still composes name/path, which
    // an opaque CDN link cannot satisfy.
    expect(isSingleFileTorrent(t)).toBe(false);
  });
});

describe("malformed and truncated input", () => {
  // Regression guard for a whole-service outage. Every case here used to spin
  // the one JS thread forever instead of throwing: the container loops tested
  // `buf[pos] !== 0x65`, and past the end `buf[pos]` is `undefined`, which is
  // never 0x65. If any of these ever hangs the suite rather than failing it,
  // that is the bug coming back.
  const cases: Array<[string, string]> = [
    ["empty input", ""],
    ["unterminated dictionary", "d4:name5:hello"],
    ["unterminated list", "l4:item"],
    ["unterminated integer", "i123"],
    ["integer with no digits", "ie"],
    ["string with no length delimiter", "4abc"],
    ["non-numeric string length", "x:abc"],
    ["negative string length", "-1:a"],
    ["string longer than the buffer", "10:abc"],
  ];

  for (const [label, raw] of cases) {
    test(`rejects ${label} instead of looping`, () => {
      expect(isWellFormedTorrent(Buffer.from(raw))).toBe(false);
    });
  }

  test("accepts a complete torrent", () => {
    expect(isWellFormedTorrent(buildMinimalTorrent("Show", "ep.mkv", 100))).toBe(true);
  });

  test("rewriteTorrent throws BencodeError on a truncated torrent", () => {
    // The real shape that took debrid02 down: a `pieces` string whose declared
    // length runs past the end of the file, as served by a cache that cut the
    // response short.
    const truncated = Buffer.from("d4:infod4:name4:Show12:piece lengthi262144e6:pieces9999:AAAAe");
    expect(() => rewriteTorrent(truncated, "New", "http://x/")).toThrow(BencodeError);
    expect(() => rewriteTorrent(truncated, "New", "http://x/")).toThrow(/wants 9999 bytes/);
  });
});

describe("torrentName", () => {
  test("reads the root name of single- and multi-file torrents", () => {
    expect(torrentName(buildSingleFileTorrent("Movie.2020.WEB-DL.mkv", 100))).toBe(
      "Movie.2020.WEB-DL.mkv",
    );
    expect(torrentName(buildMinimalTorrent("Pack.S01.WEBRip", "e01.mkv", 100))).toBe(
      "Pack.S01.WEBRip",
    );
  });
});
