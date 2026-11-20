#!/usr/bin/env bash
# Wait for the game's account API, then run the bot with whatever loop BOT_LOOP points at.
set -euo pipefail

API="${AL_API:-http://127.0.0.1:8090}"
EMAIL="${AL_BOT_EMAIL:-dev@example.test}"
PASSWORD="${AL_BOT_PASSWORD:-dev-password-123}"
LOOP="${BOT_LOOP:-/app/loops/basic.mjs}"

if [ ! -f "$LOOP" ]; then
  echo "[al-client] BOT_LOOP=$LOOP does not exist - mount your loop directory and point BOT_LOOP at the file"
  ls -la /app/loops 2>/dev/null || true
  exit 1
fi

echo "[al-client] waiting for $API"
ready=""
for _ in $(seq 1 200); do
  body=$(curl -fsS -X POST -H 'content-type: application/json' \
    -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" "$API/api/signup_or_login" 2>/dev/null || true)
  case "$body" in
    *'"success":true'*) ready=1; break ;;
  esac
  sleep 2
done
if [ -z "$ready" ]; then
  echo "[al-client] the account API never accepted a login at $API"
  exit 1
fi

ARGS=(--api "$API" --character "${AL_BOT_CHARACTER:-Devmage}" --loop "$LOOP")
[ -n "${AL_GAME_ADDRESS:-}" ] && ARGS+=(--address "${AL_GAME_ADDRESS}")
[ -n "${AL_BOT_SECONDS:-}" ] && ARGS+=(--seconds "${AL_BOT_SECONDS}")
[ -n "${AL_BOT_VENDOR_AT:-}" ] && ARGS+=(--vendor-at "${AL_BOT_VENDOR_AT}")
[ -n "${AL_BOT_TRANSPORT:-}" ] && ARGS+=(--transport "${AL_BOT_TRANSPORT}")
[ -n "${AL_BOT_EMAIL:-}" ] && ARGS+=(--email "${AL_BOT_EMAIL}")
[ -n "${AL_BOT_PASSWORD:-}" ] && ARGS+=(--password "${AL_BOT_PASSWORD}")
[ "${AL_BOT_SAY:-1}" = "0" ] && ARGS+=(--no-say)

echo "[al-client] loop: $LOOP"
echo "[al-client] node scripts/bot.mjs ${ARGS[*]}"
exec node /app/scripts/bot.mjs "${ARGS[@]}"
