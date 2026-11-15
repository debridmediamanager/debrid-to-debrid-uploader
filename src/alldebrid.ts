import { MissingCredentialError } from "./credentials";
import { counters } from "./metrics";

const API = "https://api.alldebrid.com";

/**
 * Per-call AllDebrid credentials. An absent key falls back to the shared env
 * one, matching how `torbox.ts` and `realdebrid.ts` resolve theirs.
 *
 * Unlike TorBox there is no second host to authenticate: the links AllDebrid
 * hands back from `/link/unlock` carry their own token in the path and are
 * fetched with no `Authorization` header at all. So this key covers the whole
 * AllDebrid path on its own.
 */
export type AlldebridOptions = {
  apiKey?: string;
};

function keyFor(opts: AlldebridOptions): string {
  if (!opts.apiKey) throw new MissingCredentialError("AllDebrid");
  return opts.apiKey;
}

function authHeaders(opts: AlldebridOptions): Record<string, string> {
  return { Authorization: `Bearer ${keyFor(opts)}` };
}

/** An application-level rejection, carrying AllDebrid's own error code. */
export class AlldebridError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`AllDebrid ${code}: ${message}`);
    // Assigned in the constructor rather than as a class field initializer:
    // Bun counts an initializer as an uncovered function and caps the file
    // below the 100% threshold. See the note in `metrics.ts`.
    this.name = "AlldebridError";
    this.code = code;
  }
}

export class RateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateLimitError";
  }
}

/**
 * One AllDebrid API call, envelope unwrapped.
 *
 * **AllDebrid reports application failures with HTTP 200.** Verified live
 * 2026-08-06: a rejected key returns `200` with
 * `{"status":"error","error":{"code":"AUTH_BAD_APIKEY",…}}`. `res.ok` therefore
 * proves nothing here, exactly as TorBox's `success:false` does not — and that
 * one cost a silently leaked slot on every delete. Unwrapping in one place is
 * what stops a future call site forgetting the check.
 *
 * Rate limits are 12/s and 600/min, and the docs say excess returns *either*
 * 429 or 503, so both map to `RateLimitError`.
 */
async function call<T>(path: string, opts: AlldebridOptions, body?: URLSearchParams): Promise<T> {
  const init: RequestInit = { headers: authHeaders(opts) };
  if (body) {
    init.method = "POST";
    init.body = body;
  }

  const res = await fetch(`${API}${path}`, init);
  if (res.status === 429 || res.status === 503) {
    throw new RateLimitError(`AllDebrid rate limited (${res.status})`);
  }

  const text = await res.text();
  if (!res.ok) throw new Error(`AllDebrid ${path} failed: ${res.status} ${text}`);

  let parsed: { status?: string; data?: T; error?: { code?: string; message?: string } };
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`AllDebrid ${path} returned non-JSON: ${text.slice(0, 200)}`);
  }

  if (parsed.status === "error" || parsed.error) {
    throw new AlldebridError(parsed.error?.code ?? "UNKNOWN", parsed.error?.message ?? text);
  }
  if (parsed.data === undefined) throw new Error(`AllDebrid ${path} returned no data`);
  return parsed.data;
}

// -------------------------------------------------------------------- account

/**
 * Who a key belongs to.
 *
 * AllDebrid exposes no numeric account id, so the **username** is the identity —
 * unlike TorBox and RD, which both return an `id`. That is why `owners.ts` keys
 * an AllDebrid owner on a string rather than a number; the shape of the id is
 * the provider's choice, not ours.
 */
export async function getUser(opts: AlldebridOptions = {}): Promise<{ username: string }> {
  const data = await call<{ user?: { username?: string } }>("/v4/user", opts);
  const username = data.user?.username;
  if (!username) throw new Error("AllDebrid user lookup returned no username");
  return { username };
}

// ------------------------------------------------------------------ magnets

export type AlldebridMagnet = {
  id: number;
  hash: string;
  name: string;
  size: number;
  /**
   * True when AllDebrid already holds the release — the cache signal this
   * whole path is gated on. See `uploadMagnet`.
   */
  ready: boolean;
};

/**
 * Add a magnet and report whether AllDebrid already had it.
 *
 * **This is also the cache check, because AllDebrid no longer has one.**
 * `/v4/magnet/instant` now 404s and `/v4/magnet/status` is `DISCONTINUED`
 * (both verified 2026-08-06), so unlike TorBox's free read-only `checkCached`
 * there is no way to ask before committing. The upload response's `ready` flag
 * is the answer, which means probing the cache can add a magnet to the
 * account — an uncached one starts downloading on AllDebrid's side. Uploads
 * deduplicate held hashes, so the returned id does not prove ownership and
 * `downloads.ts` preserves it even on a miss.
 */
export async function uploadMagnet(
  magnetUri: string,
  opts: AlldebridOptions = {},
): Promise<AlldebridMagnet> {
  const body = new URLSearchParams();
  body.append("magnets[]", magnetUri);

  const data = await call<{
    magnets: {
      id?: number;
      hash?: string;
      name?: string;
      size?: number;
      ready?: boolean;
      error?: { code?: string; message?: string };
    }[];
  }>("/v4/magnet/upload", opts, body);

  const magnet = data.magnets?.[0];
  if (!magnet) throw new Error("AllDebrid upload returned no magnet");
  // A per-magnet rejection rides *inside* a `status: "success"` envelope, so
  // the top-level check in `call` cannot see it.
  if (magnet.error) {
    throw new AlldebridError(magnet.error.code ?? "UNKNOWN", magnet.error.message ?? "upload");
  }
  if (magnet.id === undefined) throw new Error("AllDebrid upload returned no magnet id");

  return {
    id: magnet.id,
    hash: magnet.hash ?? "",
    name: magnet.name ?? "",
    size: magnet.size ?? 0,
    ready: magnet.ready === true,
  };
}

export type AlldebridStatus = {
  id: number;
  filename: string;
  size: number;
  status: string;
  statusCode: number;
};

/** `statusCode` 4 is Ready; anything at or above 5 is one of the error states. */
export const AD_STATUS_READY = 4;

export function isAlldebridError(statusCode: number): boolean {
  return statusCode >= 5;
}

export async function getMagnetStatus(
  id: number,
  opts: AlldebridOptions = {},
): Promise<AlldebridStatus> {
  // v4.1: v4 answers `DISCONTINUED`. A single-id request returns `magnets` as
  // an object; the list form returns an array.
  const data = await call<{ magnets: AlldebridStatus }>(`/v4.1/magnet/status?id=${id}`, opts);
  if (!data.magnets) throw new Error("AllDebrid status returned no magnet");
  return data.magnets;
}

export type AlldebridFile = {
  /** Path as it appears in the torrent, folders included. */
  path: string;
  size: number;
  /** The `alldebrid.com/f/…` locked link; `unlockLink` turns it into bytes. */
  link: string;
};

type FileNode = {
  n: string;
  s?: number;
  l?: string;
  e?: FileNode[];
};

/**
 * Flatten AllDebrid's file tree into torrent-style paths.
 *
 * The tree nests arbitrarily — a node with `e` is a folder, one with `l` is a
 * file — and the docs show a sub-sub-folder case, so this recurses rather than
 * handling one level. Folder names join with `/` to produce exactly the paths
 * a torrent's `info.files` uses, which is what lets `downloads.ts` match them
 * against the rewritten mappings.
 */
export function flattenFiles(nodes: FileNode[], prefix = ""): AlldebridFile[] {
  const out: AlldebridFile[] = [];
  for (const node of nodes) {
    const path = prefix ? `${prefix}/${node.n}` : node.n;
    if (node.e) {
      out.push(...flattenFiles(node.e, path));
    } else if (node.l) {
      out.push({ path, size: node.s ?? 0, link: node.l });
    }
  }
  return out;
}

export async function getMagnetFiles(
  id: number,
  opts: AlldebridOptions = {},
): Promise<AlldebridFile[]> {
  const body = new URLSearchParams();
  body.append("id[]", String(id));

  const data = await call<{
    magnets: { id: string; files?: FileNode[]; error?: { code?: string; message?: string } }[];
  }>("/v4/magnet/files", opts, body);

  const magnet = data.magnets?.[0];
  if (!magnet) throw new Error("AllDebrid files returned no magnet");
  // Same nested-error shape as `uploadMagnet`: `MAGNET_INVALID_ID` arrives as a
  // per-magnet error under a successful envelope.
  if (magnet.error) {
    throw new AlldebridError(magnet.error.code ?? "UNKNOWN", magnet.error.message ?? "files");
  }
  return flattenFiles(magnet.files ?? []);
}

/**
 * Turn a locked `alldebrid.com/f/…` link into a direct, ranged URL.
 *
 * The result is self-authenticating — the token is in the path, and the host
 * honours `Range` (verified 2026-08-06: a ranged read returned `206` with a
 * correct `Content-Range`). That is what makes AllDebrid usable as a webseed
 * upstream at all, and why `proxy.ts` sends no auth header with it.
 */
export async function unlockLink(link: string, opts: AlldebridOptions = {}): Promise<string> {
  const body = new URLSearchParams();
  body.append("link", link);

  const data = await call<{ link?: string }>("/v4/link/unlock", opts, body);
  if (!data.link) throw new Error("AllDebrid unlock returned no link");
  counters.inc("alldebrid.unlocks");
  return data.link;
}

/**
 * Remove a magnet from the account.
 *
 * AllDebrid has no fixed active-slot count the way TorBox Pro has ten, so this
 * is not the hard resource release `torbox.deleteTorrent` is. It matters for
 * two other reasons: an *uncached* probe leaves a magnet AllDebrid would
 * otherwise download in full (see `uploadMagnet`), and a finished job has no
 * reason to keep occupying the account's magnet list.
 */
export async function deleteMagnet(id: number, opts: AlldebridOptions = {}): Promise<void> {
  const body = new URLSearchParams();
  body.append("id", String(id));

  try {
    await call<unknown>("/v4/magnet/delete", opts, body);
  } catch (err) {
    counters.inc("alldebrid.delete_failures");
    throw err;
  }
  counters.inc("alldebrid.deletes");
}
