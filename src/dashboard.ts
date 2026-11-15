export function dashboardHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>debrid</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: ui-monospace, "Cascadia Code", Menlo, monospace; background: #0a0a0a; color: #e0e0e0; padding: 24px; }
  h1 { font-size: 18px; font-weight: 600; margin-bottom: 16px; color: #fff; }
  .stats { display: flex; gap: 12px; margin-bottom: 20px; flex-wrap: wrap; }
  .stat { padding: 8px 14px; border-radius: 6px; background: #1a1a1a; border: 1px solid #2a2a2a; font-size: 13px; }
  .stat .n { font-weight: 700; color: #fff; }
  form { display: flex; gap: 8px; margin-bottom: 20px; }
  input[type="text"] { flex: 1; padding: 8px 12px; background: #1a1a1a; border: 1px solid #333; border-radius: 6px; color: #fff; font-family: inherit; font-size: 13px; outline: none; }
  input[type="text"]:focus { border-color: #555; }
  button { padding: 8px 16px; background: #fff; color: #000; border: none; border-radius: 6px; font-family: inherit; font-size: 13px; font-weight: 600; cursor: pointer; }
  button:hover { background: #ddd; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; padding: 8px 10px; color: #888; font-weight: 500; border-bottom: 1px solid #222; }
  td { padding: 8px 10px; border-bottom: 1px solid #161616; vertical-align: top; }
  tr:hover td { background: #111; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; text-transform: uppercase; }
  .badge.pending { background: #222; color: #888; }
  .badge.downloading { background: #222; color: #ccc; }
  .badge.preparing { background: #222; color: #ccc; }
  .badge.uploading { background: #222; color: #ccc; }
  .badge.completed { background: #333; color: #fff; }
  .badge.failed { background: #222; color: #666; }
  .name-cell { max-width: 350px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .detail { color: #888; font-size: 12px; max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .time { color: #666; font-size: 11px; white-space: nowrap; }
  .del { background: none; border: 1px solid #222; color: #444; border-radius: 4px; padding: 2px 8px; font-family: inherit; font-size: 11px; cursor: pointer; }
  .del:hover { border-color: #fff; color: #fff; }
  .empty { text-align: center; color: #555; padding: 40px; }
  a { color: #e0e0e0; text-decoration: none; }
  a:hover { color: #fff; text-decoration: underline; }
</style>
</head>
<body>
<h1>debrid</h1>
<div class="stats" id="stats"></div>
<form id="form">
  <input type="text" name="input" placeholder="Magnet URI or info hash" autocomplete="off" required>
  <input type="text" name="imdb_id" placeholder="tt1234567" style="width: 110px; flex: none;" autocomplete="off" required>
  <input type="password" name="rd_api_key" placeholder="RD key" style="width: 130px; flex: none;" autocomplete="off" required>
  <input type="password" name="tb_api_key" placeholder="TorBox key" style="width: 130px; flex: none;" autocomplete="off">
  <input type="password" name="ad_api_key" placeholder="AllDebrid key" style="width: 130px; flex: none;" autocomplete="off">
  <button type="submit">Add</button>
</form>
<div id="formError" style="color:#e06c6c; font-size:12px; margin:-8px 0 12px;"></div>
<table>
  <thead><tr><th>Status</th><th>Name</th><th>Progress</th><th>Duration</th><th></th></tr></thead>
  <tbody id="tbody"></tbody>
</table>
<script>
async function load() {
  const res = await fetch('/jobs');
  const jobs = await res.json();
  const tbody = document.getElementById('tbody');
  const counts = {};
  jobs.forEach(j => counts[j.status] = (counts[j.status] || 0) + 1);
  document.getElementById('stats').innerHTML =
    Object.entries(counts).map(([s, n]) => '<div class="stat"><span class="badge ' + s + '">' + s + '</span> <span class="n">' + n + '</span></div>').join('') ||
    '<div class="stat">No jobs yet</div>';
  if (jobs.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty">No jobs</td></tr>';
    return;
  }
  tbody.innerHTML = jobs.map(j => {
    const name = j.name || j.info_hash || j.input.replace(/magnet:\\?xt=urn:btih:/, '').slice(0, 16);
    const detail = progress(j);
    return '<tr>' +
      '<td><span class="badge ' + j.status + '">' + j.status + '</span></td>' +
      '<td class="name-cell"><a href="/jobs/' + j.id + '" title="' + esc(j.input) + '">' + esc(name) + '</a></td>' +
      '<td class="detail">' + detail + '</td>' +
      '<td class="time">' + dur(j.duration_seconds) + '</td>' +
      '<td><button class="del" onclick="del(&quot;' + j.id + '&quot;)">x</button></td>' +
      '</tr>';
  }).join('');
}
function progress(j) {
  if (j.status === 'completed') return '<span style="color:#3fb950">done</span>';
  if (j.status === 'failed') return '<span style="color:#666" title="' + esc(j.error) + '">' + esc((j.error || '').split('\\n')[0]).slice(0, 60) + '</span>';
  return esc(j.status_message || j.status);
}
async function del(id) { await fetch('/jobs/' + id, { method: 'DELETE' }); load(); }
function esc(s) { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML.replace(/"/g, '&quot;'); }
function dur(s) { if (s == null) return '—'; const m = Math.floor(s / 60); const sec = Math.round(s % 60); return m > 0 ? m + 'm ' + sec + 's' : sec + 's'; }
document.getElementById('form').onsubmit = async (e) => {
  e.preventDefault();
  const input = e.target.input.value.trim();
  const imdb_id = e.target.imdb_id.value.trim();
  if (!input || !imdb_id) return;
  // Credentials are mandatory: there is no operator account to fall back to.
  const body = { input, imdb_id, rd_api_key: e.target.rd_api_key.value.trim() };
  if (e.target.tb_api_key.value.trim()) body.tb_api_key = e.target.tb_api_key.value.trim();
  if (e.target.ad_api_key.value.trim()) body.ad_api_key = e.target.ad_api_key.value.trim();
  const err = document.getElementById('formError');
  const res = await fetch('/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (res.ok) { e.target.input.value = ''; e.target.imdb_id.value = ''; err.textContent = ''; }
  else { const j = await res.json().catch(() => ({})); err.textContent = j.error || ('request failed: ' + res.status); }
  load();
};
load();
setInterval(load, 3000);
</script>
</body>
</html>`;
}
