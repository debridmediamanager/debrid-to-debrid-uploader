import { afterEach, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import { withExtendableTimeout } from "./deadline";
import recorded from "./fixtures/realdebrid/add-451-name-refusal-2026-10-13.json";
import probe from "./fixtures/realdebrid/rd-name-filter-2026-10-14.json";
import {
  _clearAccountBlocks,
  type AddHold,
  accountKeyFor,
  blockedNameIn,
  describeAddHold,
  RD_ADD_BLOCK_FOLLOW_MS,
  RdAccountBlockedError,
  RdAddCancelledError,
  RdRefusalError,
  RdReleaseRefusedError,
  throughAccountBlock,
} from "./rd-account-block";
import { sleepUnlessAborted } from "./utils/async";

/** RD's 451 body as the 2026-10-04/05 probe recorded it. */
const BODY = '{ "error": "infringing_file", "error_code": 35 }';

afterEach(() => _clearAccountBlocks());

/** Answers from a script, recording when each send happened. */
function scripted(answers: ("451" | "ok" | Error)[], clock: { now: () => number }) {
  const sent: number[] = [];
  const send = async () => {
    sent.push(clock.now());
    const next = answers.shift();
    if (next === undefined) throw new Error("sent more often than scripted");
    if (next instanceof Error) throw next;
    if (next === "451") throw new RdRefusalError("addMagnet", BODY);
    return "RDID";
  };
  return Object.assign(send, { sent });
}

/** A clock whose sleeps advance it at once; for a single caller only. */
function steppingClock() {
  let now = 1_000_000;
  const slept: number[] = [];
  return {
    now: () => now,
    slept,
    sleepFor: async (ms: number) => {
      slept.push(ms);
      now += ms;
    },
  };
}

describe("accountKeyFor", () => {
  test("holds a block under the resolved account when there is one", () => {
    expect(accountKeyFor({ apiKey: "KEY", account: "rd:67890" })).toBe("rd:67890");
  });

  test("falls back to the same key digest owners.ts degrades to, never the key", () => {
    const digest = crypto.createHash("sha256").update("SECRETKEY").digest("hex").slice(0, 12);
    const key = accountKeyFor({ apiKey: "SECRETKEY" });
    expect(key).toBe(`rd:key:${digest}`);
    expect(key).not.toContain("SECRETKEY");
    expect(accountKeyFor({})).toMatch(/^rd:key:[0-9a-f]{12}$/);
  });
});

describe("blockedNameIn", () => {
  test("finds a name carrying a pattern RD's filter refuses", () => {
    const name = "Show.S01E01.1080p.AMZN.WEB-DL.DDP5.1.H.264-GRP";
    expect(blockedNameIn(["clean root {imdb-tt1}", name])).toBe(name);
  });

  test("passes clean and de-infringed names, and no names at all", () => {
    expect(blockedNameIn(["Show.S01E01.1080p.AMZN.WEB.DL.DDP5.1.H.264-GRP"])).toBeUndefined();
    expect(blockedNameIn([])).toBeUndefined();
    expect(blockedNameIn()).toBeUndefined();
  });

  test("passes names deInfringe rewrites but RD accepts", () => {
    // Measured 2026-10-14: only `p.BluRay.DTS`, five of the nine source.codec
    // pairs, and the WEB ones and `WEB-DL` only in one case, are refused;
    // deInfringe breaks all of them in any case.
    expect(blockedNameIn(["Movie.2002.BluRay.DTS-HD.MA.5.1-GRP"])).toBeUndefined();
    expect(blockedNameIn(["Show.S01E01.720p.HDTV.h264-GRP"])).toBeUndefined();
    expect(blockedNameIn(["How.to.Train.Your.Dragon.2025.1080p.WEB.h264-ETHEL"])).toBeUndefined();
    expect(blockedNameIn(["Show.S01E01.1080p.web-dl.x265-GRP"])).toBeUndefined();
    expect(blockedNameIn(["Movie.2020.1080p.BluRay.DTS.x265-GRP"])).toBe(
      "Movie.2020.1080p.BluRay.DTS.x265-GRP",
    );
  });

  // RD's own answers from the 2026-10-14 probe: a fresh webseed torrent per
  // name, so only the names decided. An add is judged on the root name alone,
  // an unrestrict on the file's own name.
  test.each(probe.add)("gives RD's add answer for $name", ({ name, status }) => {
    expect(blockedNameIn([name]) !== undefined).toBe(status === 451);
  });
  test.each(probe.unrestrict)("gives RD's unrestrict answer for $name", ({ name, status }) => {
    expect(blockedNameIn([name]) !== undefined).toBe(status === 451);
  });
});

describe("describeAddHold", () => {
  test("says what a refused add is waiting for and which rung it is on", () => {
    expect(describeAddHold({ waitMs: 90_000, refused: true, refusals: 2 })).toBe(
      "Real-Debrid is refusing adds on this account (451), usually for a few minutes; " +
        "trying again in 90s (2/3)",
    );
  });

  test("says an add held behind another is waiting for the block to lift", () => {
    expect(describeAddHold({ waitMs: 4_200, refused: false, refusals: 0 })).toBe(
      "Waiting 5s for a Real-Debrid block on this account to lift",
    );
  });
});

describe("throughAccountBlock", () => {
  test("passes any other failure through without holding the account", async () => {
    const clock = steppingClock();
    const send = scripted([new Error("RD addMagnet failed: 400 bad")], clock);

    await expect(
      throughAccountBlock(send, { account: "rd:other-error", ...clock }),
    ).rejects.toThrow("RD addMagnet failed: 400 bad");
    expect(clock.slept).toEqual([]);

    // Nothing was held: the next add on the account goes at once.
    const next = scripted(["ok"], clock);
    await throughAccountBlock(next, { account: "rd:other-error", ...clock });
    expect(clock.slept).toEqual([]);
  });

  test("a name RD's filter refuses is never sent, and holds nobody", async () => {
    const clock = steppingClock();
    const send = scripted(["451"], clock);
    const holds: AddHold[] = [];

    const err = await throughAccountBlock(send, {
      account: "rd:named",
      names: ["Penny.Lane.Is.Dead.2025.1080p.WEB-DL.H264-SCOPE"],
      onHold: (h) => holds.push(h),
      ...clock,
    }).catch((e) => e);

    expect(err).toBeInstanceOf(RdReleaseRefusedError);
    expect(err.message).toContain("Penny.Lane.Is.Dead.2025.1080p.WEB-DL.H264-SCOPE");
    expect(send.sent).toHaveLength(0);
    expect(holds).toEqual([]);

    const next = scripted(["ok"], clock);
    await throughAccountBlock(next, { account: "rd:named", ...clock });
    expect(clock.slept).toEqual([]);
  });

  test("the retest's releases: tagged names go unsent, clean ones ride out their 451s", async () => {
    // Each answer is what RD gave that release, in order; the clean ones end
    // with an "ok" because their blocks lifted (76c781c8 was accepted on
    // re-add, 62596472's control was accepted again within a minute).
    for (const release of recorded.releases) {
      const clock = steppingClock();
      const answers = release.adds.map((a) => (a.code === 451 ? "451" : "ok")) as ("451" | "ok")[];
      if (answers.at(-1) === "451") answers.push("ok");
      const waits = [30_000, 90_000].slice(0, answers.length - 1);
      const send = scripted(answers, clock);
      const outcome = await throughAccountBlock(send, {
        account: `rd:${release.hash}`,
        names: [release.title],
        ...clock,
      }).catch((e) => e);

      if (release.kind === "name") {
        expect(outcome).toBeInstanceOf(RdReleaseRefusedError);
        expect(send.sent).toHaveLength(0);
      } else {
        expect(outcome).toBe("RDID");
        expect(clock.slept).toEqual(waits);
      }
    }
  });

  test("a refused add reports each rung before waiting it", async () => {
    const clock = steppingClock();
    const send = scripted(["451", "451", "ok"], clock);
    const holds: AddHold[] = [];

    await throughAccountBlock(send, {
      account: "rd:rungs",
      onHold: (h) => holds.push(h),
      ...clock,
    });

    expect(holds).toEqual([
      { waitMs: 30_000, refused: true, refusals: 1 },
      { waitMs: 90_000, refused: true, refusals: 2 },
    ]);
  });

  test("giving up names the block as temporary, with RD's answer flattened", async () => {
    const clock = steppingClock();
    const raw = '{\n    "error": "infringing_file",\n    "error_code": 35\n}';
    let sends = 0;
    const send = async () => {
      sends++;
      throw new RdRefusalError("addTorrent", raw);
    };

    const err = await throughAccountBlock(send, { account: "rd:gives-up", ...clock }).catch(
      (e) => e,
    );

    expect(err).toBeInstanceOf(RdAccountBlockedError);
    expect(sends).toBe(4);
    expect(err.message).toBe(
      "Real-Debrid refused every add on this account for 7 minutes " +
        '(4 tries, 451 { "error": "infringing_file", "error_code": 35 }). ' +
        "That is usually a temporary block on the account, not a verdict on this release; " +
        "try again later.",
    );
  });

  test("an add behind another's block waits for its retry, plus the follow margin", async () => {
    let now = 5_000_000;
    const holds: AddHold[] = [];
    // The refused add, left holding the account.
    const first = throughAccountBlock(
      async () => {
        throw new RdRefusalError("addMagnet", BODY);
      },
      {
        account: "rd:follow",
        now: () => now,
        // Park the refused add on its first wait so its block stays up.
        sleepFor: () => new Promise(() => {}),
      },
    );
    await new Promise((r) => setTimeout(r, 0));

    now += 5_200;
    const follower = throughAccountBlock(async () => "RDID", {
      account: "rd:follow",
      now: () => now,
      onHold: (h) => holds.push(h),
      sleepFor: async (ms) => {
        now += ms;
      },
    });

    expect(await follower).toBe("RDID");
    expect(holds).toEqual([
      { waitMs: 30_000 - 5_200 + RD_ADD_BLOCK_FOLLOW_MS, refused: false, refusals: 0 },
    ]);
    void first;
  });

  test("an abort mid-wait stops the add and releases the account", async () => {
    const controller = new AbortController();
    const reason = new Error("job deleted");
    let sends = 0;

    const err = await throughAccountBlock(
      async () => {
        sends++;
        throw new RdRefusalError("addMagnet", BODY);
      },
      {
        account: "rd:aborted",
        signal: controller.signal,
        // Real clock and real abortable sleep: the abort is what ends the wait.
        onHold: () => controller.abort(reason),
      },
    ).catch((e) => e);

    expect(err).toBe(reason);
    expect(sends).toBe(1);

    const clock = steppingClock();
    const next = scripted(["ok"], clock);
    await throughAccountBlock(next, { account: "rd:aborted", ...clock });
    expect(clock.slept).toEqual([]);
  });

  test("a job deleted while its add waited is never sent, and frees the account", async () => {
    const clock = steppingClock();
    const send = scripted(["451"], clock);
    let deleted = false;

    const err = await throughAccountBlock(send, {
      account: "rd:deleted",
      onHold: () => {
        deleted = true;
      },
      cancelled: () => deleted,
      ...clock,
    }).catch((e) => e);

    expect(err).toBeInstanceOf(RdAddCancelledError);
    expect(send.sent).toHaveLength(1);
    const next = scripted(["ok"], clock);
    await throughAccountBlock(next, { account: "rd:deleted", ...clock });
    expect(clock.slept).toEqual([30_000]);
  });

  test("an add whose job has already been cancelled is never sent", async () => {
    const controller = new AbortController();
    controller.abort(new Error("stalled"));
    const clock = steppingClock();
    const send = scripted(["ok"], clock);

    await expect(
      throughAccountBlock(send, { account: "rd:cancelled", signal: controller.signal, ...clock }),
    ).rejects.toThrow("stalled");
    expect(send.sent).toEqual([]);
  });
});

describe("a hold inside the preparing stage's clock", () => {
  // `worker.ts` runs the destination add under a one-minute stage timeout and
  // reports every hold to it. These use a 50 ms stage, and a clock on which each
  // nominal wait (30 s, 90 s, ...) passes in 80 ms of real time.
  const stageMs = 50;
  function compressedTime() {
    let t = 0;
    return {
      now: () => t,
      sleepFor: async (ms: number, signal?: AbortSignal) => {
        await sleepUnlessAborted(80, signal);
        t += ms;
      },
    };
  }

  test("extends the stage instead of timing it out", async () => {
    const answers: ("451" | "ok")[] = ["451", "ok"];
    const id = await withExtendableTimeout(
      ({ extend, signal }) =>
        throughAccountBlock(
          async () => {
            if (answers.shift() === "451") throw new RdRefusalError("addTorrent", BODY);
            return "RDID";
          },
          {
            account: "rd:stage-extends",
            signal,
            ...compressedTime(),
            onHold: (h) => extend(h.waitMs),
          },
        ),
      stageMs,
    );
    expect(id).toBe("RDID");
  });

  test("a stage that does time out sends no further add afterwards", async () => {
    let sends = 0;
    const err = await withExtendableTimeout(
      ({ signal }) =>
        throughAccountBlock(
          async () => {
            sends++;
            throw new RdRefusalError("addTorrent", BODY);
          },
          // No extend: the stage clock runs out during the wait.
          { account: "rd:stage-expires", signal, ...compressedTime() },
        ),
      stageMs,
    ).catch((e) => e);

    expect(err.message).toBe("Stage timed out after 0 minutes");
    await new Promise((r) => setTimeout(r, 120));
    expect(sends).toBe(1);
  });
});
