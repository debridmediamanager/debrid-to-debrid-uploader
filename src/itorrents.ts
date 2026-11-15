import { config } from "./config";
import { isWellFormedTorrent } from "./torrent-rewrite";
import { computeInfoHash } from "./utils/torrent-info-hash";

type Fetcher = (
  url: string,
  init?: { signal: AbortSignal },
) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }>;

/**
 * Bound one mirror's attempt, because `Promise.any` waits for the slowest loser.
 *
 * These calls had no deadline of any kind, and Bun's `fetch` imposes none — so a
 * single mirror that accepted a connection and then went quiet would hold the
 * whole metadata stage open, and with it a concurrency slot, until the stage
 * timeout fired minutes later. That was survivable while the mirrors worked and
 * one of them answered fast. It is not survivable now: measured 2026-08-17,
 * **all four are dead** — both itorrents domains redirect to a single hardcoded
 * decoy, btcache.me serves an HTML page and torrage.info 403s — so every job now
 * waits for the entire mirror list to reject before the swarm, the only source
 * that can actually answer, is even asked.
 *
 * The signal is passed to the fetcher as well as raced, so a real `fetch` drops
 * its socket rather than being merely abandoned.
 */
function withTimeout<T>(work: Promise<T>, ms: number, url: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${url} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([work, expiry]).finally(() => clearTimeout(timer));
}

const SOURCES = [
  (hash: string) => `https://itorrents.org/torrent/${hash}.torrent`,
  (hash: string) => `http://itorrents.net/torrent/${hash}.torrent`,
  (hash: string) => `https://btcache.me/torrent/${hash}`,
  (hash: string) => `https://torrage.info/torrent/${hash}`,
];

export async function fetchTorrentFile(
  infoHash: string,
  fetcher: Fetcher = fetch,
  timeoutMs: number = config.torrentMirrorTimeoutMs,
): Promise<Buffer> {
  const hash = infoHash.toUpperCase();
  const attempts = SOURCES.map((urlFn) => fetchFromSource(urlFn(hash), hash, fetcher, timeoutMs));

  return Promise.any(attempts).catch((err: AggregateError) => {
    throw new Error(
      `All torrent sources failed for ${hash.toLowerCase()}: ${err.errors.map((e: Error) => e.message).join("; ")}`,
    );
  });
}

async function fetchFromSource(
  url: string,
  hash: string,
  fetcher: Fetcher,
  timeoutMs: number,
): Promise<Buffer> {
  const res = await withTimeout(
    fetcher(url, { signal: AbortSignal.timeout(timeoutMs) }),
    timeoutMs,
    url,
  );
  if (!res.ok) throw new Error(`${url} failed: ${res.status}`);

  const data = Buffer.from(await res.arrayBuffer());
  if (data.length < 50 || data[0] !== 0x64) {
    throw new Error(`${url} returned invalid torrent for ${hash}`);
  }
  // A leading `d` and a plausible length are not enough: itorrents served a
  // copy of `Benidorm.S07` cut at exactly 76 KiB that passed both checks, and
  // because these sources race under `Promise.any`, that truncated copy *won*
  // over mirrors holding the whole file. Rejecting it here lets the race fall
  // through to a good mirror instead of failing the job on the first bad one.
  if (!isWellFormedTorrent(data)) {
    throw new Error(`${url} returned a truncated or malformed torrent for ${hash}`);
  }
  // **And it has to be the torrent that was asked for.** Well-formed is not the
  // same as correct: measured 2026-08-16, both itorrents domains answer a hash
  // they do not index with a *decoy* rather than a 404 — the same 40789-byte
  // file every time, info hash `E22D048D…`, named
  // `001FF871FB8B9348FCD8ECBFDAACC85D3CCAB00F.exe`. It is valid bencode, so
  // every check above passed it, and the pipeline would then rewrite that decoy
  // and hand it to the destination: the job describes a 40 KB executable while
  // the proxy maps files that do not exist, so it fails much later as a stall or
  // an unmatched-link error naming nothing. Verifying the hash costs one SHA-1
  // over bytes already in memory and turns a silent wrong answer into this
  // mirror simply losing the `Promise.any` race.
  const actual = computeInfoHash(data).toUpperCase();
  if (actual !== hash) {
    throw new Error(`${url} returned ${actual} when ${hash} was requested`);
  }
  return data;
}
