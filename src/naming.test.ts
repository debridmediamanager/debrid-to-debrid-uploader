import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import probe from "./fixtures/realdebrid/rd-name-filter-2026-10-14.json";
import type { MdbInfo } from "./mdblist";
import {
  buildCleanName,
  decodeEntities,
  deInfringe,
  embedOriginalName,
  extractEpisodeTag,
  parseRelease,
  rdBlocksName,
  renameDirectoryForPlex,
  renameForPlex,
  truncateBytes,
} from "./naming";

let tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "naming-test-"));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

describe("renameForPlex", () => {
  test("renames movie with mdbInfo", () => {
    const dir = tempDir();
    const filePath = path.join(dir, "Movie.2024.1080p.BluRay.mkv");
    fs.writeFileSync(filePath, "video");

    const info: MdbInfo = { title: "Test Movie", year: 2024, type: "movie" };
    const result = renameForPlex(filePath, "tt1234567", info);

    expect(path.basename(result)).toBe("Test Movie (2024) {imdb-tt1234567}.mkv");
    expect(fs.existsSync(result)).toBe(true);
  });

  test("renames movie without mdbInfo using year from filename", () => {
    const dir = tempDir();
    const filePath = path.join(dir, "Some.Movie.2023.720p.mkv");
    fs.writeFileSync(filePath, "video");

    const result = renameForPlex(filePath, "tt9999999");
    expect(path.basename(result)).toBe("Some Movie (2023) {imdb-tt9999999}.mkv");
  });

  test("returns original path when no year found and no mdbInfo", () => {
    const dir = tempDir();
    const filePath = path.join(dir, "random-file.mkv");
    fs.writeFileSync(filePath, "video");

    const result = renameForPlex(filePath, "tt0000000");
    expect(result).toBe(filePath);
  });

  test("renames show with episode tag", () => {
    const dir = tempDir();
    const filePath = path.join(dir, "Show.S01E05.Episode.Title.1080p.mkv");
    fs.writeFileSync(filePath, "video");

    const info: MdbInfo = { title: "My Show", year: 2024, type: "show" };
    const result = renameForPlex(filePath, "tt1111111", info);
    expect(path.basename(result)).toContain("My Show - S01E05");
    expect(path.basename(result)).toContain("{imdb-tt1111111}");
  });

  test("show without episode tag falls back to movie naming", () => {
    const dir = tempDir();
    const filePath = path.join(dir, "Show.2024.Special.mkv");
    fs.writeFileSync(filePath, "video");

    const info: MdbInfo = { title: "My Show", year: 2024, type: "show" };
    const result = renameForPlex(filePath, "tt2222222", info);
    expect(path.basename(result)).toBe("My Show (2024) {imdb-tt2222222}.mkv");
  });

  test("dryRun does not rename file", () => {
    const dir = tempDir();
    const filePath = path.join(dir, "Movie.2024.mkv");
    fs.writeFileSync(filePath, "video");

    const info: MdbInfo = { title: "Test", year: 2024, type: "movie" };
    const result = renameForPlex(filePath, "tt0000000", info, true);
    expect(result).not.toBe(filePath);
    expect(fs.existsSync(filePath)).toBe(true);
  });

  test("handles show without imdb tag", () => {
    const dir = tempDir();
    const filePath = path.join(dir, "Show.S02E10.Good.Episode.mkv");
    fs.writeFileSync(filePath, "video");

    const info: MdbInfo = { title: "My Show", year: 2024, type: "show" };
    const result = renameForPlex(filePath, "tt3333333", info, false, false);
    expect(path.basename(result)).not.toContain("{imdb-");
  });

  test("does not rename when path would be the same", () => {
    const dir = tempDir();
    const info: MdbInfo = { title: "Test", year: 2024, type: "movie" };
    const filePath = path.join(dir, "Test (2024) {imdb-tt0000000}.mkv");
    fs.writeFileSync(filePath, "video");

    const result = renameForPlex(filePath, "tt0000000", info);
    expect(result).toBe(filePath);
  });

  test("handles file that does not exist", () => {
    const dir = tempDir();
    const filePath = path.join(dir, "nonexistent.2024.mkv");
    const info: MdbInfo = { title: "Test", year: 2024, type: "movie" };
    const result = renameForPlex(filePath, "tt0000000", info);
    expect(result).not.toBe(filePath);
  });

  test("includes fileSuffix when configured", () => {
    const dir = tempDir();
    const filePath = path.join(dir, "Movie.2024.mkv");
    fs.writeFileSync(filePath, "video");

    const { config } = require("./config");
    const origSuffix = config.fileSuffix;
    config.fileSuffix = "srv1";

    const info: MdbInfo = { title: "Test", year: 2024, type: "movie" };
    const result = renameForPlex(filePath, "tt0000000", info);
    expect(path.basename(result)).toContain("-srv1");

    config.fileSuffix = origSuffix;
  });

  test("show with multi-episode range", () => {
    const dir = tempDir();
    const filePath = path.join(dir, "Show.S01E05-E06.mkv");
    fs.writeFileSync(filePath, "video");

    const info: MdbInfo = { title: "My Show", year: 2024, type: "show" };
    const result = renameForPlex(filePath, "tt4444444", info);
    expect(path.basename(result)).toContain("S01E05-E06");
  });
});

describe("extractEpisodeTag", () => {
  test("extracts S01E05", () => {
    expect(extractEpisodeTag("Show.S01E05.Title")).toBe("S01E05");
  });

  test("extracts multi-episode S01E05-E06", () => {
    expect(extractEpisodeTag("Show.S01E05E06.Title")).toBe("S01E05-E06");
  });

  test("returns null for non-episode filename", () => {
    expect(extractEpisodeTag("Movie.2024.1080p")).toBeNull();
  });
});

describe("embedOriginalName", () => {
  test("uses mkvpropedit for mkv files", async () => {
    const dir = tempDir();
    const filePath = path.join(dir, "Movie (2024) {imdb-tt1234567}.mkv");
    fs.writeFileSync(filePath, "video");

    const calls: string[][] = [];
    const mockRunner = async (cmd: string[]) => {
      calls.push(cmd);
    };

    await embedOriginalName(filePath, "Movie.2024.1080p.BluRay", mockRunner as never);

    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe("mkvpropedit");
    expect(calls[0]).toContain("title=Movie.2024.1080p.BluRay");
  });

  test("uses ffmpeg for mp4 files", async () => {
    const dir = tempDir();
    const filePath = path.join(dir, "Movie (2024) {imdb-tt1234567}.mp4");
    fs.writeFileSync(filePath, "video");

    const calls: string[][] = [];
    const mockRunner = async (cmd: string[]) => {
      calls.push(cmd);
      if (cmd[0] === "ffmpeg") {
        fs.writeFileSync(cmd[cmd.length - 1], "remuxed");
      }
    };

    await embedOriginalName(filePath, "Movie.2024.1080p.WEB-DL", mockRunner as never);

    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe("ffmpeg");
    expect(calls[0]).toContain("title=Movie.2024.1080p.WEB-DL");
    expect(fs.existsSync(filePath)).toBe(true);
  });

  test("skips when file does not exist", async () => {
    const calls: string[][] = [];
    const mockRunner = async (cmd: string[]) => {
      calls.push(cmd);
    };

    await embedOriginalName("/nonexistent/file.mkv", "original", mockRunner as never);

    expect(calls).toHaveLength(0);
  });

  test("uses mkvpropedit for webm files", async () => {
    const dir = tempDir();
    const filePath = path.join(dir, "video.webm");
    fs.writeFileSync(filePath, "video");

    const calls: string[][] = [];
    const mockRunner = async (cmd: string[]) => {
      calls.push(cmd);
    };

    await embedOriginalName(filePath, "original.name", mockRunner as never);

    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe("mkvpropedit");
  });
});

describe("renameDirectoryForPlex", () => {
  test("renames video files and directory", () => {
    const dir = tempDir();
    const torrentDir = path.join(dir, "Some.Show.S01.1080p");
    fs.mkdirSync(torrentDir);
    fs.writeFileSync(path.join(torrentDir, "Some.Show.S01E01.Episode.One.mkv"), "video");
    fs.writeFileSync(path.join(torrentDir, "Some.Show.S01E02.Episode.Two.mkv"), "video");
    fs.writeFileSync(path.join(torrentDir, "readme.txt"), "text");

    const info: MdbInfo = { title: "Some Show", year: 2024, type: "show" };
    const result = renameDirectoryForPlex(torrentDir, "tt5555555", info);

    expect(path.basename(result.newDirPath)).toBe("Some Show (2024) {imdb-tt5555555}");
    expect(fs.existsSync(result.newDirPath)).toBe(true);
    expect(result.renames.size).toBeGreaterThan(0);
  });

  test("uses media-imdbId when no mdbInfo", () => {
    const dir = tempDir();
    const torrentDir = path.join(dir, "random-dir");
    fs.mkdirSync(torrentDir);
    fs.writeFileSync(path.join(torrentDir, "Movie.2024.mkv"), "video");

    const result = renameDirectoryForPlex(torrentDir, "tt6666666");

    expect(path.basename(result.newDirPath)).toBe("media-tt6666666");
  });

  test("does not rename directory when name matches", () => {
    const dir = tempDir();
    const torrentDir = path.join(dir, "media-tt7777777");
    fs.mkdirSync(torrentDir);
    fs.writeFileSync(path.join(torrentDir, "file.mkv"), "video");

    const result = renameDirectoryForPlex(torrentDir, "tt7777777");

    expect(result.newDirPath).toBe(torrentDir);
  });
});

describe("parseRelease", () => {
  test("splits a scene release into title and year", () => {
    expect(parseRelease("Saw.IV.2007.Directors.Cut.1080p.BluRay.x264-LCD")).toEqual({
      title: "Saw IV",
      year: "2007",
    });
  });

  test("handles underscores and a trailing extension", () => {
    expect(parseRelease("Dead_Mans_Wire_2025_1080p_BluRay_x264-OFT")).toEqual({
      title: "Dead Mans Wire",
      year: "2025",
    });
  });

  test("cuts at the quality marker when there is no year", () => {
    expect(parseRelease("Some.Show.2160p.WEB-DL")).toEqual({ title: "Some Show" });
  });

  test("returns null when the name is all quality junk", () => {
    expect(parseRelease("2160p.x264")).toBeNull();
  });
});

describe("deInfringe", () => {
  // Every name RD refused on 2026-10-14 comes out as one it takes: the rewrite
  // must stay a superset of the rule, whatever case RD keys on this week.
  test.each(probe.add.filter(({ status }) => status === 451))(
    "rewrites $name into a name RD takes",
    ({ name }) => {
      expect(rdBlocksName(deInfringe(name))).toBe(false);
    },
  );

  test("breaks the web-dl substring", () => {
    expect(deInfringe("The.Bear.S01.1080p.DSNP.WEB-DL.DDP5.1.H.264-NTb")).toBe(
      "The.Bear.S01.1080p.DSNP.WEB.DL.DDP5.1.H.264-NTb",
    );
  });

  test("breaks a source.codec dot-adjacency and a *rip", () => {
    expect(deInfringe("Movie.2019.1080p.BluRay.x264-GRP")).toBe("Movie.2019.1080p.BluRay-x264-GRP");
    expect(deInfringe("Movie.2018.720p.BDRip.x265-GRP")).toBe("Movie.2018.720p.BD-Rip.x265-GRP");
  });

  test("breaks BluRay.DTS, which RD blocks whatever follows it", () => {
    // Measured 2026-08-25 with webseed torrents over a text file: RD refuses
    // `BluRay.DTS` on request #1 whether a codec follows it or not, so the
    // codec-adjacency rule above never sees it. RD's literal is `p.BluRay.DTS`
    // (2026-10-10, still on 2026-10-14); breaking every `BluRay.DTS` matches dmm's copy.
    expect(deInfringe("Beautiful.Creatures.2013.1080p.BluRay.DTS.x264-EbP")).toBe(
      "Beautiful.Creatures.2013.1080p.BluRay-DTS.x264-EbP",
    );
    expect(deInfringe("Movie.2019.1080p.BluRay.DTS-HD.MA.5.1.x264-GRP")).toBe(
      "Movie.2019.1080p.BluRay-DTS-HD.MA.5.1.x264-GRP",
    );
    expect(deInfringe("Movie.2019.1080p.BLURAY.DTS.AC3-GRP")).toBe(
      "Movie.2019.1080p.BLURAY-DTS.AC3-GRP",
    );
  });

  test("leaves the BluRay near-misses RD accepts untouched", () => {
    // All three were accepted by RD in the same run, so widening the rule to
    // `BluRay.` + anything would rewrite names that need no rewriting.
    expect(deInfringe("Movie.2019.1080p.BluRay.AC3.x264-GRP")).toBe(
      "Movie.2019.1080p.BluRay.AC3.x264-GRP",
    );
    expect(deInfringe("Movie.2019.1080p.BluRay.DD5.1.x264-GRP")).toBe(
      "Movie.2019.1080p.BluRay.DD5.1.x264-GRP",
    );
    expect(deInfringe("Movie.2019.1080p.Blu-Ray.DTS.x264-GRP")).toBe(
      "Movie.2019.1080p.Blu-Ray.DTS.x264-GRP",
    );
  });

  test("leaves unblocked names untouched (x265, hyphenated source)", () => {
    expect(deInfringe("Movie.2019.1080p.BluRay.x265-GRP")).toBe("Movie.2019.1080p.BluRay.x265-GRP");
    expect(deInfringe("Show.2024.1080p.Blu-Ray.x264-GRP")).toBe("Show.2024.1080p.Blu-Ray.x264-GRP");
  });
});

describe("buildCleanName", () => {
  test("keeps the release name (de-infringed) and appends the imdb tag", () => {
    expect(buildCleanName("tt0890870", "Saw.IV.2007.1080p.BluRay.x264-LCD")).toBe(
      "Saw.IV.2007.1080p.BluRay-x264-LCD {imdb-tt0890870}",
    );
  });

  test("de-infringes a season pack release name", () => {
    expect(buildCleanName("tt14452776", "The.Bear.S01.1080p.DSNP.WEB-DL.H.264-NTb")).toBe(
      "The.Bear.S01.1080p.DSNP.WEB.DL.H.264-NTb {imdb-tt14452776}",
    );
  });

  test("omits the tag when the imdb id is unknown", () => {
    expect(buildCleanName("unknown", "Some.Release.1080p.WEB-DL.x264-GRP")).toBe(
      "Some.Release.1080p.WEB.DL.x264-GRP",
    );
  });

  test("strips a trailing container extension", () => {
    expect(buildCleanName("tt1", "Movie.2024.1080p.mkv")).toBe("Movie.2024.1080p {imdb-tt1}");
  });

  test("falls back to media-imdb when there is no usable release name", () => {
    expect(buildCleanName("tt1")).toBe("media-tt1");
    expect(buildCleanName("unknown")).toBe("media-unknown");
  });

  test("keeps the name within NAME_MAX once .torrent is appended", () => {
    const name = buildCleanName("tt1", `${"A".repeat(400)}.1080p`);
    expect(Buffer.byteLength(`${name}.torrent`, "utf8")).toBeLessThanOrEqual(255);
  });

  test("counts bytes not characters, so a Cyrillic name still fits", () => {
    // The real release that failed with ENAMETOOLONG in production: comfortably
    // under 255 *characters*, well over 255 *bytes* at two per Cyrillic letter.
    const release =
      "Фриски Динго Frisky Dingo Сезон 1-2 Серии 1-25 (25) (Adam Reed, Matt Thompson Адам Рид, Мэтт Томсон) [2006-2008 черный юмор, США, сатира, DVDRemux] MVO [2x2] + Original + Sub (eng), США, 18+";
    const name = buildCleanName("tt0865409", release);
    expect(Buffer.byteLength(`${name}.torrent`, "utf8")).toBeLessThanOrEqual(255);
    expect(name).toEndWith(" {imdb-tt0865409}");
  });

  test("truncation never splits a multi-byte character", () => {
    const name = buildCleanName("tt1", "Ф".repeat(400));
    expect(name).not.toInclude("�");
    expect(name.startsWith("Ф")).toBe(true);
  });

  test("keeps the imdb tag intact when the base is what overflows", () => {
    const name = buildCleanName("tt1234567", "Б".repeat(400));
    expect(name).toEndWith(" {imdb-tt1234567}");
    expect(Buffer.byteLength(`${name}.torrent`, "utf8")).toBeLessThanOrEqual(255);
  });

  test("falls back to media-imdb when the tag alone leaves no room", () => {
    expect(buildCleanName("t".repeat(300), "Some.Release.1080p")).toBe(`media-${"t".repeat(300)}`);
  });
});

describe("truncateBytes", () => {
  test("returns the input untouched when it already fits", () => {
    expect(truncateBytes("hello", 10)).toBe("hello");
    expect(truncateBytes("hello", 5)).toBe("hello");
  });

  test("cuts to the byte budget, not the character count", () => {
    // Each Ф is two bytes, so five of them fit in a ten byte budget.
    expect(truncateBytes("Ф".repeat(20), 10)).toBe("Ф".repeat(5));
  });

  test("stops short rather than splitting a character", () => {
    // An odd budget cannot end mid-Ф, so the last one is dropped entirely.
    const out = truncateBytes("Ф".repeat(20), 9);
    expect(out).toBe("Ф".repeat(4));
    expect(Buffer.byteLength(out, "utf8")).toBe(8);
  });

  test("keeps surrogate pairs whole", () => {
    // A 4-byte emoji against a 6-byte budget: one fits, the second cannot.
    expect(truncateBytes("😀😀", 6)).toBe("😀");
  });

  test("yields an empty string when nothing fits", () => {
    expect(truncateBytes("Ф", 1)).toBe("");
    expect(truncateBytes("abc", 0)).toBe("");
    expect(truncateBytes("abc", -5)).toBe("");
  });
});

describe("decodeEntities", () => {
  test("decodes decimal, hex and the escaped HTML characters, leaves the rest", () => {
    expect(decodeEntities("Earth&#039;s &#x27;A&#X27; &amp; &QUOT;B&quot; &lt;&gt; &apos;")).toBe(
      `Earth's 'A' & "B" <> '`,
    );
    expect(decodeEntities("Q&A; &nbsp; &#1234567; R&amp")).toBe("Q&A; &nbsp; &#1234567; R&amp");
  });

  test("a decoded # still never reaches RD", () => {
    expect(buildCleanName("", "Part &#35;1")).toBe("Part 1");
  });
});
