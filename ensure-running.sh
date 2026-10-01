#!/usr/bin/env bash
# Idempotent: start bridge if down. Used by the Grok routine after restarts.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"
PIDFILE="$ROOT/bridge.pid"

running=0
if [[ -f "$PIDFILE" ]]; then
  pid="$(cat "$PIDFILE" 2>/dev/null || true)"
  if [[ -n "${pid}" ]] && kill -0 "$pid" 2>/dev/null; then
    # Confirm it is our bridge, not a recycled pid
    if tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null | grep -q 'slack-grok-bridge\|index.js'; then
      running=1
    fi
  fi
fi

if [[ "$running" -eq 1 ]]; then
  echo "up pid=$(cat "$PIDFILE")"
  exit 0
fi

# Foreground leftover from an open terminal session (scoped to this directory)
if pgrep -f "${ROOT}/.*index\.js" >/dev/null 2>&1; then
  pid="$(pgrep -f "${ROOT}/.*index\.js" | head -1)"
  echo "$pid" >"$PIDFILE"
  echo "adopted existing pid=$pid"
  exit 0
fi

if [[ ! -d node_modules/@slack/bolt ]]; then
  npm install --omit=dev
fi

exec "$ROOT/start.sh"
