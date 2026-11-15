import { describe, expect, test } from "bun:test";
import recorded from "./fixtures/realdebrid/rd-select-astral-2026-10-27.json";
import { buildCleanName } from "./naming";
import { rewriteTorrent } from "./torrent-rewrite";

// Byte-length bencode strings: the names here are multi-byte UTF-8.
const str = (s: string) => `${Buffer.byteLength(s)}:${s}`;
const pieces = `6:pieces20:${"A".repeat(20)}`;
const single = (name: string) =>
  Buffer.from(`d4:infod6:lengthi1000e4:name${str(name)}12:piece lengthi262144e${pieces}ee`);
const multi = (root: string, file: string) =>
  Buffer.from(
    `d4:infod5:filesld6:lengthi1000e4:pathl${str(file)}eee4:name${str(root)}12:piece lengthi262144e${pieces}ee`,
  );

describe("RD leaves astral-plane file names unselected (card 374)", () => {
  test("the production job's TorBox name gives RD a file it will select", () => {
    const job = recorded.production_job;
    const name = buildCleanName(job.imdb_id, job.torbox_name);
    const { files } = rewriteTorrent(single(job.original_file), name, "http://ws/");
    expect(files[0].name).toBe(
      "Love Island S08E36 1080p WEB h264-SCONES 0 1.98 GB ⚙️ EZTV {imdb-tt8819906}.mkv",
    );
  });

  test("files RD refused lose their astral characters, files it selected pass unchanged", () => {
    for (const obs of recorded.observations) {
      const refused = obs.rd_files.some((f) => f.selected === 0);
      const paths = obs.rd_files.map((f) => f.path.slice(1));
      // Single-file: the root name is the file; multi-file: root plus one file.
      const out =
        paths[0] === obs.torrent_name
          ? rewriteTorrent(single("orig.mkv"), buildCleanName("", obs.torrent_name), "http://ws/")
          : rewriteTorrent(
              multi("orig", paths[0]),
              buildCleanName("", obs.torrent_name),
              "http://ws/",
            );
      const emitted = out.files[0].name;
      // What RD selected, it keeps selecting; what it refused no longer carries an astral char.
      expect(/[\u{10000}-\u{10FFFF}]/u.test(emitted)).toBe(false);
      if (!refused) expect(emitted.replace(/\.mkv$/, "")).toBe(paths[0].replace(/\.mkv$/, ""));
    }
  });
});
