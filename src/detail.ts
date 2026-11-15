import type { JobWithDuration, TorrentFile } from "./db";

export function jobDetailHtml(job: JobWithDuration, files: TorrentFile[]): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(job.name || job.id)} — debrid</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: ui-monospace, "Cascadia Code", Menlo, monospace; background: #0a0a0a; color: #e0e0e0; padding: 24px; max-width: 960px; }
  a { color: #888; text-decoration: none; }
  a:hover { color: #fff; }
  h1 { font-size: 16px; font-weight: 600; margin-bottom: 20px; color: #fff; }
  .back { font-size: 13px; margin-bottom: 16px; display: inline-block; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; text-transform: uppercase; }
  .badge.pending { background: #222; color: #888; }
  .badge.downloading { background: #222; color: #ccc; }
  .badge.preparing { background: #222; color: #ccc; }
  .badge.uploading { background: #222; color: #ccc; }
  .badge.completed { background: #333; color: #fff; }
  .badge.failed { background: #222; color: #666; }
  section { margin-bottom: 24px; }
  section h2 { font-size: 13px; font-weight: 600; color: #888; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 10px; }
  .grid { display: grid; grid-template-columns: 140px 1fr; gap: 4px 12px; font-size: 13px; }
  .grid .label { color: #666; }
  .grid .value { color: #e0e0e0; word-break: break-all; }
  .grid .value.error { color: #888; }
  .file-card { background: #111; border: 1px solid #222; border-radius: 6px; padding: 14px; margin-bottom: 10px; }
  .file-card .fname { font-size: 13px; color: #fff; font-weight: 600; margin-bottom: 8px; word-break: break-all; }
  .file-card .fsize { color: #666; font-size: 12px; margin-bottom: 10px; }
  .rd-link { font-size: 12px; margin-bottom: 8px; }
  .rd-link a { color: #6a9; }
  .rd-link a:hover { color: #8cb; }
  .empty { color: #555; font-size: 13px; }
</style>
</head>
<body>
<a class="back" href="/">← dashboard</a>
<h1>${esc(job.name || job.id)}</h1>

<section>
  <h2>Job</h2>
  <div class="grid">
    <div class="label">Status</div>
    <div class="value"><span class="badge ${esc(job.status)}">${esc(job.status)}</span></div>
    <div class="label">ID</div>
    <div class="value">${esc(job.id)}</div>
    <div class="label">Input</div>
    <div class="value">${esc(job.input)}</div>
    ${job.imdb_id ? `<div class="label">IMDB</div><div class="value">${esc(job.imdb_id)}</div>` : ""}
    ${job.info_hash ? `<div class="label">Info Hash</div><div class="value">${esc(job.info_hash)}</div>` : ""}
    ${job.rd_torrent_id ? `<div class="label">RD Torrent</div><div class="value">${esc(job.rd_torrent_id)}</div>` : ""}
    ${job.file_path ? `<div class="label">File</div><div class="value">${esc(job.file_path)}</div>` : ""}
    ${job.status_message ? `<div class="label">Progress</div><div class="value">${esc(job.status_message)}</div>` : ""}
    ${job.error ? `<div class="label">Error</div><div class="value error">${esc(job.error)}</div>` : ""}
    <div class="label">Retries</div>
    <div class="value">${job.retry_count}</div>
    <div class="label">Created</div>
    <div class="value">${esc(job.created_at)}</div>
    ${job.completed_at ? `<div class="label">Completed</div><div class="value">${esc(job.completed_at)}</div>` : ""}
    ${job.duration_seconds != null ? `<div class="label">Duration</div><div class="value">${formatDuration(job.duration_seconds)}</div>` : ""}
  </div>
</section>

<section>
  <h2>Files (${files.length})</h2>
  ${files.length === 0 ? '<div class="empty">No files recorded</div>' : files.map(renderFile).join("")}
</section>

<script>
${job.status !== "completed" && job.status !== "failed" ? `setInterval(() => location.reload(), 5000);` : ""}
</script>
</body>
</html>`;
}

function renderFile(f: TorrentFile): string {
  return `<div class="file-card">
    <div class="fname">${esc(f.name)}</div>
    <div class="fsize">${formatBytes(f.size)}</div>
    ${f.rd_link ? `<div class="rd-link"><a href="https://real-debrid.com/downloader?links=${encodeURIComponent(f.rd_link)}" target="_blank">${esc(f.rd_link)}</a></div>` : ""}
  </div>`;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}
