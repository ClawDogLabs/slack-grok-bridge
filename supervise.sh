#!/usr/bin/env bash
# Supervisor loop for the Socket Mode bridge. Launched by start.sh; bridge.pid = this script's pid,
# bridge.child.pid = the current node child. Restarts node whenever it exits (e.g. watchdog exit 1).
# Stop with ./stop.sh (SIGTERM here stops the child and the loop).
set -uo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"
CHILDPID="$ROOT/bridge.child.pid"
LOG="$ROOT/bridge.log"
child=""
stopping=0
on_term() {
  stopping=1
  if [[ -n "$child" ]] && kill -0 "$child" 2>/dev/null; then
    kill "$child" 2>/dev/null
    for _ in 1 2 3 4 5; do kill -0 "$child" 2>/dev/null || break; sleep 1; done
    kill -9 "$child" 2>/dev/null
  fi
  rm -f "$CHILDPID"
  echo "[$(date -u +%FT%TZ)] supervisor: stopped" >>"$LOG"
  exit 0
}
trap on_term TERM INT HUP
backoff=5
while [[ "$stopping" -eq 0 ]]; do
  started=$(date +%s)
  node --env-file=.env index.js >>"$LOG" 2>&1 &
  child=$!
  echo "$child" >"$CHILDPID"
  echo "[$(date -u +%FT%TZ)] supervisor: started node pid=$child" >>"$LOG"
  wait "$child"
  code=$?
  [[ "$stopping" -eq 1 ]] && break
  ran=$(( $(date +%s) - started ))
  if (( ran > 300 )); then backoff=5; else backoff=$(( backoff * 2 )); (( backoff > 60 )) && backoff=60; fi
  echo "[$(date -u +%FT%TZ)] supervisor: node pid=$child exited code=$code after ${ran}s; restarting in ${backoff}s" >>"$LOG"
  rm -f "$CHILDPID"
  sleep "$backoff" &
  wait $!
done
