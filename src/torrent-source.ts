import { config } from "./config";
import { fetchTorrentFile } from "./itorrents";
import { counters } from "./metrics";
import { QbitClient } from "./qbittorrent";
import { enrichMagnet, getTrackers } from "./trackers";
import { sleep } from "./utils/async";
import { computeInfoHash } from "./utils/torrent-info-hash";

/**
 * Where the original `.torrent` comes from, in order of preference.
 *
 * Every route ends in `rewriteTorrent`, and that needs the original `info`
 * dict — above all its **piece hashes**, which nothing else on this box can
 * supply. A magnet carries only a fingerprint; the file lists TorBox and
 * AllDebrid return carry names and sizes but no chunking; DMM's database
 * catalogues releases without ever recording it. Hashing the bytes ourselves
 * would mean pulling the whole release before RD sees any of it, which is the
 * cost this service exists to avoid.
 *
 * So: the torrent-cache mirrors first, because they are one cheap HTTP round
 * trip. The swarm second, because it is minutes rather than milliseconds — and
 * only when the mirrors have all missed, which is a job that would otherwise
 * have failed outright.
 */
export type MetadataResolver = (infoHash: string, magnetUri: string) => Promise<Buffer>;

export async function resolveTorrentFile(
  infoHash: string,
  deps: {
    fromMirrors?: (hash: string) => Promise<Buffer>;
    fromSwarm?: MetadataResolver;
    enabled?: boolean;
    trackers?: () => Promise<string[]>;
  } = {},
): Promise<Buffer> {
  const fromMirrors = deps.fromMirrors ?? fetchTorrentFile;
  try {
    return await fromMirrors(infoHash);
  } catch (mirrorError) {
    const enabled = deps.enabled ?? config.qbitMetadataFallback;
    if (!enabled) throw mirrorError;

    counters.inc("torrent_source.swarm_attempts");
    const trackers = await (deps.trackers ?? getTrackers)();
    const magnet = enrichMagnet(`magnet:?xt=urn:btih:${infoHash.toLowerCase()}`, trackers);
    try {
      const data = await (deps.fromSwarm ?? fetchMetadataFromSwarm)(infoHash, magnet);
      counters.inc("torrent_source.swarm_hits");
      return data;
    } catch (swarmError) {
      counters.inc("torrent_source.swarm_misses");
      // Both causes, in one message. The mirror list is the usual story and the
      // swarm result is what says whether the release is reachable at all, so
      // dropping either half sends the next diagnosis down the wrong path.
      throw new Error(
        `${(mirrorError as Error).message}; swarm fallback also failed: ${(swarmError as Error).message}`,
      );
    }
  }
}

/**
 * Ask a swarm for the `info` dict via BEP 9, and take nothing else.
 *
 * The torrent is removed in a `finally` whatever happens, because a metadata
 * fetch that leaks a torrent leaves this host seeding — the one outcome a
 * metadata-only path must never produce. `deleteFiles` is true so a partial
 * write, if one ever happened, goes with it.
 *
 * The returned torrent is verified against the hash that was asked for, exactly
 * as a mirror's answer is: a swarm cannot realistically substitute a different
 * torrent the way itorrents does, but the check costs one SHA-1 over bytes
 * already in memory and it is the invariant `rewriteTorrent` depends on.
 */
export async function fetchMetadataFromSwarm(
  infoHash: string,
  magnetUri: string,
  deps: {
    client?: Pick<QbitClient, "addMagnetForMetadata" | "getTorrents" | "exportTorrent" | "delete">;
    timeoutMs?: number;
    pollMs?: number;
    wait?: (ms: number) => Promise<void>;
  } = {},
): Promise<Buffer> {
  const client = deps.client ?? new QbitClient();
  const pollMs = deps.pollMs ?? 5_000;
  const timeoutMs = deps.timeoutMs ?? config.qbitMetadataTimeoutMs;
  const polls = Math.max(1, Math.ceil(timeoutMs / pollMs));
  const wait = deps.wait ?? sleep;
  const hash = infoHash.toLowerCase();

  await client.addMagnetForMetadata(magnetUri);
  try {
    for (let poll = 0; poll < polls; poll++) {
      await wait(pollMs);
      const [torrent] = await client.getTorrents(hash);
      // `metaDL` with `total_size: -1` is the waiting state. Anything else with
      // a real size means the `info` dict has arrived — including
      // `missingFiles`, which is what a metadata-only fetch is *supposed* to
      // end in, since nothing was ever written to disk.
      if (!torrent || torrent.state === "metaDL" || (torrent.total_size ?? -1) <= 0) continue;

      const data = await client.exportTorrent(hash);
      const actual = computeInfoHash(data).toLowerCase();
      if (actual !== hash) {
        throw new Error(`qBittorrent exported ${actual} when ${hash} was requested`);
      }
      return data;
    }
    throw new Error(`no peer offered metadata for ${hash} within ${Math.round(timeoutMs / 1000)}s`);
  } finally {
    await client.delete(hash, true).catch(() => undefined);
  }
}
