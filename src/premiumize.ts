import fs from "node:fs";
import path from "node:path";
import { MissingCredentialError } from "./credentials";
import { counters } from "./metrics";

const API = "https://www.premiumize.me/api";

/**
 * Per-call Premiumize credentials, on the same no-operator-fallback rule as
 * TorBox and Real-Debrid.
 *
 * One key covers the whole Premiumize path here, and for the simplest of the
 * three reasons: this service only ever *delivers* to Premiumize, so the key
 * authenticates the REST API and nothing else. The signed CDN links `directdl`
 * hands back carry their own token and are not used by this pipeline at all.
 */
export type PremiumizeOptions = {
  apiKey?: string;
};

/** No operator fallback — see the note on `headers` in `realdebrid.ts`. */
function keyFor(opts: PremiumizeOptions): string {
  if (!opts.apiKey) throw new MissingCredentialError("Premiumize");
  return opts.apiKey;
}

/**
 * Capital `B`, exactly one space, exactly one header. Premiumize rejects a
 * lowercase `bearer`, and its Cloudflare front answers 400 to a duplicated
 * Authorization header.
 */
function headers(opts: PremiumizeOptions): Record<string, string> {
  return { Authorization: `Bearer ${keyFor(opts)}` };
}

/** Identity of the account a key belongs to, for the per-user job limit. */
export type PremiumizeUser = {
  id: string;
};

/** The transfer rows `transfer/list` returns, narrowed to what the monitor reads. */
export type PremiumizeTransfer = {
  id: string;
  name: string;
  /** `waiting` | `queued` | `running` | `seeding` | `finished` | `error`. */
  status: string;
  /** 0..1 while running; absent once finished. */
  progress: number | null;
  /** Human-readable progress line, e.g. `"38.93 MB/s from 0 peer, …"`. */
  message: string | null;
  file_id: string | null;
  folder_id: string | null;
};

type Envelope = {
  status?: string;
  message?: string;
  error?: string;
};

/**
 * Premiumize reports logical failure as **HTTP 200 with `status: "error"`**, the
 * same trap as TorBox's `success: false`. Checking `res.ok` alone would have the
 * monitor watch a transfer id that was never created for the whole uploading
 * stage before failing as a stall, so the envelope is the authority and the HTTP
 * status is only the transport.
 */
async function pmRequest<T>(
  endpoint: string,
  init: RequestInit,
  what: string,
): Promise<T & Envelope> {
  const res = await fetch(`${API}/${endpoint}`, init);
  if (!res.ok) {
    throw new Error(`Premiumize ${what} failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as T & Envelope;
  if (data?.status !== "success") {
    throw new Error(`Premiumize ${what} rejected: ${data?.message ?? "status is not success"}`);
  }
  return data;
}

function formBody(params: Record<string, string>): BodyInit {
  return new URLSearchParams(params);
}

function formHeaders(opts: PremiumizeOptions): Record<string, string> {
  return { ...headers(opts), "Content-Type": "application/x-www-form-urlencoded" };
}

/**
 * Who owns this key.
 *
 * The counterpart to `torbox.getCurrentUser`, scoped to the account rather than
 * to the key for the same reason. `customer_id` arrives as a string here where
 * TorBox and RD return numbers, so it is passed through unchanged.
 */
export async function getCurrentUser(opts: PremiumizeOptions = {}): Promise<PremiumizeUser> {
  const data = await pmRequest<{ customer_id?: string | number }>(
    "account/info",
    { method: "POST", headers: headers(opts) },
    "account lookup",
  );
  const id = data.customer_id;
  // A success envelope carrying no customer id would make every account share
  // one owner string, which is the failure `torbox.getCurrentUser` guards too.
  if (id === undefined || id === null || id === "") {
    throw new Error("Premiumize account lookup returned no customer id");
  }
  return { id: String(id) };
}

/**
 * Hand Premiumize a rewritten `.torrent` and let its client fetch our webseed.
 *
 * **It must be the file, not a magnet.** `transfer/create` accepts `src` (a
 * magnet or an http URL) as well as a multipart `file`, and dmm only ever uses
 * `src` — but a magnet cannot carry `url-list`, so the webseed would be dropped
 * on the floor and the transfer would sit forever with no swarm to fall back on.
 * The file upload is the only door into this direction.
 *
 * Premiumize honours BEP19, measured 2026-08-29 against a torrent with no
 * announce and no DHT whose hash `cache/check` reported absent beforehand: its
 * own `transfer/list` message read `"38.93 MB/s from 0 peer"`, naming the
 * webseed as the only possible source.
 *
 * Unlike TorBox there is no seeding control to ask for. Premiumize does not seed
 * what it fetches, so nothing here can turn the box into an origin for others.
 */
export async function createTransferFromFile(
  torrentPath: string,
  opts: PremiumizeOptions = {},
): Promise<{ id: string; name: string }> {
  const body = new FormData();
  body.append("file", new Blob([fs.readFileSync(torrentPath)]), path.basename(torrentPath));

  const data = await pmRequest<{ id?: string; name?: string }>(
    "transfer/create",
    { method: "POST", headers: headers(opts), body },
    "transfer create",
  );
  if (!data.id) throw new Error("Premiumize transfer create returned no id");
  counters.inc("premiumize.transfers_created");
  return { id: data.id, name: data.name ?? path.basename(torrentPath) };
}

/**
 * One transfer, or `null` when the list no longer carries it.
 *
 * `transfer/list` is the only way to read a transfer's state — there is no
 * by-id endpoint — and it **does not report an info hash**, so a transfer can
 * only ever be found by the id `transfer/create` returned. A `null` is not an
 * error on its own: `transfer/clearfinished` drops finished rows, so the monitor
 * treats a vanished row the way the TorBox path treats `DATABASE_ERROR` and asks
 * the cache before believing anything went wrong.
 */
export async function getTransfer(
  id: string,
  opts: PremiumizeOptions = {},
): Promise<PremiumizeTransfer | null> {
  const data = await pmRequest<{ transfers?: PremiumizeTransfer[] }>(
    "transfer/list",
    { method: "POST", headers: headers(opts) },
    "transfer list",
  );
  const transfers = Array.isArray(data.transfers) ? data.transfers : [];
  return transfers.find((transfer) => transfer.id === id) ?? null;
}

/**
 * Whether Premiumize holds the content for a rewritten hash.
 *
 * Only consulted when the transfer row has gone, so a `true` here means the
 * transfer landed rather than that some earlier copy happened to be cached —
 * every hash handed to a destination is unique per attempt (`attemptSalt`), so
 * nothing else can have put it there.
 */
export async function checkCached(hash: string, opts: PremiumizeOptions = {}): Promise<boolean> {
  const data = await pmRequest<{ response?: unknown }>(
    "cache/check",
    {
      method: "POST",
      headers: formHeaders(opts),
      body: formBody({ "items[]": hash }),
    },
    "cache check",
  );
  return Array.isArray(data.response) && data.response[0] === true;
}

/**
 * Drop a transfer **and the files it produced**.
 *
 * The vendor documentation says this deletes a transfer record, and that is not
 * what happens: the content goes with it. That makes it exactly right for
 * releasing a *failed* delivery and exactly wrong for tidying the transfer list,
 * which is what `transfer/clearfinished` is for. The distinction matters here
 * because the caller is the failure path, and the equivalent TorBox mistake once
 * deleted a copy that had just been delivered successfully.
 */
export async function deleteTransfer(id: string, opts: PremiumizeOptions = {}): Promise<void> {
  await pmRequest(
    "transfer/delete",
    {
      method: "POST",
      headers: formHeaders(opts),
      body: formBody({ id }),
    },
    "transfer delete",
  );
  counters.inc("premiumize.transfers_deleted");
}
