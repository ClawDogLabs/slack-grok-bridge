#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
PIDFILE="$ROOT/bridge.pid"
if [[ ! -f "$PIDFILE" ]]; then
  # Also kill any stray node running this directory's index.js
  pkill -f "${ROOT}/.*index\.js" 2>/dev/null || true
  echo "stopped (no pidfile)"
  exit 0
fi
pid="$(cat "$PIDFILE")"
if kill -0 "$pid" 2>/dev/null; then
  kill "$pid" 2>/dev/null || true
  sleep 1
  kill -9 "$pid" 2>/dev/null || true
fi
rm -f "$PIDFILE"
echo "stopped pid=$pid"
