import { deInfringe, dropAstral, dropHash } from "./naming";
import { computeInfoHash } from "./utils/torrent-info-hash";

export type FileMapping = {
  originalPath: string;
  rewrittenPath: string;
  size: number;
};

export type RewriteResult = {
  torrentData: Buffer;
  infoHash: string;
  originalName: string;
  files: { name: string; size: number }[];
  mappings: FileMapping[];
};

/**
 * True when the torrent carries a single file at its root (no `info.files`).
 *
 * This is exactly the case BEP19 lets a `url-list` entry be a direct file URL
 * for. A multi-file torrent — even one holding a single entry — makes the
 * client compose `<url-list><info.name>/<path>` instead, which no opaque CDN
 * link can satisfy.
 */
export function isSingleFileTorrent(originalTorrent: Buffer): boolean {
  const dict = decodeBencode(originalTorrent, 0).value as BDict;
  return !(dict.info as BDict).files;
}

/** The torrent's root name (`info.name`), the one name RD judges an add on. */
export function torrentName(torrent: Buffer): string {
  const dict = decodeBencode(torrent, 0).value as BDict;
  return ((dict.info as BDict).name as Buffer).toString();
}

export function rewriteTorrent(
  originalTorrent: Buffer,
  newName: string,
  webseedUrl: string,
  salt?: string,
): RewriteResult {
  const parsed = decodeBencode(originalTorrent, 0);
  const dict = parsed.value as BDict;
  const info = dict.info as BDict;

  const originalName = (info.name as Buffer).toString();
  const mappings: FileMapping[] = [];
  const outFiles: { name: string; size: number }[] = [];

  info.name = newName;

  if (info.files) {
    const fileList = info.files as BDict[];
    for (const entry of fileList) {
      const pathList = (entry.path as Buffer[]).map((b) => b.toString());
      const origFullPath = pathList.join("/");
      // Keep each file's own name and relative path, only stripping the patterns
      // RD blocks. The torrent RD sees carries the de-infringed path; the proxy
      // still fetches the real source by `originalPath`, so only the label RD
      // reads changes. Only info.name (the root) is otherwise renamed.
      const safePathList = pathList.map((p) => dropHash(dropAstral(deInfringe(p))));
      const safeFullPath = safePathList.join("/");
      entry.path = safePathList;
      const size = entry.length as number;
      outFiles.push({ name: safePathList[safePathList.length - 1], size });
      mappings.push({
        originalPath: origFullPath,
        rewrittenPath: `${newName}/${safeFullPath}`,
        size,
      });
    }
  } else {
    const ext = extname(originalName);
    const newFileName = `${newName}${ext}`;
    info.name = newFileName;
    const size = info.length as number;
    outFiles.push({ name: newFileName, size });
    mappings.push({
      originalPath: originalName,
      rewrittenPath: newFileName,
      size,
    });
  }

  if (salt) info["x-salt"] = salt;

  dict["url-list"] = webseedUrl;

  const encoded = encodeBencode(dict);
  const infoHash = computeInfoHash(encoded);
  return { torrentData: encoded, infoHash, originalName, files: outFiles, mappings };
}

function encodeBencode(value: unknown): Buffer {
  if (typeof value === "number" || typeof value === "bigint") {
    return Buffer.from(`i${value}e`);
  }
  if (Buffer.isBuffer(value)) {
    return Buffer.concat([Buffer.from(`${value.length}:`), value]);
  }
  if (typeof value === "string") {
    const buf = Buffer.from(value);
    return Buffer.concat([Buffer.from(`${buf.length}:`), buf]);
  }
  if (Array.isArray(value)) {
    const parts: Uint8Array[] = [Buffer.from("l")];
    for (const item of value) {
      parts.push(encodeBencode(item));
    }
    parts.push(Buffer.from("e"));
    return Buffer.concat(parts);
  }
  const dict = value as Record<string, unknown>;
  const keys = Object.keys(dict).sort();
  const parts: Uint8Array[] = [Buffer.from("d")];
  for (const key of keys) {
    parts.push(encodeBencode(key));
    parts.push(encodeBencode(dict[key]));
  }
  parts.push(Buffer.from("e"));
  return Buffer.concat(parts);
}

type BDict = Record<string, unknown>;

type DecodeResult = { value: unknown; end: number };

/**
 * A torrent that is malformed or, far more often, truncated.
 *
 * Its own type so callers can tell "this mirror served junk, try another" apart
 * from a genuine bug in the rewrite.
 */
export class BencodeError extends Error {
  constructor(message: string) {
    super(`malformed torrent: ${message}`);
    this.name = "BencodeError";
  }
}

/**
 * Decode one bencode value at `pos`.
 *
 * **Every branch bounds-checks, and that is the entire point.** The container
 * loops used to run `while (buf[pos] !== 0x65)`: once `pos` passed the end,
 * `buf[pos]` is `undefined`, `undefined !== 0x65` is forever true, and the loop
 * span forever making no progress. Because this is the one JS thread, that did
 * not fail a job — it took the **whole service** down. Observed live on
 * 2026-08-07: itorrents served a copy of `Benidorm.S07` truncated to exactly
 * 76 KiB (the `pieces` string declared 73040 bytes with 72262 left), and
 * debrid02 sat at 99.9% CPU answering nothing at all, webseed included, so every
 * other in-flight job stalled with it. Untrusted bytes from a third-party cache
 * must never be able to do that; a throw here fails one job and retries.
 */
function decodeBencode(buf: Buffer, pos: number): DecodeResult {
  if (pos >= buf.length) throw new BencodeError(`unexpected end of data at ${pos}`);
  const ch = buf[pos];
  if (ch === 0x64) {
    pos++;
    const dict: BDict = {};
    while (true) {
      if (pos >= buf.length) throw new BencodeError(`unterminated dictionary at ${pos}`);
      if (buf[pos] === 0x65) break;
      const key = decodeBencode(buf, pos);
      pos = key.end;
      const val = decodeBencode(buf, pos);
      pos = val.end;
      dict[(key.value as Buffer).toString()] = val.value;
    }
    return { value: dict, end: pos + 1 };
  }
  if (ch === 0x6c) {
    pos++;
    const list: unknown[] = [];
    while (true) {
      if (pos >= buf.length) throw new BencodeError(`unterminated list at ${pos}`);
      if (buf[pos] === 0x65) break;
      const item = decodeBencode(buf, pos);
      list.push(item.value);
      pos = item.end;
    }
    return { value: list, end: pos + 1 };
  }
  if (ch === 0x69) {
    const end = buf.indexOf(0x65, pos + 1);
    if (end === -1) throw new BencodeError(`unterminated integer at ${pos}`);
    const num = parseInt(buf.subarray(pos + 1, end).toString(), 10);
    if (!Number.isFinite(num)) throw new BencodeError(`invalid integer at ${pos}`);
    return { value: num, end: end + 1 };
  }
  const colon = buf.indexOf(0x3a, pos);
  if (colon === -1) throw new BencodeError(`string with no length delimiter at ${pos}`);
  const len = parseInt(buf.subarray(pos, colon).toString(), 10);
  // A NaN length is the nastier half of the old bug: `start + NaN` is NaN, so
  // the caller's `pos` became NaN and every subsequent index read `undefined`.
  if (!Number.isInteger(len) || len < 0) throw new BencodeError(`invalid string length at ${pos}`);
  const start = colon + 1;
  if (start + len > buf.length) {
    throw new BencodeError(`string at ${pos} wants ${len} bytes, ${buf.length - start} remain`);
  }
  const raw = Buffer.from(buf.subarray(start, start + len));
  return { value: raw, end: start + len };
}

/**
 * Whether `buf` decodes as a complete bencode value.
 *
 * Used to reject a mirror that served a truncated torrent, so the next mirror
 * gets a chance rather than the job dying on the first bad copy.
 */
export function isWellFormedTorrent(buf: Buffer): boolean {
  try {
    decodeBencode(buf, 0);
    return true;
  } catch {
    return false;
  }
}

function extname(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot > 0 ? filename.slice(dot) : "";
}
