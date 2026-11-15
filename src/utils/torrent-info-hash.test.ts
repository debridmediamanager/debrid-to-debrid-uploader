import { describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import { computeInfoHash } from "./torrent-info-hash";

describe("computeInfoHash", () => {
  test("hashes the bencoded info dictionary bytes", () => {
    const info = "d5:filesld6:lengthi5e4:pathl8:file.mkveee4:name4:Teste";
    const torrentData = Buffer.from(`d4:info${info}e`);

    expect(computeInfoHash(torrentData)).toBe(crypto.createHash("sha1").update(info).digest("hex"));
  });

  test("throws when the torrent has no info dictionary", () => {
    expect(() => computeInfoHash(Buffer.from("d3:foo3:bare"))).toThrow("No info dict in torrent");
  });
});
