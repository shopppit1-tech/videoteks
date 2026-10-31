#!/usr/bin/env bash
set -euo pipefail

# Run this on an always-on computer or VPS. The profile directory stores
# the browser session after the one-time manual Google Flow login.
: "${FLOW_WORKER_SECRET:?Set FLOW_WORKER_SECRET to a long random secret}"
: "${CLOUDFLARED_TUNNEL_TOKEN:?Set CLOUDFLARED_TUNNEL_TOKEN from the Cloudflare Named Tunnel setup}"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export FLOW_WORKER_PORT="${FLOW_WORKER_PORT:-3010}"
export FLOW_PROFILE_DIR="${FLOW_PROFILE_DIR:-$HOME/.videoteks-flow-profile}"
export FLOW_DOWNLOAD_DIR="${FLOW_DOWNLOAD_DIR:-$HOME/.videoteks-flow-downloads}"
export FLOW_HEADLESS="${FLOW_HEADLESS:-false}"

mkdir -p "$FLOW_PROFILE_DIR" "$FLOW_DOWNLOAD_DIR"

cleanup() {
  kill "${WORKER_PID:-}" "${TUNNEL_PID:-}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

cd "$ROOT_DIR"
node flow-worker.js &
WORKER_PID=$!

# The named tunnel must have a public hostname routed to http://localhost:${FLOW_WORKER_PORT}.
cloudflared tunnel run --token "$CLOUDFLARED_TUNNEL_TOKEN" &
TUNNEL_PID=$!

wait -n "$WORKER_PID" "$TUNNEL_PID"
exit $?
