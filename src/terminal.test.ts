import { describe, expect, test } from "bun:test";
import { AlldebridError } from "./alldebrid";
import { MaxDurationError, OversizeError } from "./deadline";
import { isAlldebridRefusal, UncachedError } from "./downloads";
import { UnservableSourceError } from "./proxy";
import { RdAccountBlockedError, RdRefusalError, RdReleaseRefusedError } from "./rd-account-block";
import { RdAuthError, RdMissingTorrentError } from "./realdebrid";
import { TakedownBlockedError } from "./takedown";
import { isTerminalError } from "./terminal";
import { PlanRestrictedError } from "./torbox";

describe("isTerminalError", () => {
  test("a source that claims cached and serves 404 is terminal", () => {
    // The regression this file exists for. Measured on debrid02: 136 of 137
    // jobs that hit this burned all three stage retries and failed, and
    // re-probing their hashes afterwards showed the content was never there —
    // so the ladder could only re-derive the same answer while holding a
    // TorBox slot and re-running `createtorrent` each time.
    expect(isTerminalError(new UnservableSourceError("TorBox", 404, "Show/ep.mkv"))).toBe(true);
  });

  test("a source failing with a 5xx stays retryable", () => {
    // TorBox being down is not TorBox being wrong. Keeping this retryable is
    // what stops one bad hour becoming permanent failures.
    expect(isTerminalError(new UnservableSourceError("TorBox", 503, "Show/ep.mkv"))).toBe(false);
    expect(isTerminalError(new UnservableSourceError("TorBox", 500, "Show/ep.mkv"))).toBe(false);
  });

  test("a takedown refusal is terminal", () => {
    expect(isTerminalError(new TakedownBlockedError("hash"))).toBe(true);
    expect(isTerminalError(new TakedownBlockedError("release"))).toBe(true);
  });

  test("an RD account that kept refusing adds stays retryable", () => {
    // A 451 is usually a block on the whole account for seconds to minutes
    // (measured 2026-10-04/05). One that outlasted the add's own ~7 minute
    // ladder still gets the stage's retries, never a permanent verdict.
    const body = '{ "error": "infringing_file", "error_code": 35 }';
    expect(isTerminalError(new RdAccountBlockedError(4, body))).toBe(false);
    expect(isTerminalError(new RdRefusalError("addMagnet", body))).toBe(false);
  });

  test("a name RD filters is left to the existing retry and source rules", () => {
    // Never sent to RD, but the job may still have another source whose own
    // failure was transient, and only the last source's error reaches here.
    const err = new RdReleaseRefusedError("X.WEB-DL");
    expect(isTerminalError(err)).toBe(false);
  });

  test("an uncached verdict is terminal", () => {
    expect(isTerminalError(new UncachedError())).toBe(true);
  });

  test("a plan restriction is terminal", () => {
    expect(isTerminalError(new PlanRestrictedError('{"error":"PLAN_RESTRICTED_FEATURE"}'))).toBe(
      true,
    );
  });

  test("a spent duration budget is terminal", () => {
    expect(isTerminalError(new MaxDurationError(3 * 3600_000, 2 * 3600_000))).toBe(true);
  });

  // A release does not shrink between attempts, and the whole point of refusing
  // it is that no bytes move — sending it round the ladder would re-derive the
  // same size three times and re-create the provider torrent each time.
  test("an oversize release is terminal", () => {
    expect(isTerminalError(new OversizeError(200e9, 100e9))).toBe(true);
  });

  test("permanent Real-Debrid errors are terminal", () => {
    expect(isTerminalError(new RdAuthError(401, '{"error":"bad_token"}'))).toBe(true);
    expect(isTerminalError(new RdMissingTorrentError('{"error":"unknown_ressource"}'))).toBe(true);
  });

  // AllDebrid refusing to be *asked* used to be swallowed into a null return,
  // which the source loop read as a clean "not cached" and turned into a
  // terminal `uncached`. Measured live 2026-08-29: debrid02 answers `NO_SERVER`
  // to every `magnet/upload` (its Hetzner address is blocked) and has 0
  // AllDebrid completions in its entire history, while a since-retired host's dominant
  // AllDebrid log line over 7 days was 19 × `AUTH_BLOCKED` against 5 cache
  // hits. Every one of those jobs told the submitter the release was uncached.
  test("AllDebrid refusing the caller is terminal, not a cache verdict", () => {
    expect(
      isTerminalError(new AlldebridError("NO_SERVER", "Servers are not allowed to use this")),
    ).toBe(true);
    expect(
      isTerminalError(new AlldebridError("AUTH_BLOCKED", "You are logging from a new location")),
    ).toBe(true);
    expect(
      isTerminalError(new AlldebridError("AUTH_BAD_APIKEY", "The auth apikey is invalid")),
    ).toBe(true);
  });

  test("an ordinary AllDebrid error still goes through the retry ladder", () => {
    // Only the refusals are permanent. A transient API fault is AllDebrid being
    // down, not AllDebrid being wrong.
    expect(isTerminalError(new AlldebridError("MAGNET_INVALID_ID", "This ID is invalid"))).toBe(
      false,
    );
  });

  test("the refusal test reads the code, never the message text", () => {
    // The old NO_SERVER check was `String(err).includes("NO_SERVER")`, which any
    // error mentioning the string could satisfy.
    expect(isAlldebridRefusal(new Error("upstream said NO_SERVER"))).toBe(false);
    expect(isAlldebridRefusal(new AlldebridError("NO_SERVER", "blocked"))).toBe(true);
  });

  test("an ordinary failure still goes through the retry ladder", () => {
    expect(isTerminalError(new Error("connection reset"))).toBe(false);
    expect(isTerminalError(undefined)).toBe(false);
  });
});
