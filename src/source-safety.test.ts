import { afterEach, expect, test } from "bun:test";
import crypto from "node:crypto";
import { config } from "./config";
import {
  createJob,
  getJob,
  getProxyMappings,
  getTorrentFiles,
  insertProxyMappings,
  insertTorrentFiles,
  updateJob,
} from "./db";
import { downloadMagnet } from "./downloads";
import raw from "./fixtures/raw-fun.json";
import rar from "./fixtures/rd-rar-bundle-torrent-info.json";
import { clearTrackerCache } from "./trackers";
import { computeInfoHash } from "./utils/torrent-info-hash";
import { cleanupJobFiles, processJob } from "./worker";

const originalFetch = globalThis.fetch;
const sources = config.cacheSources;
afterEach(() => {
  globalThis.fetch = originalFetch;
  config.cacheSources = sources;
  clearTrackerCache();
});
const progress = { set: (_message: string) => {}, setName: (_name: string) => {}, clear: () => {} };
function job() {
  const id = `source-safety-${crypto.randomUUID()}`;
  createJob(id, `magnet:?xt=urn:btih:${rar.body.hash}`, "tt1727587", false, {
    rdApiKey: "RD",
    tbApiKey: "TB",
    adApiKey: "AD",
  });
  return id;
}

test.each(["torbox", "alldebrid"] as const)(
  "cleanup preserves deduplicated %s resource shared by two jobs",
  async (source) => {
    const calls: string[] = [];
    globalThis.fetch = (async (url: unknown) => {
      calls.push(String(url));
      return Response.json({ success: true, status: "success", data: {} });
    }) as typeof fetch;
    const ids = [job(), job()];
    const tbId = raw.tb_createtorrent_existing.body.data.torrent_id;
    const adId = raw.ad_magnet_status_regressed.body.data.magnets.id;
    for (const id of ids)
      insertProxyMappings(
        id,
        source === "torbox" ? tbId : 0,
        [{ rewrittenPath: "movie.mkv", webdavPath: "movie.mkv", size: 1 }],
        { source, adMagnetId: adId },
      );
    for (const id of ids) cleanupJobFiles(id);
    await Promise.resolve();
    expect(calls).toEqual([]);
  },
);

test("cleanup still deletes an authoritatively created RD source", async () => {
  const calls: string[] = [];
  globalThis.fetch = (async (url: unknown) => {
    calls.push(String(url));
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  const id = job();
  insertProxyMappings(id, 0, [{ rewrittenPath: "movie.mkv", webdavPath: "movie.mkv", size: 1 }], {
    source: "realdebrid",
    rdSourceTorrentId: "CREATED",
  });
  cleanupJobFiles(id);
  await Promise.resolve();
  expect(calls).toEqual(["https://api.real-debrid.com/rest/1.0/torrents/delete/CREATED"]);
});

test("RD RAR selection never persists its archive link against the first selected file", async () => {
  globalThis.fetch = (async () => Response.json(rar.body)) as unknown as typeof fetch;
  const id = job();
  insertTorrentFiles(
    id,
    rar.body.files.map((f) => ({ name: f.path.slice(1), size: f.bytes })),
  );
  updateJob(id, { status: "uploading", rd_torrent_id: rar.body.id });
  await processJob(id);
  expect(getJob(id)?.status).toBe("completed");
  expect(getTorrentFiles(id).every((f) => f.rd_link === null)).toBe(true);
});

test("AllDebrid cache misses preserve a held magnet returned by duplicate upload", async () => {
  config.cacheSources = ["alldebrid"];
  const calls: string[] = [];
  const held = raw.ad_magnet_status_regressed.body.data.magnets;
  globalThis.fetch = (async (url: unknown) => {
    calls.push(String(url));
    if (String(url).includes("/magnet/upload"))
      return Response.json({
        status: "success",
        data: {
          magnets: [
            { id: held.id, hash: held.hash, name: held.filename, size: held.size, ready: false },
          ],
        },
      });
    return new Response("");
  }) as typeof fetch;
  await expect(
    downloadMagnet(job(), `magnet:?xt=urn:btih:${held.hash}`, "", progress, undefined, {
      alldebridApiKey: "AD",
    }),
  ).rejects.toThrow("uncached");
  expect(calls.some((url) => url.includes("/magnet/delete"))).toBe(false);
});

test("TorBox cache probe failure still attempts AllDebrid and retains retryable error", async () => {
  config.cacheSources = ["torbox", "alldebrid"];
  let adProbed = false;
  globalThis.fetch = (async (url: unknown) => {
    if (String(url).includes("checkcached")) throw new Error("probe offline");
    if (String(url).includes("/magnet/upload")) {
      adProbed = true;
      return Response.json({ status: "success", data: { magnets: [{ id: 1, ready: false }] } });
    }
    return new Response("");
  }) as typeof fetch;
  await expect(
    downloadMagnet(job(), `magnet:?xt=urn:btih:${rar.body.hash}`, "", progress, undefined, {
      torboxApiKey: "TB",
      alldebridApiKey: "AD",
    }),
  ).rejects.toThrow("probe offline");
  expect(adProbed).toBe(true);
});

function mirrorTorrent(): { data: Buffer; hash: string } {
  const data = Buffer.from(
    `d4:infod6:lengthi1e4:name10:sample.mkv12:piece lengthi16384e6:pieces20:${"A".repeat(20)}ee`,
  );
  return { data, hash: computeInfoHash(data) };
}

test.each(["torbox", "alldebrid"] as const)(
  "%s setup failure preserves a duplicate add",
  async (source) => {
    config.cacheSources = [source];
    const { data, hash } = mirrorTorrent();
    const deletes: string[] = [];
    globalThis.fetch = (async (input: unknown) => {
      const url = String(input);
      if (/itorrents|btcache|torrage/.test(url)) return new Response(new Uint8Array(data));
      if (/controltorrent|magnet\/delete/.test(url)) deletes.push(url);
      if (url.includes("checkcached"))
        return Response.json({ success: true, data: [{ hash, size: 1 }] });
      if (url.includes("createtorrent")) return Response.json(raw.tb_createtorrent_existing.body);
      if (url.includes("mylist"))
        return Response.json({
          success: true,
          data: { ...raw.tb_mylist_entry_same_hash.body.data[0], files: [] },
        });
      if (url.includes("magnet/upload"))
        return Response.json({
          status: "success",
          data: {
            magnets: [{ id: raw.ad_magnet_status_regressed.body.data.magnets.id, ready: true }],
          },
        });
      if (url.includes("magnet/status"))
        return Response.json({
          status: "success",
          data: { magnets: { ...raw.ad_magnet_status_regressed.body.data.magnets, statusCode: 4 } },
        });
      if (url.includes("magnet/files")) return Response.json(raw.ad_magnet_files_regressed.body);
      return new Response("");
    }) as typeof fetch;
    await expect(
      downloadMagnet(job(), `magnet:?xt=urn:btih:${hash}`, "", progress, undefined, {
        torboxApiKey: "TB",
        alldebridApiKey: "AD",
      }),
    ).rejects.toThrow("No video files");
    expect(deletes).toEqual([]);
  },
);

test("RD source rejects bundled fixture before registering any per-file link", async () => {
  const { data, hash } = mirrorTorrent();
  const id = job();
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    if (/itorrents|btcache|torrage/.test(url)) return new Response(new Uint8Array(data));
    if (url.includes("/torrents?")) return Response.json([{ ...rar.body, hash }]);
    if (url.includes("/torrents/info/")) return Response.json(rar.body);
    return new Response("");
  }) as typeof fetch;
  await expect(
    downloadMagnet(id, `magnet:?xt=urn:btih:${hash}`, "", progress, undefined, {
      destination: "torbox",
      realdebridApiKey: "RD",
    }),
  ).rejects.toThrow("bundled links");
  expect(getProxyMappings(id)).toEqual([]);
});

test("RD one-file selection still persists its matching per-file link", async () => {
  const info = raw.rd_torrent_info_26char.body;
  globalThis.fetch = (async () => Response.json(info)) as unknown as typeof fetch;
  const id = job();
  insertTorrentFiles(
    id,
    info.files.map((f) => ({ name: f.path.slice(1), size: f.bytes })),
  );
  updateJob(id, { status: "uploading", rd_torrent_id: info.id });
  await processJob(id);
  expect(getTorrentFiles(id)[0]?.rd_link).toBe(info.links[0].slice(0, -3));
});
