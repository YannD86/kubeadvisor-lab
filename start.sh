#!/usr/bin/env bash
# KubeAdvisor — start API (:10201) and web (:10200).
# Roles: default = local runner (KA_AUTH_MODE=local KA_LAB_MODE=local).
#        platform/demo: KA_AUTH_MODE=accounts [KA_LAB_MODE=hosted] KA_SECRET_KEY=... ./start.sh
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "$ROOT/logs"
if [ ! -d "$ROOT/api/.venv" ]; then
  echo "[ka] creating python venv"; python3 -m venv "$ROOT/api/.venv"; "$ROOT/api/.venv/bin/pip" install -q -r "$ROOT/api/requirements.txt"
fi
if [ ! -d "$ROOT/web/node_modules" ]; then echo "[ka] installing web dependencies"; (cd "$ROOT/web" && npm install --no-audit --no-fund); fi

export LAB_API_PORT="${LAB_API_PORT:-10201}" LAB_WEB_PORT="${LAB_WEB_PORT:-10200}"
cd "$ROOT/api" && . .venv/bin/activate
RELOAD=""; [ "${KA_DEV:-0}" = "1" ] && RELOAD="--reload"   # reload restarts the API on code edits and drops running jobs
uvicorn app.main:app --port "$LAB_API_PORT" $RELOAD > "$ROOT/logs/api.log" 2>&1 &
API_PID=$!
cd "$ROOT/web"
if [ "${KA_PROD:-0}" = "1" ]; then npm run build >/dev/null && npm run start > "$ROOT/logs/web.log" 2>&1 & else npm run dev > "$ROOT/logs/web.log" 2>&1 & fi
WEB_PID=$!

echo "KubeAdvisor  (auth=${KA_AUTH_MODE:-local} lab=${KA_LAB_MODE:-local})"
echo "  web:  http://localhost:${LAB_WEB_PORT}"
echo "  api:  http://localhost:${LAB_API_PORT}/docs"
echo "  logs: $ROOT/logs/{api,web}.log"
echo "Local runner: create the cluster from the Cluster page (or: bash cluster/up.sh). Ctrl+C stops both services."
trap 'echo; echo "[ka] stopping"; kill $API_PID $WEB_PID 2>/dev/null; exit 0' INT TERM
wait
