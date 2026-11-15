import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "./app";
import recorded from "./fixtures/realdebrid/rd-webseed-hash-fragment-2026-11-03.json";
import { buildCleanName } from "./naming";
import { proxyWebseedUrl, registerProxySession, removeProxySession } from "./proxy";
import { rewriteTorrent } from "./torrent-rewrite";

// Byte-length bencode strings: the names here can be multi-byte UTF-8.
const str = (s: string) => `${Buffer.byteLength(s)}:${s}`;
const pieces = `6:pieces20:${"A".repeat(20)}`;
const single = (name: string) =>
  Buffer.from(`d4:infod6:lengthi2000e4:name${str(name)}12:piece lengthi262144e${pieces}ee`);
const multi = (root: string, file: string) =>
  Buffer.from(
    `d4:infod5:filesld6:lengthi2000e4:pathl${str(file)}eee4:name${str(root)}12:piece lengthi262144e${pieces}ee`,
  );

/**
 * The URL RD's fetcher builds for a file: `encodeURI` escapes spaces and other
 * illegal characters but leaves `#` raw, as RD does, so the URL parser turns the
 * rest of the path into a fragment that is never sent.
 */
const rdRequestPath = (webseedUrl: string, filePath: string) =>
  new URL(webseedUrl + encodeURI(filePath)).pathname;

const ENTITY = /&(#\d+|#x[\da-f]+|[a-z]+);/i;

describe("RD drops everything after a # in a webseed path (card 374)", () => {
  test("the URL model reproduces the captured request for the name eca2376 emitted", () => {
    const rep = recorded.replication;
    const webseed = `http://ws/webseed/${rep.job_prefix}/`;
    for (const req of rep.caddy_requests) {
      expect(rdRequestPath(webseed, rep.emitted_name_eca2376)).toBe(
        `/webseed/${rep.job_prefix}/${req.path_after_job}`,
      );
    }
  });

  test("production root names lose the # and TorBox's HTML entities", () => {
    const earth = recorded.production_jobs[0];
    expect(buildCleanName(earth.imdb_id ?? "", earth.torbox_name)).toBe(
      "Earth's Greatest Enemy (2025) 1080p WEB.DL h264 {imdb-tt37547719}",
    );
    for (const job of recorded.production_jobs.filter((j) => j.where === "root")) {
      const name = buildCleanName(job.imdb_id ?? "", job.torbox_name);
      expect(name).not.toContain("#");
      expect(ENTITY.test(name)).toBe(false);
    }
  });

  test("production file paths lose the #, the rest of the name is kept", () => {
    for (const job of recorded.production_jobs.filter((j) => j.where === "file")) {
      for (const file of job.files ?? []) {
        const { files } = rewriteTorrent(multi("orig", file), "Root", "http://ws/");
        expect(files[0].name).toBe(file.replaceAll("#", ""));
      }
    }
  });

  test("names without a # or an entity are unchanged", () => {
    expect(buildCleanName("tt1", "Lucky S01 1080p ATVP WEB-DL DDP5.1 H.264-NTb")).toBe(
      "Lucky S01 1080p ATVP WEB.DL DDP5.1 H.264-NTb {imdb-tt1}",
    );
    expect(buildCleanName("", "Tom & Jerry Q&A; Ben&Jerry's")).toBe("Tom & Jerry Q&A; Ben&Jerry's");
    const { files } = rewriteTorrent(multi("orig", "S02 - Q&A 1.mkv"), "Root", "http://ws/");
    expect(files[0].name).toBe("S02 - Q&A 1.mkv");
  });

  describe("the webseed route answers RD's exact request", () => {
    let dir: string;
    let local: string;
    beforeAll(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "rd-hash-"));
      local = path.join(dir, "movie.mkv");
      fs.writeFileSync(local, Buffer.alloc(2000, 7));
    });
    afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

    const serve = async (jobId: string, original: Buffer, name: string) => {
      const webseed = proxyWebseedUrl(jobId);
      const out = rewriteTorrent(original, name, webseed);
      registerProxySession(
        jobId,
        -1,
        out.mappings.map((m) => ({
          rewrittenPath: m.rewrittenPath,
          webdavPath: local,
          size: 2000,
        })),
      );
      const [req] = recorded.replication.caddy_requests;
      const res = await createApp().request(rdRequestPath(webseed, out.mappings[0].rewrittenPath), {
        headers: { range: req.range, "user-agent": req.user_agent },
      });
      removeProxySession(jobId);
      return res.status;
    };

    test("single file named from TorBox's entity-encoded name", async () => {
      const rep = recorded.replication;
      const name = buildCleanName(rep.imdb_id, rep.torbox_name);
      expect(await serve("hash-single", single("orig.mkv"), name)).toBe(206);
    });

    test("multi-file root with a # and a file with a #", async () => {
      const falling = recorded.production_jobs[2];
      const name = buildCleanName(falling.imdb_id ?? "", falling.torbox_name);
      expect(await serve("hash-multi", multi("orig", "NCOP #01.mkv"), name)).toBe(206);
    });
  });
});
