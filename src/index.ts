import { createApp } from "./app";
import { config } from "./config";
import { getIncompleteJobs, getJobsWithoutNames, purgeFinishedJobSecrets, updateJob } from "./db";
import { gracefulShutdown } from "./shutdown";
import { takedown } from "./takedown";
import * as torbox from "./torbox";
import { processJob } from "./worker";

const app = createApp();

// Before resuming jobs, so the persisted copy is loaded when they re-check it.
if (takedown.enabled) takedown.start();
else console.warn("[takedown] DMM_BLOCKLIST_URL is empty: the takedown blocklist is disabled");

console.log(`debrid uploader listening on ${config.host}:${config.port}`);
console.log(`base URL: ${config.baseUrl}`);

resumeIncompleteJobs();
// Sequenced, not parallel: `backfillJobNames` reads `tb_api_key` off finished
// rows to ask TorBox what the release was called, so sweeping first would take
// the key out from under it. The sweep is what cleans a deployment's history —
// on 2026-08-27 that was 1604 rows across the two hosts.
backfillJobNames()
  .catch((err) => console.error("[backfill] failed", err))
  .then(() => {
    const purged = purgeFinishedJobSecrets();
    if (purged > 0) console.log(`[purge] cleared credentials from ${purged} finished job(s)`);
  });

const server = Bun.serve({
  port: config.port,
  hostname: config.host,
  fetch(req, server) {
    const ip = server.requestIP(req)?.address || "unknown";
    return app.fetch(req, { ip });
  },
});

// systemd sends SIGINT on every `systemctl restart`, i.e. on every deploy. With
// no handler Bun exits at once and every webseed range RD is mid-way through
// dies with it — bytes already billed to the submitter's TorBox account, thrown
// away. Draining costs a second and makes a deploy invisible to a live transfer.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    await gracefulShutdown(signal, server, { timeoutMs: config.shutdownDrainMs });
    process.exit(0);
  });
}

function resumeIncompleteJobs(): void {
  const incomplete = getIncompleteJobs();
  if (incomplete.length === 0) return;

  console.log(`[recovery] resuming ${incomplete.length} incomplete job(s)`);
  for (const job of incomplete) {
    console.log(`[recovery] job=${job.id} status=${job.status} retries=${job.retry_count}`);
    processJob(job.id).catch((err) => console.error(`[recovery] job=${job.id} failed`, err));
  }
}

async function backfillJobNames(): Promise<void> {
  const jobs = getJobsWithoutNames();
  if (jobs.length === 0) return;

  console.log(`[backfill] filling names for ${jobs.length} job(s)`);
  for (const { id, torbox_torrent_id, tb_api_key } of jobs) {
    try {
      // The torrent lives in whichever account submitted it, so ask that one.
      const info = await torbox.getTorrentInfo(torbox_torrent_id, {
        apiKey: tb_api_key ?? undefined,
      });
      if (info.name) {
        updateJob(id, { name: info.name });
        console.log(`[backfill] job=${id} name="${info.name}"`);
      }
    } catch (err) {
      console.log(`[backfill] job=${id} failed: ${err}`);
    }
  }
}
