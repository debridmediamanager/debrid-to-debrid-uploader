import fs from "node:fs";
import path from "node:path";
import { config } from "./config";
import type { MdbInfo } from "./mdblist";
import { runCommand } from "./utils/command";
import { isVideoFile } from "./utils/files";

/** Characters unsafe in a filename, a URL path, or a torrent name. */
const UNSAFE = /[/\\?%*:|"<>#]/g;

/**
 * RD's webseed fetcher sends a `#` in a path unescaped, so the rest of the path
 * becomes a URL fragment and every request 404s (`/webseed/<job>/Earth&`).
 * Replicated 2026-11-03, fixtures/realdebrid/rd-webseed-hash-fragment-2026-11-03.json.
 */
export function dropHash(name: string): string {
  return name.replaceAll("#", "");
}

const ENTITY = /&(?:#(\d{1,5})|#x([\da-f]{1,5})|(amp|quot|apos|lt|gt));/gi;
const NAMED: Record<string, string> = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">" };

/** TorBox names some releases HTML-escaped (`Earth&#039;s`); undo it before naming. */
export function decodeEntities(name: string): string {
  return name.replace(ENTITY, (_, dec, hex, named) =>
    named ? NAMED[named.toLowerCase()] : String.fromCodePoint(dec ? +dec : parseInt(hex, 16)),
  );
}

/**
 * Characters outside the Basic Multilingual Plane (emoji, math letters): RD
 * answers `selectFiles` 204 for a file whose path holds one, then leaves it
 * unselected and the torrent at `waiting_files_selection` for good. Measured
 * 2026-10-27, fixtures/realdebrid/rd-select-astral-2026-10-27.json.
 */
const ASTRAL = /\s*[\u{10000}-\u{10FFFF}]+/gu;

export function dropAstral(name: string): string {
  return name.replace(ASTRAL, "");
}

export function sanitize(name: string): string {
  return name.replace(UNSAFE, "").replace(/\s+/g, " ").trim();
}

/** Markers where a scene release name stops being the title. */
const QUALITY_MARKER =
  /\b(2160p|1080p|720p|480p|bluray|blu-ray|remux|web[- ]?dl|webrip|web|hdrip|bdrip|dvdrip|hdtv|x264|x265|h ?264|h ?265|hevc|xvid|proper|repack|extended|unrated|directors?)\b/i;

/**
 * Best-effort title from a scene release name, e.g.
 * `Saw.IV.2007.Directors.Cut.1080p.BluRay.x264-LCD` -> `Saw IV` + year 2007.
 * Returns null when nothing title-like can be recovered.
 */
export function parseRelease(release: string): { title: string; year?: string } | null {
  const s = release
    .replace(/\.(nzb|mkv|mp4|avi|mov|ts)$/i, "")
    .replace(/[._]+/g, " ")
    .trim();

  const yearMatch = /\b(19\d{2}|20\d{2})\b/.exec(s);
  if (yearMatch && yearMatch.index > 0) {
    const title = s.slice(0, yearMatch.index).trim();
    if (title) return { title, year: yearMatch[1] };
  }

  const cut = s.search(QUALITY_MARKER);
  const title = (cut === -1 ? s : s.slice(0, cut)).trim();
  return title ? { title } : null;
}

/** A trailing container extension to drop from a release name. */
const RELEASE_EXT = /\.(nzb|torrent|mkv|mp4|avi|mov|ts|m4v|wmv|mpg|mpeg)$/i;

/**
 * Linux caps one path component at 255 **bytes**, not characters — `NAME_MAX`.
 *
 * The distinction is the bug: a Cyrillic release name is two bytes per letter,
 * so names well under 255 characters still blew past the limit and `open` threw
 * `ENAMETOOLONG` when the rewritten `.torrent` was written. That killed the job
 * outright — and it fired *after* the provider resource was claimed, so early
 * cases leaked a TorBox slot with it.
 */
const NAME_MAX_BYTES = 255;

/** Room kept for the extension appended before a clean name becomes a filename. */
const SUFFIX_BYTES = ".torrent".length;

function byteLength(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

/**
 * Cut `s` to at most `max` bytes of UTF-8, never mid-character.
 *
 * Slicing the encoded buffer would be shorter but can halve a multi-byte
 * codepoint and yield a filename ending in a replacement character, so this
 * accumulates whole codepoints instead (`for..of` iterates codepoints, which
 * also keeps surrogate pairs intact). A `max` below zero yields "".
 */
export function truncateBytes(s: string, max: number): string {
  if (byteLength(s) <= max) return s;
  let out = "";
  let used = 0;
  for (const ch of s) {
    const n = byteLength(ch);
    if (used + n > max) break;
    out += ch;
    used += n;
  }
  return out;
}

/**
 * Strip the filename patterns Real-Debrid rejects with `451 infringing_file`, so
 * a torrent built over these names is accepted and its files stream. Measured
 * 2026-10-14 (workspace docs/providers/real-debrid.md §8), RD refuses eleven
 * strings anywhere in a name: `WEB-DL`, `WEB.x264` and `WEB.H264` only in
 * exactly that case, and `WEBRip`, `BDRip`, `HDRip`, `DVDRip`, `HDTV.x264`,
 * `HDTV.XviD`, `BluRay.x264` and `p.BluRay.DTS` (whatever follows it) in any
 * case. Only the separator shown counts, so `WEB.DL`, `WEB-Rip`, `BluRay-x264`
 * and `WEB-x264` pass. It judges an add on the torrent's root name and an
 * unrestrict on each file's own name, which is why the root and every file path
 * go through here. RD changed the list on 2026-10-03 (five case-sensitive
 * literals), 2026-10-10 (all eleven in any case) and again by 2026-10-14.
 *
 * The rewrites over-match on purpose: the source/codec one breaks all nine
 * `(bluray|hdtv|web).(x264|xvid|h264)` pairs in any case, while RD blocks five
 * of them and the `WEB` ones in only one case, `web-dl` is broken in any case,
 * and every `BluRay.DTS` is broken, while RD blocks it only after a `p`
 * (`1080p.BluRay.DTS`; `2002.BluRay.DTS` and `1080i.BluRay.DTS` pass).
 * The extra rewrites cost only a cosmetic change, and dmm's copy
 * (src/utils/deInfringe.ts) must compute the same name, so narrow both or
 * neither.
 * Each match is broken with a separator swap that keeps the name readable and
 * forms no other blocked pattern (`WEB-DL` -> `WEB.DL`, `BluRay.x264` ->
 * `BluRay-x264`, `BDRip` -> `BD-Rip`, `BluRay.DTS` -> `BluRay-DTS`). Newer
 * codecs (x265/h265/HEVC/AV1) and service tags (NF/AMZN/DSNP/...) are never
 * blocked, so they pass untouched.
 *
 * `BluRay.DTS` is its own rule because the codec-adjacency one cannot reach it:
 * the audio tag sits between the source and the codec. Measured 2026-08-25 by
 * uploading webseed torrents built over a 262 KB text file — each a fresh
 * infohash, so only the name could decide it. RD refused `BluRay.DTS.x264`,
 * `.x265`, `.H264`, `.AC3`, `DTS-HD.MA.5.1.x264` and bare `BluRay.DTS-TEST`,
 * and refused a control release whose title had nothing to do with the film.
 * It took `BluRay.AC3.x264`, `BluRay.DD5.1.x264`, `BluRay.REMUX.AVC`,
 * `Blu-Ray.DTS.x264`, `BluRay DTS x264` and the `BluRay-DTS.x264` this emits —
 * so the trigger is `BluRay` + `.` + `DTS`, not `BluRay.` + anything. On
 * 2026-10-10 RD also accepted `2026.BluRay.DTS`, `REMUX.BluRay.DTS` and
 * `1080i.BluRay.DTS` and refused `720p.BluRay.DTS` and `Xp.BluRay.DTS`, so the
 * literal is `p.BluRay.DTS`.
 */
export function deInfringe(name: string): string {
  return name
    .replace(/(bluray|hdtv|web)\.(x264|xvid|h264)/gi, "$1-$2")
    .replace(/bluray\.dts/gi, (m) => m.replace(".", "-"))
    .replace(/web-dl/gi, (m) => m.replace("-", "."))
    .replace(/(web|bd|hd|dvd)rip/gi, (m) => m.replace(/rip$/i, (r) => `-${r}`));
}

/**
 * Exactly the eleven strings RD refuses (see `deInfringe`), without its
 * over-matching: this one decides whether to send an add at all, so a false
 * positive costs a source that would have worked. Same rule as dmm's
 * `isRdBlockedName` (src/utils/deInfringe.ts) and zurg's `NameIsRDBlocked`.
 */
const RD_BLOCKED_EXACT_CASE = /WEB-DL|WEB\.(?:x264|H264)/;
const RD_BLOCKED_ANY_CASE = /(?:web|bd|hd|dvd)rip|bluray\.x264|p\.bluray\.dts|hdtv\.(?:x264|xvid)/i;
export function rdBlocksName(name: string): boolean {
  return RD_BLOCKED_EXACT_CASE.test(name) || RD_BLOCKED_ANY_CASE.test(name);
}

/**
 * The torrent/directory name RD sees: the release name kept as-is (scene dots
 * and all) bar the patterns RD blocks (`deInfringe`), with a real imdb id
 * appended as a `{imdb-ttX}` tag so Plex can force-match. RD flattens the torrent
 * into this one directory, and the files inside keep their own names — so the tag
 * on the directory is what identifies the title. Falls back to the bare imdb id
 * when there is no usable release name.
 */
export function buildCleanName(imdbId: string, releaseName?: string): string {
  const tag = imdbId && imdbId !== "unknown" ? ` {imdb-${imdbId}}` : "";
  const base = releaseName
    ? sanitize(dropAstral(deInfringe(decodeEntities(releaseName).replace(RELEASE_EXT, ""))))
    : "";
  if (!base) return `media-${imdbId}`;
  // The tag is what Plex force-matches on, so the *base* gives up the bytes.
  const fitted = truncateBytes(base, NAME_MAX_BYTES - SUFFIX_BYTES - byteLength(tag)).trimEnd();
  return fitted ? `${fitted}${tag}` : `media-${imdbId}`;
}

export function renameForPlex(
  filePath: string,
  imdbId: string,
  mdbInfo?: MdbInfo,
  dryRun = false,
  includeShowImdb = true,
): string {
  const ext = path.extname(filePath);
  const basename = path.basename(filePath, ext);
  const dir = path.dirname(filePath);
  const suffix = config.fileSuffix ? `-${config.fileSuffix}` : "";

  let newName: string | null = null;

  if (mdbInfo?.type === "show") {
    newName = buildShowName(basename, mdbInfo, imdbId, suffix, ext, includeShowImdb);
  }

  if (!newName) {
    newName = buildMovieName(basename, mdbInfo, imdbId, suffix, ext);
  }

  if (!newName) return filePath;

  const newPath = path.join(dir, newName);
  if (!dryRun && filePath !== newPath && fs.existsSync(filePath)) {
    fs.renameSync(filePath, newPath);
  }
  return newPath;
}

function buildShowName(
  basename: string,
  info: MdbInfo,
  imdbId: string,
  suffix: string,
  ext: string,
  includeImdb: boolean,
): string | null {
  const episode = extractEpisodeTag(basename);
  if (!episode) return null;
  const title = extractEpisodeTitle(basename);
  const titlePart = title ? ` - ${title}` : "";
  const imdbPart = includeImdb ? ` {imdb-${imdbId}}` : "";
  return `${info.title} - ${episode}${titlePart}${imdbPart}${suffix}${ext}`;
}

function buildMovieName(
  basename: string,
  info: MdbInfo | undefined,
  imdbId: string,
  suffix: string,
  ext: string,
): string | null {
  if (info) {
    return `${info.title} (${info.year}) {imdb-${imdbId}}${suffix}${ext}`;
  }
  const yearMatch = basename.match(/^(.+?)[.\s_-]+((?:19|20)\d{2})[.\s_-]/);
  if (!yearMatch) return null;
  const rawTitle = yearMatch[1].replace(/[._-]/g, " ").trim();
  const year = yearMatch[2];
  return `${rawTitle} (${year}) {imdb-${imdbId}}${suffix}${ext}`;
}

type CommandRunner = typeof runCommand;

const MKV_EXTENSIONS = new Set([".mkv", ".mka", ".mks", ".webm"]);

export async function embedOriginalName(
  filePath: string,
  originalName: string,
  runner: CommandRunner = runCommand,
): Promise<void> {
  if (!fs.existsSync(filePath)) return;
  const ext = path.extname(filePath).toLowerCase();

  if (MKV_EXTENSIONS.has(ext)) {
    await runner(["mkvpropedit", filePath, "--set", `title=${originalName}`]);
  } else {
    const tmpPath = `${filePath}.tmp${ext}`;
    await runner([
      "ffmpeg",
      "-y",
      "-i",
      filePath,
      "-c",
      "copy",
      "-metadata",
      `title=${originalName}`,
      tmpPath,
    ]);
    fs.renameSync(tmpPath, filePath);
  }
}

export function renameDirectoryForPlex(
  dirPath: string,
  imdbId: string,
  mdbInfo?: MdbInfo,
): { renames: Map<string, string>; newDirPath: string } {
  const renames = new Map<string, string>();
  const files = fs.readdirSync(dirPath);
  for (const file of files) {
    const filePath = path.join(dirPath, file);
    if (!fs.statSync(filePath).isFile() || !isVideoFile(file)) continue;
    const newPath = renameForPlex(filePath, imdbId, mdbInfo);
    if (newPath !== filePath) {
      renames.set(file, path.basename(newPath));
    }
  }

  const dirName = path.basename(dirPath);
  let newDirName: string;
  if (mdbInfo) {
    newDirName = `${mdbInfo.title} (${mdbInfo.year}) {imdb-${imdbId}}`;
  } else {
    newDirName = `media-${imdbId}`;
  }

  let newDirPath = dirPath;
  if (newDirName !== dirName) {
    newDirPath = path.join(path.dirname(dirPath), newDirName);
    fs.renameSync(dirPath, newDirPath);
  }

  return { renames, newDirPath };
}

export function extractEpisodeTag(filename: string): string | null {
  const match = filename.match(/[Ss](\d{1,2})[Ee](\d{1,3})(?:-?[Ee](\d{1,3}))?/);
  if (!match) return null;
  const season = match[1].padStart(2, "0");
  const epStart = match[2].padStart(2, "0");
  if (match[3]) {
    const epEnd = match[3].padStart(2, "0");
    return `S${season}E${epStart}-E${epEnd}`;
  }
  return `S${season}E${epStart}`;
}

function extractEpisodeTitle(filename: string): string | null {
  const match = filename.match(
    /[Ss]\d{1,2}[Ee]\d{1,3}(?:-?[Ee]\d{1,3})?[.\s_-]+([A-Z][A-Za-z0-9]+(?:[.\s_-][A-Z][A-Za-z0-9]+)*)/,
  );
  if (!match) return null;
  return match[1].replace(/[._-]/g, " ").trim();
}
