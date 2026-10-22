#!/usr/bin/env bash
# Detached Socket Mode bridge (no terminal needed).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"
PIDFILE="$ROOT/bridge.pid"
LOG="$ROOT/bridge.log"

if [[ -f "$PIDFILE" ]]; then
  old="$(cat "$PIDFILE" 2>/dev/null || true)"
  if [[ -n "${old}" ]] && kill -0 "$old" 2>/dev/null; then
    if tr '\0' ' ' <"/proc/$old/cmdline" 2>/dev/null | grep -q 'supervise\.sh'; then
      echo "already running pid=$old"
      exit 0
    fi
  fi
  rm -f "$PIDFILE"
fi

if [[ ! -f .env ]]; then
  echo "missing .env" >&2
  exit 1
fi

if [[ ! -d node_modules/@slack/bolt ]]; then
  echo "node_modules missing; run: npm install" >&2
  exit 1
fi

# Refuse start if required secrets are empty (do not invent tokens)
missing=0
for key in SLACK_BOT_TOKEN SLACK_APP_TOKEN GROK_WEBHOOK_URL; do
  # shellcheck disable=SC1091
  val="$(grep -E "^${key}=" .env | head -1 | cut -d= -f2- || true)"
  if [[ -z "${val}" ]]; then
    echo "missing/empty $key in .env — fill secrets before starting" >&2
    missing=1
  fi
done
if [[ "$missing" -eq 1 ]]; then
  exit 1
fi

# Refuse to create a duplicate: if any bridge supervisor/node for this dir is alive, stop it first.
for p in $(pgrep -f 'supervise\.sh|index\.js' 2>/dev/null || true); do
  [[ "$p" == "$$" ]] && continue
  if [[ "$(readlink "/proc/$p/cwd" 2>/dev/null || true)" == "$ROOT" ]]; then
    echo "found stray bridge process pid=$p; stopping it" >&2
    kill "$p" 2>/dev/null || true
  fi
done
sleep 1

# Run node under a supervisor loop so a watchdog exit (or crash) restarts it.
# bridge.pid = supervisor pid; bridge.child.pid = current node pid.
nohup setsid "$ROOT/supervise.sh" >>"$LOG" 2>&1 </dev/null &
echo $! >"$PIDFILE"
sleep 2
if kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  echo "started supervisor pid=$(cat "$PIDFILE") node pid=$(cat "$ROOT/bridge.child.pid" 2>/dev/null || echo '?') log=$LOG"
else
  echo "failed to stay up; see $LOG" >&2
  rm -f "$PIDFILE"
  exit 1
fi
