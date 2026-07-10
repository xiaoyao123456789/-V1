#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

PORT="${PORT:-8000}"
HOST="${HOST:-0.0.0.0}"
URL="http://127.0.0.1:${PORT}"

if command -v xdg-open >/dev/null 2>&1; then
  (sleep 1; xdg-open "${URL}" >/dev/null 2>&1 || true) &
fi

if command -v python3 >/dev/null 2>&1; then
  exec python3 app.py "${PORT}" "${HOST}"
fi

exec python app.py "${PORT}" "${HOST}"
