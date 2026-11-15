import type { Destination } from "./db";

export type ParsedJobInput = {
  input: string;
  imdbId: string;
  /**
   * Mandatory for the `rd` destination and optional for `torbox`, where it is a
   * *source* credential and AllDebrid can stand in for it.
   */
  rdApiKey?: string;
  torboxApiKey?: string;
  alldebridApiKey?: string;
  premiumizeApiKey?: string;
  destination: Destination;
};

export type JobInputBody = {
  input?: string;
  imdb_id?: string;
  rd_api_key?: string;
  tb_api_key?: string;
  ad_api_key?: string;
  pm_api_key?: string;
  destination?: string;
};

/**
 * Where this job delivers. Defaults to `rd`, which is what every submission
 * meant before there was a choice.
 *
 * AllDebrid is rejected rather than silently accepted: it ignores BEP19
 * webseeds outright — measured, with a control that had it take the same file
 * over BitTorrent from the very host whose webseed it never requested — so a
 * job pointed at it could only ever sit at zero until the stall detector killed
 * it. Refusing at the door is the one place that mistake is still cheap.
 */
export function parseDestination(raw: string | undefined): Destination {
  const value = raw?.trim().toLowerCase();
  if (!value || value === "rd" || value === "realdebrid") return "rd";
  if (value === "torbox" || value === "tb") return "torbox";
  if (value === "premiumize" || value === "pm") return "premiumize";
  if (value === "alldebrid" || value === "ad") {
    throw new ValidationError("alldebrid cannot be a destination: it ignores webseeds");
  }
  throw new ValidationError(`unknown destination: ${value}`);
}

/**
 * The submitter's TorBox key, if they supplied one.
 *
 * A single key covers the whole TorBox path: the REST API takes it as a bearer
 * token and the WebDAV host takes it as the Basic-auth password under the fixed
 * username `torbox`. So there is nothing here that can half-match: a job either
 * runs wholly against the submitter's TorBox account or not against TorBox at
 * all.
 */
export function parseTorboxApiKey(body: JobInputBody): string | undefined {
  return body.tb_api_key?.trim() || undefined;
}

/**
 * The submitter's AllDebrid key, if they supplied one.
 *
 * Like the TorBox key this covers the provider outright, though for the
 * opposite reason: AllDebrid's file links carry their own token, so there is no
 * second host that could end up authenticated against a different account.
 */
export function parseAlldebridApiKey(body: JobInputBody): string | undefined {
  return body.ad_api_key?.trim() || undefined;
}

/**
 * The submitter's Premiumize key, if they supplied one.
 *
 * Simplest of the four: Premiumize is only ever a *destination* here, so this
 * key authenticates the REST API and nothing else. There is no second host
 * reading bytes under it, and no cache probe spending anyone's quota.
 */
export function parsePremiumizeApiKey(body: JobInputBody): string | undefined {
  return body.pm_api_key?.trim() || undefined;
}

/**
 * Every job must arrive with its own credentials. There is no operator fallback.
 *
 * There used to be one: an absent key resolved to the shared env credential, so
 * a submission that simply omitted `tb_api_key` spent the operator's TorBox
 * quota and counted against *their* abuse threshold. It was invisible from the
 * outside — the job ran perfectly well — and one submission in seven was doing
 * it. Refusing at the door is the only place the mistake is still cheap.
 *
 * **Real-Debrid is mandatory** because it is the destination: without a key the
 * content lands in somebody else's account, which is a data-placement error, not
 * a performance one. **At least one cache source is mandatory** because a job
 * with neither has no way to obtain bytes and would fail as `uncached` after
 * spending two provider probes to discover it. Which one is up to the submitter:
 * TorBox alone, AllDebrid alone, or both.
 */
function parseCredentials(
  body: JobInputBody,
  destination: Destination,
): {
  rdApiKey?: string;
  torboxApiKey?: string;
  alldebridApiKey?: string;
  premiumizeApiKey?: string;
} {
  const rdApiKey = body.rd_api_key?.trim() || undefined;
  const torboxApiKey = parseTorboxApiKey(body);
  const alldebridApiKey = parseAlldebridApiKey(body);
  const premiumizeApiKey = parsePremiumizeApiKey(body);

  // The rule is one and the same in both directions — **the destination key is
  // mandatory, and at least one source key with it** — only the provider filling
  // each role swaps over. Written as the general rule rather than as two special
  // cases, so a third destination cannot be added without answering both halves.
  if (destination === "torbox") {
    if (!torboxApiKey) throw new ValidationError("tb_api_key is required for destination=torbox");
    if (!rdApiKey && !alldebridApiKey) {
      throw new ValidationError("rd_api_key or ad_api_key is required for destination=torbox");
    }
  } else if (destination === "premiumize") {
    if (!premiumizeApiKey) {
      throw new ValidationError("pm_api_key is required for destination=premiumize");
    }
    // Three possible sources rather than two, because Premiumize is the only
    // destination that is not also a cache source for this pipeline — nothing
    // has to be held back to avoid sourcing a job from its own destination.
    if (!rdApiKey && !torboxApiKey && !alldebridApiKey) {
      throw new ValidationError(
        "rd_api_key, tb_api_key or ad_api_key is required for destination=premiumize",
      );
    }
  } else {
    if (!rdApiKey) throw new ValidationError("rd_api_key is required");
    if (!torboxApiKey && !alldebridApiKey) {
      throw new ValidationError("tb_api_key or ad_api_key is required");
    }
  }

  return { rdApiKey, torboxApiKey, alldebridApiKey, premiumizeApiKey };
}

export function parseJobInput(body: JobInputBody): ParsedJobInput {
  if (!body.input?.trim()) throw new ValidationError("input is required");
  if (!body.imdb_id?.trim() || !/^tt\d+$/.test(body.imdb_id.trim())) {
    throw new ValidationError("imdb_id is required (format: tt1234567)");
  }

  const destination = parseDestination(body.destination);
  const creds = parseCredentials(body, destination);
  let input = body.input.trim();

  if (!input.startsWith("magnet:")) {
    const hash = extractInfoHash(input);
    if (!hash) {
      throw new ValidationError("input must contain a 40-char info hash or magnet URI");
    }
    input = `magnet:?xt=urn:btih:${hash}`;
  }

  return { input, imdbId: body.imdb_id.trim(), destination, ...creds };
}

export function extractInfoHash(raw: string): string | null {
  const btihMatch = raw.match(/btih:([0-9a-fA-F]{40})/i);
  if (btihMatch) return btihMatch[1].toLowerCase();

  const hexMatch = raw.match(/[0-9a-fA-F]{40}/);
  if (hexMatch) return hexMatch[0].toLowerCase();

  return null;
}

/** How many rows a listing returns when the caller names no bound, and its ceiling. */
export const DEFAULT_PAGE_LIMIT = 100;
export const MAX_PAGE_LIMIT = 500;

/**
 * The `limit`/`offset` of a paged listing, clamped rather than rejected.
 *
 * Clamped because the caller is a polling UI, not an operator: a page that
 * answers 400 for a bad number turns a mistyped query into a broken Transfers
 * page, while a page that quietly returns the default keeps working. The
 * ceiling is the part that matters — without it `?limit=999999` re-opens the
 * unbounded listing that scoping the query was meant to close.
 *
 * Lives here rather than in the route because `src/app.ts` is coverage-ignored,
 * so anything decided there is decided untested.
 */
export function parsePageParams(
  rawLimit: string | undefined,
  rawOffset: string | undefined,
): { limit: number; offset: number } {
  return {
    limit: clampInt(rawLimit, DEFAULT_PAGE_LIMIT, 1, MAX_PAGE_LIMIT),
    offset: clampInt(rawOffset, 0, 0, Number.MAX_SAFE_INTEGER),
  };
}

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  // The emptiness check has to come first, because `Number("")` is **0**, not
  // NaN. `?limit=` is what a URL with a valueless param produces, so without
  // this it clamps to the minimum and the page returns a single row — a default
  // silently becoming its opposite.
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  // Covers "abc" and Infinity together: only a finite number is worth clamping,
  // and anything else is the caller not having said.
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}
