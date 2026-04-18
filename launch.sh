#!/usr/bin/env bash
# pi-telegram-bot launcher with pidfile guard — prevents multiple instances.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

PIDFILE="/tmp/pi-telegram-bot.pid"

# Kill any existing instance
if [ -f "$PIDFILE" ]; then
  OLD_PID=$(cat "$PIDFILE" 2>/dev/null || echo "")
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "[launcher] Stopping existing instance (pid $OLD_PID)..."
    kill "$OLD_PID" 2>/dev/null || true
    sleep 3
  fi
  rm -f "$PIDFILE"
fi

# Also kill any orphaned instances
pkill -f "pi-telegram-bot/node_modules/.*/node\|pi-telegram-bot.*src/index" 2>/dev/null || true
sleep 2

export PI_BEDROCK_PROFILE="${PI_BEDROCK_PROFILE:-openclaw-bedrock}"
export PI_BEDROCK_REGION="${PI_BEDROCK_REGION:-us-west-2}"
export AWS_PROFILE="${AWS_PROFILE:-openclaw-bedrock}"
export AWS_REGION="${AWS_REGION:-us-west-2}"
export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-us-west-2}"

echo "[launcher] Starting pi-telegram-bot..."
node --import tsx/esm src/index.ts &
BOT_PID=$!
echo "$BOT_PID" > "$PIDFILE"
echo "[launcher] Started with pid $BOT_PID"

# Wait for the process
wait $BOT_PID
EXIT_CODE=$?
rm -f "$PIDFILE"
echo "[launcher] Bot exited with code $EXIT_CODE"
exit $EXIT_CODE
