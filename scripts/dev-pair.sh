#!/usr/bin/env bash
# Start or stop an ephemeral second PI WEB instance (dev session daemon +
# web/API + Vite UI) alongside a production instance running on this machine.
#
# Motivation and the full recipe live in AGENTS.md. The invariant: the dev pair
# must never inherit the ambient PI_WEB_* / PI_CODING_AGENT_DIR values, because
# in this container they point at the production socket and data directories.
#
# Usage:
#   scripts/dev-pair.sh start   Start the pair (idempotent; fails if running)
#   scripts/dev-pair.sh stop    Stop the pair started by this script
#
# Overrides: PI_WEB_DEV_ROOT (default /tmp/pi-web-dev),
#   PI_WEB_DEV_UI_PORT (8599), PI_WEB_DEV_API_PORT (8598),
#   PI_WEB_DEV_ALLOWED_HOSTS (dev.ai.btz; empty string disables the allowlist).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEV_ROOT="${PI_WEB_DEV_ROOT:-/tmp/pi-web-dev}"
UI_PORT="${PI_WEB_DEV_UI_PORT:-8599}"
API_PORT="${PI_WEB_DEV_API_PORT:-8598}"
# The UI is reached through the user's reverse proxy as dev.ai.btz; Vite
# rejects unknown Host headers unless allowlisted (empty disables the check).
ALLOWED_HOSTS="${PI_WEB_DEV_ALLOWED_HOSTS:-dev.ai.btz}"
PID_FILE="$DEV_ROOT/pair.pid"
LOG_FILE="$DEV_ROOT/dev.log"

start_pair() {
  if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "dev pair already running (pid $(cat "$PID_FILE")); use: $0 stop" >&2
    exit 1
  fi

  # Seed state once, cloning from the production instance resolved at first
  # start; later starts reuse whatever the dev data/agent dirs already hold.
  # Sources come from the *caller's* env so this also works when production
  # uses non-default locations.
  PROD_DATA_DIR="${PI_WEB_DATA_DIR:-$HOME/.pi-web}"
  PROD_AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
  mkdir -p "$DEV_ROOT/data"
  if [[ ! -f "$DEV_ROOT/data/projects.json" && -f "$PROD_DATA_DIR/projects.json" ]]; then
    cp -a "$PROD_DATA_DIR/projects.json" "$DEV_ROOT/data/projects.json"
  fi
  if [[ ! -d "$DEV_ROOT/agent" ]]; then
    cp -a "$PROD_AGENT_DIR" "$DEV_ROOT/agent"
  fi

  # The env -u list is the load-bearing isolation: unset inherited daemon
  # endpoints before overriding everything the pair resolves.
  cd "$ROOT"
  setsid env -u PI_WEB_SESSIOND_SOCKET -u PI_WEB_SESSIOND_PORT \
    PI_WEB_DATA_DIR="$DEV_ROOT/data" \
    PI_WEB_SESSIOND_SOCKET="$DEV_ROOT/sessiond.sock" \
    PI_WEB_PORT="$API_PORT" \
    PI_CODING_AGENT_DIR="$DEV_ROOT/agent" \
    PI_WEB_ALLOWED_HOSTS="$ALLOWED_HOSTS" \
    bash -c 'trap "kill 0" EXIT INT TERM;
      npm run dev:sessiond & npm run dev:web & npm run dev:client -- --port '"$UI_PORT"' & wait' \
    > "$LOG_FILE" 2>&1 &
  echo $! > "$PID_FILE"
  echo "dev pair starting (pid $(cat "$PID_FILE")): UI http://localhost:$UI_PORT/ , API :$API_PORT, log $LOG_FILE"
}

stop_pair() {
  if [[ -f "$PID_FILE" ]]; then
    local pid
    pid="$(cat "$PID_FILE")"
    # Negative pid = process group: setsid made the started wrapper its own
    # group leader, so this reaches the daemon, web/API, and Vite children.
    kill -TERM -- "-$pid" 2>/dev/null || true
    rm -f "$PID_FILE"
    echo "dev pair stopped (was pid $pid)"
  else
    echo "no dev pair pid file at $PID_FILE" >&2
    exit 1
  fi
}

case "${1:-start}" in
  start) start_pair ;;
  stop) stop_pair ;;
  *)
    echo "usage: $0 [start|stop]" >&2
    exit 2
    ;;
esac
