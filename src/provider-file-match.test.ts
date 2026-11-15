import { describe, expect, test } from "bun:test";
import { matchProviderFile } from "./downloads";
import alpha from "./fixtures/torbox/cached-webdav-404-cdn-206-alpha-2026-11-04.json";

/**
 * TorBox's own file list for "Alpha (2026) Hindi" against the torrent's own
 * name, as job a3fcaf2c on debrid02 saw them on 2026-11-04. The torrent is a
 * single file named with an `&`; TorBox stores it inside a folder and spells
 * the file with `and`. No candidate path existed, the file got no TorBox id,
 * and the probe asked WebDAV for a path TorBox never had — 94 jobs by 59
 * people ended "cached but serves 404" on this one release.
 */
const torbox = alpha.mylist.body.data;
const ORIGINAL =
  "www.1TamilMV.meme - Alpha (2026) Hindi TRUE WEB-DL - 1080p - AVC - (DD+5.1 - 640Kbps & AAC) - 3GB - ESub.mkv";

describe("matchProviderFile", () => {
  test("finds a single-file torrent TorBox folded into a folder and respelled", () => {
    const file = matchProviderFile(torbox.files, ORIGINAL, torbox.name, ORIGINAL, torbox.size);
    expect(file?.id).toBe(0);
  });

  test("without a size, the names still agree once compared loosely", () => {
    const file = matchProviderFile(torbox.files, ORIGINAL, torbox.name, ORIGINAL);
    expect(file?.id).toBe(0);
  });

  test("a size shared by two files decides nothing", () => {
    const files = [
      { id: 1, name: "Pack/S01E01 & more.mkv", size: 100 },
      { id: 2, name: "Pack/S01E02 & more.mkv", size: 100 },
    ];
    expect(matchProviderFile(files, "Pack", "Pack", "S01E02 and more.mkv", 100)?.id).toBe(2);
    expect(matchProviderFile(files, "Pack", "Pack", "S01E03.mkv", 100)).toBeUndefined();
  });

  test("an exact path still wins over a size coincidence", () => {
    const files = [
      { id: 1, name: "Pack/a.mkv", size: 5 },
      { id: 2, name: "Pack/b.mkv", size: 5 },
    ];
    expect(matchProviderFile(files, "Pack", "Pack", "b.mkv", 5)?.id).toBe(2);
  });
});
