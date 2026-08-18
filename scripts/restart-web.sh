#!/bin/sh
# Restart the DSH web GUI server so profile plugin changes take effect.
# Runs detached via `systemd-run --user` (survives the old server being killed).
set -u
LOG=/home/dgadelha/HD_Externo/desenv/dsh-explorer-plugni/.dsh-web.log
OLD_PID=31103
export HOME=/home/dgadelha
export PATH=/usr/local/bin:/usr/bin:/bin

echo "=== restart at $(date -Is) ===" >> "$LOG"

# 1. Stop the old server (TERM, then KILL after 8s).
if kill -0 "$OLD_PID" 2>/dev/null; then
  kill "$OLD_PID" 2>/dev/null
  i=0
  while [ "$i" -lt 40 ]; do
    if ! kill -0 "$OLD_PID" 2>/dev/null; then break; fi
    sleep 0.2
    i=$((i + 1))
  done
  if kill -0 "$OLD_PID" 2>/dev/null; then
    echo "old server still alive, sending SIGKILL" >> "$LOG"
    kill -9 "$OLD_PID" 2>/dev/null
    sleep 1
  fi
fi

# 2. Wait for the port to free.
i=0
while [ "$i" -lt 50 ]; do
  if ! /usr/bin/ss -ltn 2>/dev/null | grep -q ':3080 '; then break; fi
  sleep 0.2
  i=$((i + 1))
done

# 3. Start the new server (same profile/port/cwd as the original).
cd /home/dgadelha || exit 1
exec /usr/bin/node /usr/local/bin/dsh web >> "$LOG" 2>&1
