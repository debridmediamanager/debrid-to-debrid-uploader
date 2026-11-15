# debrid-uploader

Self-hosted service that proxies content from TorBox WebDAV to Real-Debrid via [BEP 19](https://www.bittorrent.org/beps/bep_0019.html) webseeded torrents. No local downloads needed — the server acts as a 64MB-expanded-range proxy between TorBox and RD, completing 11GB files in ~2.5 minutes.

## How it works

```
Magnet -> TorBox (cache) -> Fetch .torrent from itorrents.org -> Rename metadata (bypass RD filter)
  -> Inject proxy webseed -> Upload to RD -> RD fetches via proxy -> Proxy expands 1MB requests to 64MB from TorBox WebDAV -> Done
```

### Primary path: cached-source proxy (magnets)

The cached sources are tried in `CACHE_SOURCES` order (default `torbox,alldebrid`). TorBox goes
first because its cache probe is a free read-only call, while AllDebrid retired every read-only
probe — the only way to ask it is to *add* the magnet and read the `ready` flag off the response.
TorBox and AllDebrid deduplicate these adds against the account's existing resources. An id
does not prove this service created it, so source cleanup never deletes their torrents/magnets,
including cache misses and setup failures. This protects held content and concurrent jobs sharing
an id, at the cost of retained slots and potentially an uncached AllDebrid download. RD sources
are deleted only when this service added them; delivered destination torrents remain untouched.

**If every available source gives a clean miss, the job fails with `uncached`** and is not retried.
TorBox cache-check HTTP, network and business errors are not misses: another source is tried,
and if none succeeds the provider failure remains retryable. The old qBittorrent disk-cache
fallback is off by default (`QBIT_ENABLED`).

AllDebrid's leg of this is shorter: `/link/unlock` returns a per-file URL that is
self-authenticating and honours `Range`, so steps 4 and 7 need no WebDAV host and no auth header.
Definitive AllDebrid `LINK_HOST_NOT_SUPPORTED` failures are remembered for the session file,
including concurrent ranges; transient failures can recover on the next request. TorBox CDN
400/404 responses evict the cached URL and re-mint once before WebDAV fallback. RD file links
are mapped only when selected-file and link counts match, never when RD bundled a selection.

1. Adds magnet to TorBox, waits for cache (up to 2 min)
2. Fetches original `.torrent` from itorrents.org (preserves piece hashes)
3. Rewrites torrent root name and filenames to bypass RD's DMCA filter, injects proxy webseed URL
4. Persists per-file mappings: rewritten BEP 19 path → original TorBox WebDAV path
5. Uploads rewritten `.torrent` to RD
6. RD requests ~1MB range chunks from the proxy webseed (e.g., `/webseed/:jobId/Clean Name/Clean Name - 1.mkv`)
7. Proxy resolves the BEP 19 path to the corresponding TorBox WebDAV file, expands to 64MB, and forwards with Basic auth
8. RD accepts expanded responses and completes at ~155 MB/s

## Stack

Bun, Hono, bun:sqlite, mktorrent

## Setup

```bash
# Prerequisites
apt install mktorrent curl
curl -fsSL https://bun.sh/install | bash

# Install & run
cp .env.example .env
bun install
bun run start
```

### Quality checks

```bash
# Run the full local gate
bun run check

# Install the Git hook so checks run before every commit
pre-commit install

# Optional: run hooks against the whole tree
pre-commit run --all-files
```

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3100` | HTTP server port |
| `HOST` | `0.0.0.0` | Listen address |
| `BASE_URL` | `http://localhost:3100` | Public URL for webseed. Must be reachable by RD |
| `DOWNLOADS_DIR` | `./downloads` | File storage directory |
| `TORBOX_EMAIL` | | TorBox account email (legacy WebDAV auth; the API key is used instead) |
| `TORBOX_PASSWORD` | | TorBox account password (legacy) |
| `TORBOX_UPSTREAM` | `webdav` | `cdn` fetches ranges from a TorBox CDN link instead of WebDAV |
| `TORBOX_CDN_EDGE` | | `hare` (BunnyCDN) or `erth` (Cloudflare); comma list picks at random |
| `TORBOX_DIRECT_WEBSEED` | `false` | Direct single-file URL; discloses the full TorBox API key in torrent metadata. Keep off with untrusted destinations |
| `WEBSEED_REDIRECT` | `false` | Redirect to a CDN URL; discloses the full TorBox API key in `Location`. RD also loses Range across redirects; keep off |
| `TORBOX_CHUNK_SIZE` | `8388608` | Range expansion for the TorBox path (billable egress) |
| `ALLDEBRID_CHUNK_SIZE` | `8388608` | Range expansion for the AllDebrid path |
| `CACHE_SOURCES` | `torbox,alldebrid` | Cached sources to try, in order |
| `MAX_CONCURRENT_JOBS` | `4` | Jobs in flight at once, per host. Excess jobs queue |
| `QBIT_ENABLED` | `false` | Enable the qBittorrent disk-cache fallback. Off means an uncached release fails the job as `uncached` |
| `MDBLIST_KEY` | | MDBList API key for title/year lookup |

### Systemd

The production unit is tracked at `systemd/debrid.service`.

```bash
sudo install -m 0644 systemd/debrid.service /etc/systemd/system/debrid.service
sudo systemctl daemon-reload
sudo systemctl enable --now debrid.service
```

### Deployment

Production deploys use `scripts/deploy.sh`. The script:

- pulls `origin/main` deterministically
- preserves `.env`, `data/`, `downloads/`, and `node_modules/`
- installs production dependencies with Bun
- installs the tracked systemd unit
- restarts `debrid.service`

```bash
ssh <user>@<host> 'cd /opt/debrid && bash scripts/deploy.sh'
```

`APP_DIR`, `BUN_BIN` and `SERVICE_NAME` override the script's paths. GitHub Actions
runs the full quality gate on every push and pull request.

## API

### `POST /jobs`

```bash
# Magnet URI
curl -X POST http://localhost:3100/jobs \
  -H "Content-Type: application/json" \
  -d '{"input": "magnet:?xt=urn:btih:...", "imdb_id": "tt1234567"}'

# Raw 40-character info hash
curl -X POST http://localhost:3100/jobs \
  -H "Content-Type: application/json" \
  -d '{"input": "abcdefabcdefabcdefabcdefabcdefabcdefabcd", "imdb_id": "tt1234567"}'
```

#### Submitting your own credentials

Every job requires its destination key and at least one source key; there is no operator-key
fallback. The default RD destination requires `rd_api_key` plus `tb_api_key` or `ad_api_key`.
A supplied TorBox key is checked on every submission: a definite free plan returns HTTP 400
before creating a job. Failed lookups preserve degraded admission, not a false free-plan verdict.

```bash
curl -X POST http://localhost:3100/jobs \
  -H "Content-Type: application/json" \
  -d '{
        "input": "magnet:?xt=urn:btih:...",
        "imdb_id": "tt1234567",
        "rd_api_key": "<your RD API token>",
        "tb_api_key": "<your TorBox API key>",
        "ad_api_key": "<your AllDebrid API key>"
      }'
```

- `rd_api_key` — the content lands in **your** Real-Debrid account instead of the operator's.
- `tb_api_key` — one key covers the whole TorBox path. It is the bearer token for the REST calls
  (`checkcached`, `createtorrent`, `mylist`, `controltorrent`) and the Basic-auth password for the
  WebDAV host the proxy reads bytes from, under TorBox's fixed username `torbox`. No email or
  password is needed.

- `ad_api_key` — one key covers the whole AllDebrid path too, but for the opposite reason: the
  per-file links returned by `/link/unlock` carry their own token, so the proxy fetches bytes with
  no auth header at all.

Supplying a TorBox or AllDebrid key also enables that cached-proxy path for your jobs even when the
operator has no key of their own configured.

Credentials are stored on the job row and are **never returned by the API** — `GET /jobs` and
`GET /jobs/:id` strip them.

`TORBOX_DIRECT_WEBSEED` and `WEBSEED_REDIRECT` deliberately bypass that credential boundary:
TorBox's `requestdl` URL contains the **full account API key** as `?token=`, not a scoped file
credential. Direct mode persists it in torrent `url-list`; redirect mode gives it to the caller
and destination in `Location`. Both default off. Do not enable either for an untrusted recipient;
proxying bytes is the credential-isolating mode.

The management API, including arbitrary-URL `GET /proxy/<base64url>`, is unauthenticated.
Expose only `/webseed/*` publicly and restrict management access to trusted private-network callers.
RD source keys are still used from the service's own egress IP; do not submit an account also
used from another public IP. An IP-safe source-credential design requires a separate decision.

### `GET /jobs` / `GET /jobs/:id`

List or get job status. Statuses: `pending` -> `downloading` -> `preparing` -> `uploading` -> `completed` | `failed`

Every credential column (`SECRET_COLUMNS` in `src/db.ts`) is redacted from every job response.

### `GET /files/*`

Legacy local webseed endpoint.

### `GET /webseed/:jobId/*`

Proxy webseed endpoint. RD requests BEP 19 paths like `/webseed/:jobId/Clean Name/file.mkv`. The proxy resolves the path to the original TorBox WebDAV file, expands RD's 1MB range requests to 64MB chunks, and forwards with Basic auth to `webdav.torbox.app`.

## RD Content Filter Bypass via Proxy Webseed

RD blocks torrents by filename patterns (error 35 `infringing_file`). Since 14 October 2026 that is eleven strings, `WEB-DL`, `WEB.x264` and `WEB.H264` only in exactly that case (so `web-dl` and the scene `WEB.h264` pass) and `WEBRip`, `BDRip`, `HDRip`, `DVDRip`, `HDTV.x264`, `HDTV.XviD`, `BluRay.x264` and `p.BluRay.DTS` in any case (so `1080p.BluRay.DTS` is refused and `2002.BluRay.DTS` is not), judged on the torrent's root name when it is added and on each file's name when it is unrestricted. This can be bypassed without downloading the file locally by combining torrent renaming with a WebDAV proxy webseed.

### How it works

1. **Get original torrent** — fetch `.torrent` from itorrents.org for the blocked hash (preserves correct piece hashes)
2. **Rename torrent metadata** — replace the root name and filenames in the bencoded info dict with something clean (changes the info hash, but piece hashes stay valid)
3. **Add proxy webseed** — inject `url-list` pointing to a proxy that fetches from TorBox WebDAV
4. **Persist file mappings** — store `rewrittenPath → webdavPath` for each file so the proxy can resolve BEP 19 requests
5. **Upload to RD** — RD accepts the clean-named torrent, starts downloading via BEP 19 webseed
6. **Proxy serves via WebDAV** — RD requests rewritten paths; proxy maps them back to original TorBox file paths and forwards range requests to `webdav.torbox.app` with Basic auth

### WebDAV advantages over CDN requestdl

- **Stable URLs** — WebDAV paths don't expire (CDN links last ~1 hour)
- **No rate limits on request count** — CDN limits ~300-600 HTTP requests per window; WebDAV has no such limit
- **Multi-file support** — each file is addressable by path, no per-file `requestdl` call needed
- **Simpler session state** — no CDN URL caching/refreshing logic

### Key discoveries

- **RD blocks by filename**, not by info hash or piece data
- **RD accepts expanded range responses** — ask for 1MB, return 64MB, RD uses all of it
- **RD makes ~3 concurrent range requests**, randomly ordered across the file
- **BEP 19 URL format** — for multi-file torrents, RD requests `url-list` + `info.name` + `/` + file path

### Optimal chunk expansion: 64MB

Tested 32/64/128/256MB expanded chunk sizes on a 11.3GB file:

| Chunk Size | Requests | Download Time | Effective Speed | Redundancy |
|-----------|----------|---------------|-----------------|------------|
| 32MB | ~700 | ~409s | ~28 MB/s | 1.9x |
| **64MB** | **429** | **~150s** | **~75 MB/s** | **~2.4x** |
| 128MB | 200 | ~350s | ~32 MB/s | 2.2x |
| 256MB | 100 | ~390s | ~29 MB/s | 2.2x |

64MB wins because:
- Each 64MB request completes in ~0.4s at Hetzner-to-Hetzner speed (~160MB/s)
- RD's 3 concurrent slots stay fully saturated
- Larger chunks (128/256MB) take 1-2s each, causing RD to pipeline less aggressively
- Smaller chunks (32MB) have more request overhead and more gap-filling at the tail

### Gotchas

- **RD caches torrent errors by info hash** — if a torrent errors/stalls, use a different name to get a fresh hash
- **Don't strip Accept-Ranges** — RD still sends Range headers regardless and retries the same chunk forever
- **Don't return 200 for range requests** — RD discards the full response and retries
- **BEP 19 URL format** — RD appends `name/filename` to the webseed URL, so the proxy must handle any path

## RD downloader IPs

RD fetches webseed content from two subnets:

- `94.140.5.0/24` — observed: .51-.64, .66-.70, .150, .152-.159
- `185.126.33.0/24` — observed: .60, .62-.70

## Project structure

```
src/
  index.ts             # Bun server bootstrap and incomplete-job recovery
  app.ts               # Hono routes and request validation boundary
  worker.ts            # Job pipeline orchestration
  downloads.ts         # Cached-source selection and proxy session setup
  proxy.ts             # Path-aware webseed proxy (TorBox/AllDebrid/RD -> destination)
  torrent-rewrite.ts   # Bencode manipulation: rename torrent + inject webseed URL
  itorrents.ts         # Fetch original .torrent files from cache mirrors
  realdebrid.ts        # Real-Debrid client
  torbox.ts            # TorBox client (torbox-http.ts holds the shared proxy/UA seam)
  alldebrid.ts         # AllDebrid client
  premiumize.ts        # Premiumize client
  qbittorrent.ts       # Optional qBittorrent fallback and BEP 9 metadata fetch
  config.ts            # Environment config
  db.ts                # bun:sqlite jobs and proxy mappings (in-memory during tests)
  metrics.ts           # [stage] and [serve] measurements
  fixtures/            # Recorded provider responses driving the tests
scripts/               # deploy.sh (per host) and deploy-fleet.sh (manual fallback)
systemd/debrid.service # Production unit
data/debrid.db         # SQLite database (not tracked)
```

## License

[AGPL-3.0](LICENSE). If you run a modified copy as a service, publish your changes.
