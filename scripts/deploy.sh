#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/debrid}"
BRANCH="${BRANCH:-main}"
BUN_BIN="${BUN_BIN:-/usr/local/bin/bun}"
SERVICE_NAME="${SERVICE_NAME:-debrid.service}"
SYSTEMD_UNIT="${SYSTEMD_UNIT:-$APP_DIR/systemd/debrid.service}"

cd "$APP_DIR"

if [[ ! -f .env ]]; then
  echo "Missing $APP_DIR/.env" >&2
  exit 1
fi

if [[ ! -x "$BUN_BIN" ]]; then
  echo "Missing Bun executable at $BUN_BIN" >&2
  exit 1
fi

mkdir -p data downloads

git fetch origin "$BRANCH"
git reset --hard "origin/$BRANCH"
# Anything not listed here is destroyed on every deploy. QBIT_SAVE_PATH used to
# default inside the repo, so the qBittorrent cache was silently wiped mid-run;
# it now lives outside, and the exclusion stays as a belt-and-braces guard.
git clean -fd \
  -e .env \
  -e data \
  -e downloads \
  -e qbit-cache \
  -e node_modules

"$BUN_BIN" install --production --frozen-lockfile --ignore-scripts

sudo install -m 0644 "$SYSTEMD_UNIT" "/etc/systemd/system/$SERVICE_NAME"

sudo systemctl daemon-reload
# `enable`, not just `restart`: a freshly provisioned host otherwise installs the
# unit in the `disabled` state and does not bring debrid back after a reboot.
sudo systemctl enable "$SERVICE_NAME"
sudo systemctl restart "$SERVICE_NAME"

sudo systemctl --no-pager --full status "$SERVICE_NAME"
