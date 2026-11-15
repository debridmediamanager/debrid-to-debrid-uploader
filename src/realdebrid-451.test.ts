import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import recorded from "./fixtures/realdebrid/add-451-account-block-2026-10.json";
import * as rd from "./realdebrid";

/**
 * Regression for the overloaded 451 on adds, driven by what RD actually answered.
 *
 * The fixture is two recorded sequences from one account (2026-10-04/05). In
 * both, RD refuses every add with the same `451 infringing_file` a real refusal
 * gives, Big Buck Bunny and hashes the account had just accepted included, and
 * then accepts again within seconds. A job used to take the first of those 451s
 * as its final answer.
 */

type Recorded = (typeof recorded.sequences.et)[number];

const at = (iso: string) => Date.parse(iso);

/**
 * Virtual time shared by every caller in a test, so two jobs' waits interleave
 * the way real timers would without the test waiting minutes.
 */
function virtualClock(startIso: string) {
  let now = at(startIso);
  const timers: { at: number; fire: () => void }[] = [];
  const clock = {
    now: () => now,
    sleepFor: (ms: number) =>
      new Promise<void>((fire) => {
        timers.push({ at: now + ms, fire });
      }),
    /** Run `work` to completion, firing the earliest pending timer whenever it idles. */
    async run<T>(work: Promise<T>[]): Promise<PromiseSettledResult<T>[]> {
      let done = false;
      const all = Promise.allSettled(work).then((r) => {
        done = true;
        return r;
      });
      for (let spins = 0; !done && spins < 10_000; spins++) {
        await new Promise((r) => setTimeout(r, 0));
        if (done || timers.length === 0) continue;
        timers.sort((a, b) => a.at - b.at);
        const next = timers.shift() as { at: number; fire: () => void };
        now = Math.max(now, next.at);
        next.fire();
      }
      return all;
    },
  };
  return clock;
}

/**
 * RD as the fixture recorded it: one account, blocked from a sequence's first
 * 451 until the next add RD accepted, open otherwise. An add made at a recorded
 * instant gets the recorded answer, which the tests check the model reproduces.
 */
function replayedAccount(seq: Recorded[], clock: { now: () => number }) {
  const firstRefusal = seq.find((r) => r.status === 451) as Recorded;
  const lifted = seq.find((r) => r.status === 201 && at(r.at) > at(firstRefusal.at)) as Recorded;
  const adds: { at: number; hash: string; status: number }[] = [];
  let ids = 0;

  const fetcher: rd.Fetcher = async (_url, init) => {
    const body = decodeURIComponent(String(init?.body ?? ""));
    const hash = body.match(/btih:([0-9a-f]{40})/i)?.[1]?.toLowerCase() ?? "torrent-file";
    const now = clock.now();
    const blocked = now >= at(firstRefusal.at) && now < at(lifted.at);
    const status = blocked ? 451 : 201;
    adds.push({ at: now, hash, status });
    if (status === 451) {
      const same = seq.find((r) => r.status === 451);
      return new Response((same as Recorded).body, { status: 451 });
    }
    // The probe kept no 201 bodies; RD's carries the new torrent's id.
    ids++;
    return Response.json(
      { id: `RDID${ids}`, uri: `https://real-debrid.com/torrents/info/RDID${ids}` },
      { status: 201 },
    );
  };
  return { fetcher, adds, blockedFrom: at(firstRefusal.at), liftedAt: at(lifted.at) };
}

const magnet = (hash: string) => `magnet:?xt=urn:btih:${hash}`;

function tempTorrent(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "debrid-rd451-"));
  const file = path.join(dir, "Clean.Name.2025.1080p {imdb-tt0000001}.torrent");
  fs.writeFileSync(file, "d4:infod4:name5:cleanee");
  return file;
}

describe("a 451 on an add during a recorded account block", () => {
  test("the replay reproduces every recorded answer", () => {
    for (const seq of [recorded.sequences.et, recorded.sequences.r2]) {
      const clock = { now: () => 0 };
      const account = replayedAccount(seq, clock);
      for (const r of seq) {
        const blocked = at(r.at) >= account.blockedFrom && at(r.at) < account.liftedAt;
        expect(blocked ? 451 : 201).toBe(r.status);
      }
    }
  });

  test("E.T. refused at 22:53:40 is retried after 30 s and accepted, not failed", async () => {
    // 2026-10-04: RD refused E.T. and then took the very next control 17 s
    // later; two hours on it accepted E.T. itself. One 451 was the account.
    const seq = recorded.sequences.et;
    const et = seq.find((r) => r.kind === "refused") as Recorded;
    const clock = virtualClock(et.at);
    const account = replayedAccount(seq, clock);

    const [result] = await clock.run([
      rd.addMagnet(magnet(et.hash), {
        apiKey: "RD_KEY_ET",
        account: "rd:fixture-et",
        fetcher: account.fetcher,
        sleepFor: clock.sleepFor,
        now: clock.now,
      } as rd.RdAddOptions),
    ]);

    expect(result).toEqual({ status: "fulfilled", value: "RDID1" });
    expect(account.adds.map((a) => a.status)).toEqual([451, 201]);
    // The retry waited the first rung of the ladder, and no more.
    expect(account.adds[1].at - account.adds[0].at).toBe(30_000);
  });

  test("a second add on the same account holds instead of firing into the block", async () => {
    // 2026-10-05 01:00:42 c5c19c1c was refused; the control 1e7cef09, accepted
    // by this account earlier that night, was fired 5 s later and refused too.
    // Holding it until the first add's retry resolves spares that refusal.
    const seq = recorded.sequences.r2;
    const first = seq.find((r) => r.kind === "fresh" && r.status === 451) as Recorded;
    const second = seq.find((r) => r.kind === "control") as Recorded;
    const clock = virtualClock(first.at);
    const account = replayedAccount(seq, clock);
    const opts = {
      apiKey: "RD_KEY_R2",
      account: "rd:fixture-r2",
      fetcher: account.fetcher,
      sleepFor: clock.sleepFor,
      now: clock.now,
    } as rd.RdAddOptions;

    const results = await clock.run([
      rd.addMagnet(magnet(first.hash), opts),
      clock
        .sleepFor(at(second.at) - at(first.at))
        .then(() => rd.addMagnet(magnet(second.hash), opts)),
    ]);

    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
    // Nothing reached RD between the refusal and the block lifting.
    const duringBlock = account.adds.filter(
      (a) => a.at > account.blockedFrom && a.at < account.liftedAt,
    );
    expect(duringBlock).toEqual([]);
    // The held add went after the first add's retry, never into a 451.
    const secondAdds = account.adds.filter((a) => a.hash === second.hash);
    expect(secondAdds).toHaveLength(1);
    expect(secondAdds[0].status).toBe(201);
    const firstRetry = account.adds.filter((a) => a.hash === first.hash)[1];
    expect(secondAdds[0].at).toBeGreaterThan(firstRetry.at);
  });

  test("another account's add is not held by this account's block", async () => {
    const seq = recorded.sequences.r2;
    const first = seq.find((r) => r.kind === "fresh" && r.status === 451) as Recorded;
    const second = seq.find((r) => r.kind === "control") as Recorded;
    const clock = virtualClock(first.at);
    const blockedAccount = replayedAccount(seq, clock);
    const otherAdds: number[] = [];
    const other: rd.Fetcher = async () => {
      otherAdds.push(clock.now());
      return Response.json({ id: "OTHER" }, { status: 201 });
    };

    await clock.run([
      rd.addMagnet(magnet(first.hash), {
        apiKey: "RD_KEY_A",
        account: "rd:fixture-a",
        fetcher: blockedAccount.fetcher,
        sleepFor: clock.sleepFor,
        now: clock.now,
      } as rd.RdAddOptions),
      clock.sleepFor(at(second.at) - at(first.at)).then(() =>
        rd.addMagnet(magnet(second.hash), {
          apiKey: "RD_KEY_B",
          account: "rd:fixture-b",
          fetcher: other,
          sleepFor: clock.sleepFor,
          now: clock.now,
        } as rd.RdAddOptions),
      ),
    ]);

    expect(otherAdds).toEqual([at(second.at)]);
  });

  test("the destination add (addTorrent) rides out the same block", async () => {
    // Our rewritten torrent carries a de-infringed name and a fresh info hash,
    // so a 451 on it can only be the account.
    const seq = recorded.sequences.et;
    const clock = virtualClock((seq.find((r) => r.kind === "refused") as Recorded).at);
    const account = replayedAccount(seq, clock);

    const [result] = await clock.run([
      rd.addTorrent(tempTorrent(), {
        apiKey: "RD_KEY_DEST",
        account: "rd:fixture-dest",
        fetcher: account.fetcher,
        sleepFor: clock.sleepFor,
        now: clock.now,
      } as rd.RdAddOptions),
    ]);

    expect(result.status).toBe("fulfilled");
    expect(account.adds.map((a) => a.status)).toEqual([451, 201]);
  });

  test("a block outlasting the ladder ends retryable, not as a permanent verdict", async () => {
    // Longer than any block measured (21 s to ~5 min): 30 + 90 + 300 s of
    // waiting, then a failure the job's own retry ladder may still carry.
    const clock = virtualClock("2026-10-05T01:00:42.0Z");
    const sends: number[] = [];
    const alwaysBlocked: rd.Fetcher = async () => {
      sends.push(clock.now());
      return new Response(recorded.sequences.r2[3].body, { status: 451 });
    };

    const [result] = await clock.run([
      rd.addMagnet(magnet("c5c19c1c8c8ddaa6f3094987cf71f96330025025"), {
        apiKey: "RD_KEY_LONG",
        account: "rd:fixture-long",
        fetcher: alwaysBlocked,
        sleepFor: clock.sleepFor,
        now: clock.now,
      } as rd.RdAddOptions),
    ]);

    expect(result.status).toBe("rejected");
    const err = (result as PromiseRejectedResult).reason;
    expect(sends.map((t) => (t - sends[0]) / 1000)).toEqual([0, 30, 120, 420]);
    expect(rd.isPermanentRdError(err)).toBe(false);
    expect(err.name).toBe("RdAccountBlockedError");
  });
});
