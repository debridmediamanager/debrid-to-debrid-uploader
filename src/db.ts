import { Database, type SQLQueryBindings } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";

/**
 * True under `bun test`, which is what routes the database to memory.
 *
 * This used to sniff `"expect" in globalThis` — but Bun's `expect` is *imported*
 * from `bun:test`, never made global, so the check was always false and every
 * test run wrote to the real `data/debrid.db`. The suite still passed only
 * because `db.test.ts` drops and recreates the `jobs` table early, wiping the
 * rows earlier files had left; running a single test file on its own would fail
 * on a primary-key collision with its own previous run. `bun test` sets
 * `NODE_ENV=test`, which is stable and documented.
 */
const IS_TEST = process.env.NODE_ENV === "test";
const DATA_DIR = path.join(import.meta.dir, "..", "data");
const DB_PATH = IS_TEST ? ":memory:" : path.join(DATA_DIR, "debrid.db");

if (!IS_TEST) fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(DB_PATH, { create: true });
db.exec("PRAGMA journal_mode = WAL");

/**
 * Every column added to `jobs` after the original schema, applied as idempotent
 * ALTERs.
 *
 * A function rather than a run-once block because `migrateJobStageNames`
 * rebuilds the table from a *fixed* column list that predates all of these — so
 * without re-applying them afterwards that rebuild silently drops `force_qbit`,
 * the RD key and the TorBox key from any database old enough to need it. Each
 * ALTER throws harmlessly once its column exists.
 */
export function addOptionalJobColumns(): void {
  const columns = [
    "info_hash TEXT",
    "retry_count INTEGER NOT NULL DEFAULT 0",
    "deleted INTEGER NOT NULL DEFAULT 0",
    "status_message TEXT",
    "name TEXT",
    "imdb_id TEXT",
    "completed_at TEXT",
    "force_qbit INTEGER NOT NULL DEFAULT 0",
    "rd_api_key TEXT",
    // One key covers all of TorBox: the REST calls take it as a bearer token,
    // and the WebDAV host accepts it as the password under the fixed username
    // `torbox`. See `webdavAuth` in `proxy.ts`.
    "tb_api_key TEXT",
    // One key covers all of AllDebrid too, but for the opposite reason: the
    // unlocked links carry their own token, so nothing else needs authenticating.
    "ad_api_key TEXT",
    // Premiumize is delivery-only here, so its key authenticates the REST API
    // and nothing else — no second host reads the bytes under it.
    "pm_api_key TEXT",
    // Resolved account ids for the per-user job limit. Must be listed here as
    // well as in the CREATE TABLE: `migrateJobStageNames` rebuilds `jobs` from a
    // fixed column list that predates every ALTER, so a column missing from this
    // helper is silently dropped by the next migration.
    "tb_user_id TEXT",
    "rd_user_id TEXT",
    "pm_user_id TEXT",
    // Which cached source actually served the job. `proxy_sessions.source`
    // records the same thing, but those rows are dropped the moment the job
    // finishes — and a finished job is exactly when a caller wants to know
    // where its bytes came from. Set once, when the session is registered.
    "source TEXT",
    // When the job first began running, as opposed to when it was submitted.
    // The size-scaled duration budget keys on this rather than `created_at`,
    // because `created_at` includes time spent queued behind
    // MAX_CONCURRENT_JOBS — budget a job is not yet using.
    "started_at TEXT",
    // Where the content is being delivered *to*. NULL means `rd`, which is what
    // every row written before the reverse direction existed meant.
    "destination TEXT",
    // The destination provider's own id for the torrent we handed it. Kept apart
    // from `rd_torrent_id` so a TorBox-destination job cannot be monitored with
    // an RD id, and vice versa.
    "dest_torrent_id TEXT",
  ];
  for (const column of columns) {
    try {
      db.exec(`ALTER TABLE jobs ADD COLUMN ${column}`);
    } catch {}
  }
}

addOptionalJobColumns();

export function migrateJobStageNames(): void {
  const sql = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='jobs'")
    .get() as { sql: string } | null;
  if (!sql?.sql?.includes("creating_torrent")) return;

  db.exec("ALTER TABLE jobs RENAME TO jobs_old");
  db.exec(`
    CREATE TABLE jobs (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL DEFAULT 'magnet',
      input TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'downloading', 'preparing', 'uploading', 'completed', 'failed')),
      error TEXT,
      rd_torrent_id TEXT,
      info_hash TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      file_path TEXT,
      webseed_url TEXT,
      deleted INTEGER NOT NULL DEFAULT 0,
      status_message TEXT,
      name TEXT,
      imdb_id TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.exec(`
    INSERT INTO jobs SELECT id, type, input,
      CASE status
        WHEN 'downloading' THEN 'downloading'
        WHEN 'creating_torrent' THEN 'preparing'
        WHEN 'uploading_to_rd' THEN 'preparing'
        WHEN 'monitoring_rd' THEN 'uploading'
        ELSE status
      END,
      error, rd_torrent_id, info_hash, retry_count, file_path, webseed_url,
      deleted, status_message, name, imdb_id, completed_at, created_at, updated_at
    FROM jobs_old
  `);
  db.exec("DROP TABLE jobs_old");
  // The CREATE above lists only the original columns, so restore everything
  // added since — otherwise this migration is a data-losing downgrade.
  addOptionalJobColumns();
}

migrateJobStageNames();

db.exec(`
  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL DEFAULT 'magnet',
    input TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'downloading', 'preparing', 'uploading', 'completed', 'failed')),
    error TEXT,
    rd_torrent_id TEXT,
    info_hash TEXT,
    retry_count INTEGER NOT NULL DEFAULT 0,
    file_path TEXT,
    webseed_url TEXT,
    deleted INTEGER NOT NULL DEFAULT 0,
    status_message TEXT,
    name TEXT,
    imdb_id TEXT,
    completed_at TEXT,
    force_qbit INTEGER NOT NULL DEFAULT 0,
    -- Optional per-job RD key; when set, the job's RD calls use it instead of
    -- the shared env RD_API_KEY, so content lands in the submitter's account.
    rd_api_key TEXT,
    -- Optional per-job TorBox key, covering both the REST calls and the WebDAV
    -- reads the proxy serves from.
    tb_api_key TEXT,
    -- Optional per-job AllDebrid key, covering the REST calls; the unlocked
    -- links the proxy reads from authenticate themselves.
    ad_api_key TEXT,
    -- Optional per-job Premiumize key. Delivery-only, so it covers the REST
    -- calls and nothing else reads bytes under it.
    pm_api_key TEXT,
    -- Resolved account ids behind the keys above, for the per-user job limit.
    -- Stored rather than looked up per check so the limit survives a restart
    -- and costs no API call to enforce.
    tb_user_id TEXT,
    rd_user_id TEXT,
    pm_user_id TEXT,
    -- Which cached source served the job; see addOptionalJobColumns.
    source TEXT,
    -- When the job first began running; the duration budget keys on this rather
    -- than created_at, which includes queue wait.
    started_at TEXT,
    -- Delivery target: 'rd' (default), 'torbox' or 'premiumize'. NULL reads as 'rd'.
    destination TEXT,
    -- The destination provider's id for the torrent we handed it.
    dest_torrent_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

// The `jobs` table carried no indexes at all, and two hot paths scan on the same
// column: the per-user limit check on every submission (`getActiveJobsForOwner`)
// and `listJobsForRdOwner`, which dmm's Transfers page polls every 5 seconds for
// every viewer. Created after `migrateJobStageNames`, which drops and recreates
// the table and would otherwise take the index with it.
db.exec("CREATE INDEX IF NOT EXISTS jobs_rd_user_id ON jobs(rd_user_id)");

db.exec(`
  CREATE TABLE IF NOT EXISTS torrent_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL REFERENCES jobs(id),
    name TEXT NOT NULL,
    size INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    rd_link TEXT
  )
`);

// Databases created before rd_link was part of the table.
try {
  db.exec(`ALTER TABLE torrent_files ADD COLUMN rd_link TEXT`);
} catch {}

export type JobStatus =
  | "pending"
  | "downloading"
  | "preparing"
  | "uploading"
  | "completed"
  | "failed";

export type Job = {
  id: string;
  type: string;
  input: string;
  status: JobStatus;
  error: string | null;
  rd_torrent_id: string | null;
  info_hash: string | null;
  retry_count: number;
  file_path: string | null;
  webseed_url: string | null;
  /** Soft-delete flag set by `deleteJob`; the worker stops on it. */
  deleted: number;
  status_message: string | null;
  name: string | null;
  imdb_id: string | null;
  completed_at: string | null;
  force_qbit: number;
  /** Per-job RD key, or null to use the shared env key. */
  rd_api_key: string | null;
  /** Per-job TorBox key, or null to use the shared env key. */
  tb_api_key: string | null;
  /** Per-job AllDebrid key, or null to use the shared env key. */
  ad_api_key: string | null;
  /** Per-job Premiumize key, or null when the job is not delivering there. */
  pm_api_key: string | null;
  /** Resolved TorBox account behind `tb_api_key`, e.g. `tb:12345`. */
  tb_user_id: string | null;
  /** Resolved Real-Debrid account behind `rd_api_key`, e.g. `rd:67890`. */
  rd_user_id: string | null;
  /** Resolved Premiumize customer behind `pm_api_key`, e.g. `pm:704233992`. */
  pm_user_id: string | null;
  /**
   * Which cached source served this job, or null until one is chosen. Outlives
   * `proxy_sessions`, which is dropped on completion.
   */
  source: ProxySource | null;
  /**
   * When this job first began running, not when it was submitted.
   *
   * Null while queued behind `MAX_CONCURRENT_JOBS`, and null for rows predating
   * the column. The duration budget reads this rather than `created_at` so that
   * queue wait cannot consume a job's run budget before it starts.
   */
  started_at: string | null;
  /**
   * Where the bytes are being delivered. Null on every row written before the
   * reverse direction existed, and `destinationOf` reads that as `rd` — which is
   * what those jobs were.
   */
  destination: Destination | null;
  /** The destination provider's own torrent id, once it has one. */
  dest_torrent_id: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * Where a job delivers its bytes.
 *
 * `rd` is the original direction (a cached source feeds Real-Debrid through our
 * webseed). `torbox` is the reverse: TorBox's client honours BEP19 `url-list`,
 * verified against a negative control, so the same rewritten torrent works with
 * TorBox on the receiving end. AllDebrid is deliberately absent — it ignores
 * webseeds entirely (measured: it took a whole file over BitTorrent from the
 * same host whose webseed it never once requested), so it can only ever be a
 * source here.
 */
export type Destination = "rd" | "torbox" | "premiumize";

/** A job's destination, treating the pre-column NULL as the original `rd`. */
export function destinationOf(job: { destination: string | null }): Destination {
  if (job.destination === "torbox") return "torbox";
  if (job.destination === "premiumize") return "premiumize";
  return "rd";
}

/**
 * The secrets a submitter may attach to a job, each falling back to the shared
 * env credential independently.
 *
 * Bundled into one object rather than trailing positional parameters because
 * adjacent optional strings are exactly the shape that silently swaps an RD key
 * for a TorBox one at a call site.
 */
export type JobCredentials = {
  rdApiKey?: string;
  tbApiKey?: string;
  adApiKey?: string;
  pmApiKey?: string;
};

/** The job columns that hold a secret and must never reach an API response. */
const SECRET_COLUMNS = ["rd_api_key", "tb_api_key", "ad_api_key", "pm_api_key"] as const;

export function createJob(
  id: string,
  input: string,
  imdbId?: string,
  forceWebtorrent?: boolean,
  creds?: JobCredentials,
  owners?: { tbUserId: string; rdUserId: string; pmUserId: string },
  destination: Destination = "rd",
): Job {
  db.prepare(
    `INSERT INTO jobs (id, type, input, imdb_id, force_qbit, rd_api_key, tb_api_key, ad_api_key, pm_api_key, tb_user_id, rd_user_id, pm_user_id, destination)
     VALUES (?, 'magnet', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input,
    imdbId ?? null,
    forceWebtorrent ? 1 : 0,
    creds?.rdApiKey ?? null,
    creds?.tbApiKey ?? null,
    creds?.adApiKey ?? null,
    creds?.pmApiKey ?? null,
    owners?.tbUserId || null,
    owners?.rdUserId || null,
    owners?.pmUserId || null,
    destination,
  );
  return getRequiredJob(id);
}

export function getJob(id: string): Job | undefined {
  return db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as Job | undefined;
}

function getRequiredJob(id: string): Job {
  const job = getJob(id);
  if (!job) throw new Error(`Job not found after insert: ${id}`);
  return job;
}

export function listJobs(): Job[] {
  return db.prepare("SELECT * FROM jobs WHERE deleted = 0 ORDER BY created_at DESC").all() as Job[];
}

/**
 * One account's jobs, newest first — everything it submitted, in any state.
 *
 * `listJobs` returns every row on the host with no bound, which is right for the
 * operator dashboard and wrong for a per-user view: dmm's Transfers page polls
 * this every 5 seconds per viewer, the table holds hundreds of rows across every
 * submitter, and one user must never see another's.
 *
 * **Bounded, and the caller must pass the bound.** An unbounded per-user query is
 * the same mistake in a smaller costume — an account with a long history would
 * serialise its entire past on every poll.
 *
 * An empty owner matches nothing, and returns before touching the DB. Rows
 * predating `rd_user_id` hold NULL and already match nothing; a blank owner has
 * to behave the same way, or every job submitted without a resolvable RD account
 * would belong to whoever asked first. This is the same fail-closed rule
 * `getActiveJobsForOwner` applies, for the same reason.
 */
export function listJobsForRdOwner(ownerId: string, limit: number, offset: number): Job[] {
  if (!ownerId) return [];
  return db
    .prepare(
      `SELECT * FROM jobs
       WHERE deleted = 0 AND rd_user_id = ?
       ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    )
    .all(ownerId, limit, offset) as Job[];
}

export function getIncompleteJobs(): Job[] {
  return db
    .prepare(
      "SELECT * FROM jobs WHERE deleted = 0 AND status NOT IN ('completed', 'failed') ORDER BY created_at ASC",
    )
    .all() as Job[];
}

/**
 * Jobs already in flight for a submitter's Real-Debrid account.
 *
 * "In flight" spans `pending` as well as the active stages, because the limit is
 * on how much of the pipeline one account may occupy at once — a queued job is
 * holding a place in line, and letting those accumulate is precisely the burst
 * shape the limit exists to prevent.
 *
 * **The Real-Debrid account is the whole of the identity**, and `tb_user_id` is
 * kept as an audit trail rather than a second key to count on. RD is the one
 * side every job has: the destination is mandatory while the cache source may be
 * TorBox *or* AllDebrid, so counting the source as well limited the two sources
 * unevenly — an AllDebrid-only submitter had one identity and a TorBox one had
 * two, and which of them was scarce decided a limit that is supposed to be about
 * the submitter. The cost is deliberate and worth naming: one TorBox account can
 * now feed as many concurrent jobs as it has Real-Debrid accounts to feed them
 * into, which is the shape `tb_user_id` was originally added to stop.
 *
 * Rows predating the column hold NULL and match nothing, so jobs submitted
 * before the limit existed are grandfathered rather than blocking their owner
 * forever.
 */
export function getActiveJobsForRdOwner(rdUserId: string): Job[] {
  return getActiveJobsForOwner("rd", rdUserId);
}

/**
 * The same limit, counted against whichever account the job *delivers to*.
 *
 * The rule was always "count the destination", it just needed no saying while
 * Real-Debrid was the only destination there was. A TorBox-destination job may
 * legitimately carry no RD key at all (AllDebrid can be its source), so keying
 * on RD would leave those jobs matching an empty owner and sharing one bucket
 * across unrelated submitters — the limit would bind strangers together and let
 * a single account run unbounded jobs the moment it stopped supplying an RD key.
 */
export function getActiveJobsForDestinationOwner(
  destination: Destination,
  owners: { tbUserId: string; rdUserId: string; pmUserId: string },
): Job[] {
  if (destination === "torbox") return getActiveJobsForOwner("tb", owners.tbUserId);
  if (destination === "premiumize") return getActiveJobsForOwner("pm", owners.pmUserId);
  return getActiveJobsForOwner("rd", owners.rdUserId);
}

/**
 * Jobs in flight for one owner on one side.
 *
 * The column is chosen from a closed set rather than interpolated from caller
 * input, so this cannot become an injection site as destinations are added.
 */
function getActiveJobsForOwner(side: "rd" | "tb" | "pm", ownerId: string): Job[] {
  // An unresolved owner (`""`) must match nothing. Rows predating the columns
  // hold NULL and already match nothing, and a blank owner has to behave the
  // same way or every job missing that side would count against every other.
  if (!ownerId) return [];
  const column = side === "tb" ? "tb_user_id" : side === "pm" ? "pm_user_id" : "rd_user_id";
  // **Filtered on the destination too, and it has to be.** The rule is "how many
  // jobs is this account having *delivered* to it", so a job that merely reads
  // from the account must not count against it. Without this an account that is
  // the destination of one job and the source of another is charged for both —
  // which is not the limit going slightly wrong, it is the limit measuring a
  // different thing. It only became possible to get wrong once a provider could
  // appear on either side.
  const destinationClause =
    side === "tb"
      ? "destination = 'torbox'"
      : side === "pm"
        ? "destination = 'premiumize'"
        : "(destination IS NULL OR destination = 'rd')";
  return db
    .prepare(
      `SELECT * FROM jobs
       WHERE deleted = 0
         AND status NOT IN ('completed', 'failed')
         AND ${destinationClause}
         AND ${column} = ?
       ORDER BY created_at ASC`,
    )
    .all(ownerId) as Job[];
}

/** Where a still-waiting job sits in line. */
export type QueuePlace = {
  /** 1-based place among the jobs waiting to start, this one included. */
  position: number;
  /** How many are waiting in total. */
  waiting: number;
};

/**
 * A `pending` job's place in line, or null once it has started.
 *
 * Derived from SQLite rather than from `JobQueue`, whose waiter list is a bare
 * array of resolvers with no job identity in it. That is fine because the two
 * orders agree: new submissions enqueue in arrival order, and boot resume feeds
 * `getIncompleteJobs()` — `ORDER BY created_at ASC` — into the same gate.
 *
 * `created_at` is `datetime('now')`, so it is only second-resolution and a
 * burst ties; `rowid` breaks the tie by insertion order, which is the order the
 * gate actually admits them in.
 *
 * Known limit: jobs resumed mid-pipeline after a restart hold slots without
 * being `pending`, so right after a reboot the wait can be longer than the
 * position suggests. The number is exact as what it claims to be — a place
 * among the jobs still waiting — rather than a time estimate.
 */
export function queuePlaceOf(id: string): QueuePlace | null {
  const row = db
    .prepare(
      `SELECT created_at, rowid AS rid FROM jobs
       WHERE id = ? AND deleted = 0 AND status = 'pending'`,
    )
    .get(id) as { created_at: string; rid: number } | null;
  if (!row) return null;

  const ahead = db
    .prepare(
      `SELECT COUNT(*) AS n FROM jobs
       WHERE deleted = 0 AND status = 'pending'
         AND (created_at < ? OR (created_at = ? AND rowid < ?))`,
    )
    .get(row.created_at, row.created_at, row.rid) as { n: number };
  const total = db
    .prepare(`SELECT COUNT(*) AS n FROM jobs WHERE deleted = 0 AND status = 'pending'`)
    .get() as { n: number };

  return { position: ahead.n + 1, waiting: total.n };
}

export function deleteJob(id: string) {
  db.prepare("UPDATE jobs SET deleted = 1, updated_at = datetime('now') WHERE id = ?").run(id);
}

export function updateJob(
  id: string,
  updates: Partial<
    Pick<
      Job,
      | "status"
      | "error"
      | "rd_torrent_id"
      | "info_hash"
      | "retry_count"
      | "file_path"
      | "webseed_url"
      | "status_message"
      | "name"
      | "imdb_id"
      | "dest_torrent_id"
    >
  >,
) {
  const fields: string[] = [];
  const values: SQLQueryBindings[] = [];
  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) continue;
    fields.push(`${key} = ?`);
    values.push(value);
  }
  if (fields.length === 0) return;
  if (updates.status === "completed" || updates.status === "failed") {
    fields.push("completed_at = datetime('now')");
  }
  fields.push("updated_at = datetime('now')");
  values.push(id);
  db.prepare(`UPDATE jobs SET ${fields.join(", ")} WHERE id = ?`).run(...values);
}

const NULL_SECRETS = SECRET_COLUMNS.map((column) => `${column} = NULL`).join(", ");

/**
 * Drop a finished job's credentials.
 *
 * A job carries the submitter's keys because the proxy needs them on every
 * range read — TorBox is authenticated per request as WebDAV Basic auth — so
 * they have to outlive the submission. What they must not do is outlive the
 * *job*: every terminal row kept them indefinitely, which on 2026-08-27 was
 * 1604 rows across the two hosts holding roughly a thousand distinct live
 * credentials in plaintext.
 *
 * **Deliberately not folded into `updateJob`'s terminal branch.** Cleanup after
 * the status write still needs the submitter's keys for an owned RD source or
 * failed destination. Clear them only once cleanup has started with those keys.
 *
 * `updated_at` is left alone on purpose: dmm's Transfers page and the announcer
 * both poll on job state, and a purge is not a state change.
 */
export function clearJobSecrets(id: string): void {
  db.prepare(`UPDATE jobs SET ${NULL_SECRETS} WHERE id = ?`).run(id);
}

/**
 * Sweep credentials off every job that is finished with.
 *
 * Runs at boot so a deploy cleans the history without anyone running SQL by
 * hand, and so a job that somehow skipped its inline purge — killed between the
 * status write and the clear — does not keep its keys forever.
 *
 * **"Finished" is terminal *or* soft-deleted, and the second half is not
 * redundant.** `deleteJob` only sets `deleted = 1`; it never moves the status,
 * so a cancelled job sits at `pending`/`downloading`/`uploading` for ever. A
 * terminal-only sweep skipped every one of them, which on 2026-08-27 left 113
 * dead rows on debrid02 alone still holding live keys, the oldest from
 * 2026-08-05. Nothing will ever resume them either — `getIncompleteJobs`
 * filters `deleted = 0` — so they are finished in every sense but the status
 * column's.
 *
 * A row that is neither is left alone: it may still be mid-pipeline, and
 * `getIncompleteJobs` will hand it straight back to `processJob` on this very
 * boot.
 *
 * @returns how many rows still held a secret.
 */
export function purgeFinishedJobSecrets(): number {
  return db
    .prepare(
      `UPDATE jobs SET ${NULL_SECRETS}
       WHERE (status IN ('completed', 'failed') OR deleted = 1)
         AND (rd_api_key IS NOT NULL OR tb_api_key IS NOT NULL OR ad_api_key IS NOT NULL)`,
    )
    .run().changes;
}

/**
 * Record which cached source served a job.
 *
 * Written once, when the proxy session is registered — the first moment the
 * choice is settled. Deliberately not part of `updateJob`: that takes pipeline
 * state, and this is a fact about the job's origin that must not be cleared by
 * a retry writing a partial update.
 */
export function setJobSource(id: string, source: ProxySource): void {
  db.prepare("UPDATE jobs SET source = ?, updated_at = datetime('now') WHERE id = ?").run(
    source,
    id,
  );
}

export type TorrentFile = {
  id: number;
  job_id: string;
  name: string;
  size: number;
  rd_link: string | null;
  created_at: string;
};

/**
 * Replace the recorded file list for a job.
 *
 * The previous rows are dropped first so a stage retry re-records rather than
 * duplicating. Today the pipeline flips a job to `preparing` before this runs,
 * so a retry re-enters past it and duplicates cannot actually happen — but that
 * is an accident of statement ordering in `runPipeline`, not a property of this
 * function, and duplicated rows would silently break `saveRdLinks`, which
 * matches RD's files against these by name and size.
 */
export function insertTorrentFiles(
  jobId: string,
  files: { name: string; size: number }[],
): TorrentFile[] {
  db.prepare("DELETE FROM torrent_files WHERE job_id = ?").run(jobId);
  if (files.length === 0) return [];

  const stmt = db.prepare("INSERT INTO torrent_files (job_id, name, size) VALUES (?, ?, ?)");
  const ids: number[] = [];
  for (const f of files) {
    const result = stmt.run(jobId, f.name, f.size);
    ids.push(Number(result.lastInsertRowid));
  }
  return db
    .prepare(`SELECT * FROM torrent_files WHERE id IN (${ids.map(() => "?").join(",")})`)
    .all(...ids) as TorrentFile[];
}

/**
 * Stamp when this job began running, once.
 *
 * Idempotent by the `IS NULL` guard, which is what makes the duration budget a
 * *total* rather than a per-attempt allowance: `retryOrFail` re-enters `runJob`
 * and boot resume re-enters `processJob`, and both must inherit the elapsed time
 * rather than reset it. Without the guard, three retries treble the ceiling.
 */
export function markJobStarted(id: string): void {
  db.prepare(
    "UPDATE jobs SET started_at = datetime('now') WHERE id = ? AND started_at IS NULL",
  ).run(id);
}

/**
 * Total payload size, or null before the torrent's files are known.
 *
 * Null is meaningful and must not be coerced to zero: the duration budget hands
 * an unknown size the *ceiling*, so a job that dies here would otherwise be
 * capped at the floor before it ever reported how big it was.
 */
export function getJobTotalBytes(jobId: string): number | null {
  const row = db.prepare("SELECT SUM(size) total FROM torrent_files WHERE job_id = ?").get(jobId) as
    | { total: number | null }
    | undefined;
  return row?.total ?? null;
}

export function getTorrentFiles(jobId: string): TorrentFile[] {
  return db
    .prepare("SELECT * FROM torrent_files WHERE job_id = ? ORDER BY size DESC")
    .all(jobId) as TorrentFile[];
}

export function updateTorrentFileRdLink(id: number, rdLink: string): void {
  db.prepare("UPDATE torrent_files SET rd_link = ? WHERE id = ?").run(rdLink, id);
}

migrateProxySessions();

try {
  db.exec(`ALTER TABLE proxy_sessions ADD COLUMN qbit_hash TEXT`);
} catch {}
try {
  db.exec(`ALTER TABLE proxy_sessions ADD COLUMN qbit_file_index INTEGER`);
} catch {}
// TorBox's own file id, needed to mint a `requestdl` CDN link for the redirect
// path. `webdav_path` cannot substitute: requestdl addresses files by id, not
// by name.
try {
  db.exec(`ALTER TABLE proxy_sessions ADD COLUMN torbox_file_id INTEGER`);
} catch {}
// Which provider serves this session's bytes. Before AllDebrid there were only
// two and `torbox_torrent_id === -1` was enough to tell them apart; a third
// source makes that overload ambiguous, so the origin is now recorded outright.
// Rows written before this column exists read back NULL and are resolved by the
// old rule — see `proxySourceOf`.
try {
  db.exec(`ALTER TABLE proxy_sessions ADD COLUMN source TEXT`);
} catch {}
try {
  db.exec(`ALTER TABLE proxy_sessions ADD COLUMN ad_magnet_id INTEGER`);
} catch {}
// The per-file `alldebrid.com/f/…` token is identical across accounts for the
// same torrent and survives magnet deletion. A regressed/evicted source may
// still invalidate it. `proxy.ts` unlocks on demand and caches delivery URLs.
try {
  db.exec(`ALTER TABLE proxy_sessions ADD COLUMN ad_link TEXT`);
} catch {}
// The restricted `real-debrid.com/d/…` link. Unrestricted URLs live seven days
// and are account-specific/IP-tracked even when another IP receives bytes.
// `proxy.ts` mints and consumes them on this account's single egress host.
try {
  db.exec(`ALTER TABLE proxy_sessions ADD COLUMN rd_link TEXT`);
} catch {}
// The RD torrent id to delete when the job ends — set **only when this service
// added it**. A release already sitting in the submitter's account is theirs,
// and cleaning it up would delete a library item they never asked us to touch.
// NULL therefore means "leave it alone", which is the safe default for a column
// that did not exist before.
try {
  db.exec(`ALTER TABLE proxy_sessions ADD COLUMN rd_source_torrent_id TEXT`);
} catch {}

export { db as _db };

export function migrateProxySessions(): void {
  const cols = db.prepare("PRAGMA table_info(proxy_sessions)").all() as { name: string }[];
  if (cols.length > 0 && !cols.some((c) => c.name === "rewritten_path")) {
    db.exec("DROP TABLE proxy_sessions");
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS proxy_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL REFERENCES jobs(id),
      torbox_torrent_id INTEGER NOT NULL,
      rewritten_path TEXT NOT NULL,
      webdav_path TEXT NOT NULL,
      file_size INTEGER NOT NULL,
      qbit_hash TEXT,
      qbit_file_index INTEGER,
      torbox_file_id INTEGER,
      source TEXT,
      ad_magnet_id INTEGER,
      ad_link TEXT,
      rd_link TEXT,
      rd_source_torrent_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
}

/** Where a proxy session's bytes come from. */
export type ProxySource = "torbox" | "qbit" | "alldebrid" | "realdebrid";

/**
 * Resolve a row's source, tolerating rows written before the column existed.
 *
 * The old encoding was positional: -1 meant qBittorrent, anything else meant
 * TorBox. Sessions persist across restarts and a job mid-flight during a deploy
 * would otherwise rehydrate with no source at all, so the legacy rule stays as
 * the fallback rather than being migrated away.
 */
export function proxySourceOf(row: {
  source: string | null;
  torbox_torrent_id: number;
}): ProxySource {
  if (
    row.source === "torbox" ||
    row.source === "qbit" ||
    row.source === "alldebrid" ||
    row.source === "realdebrid"
  ) {
    return row.source;
  }
  return row.torbox_torrent_id === -1 ? "qbit" : "torbox";
}

export type ProxyFileMapping = {
  job_id: string;
  torbox_torrent_id: number;
  rewritten_path: string;
  webdav_path: string;
  file_size: number;
  qbit_hash: string | null;
  qbit_file_index: number | null;
  torbox_file_id: number | null;
  source: string | null;
  ad_magnet_id: number | null;
  ad_link: string | null;
  rd_link: string | null;
  rd_source_torrent_id: string | null;
};

/**
 * Where a session's bytes come from, beyond the per-file mappings.
 *
 * An object rather than more trailing positional arguments: `qbitHash` and the
 * two AllDebrid fields are all optional and two of the three are strings, which
 * is exactly the shape that silently swaps one for another at a call site — the
 * same reasoning as `JobCredentials`.
 */
export type ProxyOrigin = {
  source?: ProxySource;
  qbitHash?: string;
  adMagnetId?: number;
  /**
   * The RD torrent to delete on teardown, set only when we created it. Absent
   * for a release the submitter already had — see the column comment.
   */
  rdSourceTorrentId?: string;
};

export function insertProxyMappings(
  jobId: string,
  torboxTorrentId: number,
  mappings: {
    rewrittenPath: string;
    webdavPath: string;
    size: number;
    qbitFileIndex?: number;
    torboxFileId?: number;
    adLink?: string;
    rdLink?: string;
  }[],
  origin: ProxyOrigin = {},
): void {
  db.prepare("DELETE FROM proxy_sessions WHERE job_id = ?").run(jobId);
  const stmt = db.prepare(
    `INSERT INTO proxy_sessions (job_id, torbox_torrent_id, rewritten_path, webdav_path, file_size, qbit_hash, qbit_file_index, torbox_file_id, source, ad_magnet_id, ad_link, rd_link, rd_source_torrent_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const m of mappings) {
    stmt.run(
      jobId,
      torboxTorrentId,
      m.rewrittenPath,
      m.webdavPath,
      m.size,
      origin.qbitHash ?? null,
      m.qbitFileIndex ?? null,
      m.torboxFileId ?? null,
      origin.source ?? null,
      origin.adMagnetId ?? null,
      m.adLink ?? null,
      m.rdLink ?? null,
      origin.rdSourceTorrentId ?? null,
    );
  }
}

/**
 * The TorBox torrent id recorded for a job, or undefined when the job never
 * took the TorBox path. Nonpositive ids are not TorBox resources.
 * This is a serving id, not evidence of creation or permission to delete.
 */
export function getTorboxTorrentId(jobId: string): number | undefined {
  const row = db
    .prepare("SELECT torbox_torrent_id, source FROM proxy_sessions WHERE job_id = ? LIMIT 1")
    .get(jobId) as { torbox_torrent_id: number; source: string | null } | null;
  if (!row || proxySourceOf(row) !== "torbox") return undefined;
  return row.torbox_torrent_id > 0 ? row.torbox_torrent_id : undefined;
}

/**
 * The Real-Debrid *source* torrent to clean up, or undefined when there is none
 * to clean up.
 *
 * Undefined covers two very different cases on purpose, and both must be left
 * alone: the job did not source from RD at all, and the job sourced from a
 * release the submitter already had in their account. Only a torrent this
 * service added writes the column, so a missing value can never be read as
 * permission to delete somebody's library item.
 */
export function getRdSourceTorrentId(jobId: string): string | undefined {
  const row = db
    .prepare(
      "SELECT rd_source_torrent_id, source, torbox_torrent_id FROM proxy_sessions WHERE job_id = ? LIMIT 1",
    )
    .get(jobId) as {
    rd_source_torrent_id: string | null;
    source: string | null;
    torbox_torrent_id: number;
  } | null;
  if (!row || proxySourceOf(row) !== "realdebrid") return undefined;
  return row.rd_source_torrent_id ?? undefined;
}

/**
 * The AllDebrid magnet id recorded for a job, or undefined when it took another
 * path.
 *
 * Gated on the source so provider-local ids cannot be confused.
 * Upload deduplicates, so this id is not permission to delete the magnet.
 */
export function getAlldebridMagnetId(jobId: string): number | undefined {
  const row = db
    .prepare(
      "SELECT ad_magnet_id, torbox_torrent_id, source FROM proxy_sessions WHERE job_id = ? LIMIT 1",
    )
    .get(jobId) as {
    ad_magnet_id: number | null;
    torbox_torrent_id: number;
    source: string | null;
  } | null;
  if (!row || proxySourceOf(row) !== "alldebrid") return undefined;
  return row.ad_magnet_id ?? undefined;
}

export function getProxyMappings(jobId: string): ProxyFileMapping[] {
  return db
    .prepare("SELECT * FROM proxy_sessions WHERE job_id = ?")
    .all(jobId) as ProxyFileMapping[];
}

export function deleteProxySession(jobId: string): void {
  db.prepare("DELETE FROM proxy_sessions WHERE job_id = ?").run(jobId);
}

/**
 * Jobs still missing a name, with the TorBox key each was submitted under —
 * the backfill has to ask the account that actually holds the torrent, which
 * for a custom-key job is not the operator's.
 */
export function getJobsWithoutNames(): {
  id: string;
  torbox_torrent_id: number;
  tb_api_key: string | null;
}[] {
  return db
    .prepare(
      `SELECT j.id, ps.torbox_torrent_id, j.tb_api_key FROM jobs j
       JOIN proxy_sessions ps ON ps.job_id = j.id
       WHERE j.name IS NULL AND j.deleted = 0
       GROUP BY j.id`,
    )
    .all() as { id: string; torbox_torrent_id: number; tb_api_key: string | null }[];
}

/**
 * A job as the API is allowed to present it: every secret column stripped.
 *
 * `Omit` rather than a hand-listed type so that adding a column to
 * `SECRET_COLUMNS` is a compile error at any call site still expecting it,
 * instead of a silent re-exposure.
 */
export type PublicJob = Omit<Job, (typeof SECRET_COLUMNS)[number]>;
export type JobWithDuration = PublicJob & { duration_seconds: number | null };

/**
 * The single choke point every job response passes through, so it is also where
 * secrets are removed.
 *
 * `getJob`/`listJobs` do `SELECT *`, which means the per-job RD and TorBox
 * credentials ride along in the row. Spreading that row into a response served
 * them in plaintext to anyone who could reach `GET /jobs` — unauthenticated and
 * public. Redact here rather than at each route: there is one of these and four
 * of those, and the next route added would not think to strip anything.
 */
export function withDuration(job: Job): JobWithDuration {
  let duration_seconds: number | null = null;
  if (job.completed_at) {
    duration_seconds =
      (new Date(`${job.completed_at}Z`).getTime() - new Date(`${job.created_at}Z`).getTime()) /
      1000;
  }
  const safe: Record<string, unknown> = { ...job };
  for (const column of SECRET_COLUMNS) delete safe[column];
  if (isCancelledUnfinished(job)) {
    safe.status = "failed";
    safe.error = CANCELLED_ERROR;
  }
  return { ...(safe as unknown as PublicJob), duration_seconds };
}

export const TERMINAL_STATUSES: ReadonlySet<JobStatus> = new Set<JobStatus>([
  "completed",
  "failed",
]);

/** The `error` a cancelled job is reported with. */
export const CANCELLED_ERROR = "cancelled";

/**
 * A job someone cancelled before it reached an outcome.
 *
 * `deleteJob` sets the flag and nothing else, because a stage already in flight
 * cannot be interrupted and would only write its next status over a stored
 * verdict. So the row keeps the status it had at the cancel for good, and every
 * caller polling for a terminal one waited forever: DMM read 222 cancelled jobs
 * on debrid02 as transfers still in progress on 2026-10-03, refusing every later
 * send of those releases, and rd-uploader's poll loop has no bound at all.
 *
 * Reported rather than stored for the same reason, and it is `failed` rather
 * than a new status so that every existing caller already treats it as over and
 * as retryable. A job that finished before the cancel keeps its real outcome.
 */
function isCancelledUnfinished(job: Job): boolean {
  return job.deleted === 1 && !TERMINAL_STATUSES.has(job.status);
}

/**
 * The TorBox key recorded for a job, read straight from the row rather than
 * from `withDuration`'s redacted view.
 *
 * `proxy.ts` needs it on every rehydrated session, which happens after a
 * restart when the in-memory session map is empty. Undefined covers both a
 * missing job and one submitted without a key — either way the caller falls
 * back to the shared env key.
 */
export function getJobTorboxApiKey(jobId: string): string | undefined {
  const row = db.prepare("SELECT tb_api_key FROM jobs WHERE id = ?").get(jobId) as
    | { tb_api_key: string | null }
    | undefined;
  return row?.tb_api_key ?? undefined;
}

/** The AllDebrid key recorded for a job, on the same terms as the TorBox one. */
export function getJobAlldebridApiKey(jobId: string): string | undefined {
  const row = db.prepare("SELECT ad_api_key FROM jobs WHERE id = ?").get(jobId) as
    | { ad_api_key: string | null }
    | undefined;
  return row?.ad_api_key ?? undefined;
}

/**
 * A job's destination, read from the row.
 *
 * The proxy needs it because the two destinations' torrent clients disagree
 * about over-sized responses — see `expandedEndFor` in `proxy.ts` — and a
 * session rehydrated after a restart has nothing in memory to consult. An
 * unknown job reads as `rd`, the original behaviour.
 */
export function getJobDestination(jobId: string): Destination {
  const row = db.prepare("SELECT destination FROM jobs WHERE id = ?").get(jobId) as
    | { destination: string | null }
    | undefined;
  return destinationOf({ destination: row?.destination ?? null });
}

/**
 * The job's RD key, for a session that *sources* its bytes from Real-Debrid.
 *
 * The same value `rdOptsFor` uses to talk to RD as a destination — one account
 * either way — but read from the row here for the same reason as the other two:
 * a session rehydrated after a restart has no key in memory, and falling back to
 * the operator's would unrestrict against the wrong account.
 */
export function getJobRealdebridApiKey(jobId: string): string | undefined {
  const row = db.prepare("SELECT rd_api_key FROM jobs WHERE id = ?").get(jobId) as
    | { rd_api_key: string | null }
    | undefined;
  return row?.rd_api_key ?? undefined;
}
