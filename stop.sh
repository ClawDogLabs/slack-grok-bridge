#!/usr/bin/env bash
# Stops the bridge supervisor (bridge.pid) and its node child, plus any stray bridge process for this dir.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
PIDFILE="$ROOT/bridge.pid"
CHILDPID="$ROOT/bridge.child.pid"
ours() { [[ "$(readlink "/proc/$1/cwd" 2>/dev/null || true)" == "$ROOT" ]]; }
sup="$(cat "$PIDFILE" 2>/dev/null || true)"
if [[ -n "$sup" ]] && kill -0 "$sup" 2>/dev/null && ours "$sup"; then
  kill "$sup" 2>/dev/null || true
  for _ in 1 2 3 4 5 6 7 8; do kill -0 "$sup" 2>/dev/null || break; sleep 1; done
  kill -9 "$sup" 2>/dev/null || true
fi
# Child and strays (supervisors first so nothing respawns)
for pat in 'supervise\.sh' 'index\.js'; do
  for p in $(pgrep -f "$pat" 2>/dev/null || true); do
    [[ "$p" == "$$" ]] && continue
    ours "$p" && kill "$p" 2>/dev/null || true
  done
done
sleep 1
for p in $(pgrep -f 'supervise\.sh|index\.js' 2>/dev/null || true); do
  ours "$p" && kill -9 "$p" 2>/dev/null || true
done
rm -f "$PIDFILE" "$CHILDPID"
echo "stopped supervisor=${sup:-none}"
