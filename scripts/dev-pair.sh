#!/usr/bin/env bash
# Start or stop an ephemeral second PI WEB instance (dev session daemon +
# web/API + Vite UI) alongside a production instance running on this machine.
#
# Motivation and the full recipe live in AGENTS.md. The invariant: the dev pair
# must never inherit the ambient PI_WEB_* / PI_CODING_AGENT_DIR values, because
# in this container they point at the production socket and data directories.
#
# Usage:
#   scripts/dev-pair.sh start   Start the pair (refuses if one is already running)
#   scripts/dev-pair.sh stop    Stop the dev pair, including processes orphaned by
#                               a previous stop, crash, or container restart
#
# Overrides: PI_WEB_DEV_ROOT (default /tmp/pi-web-dev),
#   PI_WEB_DEV_UI_PORT (8599), PI_WEB_DEV_API_PORT (8598),
#   PI_WEB_DEV_ALLOWED_HOSTS (dev.ai.btz; empty string disables the allowlist),
#   PI_WEB_DEV_PLUGIN_SOURCE (default ../pi-web-plugins; falls back to the
#   running instance's plugins directory when absent).
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
DEV_SOCKET="$DEV_ROOT/sessiond.sock"
DEV_DATA_DIR="$DEV_ROOT/data"
PLUGIN_SOURCE="${PI_WEB_DEV_PLUGIN_SOURCE:-$ROOT/../pi-web-plugins}"

# Refuse any root whose resolved paths could reach the production instance,
# before anything is created or removed. A dev root at or inside the production
# data directory makes the dev sessiond bind and unlink the production socket.
assert_safe_paths() {
  local prod_data_dir="$1" prod_agent_dir="${2:-}" conflicts
  conflicts="$(node "$ROOT/scripts/dev-pair-paths.mjs" \
    --dev-root "$DEV_ROOT" \
    --prod-data-dir "$prod_data_dir" \
    --prod-agent-dir "$prod_agent_dir" \
    --inherited-socket "${PI_WEB_SESSIOND_SOCKET:-}" 2>/dev/null || true)"
  if [[ -n "$conflicts" ]]; then
    echo "refusing to start the dev pair:" >&2
    printf '%s\n' "$conflicts" | sed 's/^/  - /' >&2
    exit 1
  fi
}

# Every dev child is spawned detached, so it leads its own process group and a
# group kill aimed at the wrapper misses it. Teardown therefore cannot rely on
# the inner supervisors running their cleanup: anything that kills the wrapper
# without it (a hard kill, a crash, a container restart) orphans whole groups,
# and a second instance then fights the survivors for the sessiond socket.
#
# Selection is delegated to dev-pair-processes.mjs, which requires both dev-only
# environment markers *and* a dev entrypoint, and skips pid 1, this process, and
# this process's ancestors. Production shares command lines with the dev pair
# (it also runs dev-web and Vite) but never the dev environment, so it can
# never be selected.
dev_pair_pids() {
  node "$ROOT/scripts/dev-pair-processes.mjs" \
    --socket "$DEV_SOCKET" --data-dir "$DEV_DATA_DIR" --ui-port "$UI_PORT" 2>/dev/null || true
}

signal_dev_pids() {
  local signal="$1" pid
  shift
  for pid in "$@"; do
    [[ -n "$pid" ]] || continue
    kill "-$signal" "$pid" 2>/dev/null || true
  done
}

# Reap anything the dev pair still owns, newest signal last, so a survivor that
# ignores SIGTERM is still collected.
reap_dev_processes() {
  local deadline=$((SECONDS + 20)) pids
  while :; do
    pids="$(dev_pair_pids | tr '\n' ' ')"
    if [[ -z "${pids// /}" ]]; then
      return 0
    fi
    if (( SECONDS < deadline )); then
      signal_dev_pids TERM $pids
    else
      signal_dev_pids KILL $pids
    fi
    sleep 0.5
  done
}

# User plugins are re-linked on every start so the dev instance always runs the
# current plugin sources: a plugin edited in the checkout is live on refresh, a
# plugin deleted upstream disappears from dev, and dev never runs a stale copy.
# The checkout wins when it exists, because that is what gets edited; otherwise
# the running instance's plugins are mirrored. Only entries the plugin catalog
# would accept are linked (a directory, or a symlink to one, whose package.json
# declares "piWeb"), which is why the surrounding repository files are skipped.
PLUGIN_ENTRY_NAMES='
const fs = require("node:fs");
const path = require("node:path");
const root = process.argv[1];
const names = [];
for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
  const full = path.join(root, entry.name);
  let isDirectory = entry.isDirectory();
  if (!isDirectory && entry.isSymbolicLink()) {
    try { isDirectory = fs.statSync(full).isDirectory(); } catch { isDirectory = false; }
  }
  if (!isDirectory) continue;
  try {
    if (JSON.parse(fs.readFileSync(path.join(full, "package.json"), "utf8")).piWeb !== undefined) names.push(entry.name);
  } catch { /* not a plugin root; the catalog would reject it too */ }
}
process.stdout.write(names.join("\n"));
'

plugin_entry_names() {
  node -e "$PLUGIN_ENTRY_NAMES" "$1" 2>/dev/null || true
}

sync_plugins() {
  local prod_data_dir="$1" source="" names name linked=0
  if [[ -d "$PLUGIN_SOURCE" ]]; then
    source="$PLUGIN_SOURCE"
  elif [[ -d "$prod_data_dir/plugins" ]]; then
    source="$prod_data_dir/plugins"
  else
    echo "no plugin source at $PLUGIN_SOURCE or $prod_data_dir/plugins; starting without user plugins" >&2
    return 0
  fi

  # This replaces a directory, so refuse any root that could reach the real
  # instance's plugins.
  if [[ "$DEV_DATA_DIR" == "$prod_data_dir" ]]; then
    echo "refusing to sync plugins: dev data dir is the production data dir ($DEV_DATA_DIR)" >&2
    return 1
  fi

  names="$(plugin_entry_names "$source")"
  # Only ever removes the dev copy, whose entries are symlinks; rm does not
  # follow them, so the plugin sources are never deleted.
  rm -rf "$DEV_DATA_DIR/plugins"
  mkdir -p "$DEV_DATA_DIR/plugins"
  while IFS= read -r name; do
    [[ -n "$name" ]] || continue
    ln -sfn "$source/$name" "$DEV_DATA_DIR/plugins/$name"
    linked=$((linked + 1))
  done <<< "$names"
  echo "dev plugins linked from $source ($linked: ${names//$'\n'/, })"
}


start_pair() {
  # Refuse when anything still runs, not just when the pid file does: an
  # orphaned survivor is exactly the condition that lets a second instance
  # clobber the sessiond socket, so `start` must never add to it.
  local existing
  existing="$(dev_pair_pids | tr '\n' ' ')"
  if [[ -n "${existing// /}" ]]; then
    echo "dev pair processes already running (pids: ${existing% }); run '$0 stop' first" >&2
    exit 1
  fi
  rm -f "$PID_FILE"

  # Seed state once, cloning from the production instance resolved at first
  # start; later starts reuse whatever the dev data/agent dirs already hold.
  # Sources come from the *caller's* env so this also works when production
  # uses non-default locations.
  PROD_DATA_DIR="${PI_WEB_DATA_DIR:-$HOME/.pi-web}"
  PROD_AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
  assert_safe_paths "$PROD_DATA_DIR" "$PROD_AGENT_DIR"
  mkdir -p "$DEV_ROOT/data"
  if [[ ! -f "$DEV_ROOT/data/projects.json" && -f "$PROD_DATA_DIR/projects.json" ]]; then
    cp -a "$PROD_DATA_DIR/projects.json" "$DEV_ROOT/data/projects.json"
  fi
  if [[ ! -d "$DEV_ROOT/agent" ]]; then
    cp -a "$PROD_AGENT_DIR" "$DEV_ROOT/agent"
  fi
  sync_plugins "$PROD_DATA_DIR"

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
  local wrapper=""
  if [[ -f "$PID_FILE" ]]; then
    wrapper="$(cat "$PID_FILE")"
    # Negative pid = the wrapper's process group, which covers the wrapper, the
    # npm/sh wrappers, Vite, and the dev supervisors. Detached children lead
    # their own groups and are collected by the identity sweep below.
    [[ -n "$wrapper" ]] && kill -TERM -- "-$wrapper" 2>/dev/null || true
  fi

  reap_dev_processes
  rm -f "$PID_FILE"

  # Loud on purpose: a silent survivor here is what produced the original
  # socket clobbering, so a clean stop is asserted rather than assumed.
  local remaining
  remaining="$(dev_pair_pids | tr '\n' ' ')"
  if [[ -n "${remaining// /}" ]]; then
    echo "dev pair stop incomplete; still running (pids: ${remaining% })" >&2
    exit 1
  fi
  if [[ -n "$wrapper" ]]; then
    echo "dev pair stopped (was pid $wrapper)"
  else
    echo "no dev pair pid file at $PID_FILE; no dev pair processes remain"
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
