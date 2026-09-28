#!/bin/sh
# Resolve the puppeteer-installed Chrome path (version segment varies) and exec
# the server with --env-file, matching the repo's `npm start` contract.
set -e
CHROME="$(find "${PUPPETEER_CACHE_DIR:-/home/node/.cache/puppeteer}/chrome" -type f -name chrome -path '*chrome-linux64*' 2>/dev/null | head -n1 || true)"
if [ -z "$CHROME" ]; then
  echo "qwen2api: chrome not found in ${PUPPETEER_CACHE_DIR:-/home/node/.cache/puppeteer}" >&2
  exit 1
fi
export CHROME_PATH="$CHROME"

if [ -f /app/.env ]; then
  exec node --env-file=/app/.env server.js
else
  exec node server.js
fi
