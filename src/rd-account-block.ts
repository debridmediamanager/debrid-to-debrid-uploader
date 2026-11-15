import { counters } from "./metrics";
import { rdBlocksName } from "./naming";
import { sleepUnlessAborted } from "./utils/async";

/**
 * What a 451 on an add means, and how long to wait one out.
 *
 * RD answers `addMagnet`/`addTorrent` with `451 {"error": "infringing_file",
 * "error_code": 35}` in two situations that look identical on the wire: a real
 * refusal of that release's *name*, and a short block on the **whole account**,
 * during which every add is refused — Big Buck Bunny and hashes the account
 * accepted minutes earlier included. Measured 2026-10-04/05 on one account
 * (workspace docs/providers/real-debrid.md §9, recorded in
 * `fixtures/realdebrid/add-451-account-block-2026-10.json`): blocks lasted 21 s
 * to ~5 min, a refusal during one did not lengthen it, and E.T., refused on two
 * accounts and filed as a content block, was accepted the next night. Only
 * names carrying a pattern RD filters stayed refused every time.
 *
 * So a 451 alone is not a verdict. A name carrying one of the patterns RD
 * filters is never sent. On a dedicated account on 2026-10-13/14 RD refused
 * 37 of 46 tagged titles and accepted 1 of those 37 when re-added an hour
 * later, against 4 of 9 refused untagged ones, so the add would only be spent
 * (`fixtures/realdebrid/add-451-name-refusal-2026-10-13.json`). A 451 on any
 * other name is retried on this ladder, and other adds on the same account
 * wait instead of being fired into the block.
 *
 * It is deliberately not part of `isTransient` in `realdebrid.ts`: that ladder
 * retries within ~15 s, which would spend five adds inside the block.
 */

/** Waits before re-trying an add after each 451: ~7 minutes in all. */
export const RD_ADD_BLOCK_BACKOFF_MS: readonly number[] = [30_000, 90_000, 300_000];

/**
 * How long an add waiting behind another add's 451 stays behind it, so the
 * refused add retries first and its answer decides whether the rest go.
 */
export const RD_ADD_BLOCK_FOLLOW_MS = 5_000;

/** RD's 451 on a request, before anything has decided what it means. */
export class RdRefusalError extends Error {
  readonly body: string;

  constructor(label: string, body: string) {
    super(`RD ${label} failed: 451 ${body}`);
    // Assigned here, not as field initializers: see the note in `metrics.ts`.
    this.name = "RdRefusalError";
    this.body = body;
  }
}

/** A name carrying a pattern RD's filename filter refuses, so the add was never sent. */
export class RdReleaseRefusedError extends Error {
  constructor(name: string) {
    super(
      `Real-Debrid refuses "${name}": its name carries a pattern RD blocks (451 infringing_file), so it was not sent`,
    );
    this.name = "RdReleaseRefusedError";
  }
}

/**
 * Every add on this account was refused for the whole ladder.
 *
 * Retryable, not a verdict: the longest block measured was ~5 min, so this is
 * an account that stayed blocked unusually long, and a later attempt is the
 * right answer rather than calling the release unavailable.
 */
export class RdAccountBlockedError extends Error {
  constructor(tries: number, body: string) {
    const minutes = Math.round(RD_ADD_BLOCK_BACKOFF_MS.reduce((a, b) => a + b, 0) / 60_000);
    super(
      `Real-Debrid refused every add on this account for ${minutes} minutes ` +
        `(${tries} tries, 451 ${flat(body)}). That is usually a temporary block on ` +
        `the account, not a verdict on this release; try again later.`,
    );
    this.name = "RdAccountBlockedError";
  }
}

/**
 * The job was cancelled while its add waited out a block.
 *
 * Without this a deleted job would wake minutes later and add a torrent to the
 * submitter's account with a key the deletion has already cleared from its row.
 */
export class RdAddCancelledError extends Error {
  constructor() {
    super("Cancelled while waiting out a Real-Debrid block");
    this.name = "RdAddCancelledError";
  }
}

function flat(body: string): string {
  return body.replace(/\s+/g, " ").trim();
}

/** A deliberate wait, reported before it starts. */
export type AddHold = {
  waitMs: number;
  /** Whether this add was itself refused, rather than waiting behind another add's 451. */
  refused: boolean;
  /** How many 451s this add has had so far. */
  refusals: number;
};

export type AccountBlockOptions = {
  apiKey?: string;
  /**
   * The RD account behind `apiKey` as `owners.ts` resolves it (`rd:67890`).
   * The block is the account's, and one account can reach us under more than
   * one key (OAuth access tokens rotate), so this keys the hold when known.
   */
  account?: string;
  /** Names RD judges this add on: the torrent's root name, and its file names. */
  names?: readonly string[];
  /** Ends a wait early: the job stalled or ran out of time. */
  signal?: AbortSignal;
  /** Checked after every wait; true (the job was deleted) ends the add unsent. */
  cancelled?: () => boolean;
  /** Told before each wait, so the caller can show it and keep its clocks off it. */
  onHold?: (hold: AddHold) => void;
  sleepFor?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
};

type Block = { until: number; owner: symbol };

/** Accounts currently refusing adds, by `accountKeyFor`. Never shared across accounts. */
const blocks = new Map<string, Block>();

/** Test seam. */
export function _clearAccountBlocks(): void {
  blocks.clear();
}

/**
 * The key a block is held under: the resolved account, or a digest of the key
 * when that lookup failed — the same `rd:key:<12 hex>` form `owners.ts` falls
 * back to, so a raw key is never held or logged.
 */
export function accountKeyFor(opts: { apiKey?: string; account?: string }): string {
  if (opts.account) return opts.account;
  const digest = new Bun.CryptoHasher("sha256")
    .update(opts.apiKey ?? "")
    .digest("hex")
    .slice(0, 12);
  return `rd:key:${digest}`;
}

/** The first name carrying a pattern RD's filter refuses. */
export function blockedNameIn(names: readonly string[] = []): string | undefined {
  return names.find(rdBlocksName);
}

/** The job's status line while it waits. */
export function describeAddHold(hold: AddHold): string {
  const secs = Math.ceil(hold.waitMs / 1000);
  if (hold.refused) {
    return (
      `Real-Debrid is refusing adds on this account (451), usually for a few minutes; ` +
      `trying again in ${secs}s (${hold.refusals}/${RD_ADD_BLOCK_BACKOFF_MS.length})`
    );
  }
  return `Waiting ${secs}s for a Real-Debrid block on this account to lift`;
}

/**
 * Send one add, riding out an account block.
 *
 * Every add on an account passes the same gate. While the account is blocked
 * an add that was refused waits for its next rung and then retries; any other
 * add waits a little longer, so it goes only once that retry has answered. An
 * accepted add ends the block for everyone. When the ladder runs out the block
 * is dropped too, and the next add becomes the one that tries.
 */
export async function throughAccountBlock<T>(
  send: () => Promise<T>,
  opts: AccountBlockOptions = {},
): Promise<T> {
  const key = accountKeyFor(opts);
  const me = Symbol(key);
  const now = opts.now ?? Date.now;
  const sleepFor = opts.sleepFor ?? sleepUnlessAborted;
  let refusals = 0;

  const blocked = blockedNameIn(opts.names);
  if (blocked !== undefined) {
    counters.inc("rd.add_name_refused");
    throw new RdReleaseRefusedError(blocked);
  }

  try {
    for (;;) {
      const block = blocks.get(key);
      if (block) {
        const resumeAt = block.until + (block.owner === me ? 0 : RD_ADD_BLOCK_FOLLOW_MS);
        const waitMs = resumeAt - now();
        if (waitMs > 0) {
          opts.onHold?.({ waitMs, refused: refusals > 0, refusals });
          await sleepFor(waitMs, opts.signal);
          if (opts.cancelled?.()) throw new RdAddCancelledError();
          continue;
        }
      }
      opts.signal?.throwIfAborted();

      try {
        const result = await send();
        if (blocks.delete(key)) {
          counters.inc("rd.add_block_lifted");
          console.log(`[realdebrid] ${key} accepted an add again, releasing held adds`);
        }
        return result;
      } catch (err) {
        if (!(err instanceof RdRefusalError)) throw err;
        if (refusals >= RD_ADD_BLOCK_BACKOFF_MS.length) {
          counters.inc("rd.add_block_gave_up");
          throw new RdAccountBlockedError(refusals + 1, err.body);
        }
        const delay = RD_ADD_BLOCK_BACKOFF_MS[refusals++];
        counters.inc("rd.add_blocked");
        const until = Math.max(now() + delay, blocks.get(key)?.until ?? 0);
        blocks.set(key, { until, owner: me });
        console.log(
          `[realdebrid] ${key} add refused (451), holding adds on this account ` +
            `${delay / 1000}s (${refusals}/${RD_ADD_BLOCK_BACKOFF_MS.length})`,
        );
      }
    }
  } finally {
    if (blocks.get(key)?.owner === me) blocks.delete(key);
  }
}
