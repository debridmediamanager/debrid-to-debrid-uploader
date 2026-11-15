import { MaxDurationError, OversizeError } from "./deadline";
import { isAlldebridRefusal, UncachedError } from "./downloads";
import { UnservableSourceError } from "./proxy";
import * as rd from "./realdebrid";
import { TakedownBlockedError } from "./takedown";
import * as torbox from "./torbox";

/**
 * Which failures end a job on sight instead of entering the retry ladder.
 *
 * Extracted from `worker.ts` `retryOrFail` because that file is excluded from
 * coverage, so the decision could not otherwise be tested — the same reason
 * `liveness.ts` exists.
 *
 * The rule the list encodes: a *verdict* is terminal, an *outage* is not. A
 * retry re-enters the stage holding a concurrency slot, a provider slot and a
 * share of the API budget, so it has to be able to change the answer. Where it
 * cannot, the ladder only re-derives the same failure three times over while
 * holding all of that.
 *
 * - `UncachedError` — the probes are deterministic, and AllDebrid's is a create
 *   plus delete against the account every time.
 * - An AllDebrid refusal to be asked at all — a blocked host IP or a rejected
 *   key. Both are verdicts, just about the caller rather than the release, and
 *   neither changes between attempts: `NO_SERVER` needs the address whitelisted
 *   and `AUTH_BLOCKED` needs the account owner to click a link in their email.
 *   They are terminal for the same reason `UncachedError` is, but they must
 *   reach the submitter as themselves — reporting them as `uncached` is what
 *   told people the release did not exist.
 * - `PlanRestrictedError` — a free TorBox account does not become paid between
 *   attempts.
 * - `MaxDurationError` — a retry re-enters with the budget already spent.
 * - `OversizeError` — a release does not shrink between attempts, and the point
 *   of refusing it is that no payload bytes move; a retry would re-derive the
 *   same size while re-creating the provider torrent each round.
 * - A permanent RD error — a rejected token or a torrent RD has lost reads the
 *   same on every poll.
 * - An unservable source, but only on a 404: see below.
 * - `TakedownBlockedError` — a copyright notice does not lapse between attempts.
 */
export function isTerminalError(err: unknown): boolean {
  return (
    err instanceof UncachedError ||
    isAlldebridRefusal(err) ||
    err instanceof torbox.PlanRestrictedError ||
    err instanceof MaxDurationError ||
    err instanceof OversizeError ||
    rd.isPermanentRdError(err) ||
    isUnservableVerdict(err) ||
    err instanceof TakedownBlockedError
  );
}

/**
 * A source that claimed a release and then would not serve it.
 *
 * **Terminal on 404, retryable on anything else, and the split is the whole
 * point.** `assertTorboxServable` already waits out `torboxServableGraceMs`
 * (25s) before believing a 404, which is what covers the materialisation race —
 * an item is absent from WebDAV at 3s and present at 6s. What survives that
 * grace is TorBox asserting a cache entry it cannot back, and measured on
 * debrid02 over 2026-08-11..17 that never recovers: of 137 jobs that hit it,
 * **136 exhausted all three stage retries and failed, and exactly one ever
 * recovered**. Re-probing six of those infohashes through `checkcached`
 * afterwards returned *miss* for all six — the content genuinely was not there,
 * so no retry could have found it. Each wasted attempt re-ran `createtorrent`
 * and took a TorBox slot, roughly 400 needless torrent creations in that sample,
 * which is also the behaviour TorBox's abuse system names first.
 *
 * A 5xx is deliberately left retryable: that is TorBox being down rather than
 * TorBox being wrong, and turning one bad hour into permanent failures is the
 * mistake this codebase already avoids elsewhere.
 *
 * Failing on sight does **not** cost the AllDebrid fallback. That failover runs
 * inside `downloadMagnet`'s source loop in `downloads.ts`, well before the error
 * reaches `retryOrFail` — by the time this predicate sees it, the next source
 * has already had its turn.
 */
function isUnservableVerdict(err: unknown): boolean {
  return err instanceof UnservableSourceError && err.status === 404;
}
