import crypto from "node:crypto";
import { Hono } from "hono";
import { dashboardHtml } from "./dashboard";
import {
  clearJobSecrets,
  createJob,
  deleteJob,
  getActiveJobsForDestinationOwner,
  getJob,
  getTorrentFiles,
  listJobs,
  listJobsForRdOwner,
  queuePlaceOf,
  withDuration,
} from "./db";
import { jobDetailHtml } from "./detail";
import { type JobInputBody, parseJobInput, parsePageParams, ValidationError } from "./job-input";
import { claimsSponsor, jobLimitFor, resolveJobOwners } from "./owners";
import { handleProxyRequest } from "./proxy";
import { requestIp } from "./request";
import { takedown } from "./takedown";
import { getCurrentUser as getTorboxUser, PlanRestrictedError } from "./torbox";
import { cleanupJobFiles, processJob } from "./worker";

type Bindings = {
  ip?: string;
};

export function createApp(): Hono<{ Bindings: Bindings }> {
  const app = new Hono<{ Bindings: Bindings }>();

  app.get("/", (c) => c.html(dashboardHtml()));

  app.post("/jobs", async (c) => {
    try {
      const body = await c.req.json<
        JobInputBody & { force_webtorrent?: boolean; sponsor?: unknown }
      >();
      const parsed = parseJobInput(body);
      // Before anything else touches a provider: a source named in a copyright
      // notice is refused outright, whatever the caller's limits would say.
      const blocked = takedown.check({ input: parsed.input });
      if (blocked) return c.json({ error: blocked.message }, 451);
      if (parsed.torboxApiKey) {
        // Owner ids are cached indefinitely, but plan entitlements can change.
        // Refuse a definite free plan on every submission, before creating a job.
        try {
          await getTorboxUser({ apiKey: parsed.torboxApiKey });
        } catch (err) {
          if (err instanceof PlanRestrictedError) {
            throw new ValidationError("A paid TorBox plan is required to use tb_api_key");
          }
          // Preserve degraded admission on identity outages; the worker reports
          // those provider failures rather than calling an unknown plan free.
        }
      }
      const creds = {
        rdApiKey: parsed.rdApiKey,
        tbApiKey: parsed.torboxApiKey,
        adApiKey: parsed.alldebridApiKey,
        pmApiKey: parsed.premiumizeApiKey,
      };

      // Resolve the owners *before* the check, so that everything from here to
      // the insert runs without an await. Two submissions racing on one account
      // would otherwise both read the count, both see room, and both be
      // admitted — the check and the write have to be one synchronous step.
      const owners = await resolveJobOwners(creds);
      // Counted against the account the job *delivers to*, which is the identity
      // every job has whichever direction it runs in.
      const active = getActiveJobsForDestinationOwner(parsed.destination, owners);
      // A sponsor gets a higher ceiling, not an exemption — `null` is the
      // operator exemption and nothing else reaches it.
      const limit = jobLimitFor(owners, claimsSponsor(body.sponsor));
      if (limit !== null && active.length >= limit) {
        return c.json(
          {
            error: "job limit reached",
            limit,
            active: active.map((j) => ({ id: j.id, status: j.status })),
          },
          429,
        );
      }

      const job = createJob(
        crypto.randomUUID(),
        parsed.input,
        parsed.imdbId,
        body.force_webtorrent,
        creds,
        owners,
        parsed.destination,
      );
      processJob(job.id).catch((err) => console.error(`[worker] job=${job.id} failed`, err));
      return c.json(withDuration(job), 201);
    } catch (err) {
      if (err instanceof ValidationError) return c.json({ error: err.message }, 400);
      throw err;
    }
  });

  app.get("/jobs", (c) => c.json(listJobs().map(withDuration)));

  // One caller's own jobs, resolved from the key they present rather than from a
  // parameter. **Never take an account id here**: RD ids are small integers, so
  // an `?rd_user_id=` parameter would let anyone page through everybody's
  // transfers by counting upwards. The key is the proof, and it arrives as a
  // header because a query string is logged by every proxy in front of this.
  //
  // Registered before `/jobs/:id` so the literal wins over the parameter — a
  // job can never be named `mine`, but relying on that ordering accident is
  // cheaper than relying on nobody trying.
  app.get("/jobs/mine", async (c) => {
    const rdApiKey = c.req.header("x-rd-api-key");
    if (!rdApiKey) return c.json({ error: "x-rd-api-key required" }, 401);

    const { limit, offset } = parsePageParams(c.req.query("limit"), c.req.query("offset"));
    // Reuses the submit path's owner cache, so a 5s poll costs one RD call for
    // the life of the process rather than one per tick. A failed lookup degrades
    // to `rd:key:<digest>` (see `owners.ts`), which matches only jobs stored
    // under that same digest — so an RD outage shortens the list rather than
    // widening it, which is the direction this has to fail in.
    const { rdUserId } = await resolveJobOwners({ rdApiKey });
    // Carries `queue` for the same reason `/jobs/:id` does, and it has to: this
    // route replaces the per-job poll, so anything it drops disappears from the
    // UI. `queuePlaceOf` returns null on its first query for a job that is not
    // `pending`, so a page of running jobs pays one short lookup each.
    return c.json(
      listJobsForRdOwner(rdUserId, limit, offset).map((job) => {
        const queue = queuePlaceOf(job.id);
        return queue ? { ...withDuration(job), queue } : withDuration(job);
      }),
    );
  });

  app.get("/jobs/:id", (c) => {
    const job = getJob(c.req.param("id"));
    if (!job) return c.json({ error: "not found" }, 404);
    if (c.req.header("accept")?.includes("text/html")) {
      const files = getTorrentFiles(job.id);
      return c.html(jobDetailHtml(withDuration(job), files));
    }
    // Only a waiting job has a place in line, so the field is absent rather
    // than zeroed once it starts — a caller can treat its presence as "still
    // queued" without re-deriving that from the status.
    const queue = queuePlaceOf(job.id);
    return c.json(queue ? { ...withDuration(job), queue } : withDuration(job));
  });

  app.get("/jobs/:id/files", (c) => {
    const job = getJob(c.req.param("id"));
    if (!job) return c.json({ error: "not found" }, 404);
    return c.json(getTorrentFiles(job.id));
  });

  app.get("/webseed/:jobId/*", async (c) => {
    const jobId = c.req.param("jobId");
    const filePath = decodeURIComponent(c.req.path.replace(`/webseed/${jobId}/`, ""));
    const range = c.req.header("range") || null;
    return handleProxyRequest(jobId, filePath, range);
  });

  app.get("/proxy/*", async (c) => {
    const parts = c.req.path.replace("/proxy/", "").split("/");
    const upstream = Buffer.from(parts[0], "base64url").toString();
    const ip = requestIp(c.req, c.env);
    const range = c.req.header("range") || "none";
    console.log(`[proxy] ip=${ip} range=${range}`);

    const headers: Record<string, string> = {};
    if (range !== "none") headers.Range = range;

    const res = await fetch(upstream, { headers });
    const respHeaders = new Headers();
    for (const key of ["content-type", "content-length", "content-range", "accept-ranges"]) {
      const val = res.headers.get(key);
      if (val) respHeaders.set(key, val);
    }
    return new Response(res.body, { status: res.status, headers: respHeaders });
  });

  app.delete("/jobs/:id", (c) => {
    const job = getJob(c.req.param("id"));
    if (!job) return c.json({ error: "not found" }, 404);
    deleteJob(job.id);
    // Cleanup owns local files, session rows and any authoritatively created
    // RD source. A TorBox/AllDebrid source id never authorizes provider deletion.
    cleanupJobFiles(job.id);
    // Cleanup must read the job's credentials before they are cleared.
    clearJobSecrets(job.id);
    return c.json({ ok: true });
  });

  return app;
}
