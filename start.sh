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
    if tr '\0' ' ' <"/proc/$old/cmdline" 2>/dev/null | grep -q 'index.js'; then
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

# Direct node so $! is the real Socket Mode process (not npm).
nohup node --env-file=.env index.js >>"$LOG" 2>&1 &
echo $! >"$PIDFILE"
sleep 1
if kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  echo "started pid=$(cat "$PIDFILE") log=$LOG"
else
  echo "failed to stay up; see $LOG" >&2
  rm -f "$PIDFILE"
  exit 1
fi
