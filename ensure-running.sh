#!/usr/bin/env bash
# Idempotent: start bridge (supervisor + node) if down. Used by the keep-alive routine.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"
PIDFILE="$ROOT/bridge.pid"
CHILDPID="$ROOT/bridge.child.pid"
ours() { [[ "$(readlink "/proc/$1/cwd" 2>/dev/null || true)" == "$ROOT" ]]; }
is_sup() { kill -0 "$1" 2>/dev/null && ours "$1" && tr '\0' ' ' <"/proc/$1/cmdline" 2>/dev/null | grep -q 'supervise\.sh'; }

# Host restarts / computer updates can wipe node_modules while .env survives. Reinstall first,
# so a running supervisor's next restart (or start.sh below) finds its dependencies.
if [[ ! -d node_modules/@slack/bolt ]]; then
  npm install --omit=dev
fi

sup="$(cat "$PIDFILE" 2>/dev/null || true)"
if [[ -z "$sup" ]] || ! is_sup "$sup"; then
  sup=""
  # Adopt an existing supervisor for this dir if the pidfile is stale/missing.
  for p in $(pgrep -f 'supervise\.sh' 2>/dev/null || true); do
    if is_sup "$p"; then sup="$p"; echo "$p" >"$PIDFILE"; echo "adopted supervisor pid=$p"; break; fi
  done
fi

if [[ -n "$sup" ]]; then
  child="$(cat "$CHILDPID" 2>/dev/null || true)"
  if [[ -n "$child" ]] && kill -0 "$child" 2>/dev/null; then
    echo "up supervisor=$sup node=$child"
  else
    echo "up supervisor=$sup (node restarting)"
  fi
  exit 0
fi

# No supervisor: start.sh kills any unsupervised stray node for this dir, then starts fresh.
exec "$ROOT/start.sh"
