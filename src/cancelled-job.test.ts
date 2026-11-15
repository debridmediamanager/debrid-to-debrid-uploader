import { describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import { createApp } from "./app";
import { createJob, deleteJob, getJob, type JobStatus, listJobs, updateJob } from "./db";
import cancelledDownloading from "./fixtures/jobs/cancelled-downloading.json";
import cancelledPending from "./fixtures/jobs/cancelled-pending.json";
import cancelledUploading from "./fixtures/jobs/cancelled-uploading.json";

/**
 * `GET /jobs/:id` bodies captured from debrid02 on 2026-10-03 for three jobs
 * whose submitters had cancelled them from DMM's Transfers page. Each came back
 * with `deleted: 1` and the status it held at the moment of the cancel, which it
 * keeps for good: `deleteJob` only sets the flag. 237 rows on that host read
 * like this, and DMM held 222 of them as transfers still "in progress", which
 * refused every later send of those releases.
 */
/** The fields of a captured body that decide what the route reports. */
type CapturedJob = {
  input: string;
  imdb_id: string;
  status: string;
  deleted: number;
  status_message: string | null;
  name: string | null;
  info_hash: string | null;
  rd_torrent_id: string | null;
};

const CAPTURED: [string, CapturedJob][] = [
  ["cancelled while RD was pulling", cancelledUploading],
  ["cancelled while queued", cancelledPending],
  ["cancelled while fetching the torrent", cancelledDownloading],
];

/**
 * Put a row into the state the captured body describes, under a fresh id so
 * the suite's shared database never sees the same job twice.
 */
function replay(captured: CapturedJob): string {
  const id = `cancel-${crypto.randomUUID()}`;
  createJob(id, captured.input, captured.imdb_id);
  updateJob(id, {
    status: captured.status as JobStatus,
    status_message: captured.status_message ?? undefined,
    name: captured.name ?? undefined,
    info_hash: captured.info_hash ?? undefined,
    rd_torrent_id: captured.rd_torrent_id ?? undefined,
  });
  if (captured.deleted === 1) deleteJob(id);
  return id;
}

async function getJson(id: string): Promise<Record<string, unknown>> {
  const res = await createApp().request(`/jobs/${id}`, {
    headers: { accept: "application/json" },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

describe("GET /jobs/:id for a cancelled job", () => {
  for (const [label, captured] of CAPTURED) {
    test(`${label}: reports it failed, not ${captured.status}`, async () => {
      const id = replay(captured);
      // The row itself keeps its last stage: an in-flight stage can still be
      // writing it, which is why the answer is derived rather than stored.
      expect(getJob(id)?.status).toBe(captured.status as JobStatus);

      const body = await getJson(id);

      expect(body.status).toBe("failed");
      expect(body.error).toBe("cancelled");
      expect(body.deleted).toBe(1);
    });
  }

  test("a cancelled job stays out of the listings", () => {
    const id = replay(cancelledUploading);
    expect(listJobs().some((job) => job.id === id)).toBe(false);
  });

  test("a job that finished before its cancel keeps its real outcome", async () => {
    // A completed transfer is in RD whether or not someone cleared it from a
    // list afterwards, and DMM files it into search on that word.
    const completed = replay({ ...cancelledUploading, status: "completed", deleted: 0 });
    deleteJob(completed);
    expect((await getJson(completed)).status).toBe("completed");

    const failed = replay({ ...cancelledUploading, status: "failed", deleted: 0 });
    updateJob(failed, { status: "failed", error: "uncached" });
    deleteJob(failed);
    const body = await getJson(failed);
    expect(body.status).toBe("failed");
    expect(body.error).toBe("uncached");
  });

  test("a live job is reported as it is", async () => {
    const id = replay({ ...cancelledUploading, deleted: 0 });
    const body = await getJson(id);
    expect(body.status).toBe("uploading");
    expect(body.error).toBeNull();
  });
});
