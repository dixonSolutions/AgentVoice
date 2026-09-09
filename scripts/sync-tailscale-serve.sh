#!/usr/bin/env bash
# Point Tailscale Serve at the correct local upstream (nginx webPort or bridge port).
#
# Split-host: nginx on runModes.serve.webPort (default 5671) → bridge backendPort.
# Unified: bridge serves PWA + API on backendPort (.env PORT).
#
# Re-run after port changes or if HTTPS stops working:
#   bash scripts/sync-tailscale-serve.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

if ! command -v tailscale &>/dev/null; then
  echo "[sync-tailscale-serve] tailscale not installed — skipping."
  exit 0
fi

ENV_FILE="${PROJECT_DIR}/.env"
PORT=8787
if [[ -f "$ENV_FILE" ]]; then
  set -o allexport
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +o allexport
  PORT="${PORT:-8787}"
fi

SERVE_WEB_PORT=""
SERVE_BACKEND_PORT=""
if [[ -f "${PROJECT_DIR}/config.json" ]]; then
  read -r SERVE_WEB_PORT SERVE_BACKEND_PORT < <(
    python3 - <<'PY' "${PROJECT_DIR}/config.json"
import json, sys
with open(sys.argv[1]) as f:
    serve = json.load(f).get("settings", {}).get("runModes", {}).get("serve", {})
print(serve.get("webPort", ""), serve.get("backendPort", ""))
PY
  )
fi

UPSTREAM_PORT="${SERVE_BACKEND_PORT:-$PORT}"

# Unified hosting (default): bridge serves PWA + API + WS on backendPort with COOP/COEP.
# Only use nginx webPort when explicitly enabled — nginx often serves stale web/dist
# while proxying API/WS to the live bridge, which breaks the PWA.
USE_NGINX_FRONT="${CURSOR_VOICE_NGINX_FRONT:-}"
if [[ -z "$USE_NGINX_FRONT" && -f "${PROJECT_DIR}/config.json" ]]; then
  USE_NGINX_FRONT="$(python3 - <<'PY' "${PROJECT_DIR}/config.json"
import json, sys
with open(sys.argv[1]) as f:
    serve = json.load(f).get("settings", {}).get("runModes", {}).get("serve", {})
print("1" if serve.get("nginxFrontend") else "0")
PY
  )"
fi

if [[ "$USE_NGINX_FRONT" == "1" && -n "$SERVE_WEB_PORT" ]] && \
   curl -sf --max-time 5 "http://127.0.0.1:${SERVE_WEB_PORT}/healthz" >/dev/null 2>&1; then
  UPSTREAM_PORT="$SERVE_WEB_PORT"
fi

# The bridge serves HTTPS itself when it holds a cert (src/tls.ts). nginx, when
# fronting, stays plain HTTP. https+insecure:// tells tailscale to proxy to a
# TLS upstream without verifying it — mkcert/self-signed certs fail otherwise.
if [[ "$UPSTREAM_PORT" == "$SERVE_BACKEND_PORT" || "$UPSTREAM_PORT" == "$PORT" ]] \
   && [[ -n "${HTTPS_CERT_PATH:-}" && -n "${HTTPS_KEY_PATH:-}" ]]; then
  TARGET="https+insecure://127.0.0.1:${UPSTREAM_PORT}"
else
  TARGET="http://127.0.0.1:${UPSTREAM_PORT}"
fi
STATUS="$(tailscale serve status 2>&1 || true)"

if echo "$STATUS" | grep -q "127.0.0.1:${UPSTREAM_PORT}"; then
  echo "[sync-tailscale-serve] already proxying ${TARGET}"
  exit 0
fi

echo "[sync-tailscale-serve] configuring Tailscale Serve → ${TARGET}"
tailscale serve reset
tailscale serve --bg "${TARGET}"

sleep 1
if curl -sfk --max-time 10 "https://$(tailscale status --json 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('Self',{}).get('DNSName','').rstrip('.'))" 2>/dev/null)/healthz" >/dev/null 2>&1; then
  echo "[sync-tailscale-serve] HTTPS health check passed."
else
  echo "[sync-tailscale-serve] warn: HTTPS health check failed — run: bash scripts/doctor.sh" >&2
fi
