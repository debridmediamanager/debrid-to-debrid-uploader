import { afterEach, describe, expect, test } from "bun:test";
import { downloadMagnet } from "./downloads";
import recorded from "./fixtures/realdebrid/add-451-name-refusal-2026-10-13.json";
import { _clearAccountBlocks } from "./rd-account-block";
import { computeInfoHash } from "./utils/torrent-info-hash";

/**
 * Real-Debrid as a *source* (TorBox/Premiumize destinations) adds the original
 * release to the submitter's account. DMM submits it as a bare-hash magnet, so
 * the only name RD judges that add on is the torrent's own root name, and the
 * add used to go out without it: a release RD refuses by name drew a 451 that
 * was then held as an account block for ~7 minutes, every stage retry over.
 *
 * Driven by the 2026-10-13/14 retest: the same release names, RD's recorded
 * answer to each, and the bare magnet the retest (and DMM) sent.
 */

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  _clearAccountBlocks();
});

/** A single-file torrent whose root name is `name`, and its real info hash. */
function torrentNamed(name: string): { data: Buffer; hash: string } {
  const bytes = Buffer.byteLength(name);
  const info = `d6:lengthi1048576e4:name${bytes}:${name}12:piece lengthi262144e6:pieces20:${"A".repeat(20)}e`;
  const data = Buffer.from(`d4:info${info}e`);
  return { data, hash: computeInfoHash(data).toLowerCase() };
}

/** Mirrors serve the torrent, the account holds nothing, and RD answers adds as recorded. */
function serve(torrent: Buffer, addAnswer: { code: number; body: string }) {
  const adds: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (/itorrents|btcache|torrage/.test(url)) return new Response(new Uint8Array(torrent));
    if (url.includes("/torrents?limit=")) return Response.json([]);
    if (url.endsWith("/torrents/addMagnet")) {
      adds.push(url);
      return new Response(addAnswer.body, { status: addAnswer.code });
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;
  return adds;
}

function progressLog() {
  const messages: string[] = [];
  return { messages, set: (m: string) => messages.push(m), setName: () => {}, clear: () => {} };
}

const named = recorded.releases.filter((r) => r.kind === "name");
const clean = recorded.releases.filter((r) => r.kind === "account");

describe("Real-Debrid as a source, given a bare-hash magnet", () => {
  test.each(named.map((r) => [r.title, r] as const))(
    "never adds %s, which RD refuses by name",
    async (_title, release) => {
      const { data, hash } = torrentNamed(release.title);
      const adds = serve(data, release.adds[0]);
      const progress = progressLog();

      const err = await downloadMagnet(
        "job-name",
        `magnet:?xt=urn:btih:${hash}`,
        "tt0000001",
        progress,
        undefined,
        { destination: "torbox", realdebridApiKey: "RDKEY", realdebridAccount: "rd:retest" },
      ).catch((e) => e);

      expect(adds).toEqual([]);
      expect(err?.name).toBe("RdReleaseRefusedError");
      expect(err.message).toContain(release.title);
      expect(progress.messages.join("\n")).not.toContain("refusing adds on this account");
    },
    2_000,
  );

  test.each(clean.map((r) => [r.title, r] as const))(
    "adds %s and holds the account on its 451 instead of refusing it",
    async (_title, release) => {
      const { data, hash } = torrentNamed(release.title);
      const adds = serve(data, release.adds[0]);
      const abort = new AbortController();
      const progress = {
        ...progressLog(),
        set: (m: string) => {
          if (m.includes("refusing adds on this account")) abort.abort();
        },
      };

      const err = await downloadMagnet(
        "job-clean",
        `magnet:?xt=urn:btih:${hash}`,
        "tt0000001",
        progress,
        abort.signal,
        { destination: "torbox", realdebridApiKey: "RDKEY", realdebridAccount: "rd:retest" },
      ).catch((e) => e);

      expect(adds).toHaveLength(1);
      expect(abort.signal.aborted).toBe(true);
      expect(err?.name).not.toBe("RdReleaseRefusedError");
    },
    2_000,
  );
});
