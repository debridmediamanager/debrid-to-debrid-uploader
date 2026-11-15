import { describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import {
  _db,
  addOptionalJobColumns,
  clearJobSecrets,
  createJob,
  deleteJob,
  deleteProxySession,
  destinationOf,
  getActiveJobsForDestinationOwner,
  getActiveJobsForRdOwner,
  getAlldebridMagnetId,
  getIncompleteJobs,
  getJob,
  getJobAlldebridApiKey,
  getJobRealdebridApiKey,
  getJobsWithoutNames,
  getJobTorboxApiKey,
  getJobTotalBytes,
  getProxyMappings,
  getRdSourceTorrentId,
  getTorboxTorrentId,
  getTorrentFiles,
  insertProxyMappings,
  insertTorrentFiles,
  type JobStatus,
  listJobs,
  listJobsForRdOwner,
  markJobStarted,
  migrateJobStageNames,
  migrateProxySessions,
  proxySourceOf,
  purgeFinishedJobSecrets,
  queuePlaceOf,
  setJobSource,
  updateJob,
  updateTorrentFileRdLink,
  withDuration,
} from "./db";

function uid(): string {
  return `test-${crypto.randomUUID()}`;
}

describe("jobs CRUD", () => {
  test("createJob and getJob", () => {
    const id = uid();
    const job = createJob(id, "magnet:?xt=urn:btih:abc123");
    expect(job.id).toBe(id);
    expect(job.input).toBe("magnet:?xt=urn:btih:abc123");
    expect(job.status).toBe("pending");
    expect(job.imdb_id).toBeNull();

    const fetched = getJob(id);
    expect(fetched?.id).toBe(id);
  });

  test("createJob with imdbId", () => {
    const id = uid();
    const job = createJob(id, "magnet:?xt=urn:btih:abc", "tt1234567");
    expect(job.imdb_id).toBe("tt1234567");
  });

  test("createJob defaults to no per-job credentials", () => {
    const job = createJob(uid(), "magnet:?xt=urn:btih:nokey");
    expect(job.rd_api_key).toBeNull();
    expect(job.tb_api_key).toBeNull();
  });

  test("createJob stores an optional per-job RD key", () => {
    const id = uid();
    const job = createJob(id, "magnet:?xt=urn:btih:withkey", "tt1", false, {
      rdApiKey: "USER_RD_KEY",
    });
    expect(job.rd_api_key).toBe("USER_RD_KEY");
    expect(getJob(id)?.rd_api_key).toBe("USER_RD_KEY");
  });

  test("createJob stores an optional per-job TorBox key", () => {
    const id = uid();
    const job = createJob(id, "magnet:?xt=urn:btih:withtb", "tt1", false, {
      tbApiKey: "USER_TB_KEY",
    });
    expect(job.tb_api_key).toBe("USER_TB_KEY");
    expect(getJobTorboxApiKey(id)).toBe("USER_TB_KEY");
  });

  test("getJobTorboxApiKey returns undefined for a job without one", () => {
    const id = uid();
    createJob(id, "magnet:?xt=urn:btih:notb");
    expect(getJobTorboxApiKey(id)).toBeUndefined();
  });

  test("getJobTorboxApiKey returns undefined for a missing job", () => {
    expect(getJobTorboxApiKey("nonexistent-id-tb")).toBeUndefined();
  });

  test("withDuration strips every secret column", () => {
    const id = uid();
    const job = createJob(id, "magnet:?xt=urn:btih:secret", "tt1", false, {
      rdApiKey: "USER_RD_KEY",
      tbApiKey: "USER_TB_KEY",
    });
    const serialized = JSON.stringify(withDuration(job));
    for (const secret of ["USER_RD_KEY", "USER_TB_KEY"]) {
      expect(serialized).not.toContain(secret);
    }
    // The non-secret fields still come through.
    expect(JSON.parse(serialized).imdb_id).toBe("tt1");
  });

  test("getJob returns falsy for missing", () => {
    expect(getJob("nonexistent-id-xyz")).toBeFalsy();
  });

  test("listJobs excludes deleted", () => {
    const id = uid();
    createJob(id, "magnet:?xt=urn:btih:aaa");
    const jobs = listJobs();
    expect(jobs.some((j) => j.id === id)).toBe(true);

    deleteJob(id);
    const afterDelete = listJobs();
    expect(afterDelete.some((j) => j.id === id)).toBe(false);
  });

  test("getIncompleteJobs returns non-terminal jobs", () => {
    const id = uid();
    createJob(id, "magnet:?xt=urn:btih:bbb");
    const incomplete = getIncompleteJobs();
    expect(incomplete.some((j) => j.id === id)).toBe(true);

    updateJob(id, { status: "completed" });
    const afterComplete = getIncompleteJobs();
    expect(afterComplete.some((j) => j.id === id)).toBe(false);
  });

  test("updateJob updates fields", () => {
    const id = uid();
    createJob(id, "magnet:?xt=urn:btih:def");
    updateJob(id, {
      status: "downloading",
      file_path: "/tmp/file.bin",
      webseed_url: "http://ws/file",
      status_message: "50%",
      name: "test torrent",
    });
    const job = getJob(id);
    expect(job?.status).toBe("downloading");
    expect(job?.file_path).toBe("/tmp/file.bin");
    expect(job?.webseed_url).toBe("http://ws/file");
    expect(job?.status_message).toBe("50%");
    expect(job?.name).toBe("test torrent");
  });

  test("updateJob sets completed_at on terminal status", () => {
    const id = uid();
    createJob(id, "magnet:?xt=urn:btih:ccc");
    updateJob(id, { status: "failed", error: "boom" });
    const job = getJob(id);
    expect(job?.completed_at).not.toBeNull();
    expect(job?.error).toBe("boom");
  });

  test("updateJob with empty updates is no-op", () => {
    const id = uid();
    createJob(id, "magnet:?xt=urn:btih:ddd");
    updateJob(id, {});
    const job = getJob(id);
    expect(job?.status).toBe("pending");
  });
});

describe("torrent files", () => {
  test("insertTorrentFiles and getTorrentFiles", () => {
    const id = uid();
    createJob(id, "magnet:?xt=urn:btih:ghi");
    const files = insertTorrentFiles(id, [
      { name: "video.mkv", size: 5000 },
      { name: "subs.srt", size: 100 },
    ]);
    expect(files).toHaveLength(2);
    expect(files[0].job_id).toBe(id);

    const fetched = getTorrentFiles(id);
    expect(fetched).toHaveLength(2);
    expect(fetched[0].size).toBeGreaterThanOrEqual(fetched[1].size);
  });

  test("insertTorrentFiles replaces the previous set rather than duplicating", () => {
    const id = uid();
    createJob(id, "magnet:?xt=urn:btih:redo");
    insertTorrentFiles(id, [
      { name: "old.mkv", size: 5000 },
      { name: "old.srt", size: 100 },
    ]);
    insertTorrentFiles(id, [{ name: "new.mkv", size: 7000 }]);

    const files = getTorrentFiles(id);
    expect(files).toHaveLength(1);
    expect(files[0].name).toBe("new.mkv");
  });

  test("insertTorrentFiles handles empty input", () => {
    const id = uid();
    createJob(id, "magnet:?xt=urn:btih:empty");
    expect(insertTorrentFiles(id, [])).toEqual([]);
    expect(getTorrentFiles(id)).toEqual([]);
  });

  test("updateTorrentFileRdLink", () => {
    const id = uid();
    createJob(id, "magnet:?xt=urn:btih:jkl");
    const files = insertTorrentFiles(id, [{ name: "f.mkv", size: 1000 }]);
    updateTorrentFileRdLink(files[0].id, "https://real-debrid.com/d/ABCDEFGHIJKLM");
    const fetched = getTorrentFiles(id);
    expect(fetched[0].rd_link).toBe("https://real-debrid.com/d/ABCDEFGHIJKLM");
  });
});

describe("proxy sessions", () => {
  test("insertProxyMappings and getProxyMappings", () => {
    const id = uid();
    createJob(id, "magnet:?xt=urn:btih:stu");
    insertProxyMappings(id, 42, [
      { rewrittenPath: "Clean/a.mkv", webdavPath: "Orig/a.mkv", size: 5000 },
      { rewrittenPath: "Clean/b.srt", webdavPath: "Orig/b.srt", size: 100 },
    ]);
    const mappings = getProxyMappings(id);
    expect(mappings).toHaveLength(2);
    expect(mappings[0].rewritten_path).toBe("Clean/a.mkv");
    expect(mappings[0].webdav_path).toBe("Orig/a.mkv");
    expect(mappings[0].torbox_torrent_id).toBe(42);
    expect(mappings[1].rewritten_path).toBe("Clean/b.srt");
  });

  test("insertProxyMappings replaces existing rows on retry", () => {
    const id = uid();
    createJob(id, "magnet:?xt=urn:btih:retry");
    insertProxyMappings(id, 10, [{ rewrittenPath: "old.mkv", webdavPath: "x.mkv", size: 1000 }]);
    insertProxyMappings(id, 20, [
      { rewrittenPath: "new.mkv", webdavPath: "y.mkv", size: 2000 },
      { rewrittenPath: "new2.mkv", webdavPath: "z.mkv", size: 500 },
    ]);
    const mappings = getProxyMappings(id);
    expect(mappings).toHaveLength(2);
    expect(mappings[0].torbox_torrent_id).toBe(20);
    expect(mappings[0].rewritten_path).toBe("new.mkv");
  });

  test("getTorboxTorrentId returns the id for a TorBox job", () => {
    const id = uid();
    createJob(id, "magnet:?xt=urn:btih:tbslot");
    insertProxyMappings(id, 314, [
      { rewrittenPath: "a.mkv", webdavPath: "x.mkv", size: 10 },
      { rewrittenPath: "b.mkv", webdavPath: "y.mkv", size: 20 },
    ]);
    expect(getTorboxTorrentId(id)).toBe(314);
  });

  test("getTorboxTorrentId ignores the qBittorrent sentinel", () => {
    const id = uid();
    createJob(id, "magnet:?xt=urn:btih:qbslot");
    insertProxyMappings(id, -1, [{ rewrittenPath: "a.mkv", webdavPath: "x.mkv", size: 10 }], {
      qbitHash: "hash",
    });
    expect(getTorboxTorrentId(id)).toBeUndefined();
  });

  test("getTorboxTorrentId returns undefined when no session exists", () => {
    expect(getTorboxTorrentId(uid())).toBeUndefined();
  });

  test("proxySourceOf prefers the recorded source", () => {
    expect(proxySourceOf({ source: "alldebrid", torbox_torrent_id: 0 })).toBe("alldebrid");
    expect(proxySourceOf({ source: "torbox", torbox_torrent_id: 5 })).toBe("torbox");
    expect(proxySourceOf({ source: "qbit", torbox_torrent_id: -1 })).toBe("qbit");
  });

  test("proxySourceOf falls back to the pre-AllDebrid encoding", () => {
    // Rows written before the column existed carry NULL, and a job mid-flight
    // across a deploy has to rehydrate from them.
    expect(proxySourceOf({ source: null, torbox_torrent_id: -1 })).toBe("qbit");
    expect(proxySourceOf({ source: null, torbox_torrent_id: 42 })).toBe("torbox");
    // An unrecognised value is data corruption, not a fourth source.
    expect(proxySourceOf({ source: "premiumize", torbox_torrent_id: -1 })).toBe("qbit");
  });

  test("getAlldebridMagnetId returns the id for an AllDebrid job", () => {
    const id = uid();
    createJob(id, "magnet:?xt=urn:btih:adslot");
    insertProxyMappings(id, 0, [{ rewrittenPath: "a.mkv", webdavPath: "Rel/a.mkv", size: 10 }], {
      source: "alldebrid",
      adMagnetId: 667750156,
    });
    expect(getAlldebridMagnetId(id)).toBe(667750156);
    // The two providers number their torrents independently, so a TorBox
    // cleanup must not see this row at all — deleting by a foreign id would
    // silently remove an unrelated torrent.
    expect(getTorboxTorrentId(id)).toBeUndefined();
  });

  test("getAlldebridMagnetId ignores sessions from other sources", () => {
    const tb = uid();
    createJob(tb, "magnet:?xt=urn:btih:tbnotad");
    insertProxyMappings(tb, 314, [{ rewrittenPath: "a.mkv", webdavPath: "x.mkv", size: 10 }], {
      source: "torbox",
    });
    expect(getAlldebridMagnetId(tb)).toBeUndefined();
    expect(getAlldebridMagnetId(uid())).toBeUndefined();
  });

  test("getAlldebridMagnetId returns undefined when the id was never recorded", () => {
    const id = uid();
    createJob(id, "magnet:?xt=urn:btih:adnoid");
    insertProxyMappings(id, 0, [{ rewrittenPath: "a.mkv", webdavPath: "x.mkv", size: 10 }], {
      source: "alldebrid",
    });
    expect(getAlldebridMagnetId(id)).toBeUndefined();
  });

  test("persists the per-file AllDebrid link", () => {
    const id = uid();
    createJob(id, "magnet:?xt=urn:btih:adlink");
    insertProxyMappings(
      id,
      0,
      [
        {
          rewrittenPath: "clean.mkv",
          webdavPath: "Rel/movie.mkv",
          size: 10,
          adLink: "https://alldebrid.com/f/tok",
        },
      ],
      { source: "alldebrid", adMagnetId: 1 },
    );
    const rows = getProxyMappings(id);
    expect(rows[0].ad_link).toBe("https://alldebrid.com/f/tok");
    expect(rows[0].source).toBe("alldebrid");
    expect(rows[0].ad_magnet_id).toBe(1);
  });

  test("getJobAlldebridApiKey reads the key off the job row", () => {
    const id = uid();
    createJob(id, "magnet:?xt=urn:btih:adkey", "tt1", false, { adApiKey: "USER_AD_KEY" });
    expect(getJobAlldebridApiKey(id)).toBe("USER_AD_KEY");

    const bare = uid();
    createJob(bare, "magnet:?xt=urn:btih:adnokey");
    expect(getJobAlldebridApiKey(bare)).toBeUndefined();
    expect(getJobAlldebridApiKey(uid())).toBeUndefined();
  });

  test("withDuration strips the AllDebrid key alongside the others", () => {
    const id = uid();
    const job = createJob(id, "magnet:?xt=urn:btih:adsecret", "tt1", false, {
      rdApiKey: "RD",
      tbApiKey: "TB",
      adApiKey: "AD",
    });
    const safe = withDuration(job) as Record<string, unknown>;
    expect(safe.ad_api_key).toBeUndefined();
    expect(safe.rd_api_key).toBeUndefined();
    expect(safe.tb_api_key).toBeUndefined();
  });

  test("deleteProxySession removes all mappings", () => {
    const id = uid();
    createJob(id, "magnet:?xt=urn:btih:vwx");
    insertProxyMappings(id, 99, [{ rewrittenPath: "a.mkv", webdavPath: "b.mkv", size: 1000 }]);
    deleteProxySession(id);
    expect(getProxyMappings(id)).toHaveLength(0);
  });

  test("getJobsWithoutNames returns jobs with proxy sessions but no name", () => {
    const id1 = uid();
    const id2 = uid();
    createJob(id1, "magnet:?xt=urn:btih:noname1");
    createJob(id2, "magnet:?xt=urn:btih:noname2");
    insertProxyMappings(id1, 50, [{ rewrittenPath: "a.mkv", webdavPath: "b.mkv", size: 1000 }]);
    insertProxyMappings(id2, 60, [{ rewrittenPath: "c.mkv", webdavPath: "d.mkv", size: 2000 }]);
    updateJob(id2, { name: "Already Named" });

    const results = getJobsWithoutNames();
    expect(results.some((r) => r.id === id1 && r.torbox_torrent_id === 50)).toBe(true);
    expect(results.some((r) => r.id === id2)).toBe(false);
  });
});

describe("withDuration", () => {
  test("computes duration for completed job", () => {
    const id = uid();
    createJob(id, "magnet:?xt=urn:btih:eee");
    updateJob(id, { status: "completed" });
    const job = getJob(id) as NonNullable<ReturnType<typeof getJob>>;
    const result = withDuration(job);
    expect(result.duration_seconds).toBeGreaterThanOrEqual(0);
  });

  test("returns null duration for incomplete job", () => {
    const id = uid();
    createJob(id, "magnet:?xt=urn:btih:fff");
    const job = getJob(id) as NonNullable<ReturnType<typeof getJob>>;
    const result = withDuration(job);
    expect(result.duration_seconds).toBeNull();
  });
});

describe("migrateJobStageNames", () => {
  test("migrates old stage names to new ones", () => {
    _db.exec("DROP TABLE IF EXISTS jobs");
    _db.exec(`
      CREATE TABLE jobs (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL DEFAULT 'magnet',
        input TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'downloading', 'creating_torrent', 'uploading_to_rd', 'monitoring_rd', 'completed', 'failed')),
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
    _db.exec(
      "INSERT INTO jobs (id, type, input, status) VALUES ('j1', 'magnet', 'magnet:?xt=urn:btih:aaa', 'monitoring_rd')",
    );
    _db.exec(
      "INSERT INTO jobs (id, type, input, status) VALUES ('j2', 'magnet', 'magnet:?xt=urn:btih:bbb', 'creating_torrent')",
    );
    _db.exec(
      "INSERT INTO jobs (id, type, input, status) VALUES ('j3', 'magnet', 'magnet:?xt=urn:btih:ccc', 'completed')",
    );

    migrateJobStageNames();

    const j1 = _db.prepare("SELECT status FROM jobs WHERE id = 'j1'").get() as { status: string };
    const j2 = _db.prepare("SELECT status FROM jobs WHERE id = 'j2'").get() as { status: string };
    const j3 = _db.prepare("SELECT status FROM jobs WHERE id = 'j3'").get() as { status: string };
    expect(j1.status).toBe("uploading");
    expect(j2.status).toBe("preparing");
    expect(j3.status).toBe("completed");

    // Recreate the proper table for subsequent tests
    _db.exec("DROP TABLE jobs");
    _db.exec(`
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
    // Restore the added columns through the same idempotent helper production
    // uses, rather than hand-copying them into the CREATE above. That copy is
    // precisely the bug this suite exists to catch in `migrateJobStageNames` —
    // a fixed column list that silently falls behind every later ALTER — and it
    // had already fallen behind here, dropping `ad_api_key` for every test that
    // ran after this one.
    addOptionalJobColumns();
  });

  test("no-op when table already has new constraint", () => {
    const id = uid();
    createJob(id, "magnet:?xt=urn:btih:noop");
    migrateJobStageNames();
    const job = getJob(id);
    expect(job?.status).toBe("pending");
  });
});

describe("migrateProxySessions", () => {
  test("recreates table when old schema lacks rewritten_path", () => {
    _db.exec("DROP TABLE IF EXISTS proxy_sessions");
    _db.exec(`
      CREATE TABLE proxy_sessions (
        job_id TEXT PRIMARY KEY,
        torbox_torrent_id INTEGER NOT NULL,
        file_id INTEGER NOT NULL,
        file_size INTEGER NOT NULL
      )
    `);
    _db.exec("INSERT INTO proxy_sessions VALUES ('old-job', 1, 2, 3000)");

    migrateProxySessions();

    const cols = _db.prepare("PRAGMA table_info(proxy_sessions)").all() as { name: string }[];
    expect(cols.some((c) => c.name === "rewritten_path")).toBe(true);
    expect(cols.some((c) => c.name === "webdav_path")).toBe(true);

    const rows = _db.prepare("SELECT * FROM proxy_sessions").all();
    expect(rows).toHaveLength(0);
  });
});

describe("per-user job limit", () => {
  const owners = (n: string) => ({
    tbUserId: `tb:${n}`,
    rdUserId: `rd:${n}`,
    pmUserId: `pm:${n}`,
  });

  test("finds a submitter's in-flight jobs, pending included", () => {
    const id = uid();
    createJob(id, "magnet:?xt=urn:btih:a", undefined, undefined, undefined, owners("1"));

    // `pending` counts: a queued job is holding a place in line, and letting
    // those pile up is the burst the limit exists to prevent.
    const active = getActiveJobsForRdOwner("rd:1");
    expect(active.map((j) => j.id)).toContain(id);
    expect(active.find((j) => j.id === id)?.status).toBe("pending");
  });

  test("ignores other accounts", () => {
    const id = uid();
    createJob(id, "magnet:?xt=urn:btih:b", undefined, undefined, undefined, owners("2"));
    expect(getActiveJobsForRdOwner("rd:other").map((j) => j.id)).not.toContain(id);
  });

  test("counts the Real-Debrid account and nothing else", () => {
    const id = uid();
    createJob(id, "magnet:?xt=urn:btih:c", undefined, undefined, undefined, {
      tbUserId: "tb:3",
      rdUserId: "rd:3",
      pmUserId: "",
    });

    // A second key for the same RD account is still the same submitter.
    expect(getActiveJobsForRdOwner("rd:3").map((j) => j.id)).toContain(id);
    // The TorBox side is an audit trail, not a second thing to count: one TorBox
    // account feeding two RD accounts gets a slot in each, deliberately.
    expect(getActiveJobsForRdOwner("tb:3").map((j) => j.id)).not.toContain(id);
    expect(getActiveJobsForRdOwner("rd:elsewhere").map((j) => j.id)).not.toContain(id);
  });

  test("a finished or deleted job stops counting against its owner", () => {
    const done = uid();
    const gone = uid();
    createJob(done, "magnet:?xt=urn:btih:d", undefined, undefined, undefined, owners("4"));
    createJob(gone, "magnet:?xt=urn:btih:e", undefined, undefined, undefined, owners("4"));

    expect(getActiveJobsForRdOwner("rd:4")).toHaveLength(2);

    updateJob(done, { status: "completed" });
    deleteJob(gone);

    expect(getActiveJobsForRdOwner("rd:4")).toHaveLength(0);
  });

  test("an AllDebrid-only job is limited exactly like a TorBox one", () => {
    // Its TorBox owner is the empty sentinel, which used to be the whole of the
    // difference: the RD side is the only identity either shape reliably has.
    const id = uid();
    createJob(id, "magnet:?xt=urn:btih:h", undefined, undefined, undefined, {
      tbUserId: "",
      rdUserId: "rd:7",
      pmUserId: "",
    });

    expect(getJob(id)?.tb_user_id).toBeNull();
    expect(getActiveJobsForRdOwner("rd:7").map((j) => j.id)).toContain(id);
  });

  test("jobs predating the columns are grandfathered, not blocking", () => {
    // Rows written before the limit existed hold NULL owners. They must match
    // nothing, or their submitter would be locked out until they drained.
    const id = uid();
    createJob(id, "magnet:?xt=urn:btih:f");

    expect(getJob(id)?.tb_user_id).toBeNull();
    expect(getActiveJobsForRdOwner("rd:5").map((j) => j.id)).not.toContain(id);
  });

  test("the owner columns survive the stage-name migration", () => {
    // `migrateJobStageNames` rebuilds `jobs` from a fixed column list that
    // predates every ALTER, so a column missing from `addOptionalJobColumns` is
    // silently dropped. That made it a data-losing downgrade once already.
    const id = uid();
    createJob(id, "magnet:?xt=urn:btih:g", undefined, undefined, undefined, owners("6"));

    migrateJobStageNames();

    expect(getJob(id)?.tb_user_id).toBe("tb:6");
    expect(getJob(id)?.rd_user_id).toBe("rd:6");
  });
});

describe("listJobsForRdOwner", () => {
  const owners = (n: string) => ({
    tbUserId: `tb:${n}`,
    rdUserId: `rd:${n}`,
    pmUserId: `pm:${n}`,
  });

  test("returns only the asking account's jobs, finished ones included", () => {
    const mine = uid();
    const theirs = uid();
    createJob(mine, "magnet:?xt=urn:btih:a1", undefined, undefined, undefined, owners("100"));
    createJob(theirs, "magnet:?xt=urn:btih:a2", undefined, undefined, undefined, owners("101"));
    // Unlike the per-user limit, this is a history view: a completed transfer is
    // exactly what a user opens the page to see.
    updateJob(mine, { status: "completed" });

    const ids = listJobsForRdOwner("rd:100", 100, 0).map((j) => j.id);
    expect(ids).toContain(mine);
    expect(ids).not.toContain(theirs);
  });

  test("an empty owner matches nothing", () => {
    // A job whose RD account never resolved holds NULL and matches nothing
    // already; a blank owner has to behave the same way, or the first caller
    // with an unresolvable key would be handed every such job on the host.
    const id = uid();
    createJob(id, "magnet:?xt=urn:btih:a3");

    expect(getJob(id)?.rd_user_id).toBeNull();
    expect(listJobsForRdOwner("", 100, 0)).toHaveLength(0);
  });

  test("the TorBox owner is not an alias for the RD one", () => {
    const id = uid();
    createJob(id, "magnet:?xt=urn:btih:a4", undefined, undefined, undefined, {
      tbUserId: "tb:102",
      rdUserId: "rd:102",
      pmUserId: "",
    });

    expect(listJobsForRdOwner("rd:102", 100, 0).map((j) => j.id)).toContain(id);
    expect(listJobsForRdOwner("tb:102", 100, 0).map((j) => j.id)).not.toContain(id);
  });

  test("a deleted job leaves the list", () => {
    const id = uid();
    createJob(id, "magnet:?xt=urn:btih:a5", undefined, undefined, undefined, owners("103"));
    expect(listJobsForRdOwner("rd:103", 100, 0)).toHaveLength(1);

    deleteJob(id);

    expect(listJobsForRdOwner("rd:103", 100, 0)).toHaveLength(0);
  });

  test("honours limit and offset, newest first", () => {
    const ids = [uid(), uid(), uid()];
    for (const id of ids) {
      createJob(id, `magnet:?xt=urn:btih:${id}`, undefined, undefined, undefined, owners("104"));
    }

    expect(listJobsForRdOwner("rd:104", 2, 0)).toHaveLength(2);
    expect(listJobsForRdOwner("rd:104", 2, 2)).toHaveLength(1);
    // Same-second inserts share a `created_at`, so the ordering claim that can
    // be made without a sleep is that paging covers every row exactly once.
    const paged = [
      ...listJobsForRdOwner("rd:104", 2, 0).map((j) => j.id),
      ...listJobsForRdOwner("rd:104", 2, 2).map((j) => j.id),
    ];
    expect(paged.sort()).toEqual([...ids].sort());
  });
});

describe("queuePlaceOf", () => {
  test("numbers waiting jobs consecutively, oldest first", () => {
    const [a, b, c] = [uid(), uid(), uid()];
    for (const id of [a, b, c]) createJob(id, `magnet:?xt=urn:btih:${id}`);

    const first = queuePlaceOf(a);
    const second = queuePlaceOf(b);
    const third = queuePlaceOf(c);

    expect(second?.position).toBe((first?.position ?? 0) + 1);
    expect(third?.position).toBe((second?.position ?? 0) + 1);
    // The three were created without anything else running, so they all see the
    // same queue depth and it is at least their own count.
    expect(second?.waiting).toBe(first?.waiting);
    expect(third?.waiting).toBe(first?.waiting);
    expect(first?.waiting).toBeGreaterThanOrEqual(3);
  });

  test("orders a same-second burst by insertion, not arbitrarily", () => {
    // `created_at` is `datetime('now')`, so a burst ties on it; without the
    // rowid tie-break the three could come back in any order, or share a place.
    const ids = [uid(), uid(), uid()];
    for (const id of ids) createJob(id, `magnet:?xt=urn:btih:${id}`);
    const places = ids.map((id) => queuePlaceOf(id)?.position ?? 0);

    expect(new Set(places).size).toBe(3);
    expect(places).toEqual([...places].sort((x, y) => x - y));
  });

  test("has no place once the job has started", () => {
    const id = uid();
    createJob(id, "magnet:?xt=urn:btih:started");
    expect(queuePlaceOf(id)).not.toBeNull();

    updateJob(id, { status: "downloading" });
    expect(queuePlaceOf(id)).toBeNull();
  });

  test("has no place once terminal", () => {
    const done = uid();
    const dead = uid();
    createJob(done, "magnet:?xt=urn:btih:done");
    createJob(dead, "magnet:?xt=urn:btih:dead");

    updateJob(done, { status: "completed" });
    updateJob(dead, { status: "failed" });

    expect(queuePlaceOf(done)).toBeNull();
    expect(queuePlaceOf(dead)).toBeNull();
  });

  test("has no place once deleted", () => {
    const id = uid();
    createJob(id, "magnet:?xt=urn:btih:gone");
    deleteJob(id);
    expect(queuePlaceOf(id)).toBeNull();
  });

  test("is unknown for a job that does not exist", () => {
    expect(queuePlaceOf("no-such-job")).toBeNull();
  });

  test("moves a job up when one ahead of it leaves the queue", () => {
    const ahead = uid();
    const behind = uid();
    createJob(ahead, "magnet:?xt=urn:btih:ahead");
    createJob(behind, "magnet:?xt=urn:btih:behind");

    const before = queuePlaceOf(behind);
    deleteJob(ahead);
    const after = queuePlaceOf(behind);

    expect(after?.position).toBe((before?.position ?? 0) - 1);
    expect(after?.waiting).toBe((before?.waiting ?? 0) - 1);
  });
});

describe("setJobSource", () => {
  test("records which provider served the job", () => {
    const id = uid();
    createJob(id, "magnet:?xt=urn:btih:src");
    expect(getJob(id)?.source).toBeNull();

    setJobSource(id, "alldebrid");
    expect(getJob(id)?.source).toBe("alldebrid");
  });

  test("outlives the proxy session it was learned from", () => {
    // `removeProxySession` drops the mappings on completion, so the job row is
    // the only place the answer survives — and a finished transfer is exactly
    // when someone wants to know where its bytes came from.
    const id = uid();
    createJob(id, "magnet:?xt=urn:btih:outlives");
    insertProxyMappings(id, 7, [{ rewrittenPath: "a.mkv", webdavPath: "b.mkv", size: 1 }], {
      source: "torbox",
    });
    setJobSource(id, "torbox");

    deleteProxySession(id);

    expect(getProxyMappings(id)).toHaveLength(0);
    expect(getJob(id)?.source).toBe("torbox");
  });

  test("survives the stage-name migration", () => {
    // `migrateJobStageNames` rebuilds `jobs` from a fixed column list that
    // predates every ALTER, so a column left out of `addOptionalJobColumns` is
    // silently dropped — that has already been a data-losing downgrade once.
    const id = uid();
    createJob(id, "magnet:?xt=urn:btih:migrated");
    setJobSource(id, "alldebrid");

    migrateJobStageNames();

    expect(getJob(id)?.source).toBe("alldebrid");
  });
});

describe("markJobStarted", () => {
  // A job queued behind MAX_CONCURRENT_JOBS must have no start time, or the
  // duration budget would count against work that has not begun.
  test("a new job has not started", () => {
    expect(createJob(uid(), "magnet:?xt=urn:btih:notstarted").started_at).toBeNull();
  });

  test("stamps the first start", () => {
    const id = uid();
    createJob(id, "magnet:?xt=urn:btih:started");
    markJobStarted(id);
    expect(getJob(id)?.started_at).toBeTruthy();
  });

  // The load-bearing property: `retryOrFail` re-enters `runJob`, so a retry must
  // inherit the elapsed time. If this reset, three retries would treble the cap.
  test("is idempotent, so a retry cannot win a fresh budget", () => {
    const id = uid();
    createJob(id, "magnet:?xt=urn:btih:idem");
    _db.prepare("UPDATE jobs SET started_at = ? WHERE id = ?").run("2020-01-01 00:00:00", id);
    markJobStarted(id);
    expect(getJob(id)?.started_at).toBe("2020-01-01 00:00:00");
  });
});

describe("getJobTotalBytes", () => {
  // Null rather than 0: the duration budget hands an unknown size the ceiling,
  // so coercing to zero would cap a job at the floor before it reported its size.
  test("is null before any files are known", () => {
    const id = uid();
    createJob(id, "magnet:?xt=urn:btih:nofiles");
    expect(getJobTotalBytes(id)).toBeNull();
  });

  test("sums every file of the job", () => {
    const id = uid();
    createJob(id, "magnet:?xt=urn:btih:sized");
    insertTorrentFiles(id, [
      { name: "a.mkv", size: 100 },
      { name: "b.mkv", size: 250 },
    ]);
    expect(getJobTotalBytes(id)).toBe(350);
  });

  test("does not count another job's files", () => {
    const mine = uid();
    const theirs = uid();
    createJob(mine, "magnet:?xt=urn:btih:mine");
    createJob(theirs, "magnet:?xt=urn:btih:theirs");
    insertTorrentFiles(theirs, [{ name: "big.mkv", size: 9999 }]);
    expect(getJobTotalBytes(mine)).toBeNull();
  });
});

describe("destinations", () => {
  test("a row written before the column reads as the original rd destination", () => {
    // NULL is what every job predating the reverse direction holds, and every
    // one of those delivered to Real-Debrid.
    expect(destinationOf({ destination: null })).toBe("rd");
    expect(destinationOf({ destination: "rd" })).toBe("rd");
    expect(destinationOf({ destination: "torbox" })).toBe("torbox");
    // Anything unrecognised falls back to the safe original rather than
    // becoming a destination nothing knows how to drive.
    expect(destinationOf({ destination: "nonsense" })).toBe("rd");
  });

  test("createJob stores the destination and defaults it to rd", () => {
    const plain = uid();
    createJob(plain, "magnet:?xt=urn:btih:d1");
    expect(getJob(plain)?.destination).toBe("rd");

    const tb = uid();
    createJob(tb, "magnet:?xt=urn:btih:d2", undefined, undefined, undefined, undefined, "torbox");
    expect(getJob(tb)?.destination).toBe("torbox");
  });

  test("the per-user limit counts the account the job delivers to", () => {
    const rdJob = uid();
    const tbJob = uid();
    createJob(rdJob, "magnet:?xt=urn:btih:d3", undefined, undefined, undefined, {
      tbUserId: "tb:50",
      rdUserId: "rd:50",
      pmUserId: "",
    });
    createJob(
      tbJob,
      "magnet:?xt=urn:btih:d4",
      undefined,
      undefined,
      undefined,
      { tbUserId: "tb:50", rdUserId: "rd:51", pmUserId: "" },
      "torbox",
    );

    // Same TorBox account owns both, but only the TorBox-destination one is
    // counted against it; the other is counted against its RD account.
    const forTorbox = getActiveJobsForDestinationOwner("torbox", {
      tbUserId: "tb:50",
      rdUserId: "rd:50",
      pmUserId: "",
    });
    expect(forTorbox.map((j) => j.id)).toEqual([tbJob]);

    const forRd = getActiveJobsForDestinationOwner("rd", {
      tbUserId: "tb:50",
      rdUserId: "rd:50",
      pmUserId: "",
    });
    expect(forRd.map((j) => j.id)).toEqual([rdJob]);
  });

  test("the Premiumize limit counts only jobs delivered to Premiumize", () => {
    const rdJob = uid();
    const pmJob = uid();
    const owners = { tbUserId: "", rdUserId: "rd:70", pmUserId: "pm:70" };
    createJob(rdJob, "magnet:?xt=urn:btih:d6", undefined, undefined, undefined, owners);
    createJob(
      pmJob,
      "magnet:?xt=urn:btih:d7",
      undefined,
      undefined,
      undefined,
      owners,
      "premiumize",
    );

    expect(getActiveJobsForDestinationOwner("premiumize", owners).map((j) => j.id)).toEqual([
      pmJob,
    ]);
  });

  test("an unresolved owner matches nothing rather than everything", () => {
    // A TorBox-destination job may carry no RD key, so that side resolves to "".
    // If a blank owner matched blank rows, unrelated submitters would share one
    // bucket and the limit would bind strangers together.
    const id = uid();
    createJob(id, "magnet:?xt=urn:btih:d5", undefined, undefined, undefined, {
      tbUserId: "tb:60",
      rdUserId: "",
      pmUserId: "",
    });
    expect(
      getActiveJobsForDestinationOwner("rd", { tbUserId: "tb:60", rdUserId: "", pmUserId: "" }),
    ).toEqual([]);
  });
});

describe("Real-Debrid source cleanup", () => {
  const mapping = [{ rewrittenPath: "Movie.mkv", webdavPath: "orig.mkv", size: 10 }];

  test("returns the id only for a torrent this service added", () => {
    const id = uid();
    createJob(id, "magnet:?xt=urn:btih:e1");
    insertProxyMappings(id, 0, mapping, { source: "realdebrid", rdSourceTorrentId: "RDT1" });
    expect(getRdSourceTorrentId(id)).toBe("RDT1");
  });

  test("returns undefined for a release the submitter already had", () => {
    // The whole point: no recorded id means we did not create it, and deleting
    // it would remove a library item they never asked us to touch.
    const id = uid();
    createJob(id, "magnet:?xt=urn:btih:e2");
    insertProxyMappings(id, 0, mapping, { source: "realdebrid" });
    expect(getRdSourceTorrentId(id)).toBeUndefined();
  });

  test("returns undefined when the job sourced from somewhere else", () => {
    const id = uid();
    createJob(id, "magnet:?xt=urn:btih:e3");
    insertProxyMappings(id, 7, mapping, { source: "torbox" });
    expect(getRdSourceTorrentId(id)).toBeUndefined();
  });

  test("returns undefined for a job with no session at all", () => {
    expect(getRdSourceTorrentId(uid())).toBeUndefined();
  });

  test("round-trips the per-file restricted link", () => {
    const id = uid();
    createJob(id, "magnet:?xt=urn:btih:e4");
    insertProxyMappings(id, 0, [{ ...mapping[0], rdLink: "https://real-debrid.com/d/ABC" }], {
      source: "realdebrid",
    });
    expect(getProxyMappings(id)[0].rd_link).toBe("https://real-debrid.com/d/ABC");
  });

  test("realdebrid survives as a source through proxySourceOf", () => {
    expect(proxySourceOf({ source: "realdebrid", torbox_torrent_id: 0 })).toBe("realdebrid");
  });

  test("the RD key is readable from the job row for a rehydrated session", () => {
    const id = uid();
    createJob(id, "magnet:?xt=urn:btih:e5", undefined, undefined, { rdApiKey: "RDKEY" });
    expect(getJobRealdebridApiKey(id)).toBe("RDKEY");
    expect(getJobRealdebridApiKey(uid())).toBeUndefined();
  });
});

describe("credential purge", () => {
  function withKeys(id: string, status?: JobStatus): string {
    createJob(id, "magnet:?xt=urn:btih:purge", "tt1", false, {
      rdApiKey: "RD_SECRET",
      tbApiKey: "TB_SECRET",
      adApiKey: "AD_SECRET",
    });
    if (status) updateJob(id, { status });
    return id;
  }

  test("clearJobSecrets removes all three credentials", () => {
    const id = withKeys(uid());
    clearJobSecrets(id);
    const job = getJob(id);
    expect(job?.rd_api_key).toBeNull();
    expect(job?.tb_api_key).toBeNull();
    expect(job?.ad_api_key).toBeNull();
    expect(getJobTorboxApiKey(id)).toBeUndefined();
    expect(getJobAlldebridApiKey(id)).toBeUndefined();
    expect(getJobRealdebridApiKey(id)).toBeUndefined();
  });

  test("clearJobSecrets leaves the rest of the job intact", () => {
    const id = withKeys(uid(), "completed");
    clearJobSecrets(id);
    const job = getJob(id);
    expect(job?.status).toBe("completed");
    expect(job?.input).toBe("magnet:?xt=urn:btih:purge");
    expect(job?.imdb_id).toBe("tt1");
    expect(job?.completed_at).not.toBeNull();
  });

  // dmm's Transfers page and the announcer both poll on job state. A purge is
  // not a state change and must not read like one.
  test("clearJobSecrets does not bump updated_at", () => {
    const id = withKeys(uid(), "completed");
    const before = getJob(id)?.updated_at;
    clearJobSecrets(id);
    expect(getJob(id)?.updated_at).toBe(before as string);
  });

  test("clearJobSecrets on an unknown id is a no-op", () => {
    expect(() => clearJobSecrets("no-such-job")).not.toThrow();
  });

  test("clearJobSecrets is idempotent", () => {
    const id = withKeys(uid());
    clearJobSecrets(id);
    clearJobSecrets(id);
    expect(getJob(id)?.rd_api_key).toBeNull();
  });

  test("purgeFinishedJobSecrets clears finished jobs and reports the count", () => {
    const done = withKeys(uid(), "completed");
    const dead = withKeys(uid(), "failed");
    expect(purgeFinishedJobSecrets()).toBeGreaterThanOrEqual(2);
    expect(getJob(done)?.tb_api_key).toBeNull();
    expect(getJob(dead)?.tb_api_key).toBeNull();
  });

  // The safety property, and the reason the purge is not folded into
  // `updateJob`. A job that is still in flight needs its key on every range
  // read, and `releaseTorboxSlot` reads it back off the row during cleanup —
  // clearing one of these early strands the submitter's TorBox slot for the
  // full 30-day seed window.
  test.each<JobStatus>(["pending", "downloading", "uploading", "preparing"])(
    "purgeFinishedJobSecrets never touches a %s job",
    (status) => {
      const id = withKeys(uid(), status);
      purgeFinishedJobSecrets();
      expect(getJobTorboxApiKey(id)).toBe("TB_SECRET");
      expect(getJobRealdebridApiKey(id)).toBe("RD_SECRET");
      expect(getJobAlldebridApiKey(id)).toBe("AD_SECRET");
    },
  );

  test("purgeFinishedJobSecrets counts only rows that still held a secret", () => {
    withKeys(uid(), "completed");
    purgeFinishedJobSecrets();
    expect(purgeFinishedJobSecrets()).toBe(0);
  });

  test("purgeFinishedJobSecrets purges a soft-deleted terminal job too", () => {
    const id = withKeys(uid(), "completed");
    deleteJob(id);
    purgeFinishedJobSecrets();
    expect(getJob(id)?.rd_api_key).toBeNull();
  });

  // `deleteJob` sets `deleted = 1` and leaves the status alone, so a cancelled
  // job never becomes terminal. Sweeping on status alone left 113 of these on
  // debrid02 holding live keys, the oldest three weeks old. Nothing resumes
  // them — `getIncompleteJobs` filters `deleted = 0` — so they are finished.
  test.each<JobStatus>(["pending", "downloading", "uploading", "preparing"])(
    "purgeFinishedJobSecrets clears a cancelled %s job",
    (status) => {
      const id = withKeys(uid(), status);
      deleteJob(id);
      purgeFinishedJobSecrets();
      expect(getJobTorboxApiKey(id)).toBeUndefined();
      expect(getJobRealdebridApiKey(id)).toBeUndefined();
      expect(getJobAlldebridApiKey(id)).toBeUndefined();
    },
  );

  test("a cancelled job is not resumable, which is what makes clearing it safe", () => {
    const id = withKeys(uid(), "uploading");
    deleteJob(id);
    expect(getIncompleteJobs().some((j) => j.id === id)).toBe(false);
  });

  test("purgeFinishedJobSecrets still spares a live job that was never cancelled", () => {
    const id = withKeys(uid(), "uploading");
    purgeFinishedJobSecrets();
    expect(getJobTorboxApiKey(id)).toBe("TB_SECRET");
  });
});
