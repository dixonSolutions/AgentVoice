#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# AgentVoice — start script (Linux)
#
# Starts the production HOST bridge back up after `npm run stop`.
# Counterpart to scripts/stop.sh. (The local dev server `npm run dev` runs on a
# separate port — default 5089 — and is managed independently.)
#   1. Starts the agentvoice.service systemd unit
#   2. Starts the agentvoice-watch.path unit (auto-restart on rebuilds)
#   3. Falls back to a manual nohup process when no systemd unit exists
#   4. Runs a /healthz check to confirm startup
#
# Usage:
#   bash scripts/start.sh [--tail]
#
# Options:
#   --tail   Stream journald logs after start (Ctrl-C to stop)
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "$PROJECT_DIR"

# ── Colours ───────────────────────────────────────────────────────────────
GRN='\033[0;32m'; YEL='\033[1;33m'; BLU='\033[0;34m'
CYN='\033[0;36m'; RED='\033[0;31m'; BLD='\033[1m'; NC='\033[0m'

info()    { echo -e "${BLU}[info]${NC}  $*"; }
ok()      { echo -e "${GRN}[ok]${NC}    $*"; }
warn()    { echo -e "${YEL}[warn]${NC}  $*" >&2; }
err()     { echo -e "${RED}[err]${NC}   $*" >&2; exit 1; }
section() { echo -e "\n${CYN}${BLD}── $* ──${NC}"; }

# ── Args ──────────────────────────────────────────────────────────────────
TAIL_LOGS=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --tail) TAIL_LOGS=true; shift;;
    -h|--help)
      grep '^#' "$0" | grep -v '!/usr/bin' | sed 's/^# \?//'
      exit 0;;
    *) err "Unknown option: $1";;
  esac
done

if [[ "$(uname -s)" != "Linux" ]]; then
  err "This script is Linux-only. Use start.ps1 on Windows."
fi

echo -e "${CYN}${BLD}AgentVoice — start${NC}  |  Project: ${BLD}${PROJECT_DIR}${NC}"

# ── Load .env for PORT ──────────────────────────────────────────────────────
ENV_FILE="${PROJECT_DIR}/.env"
if [[ -f "$ENV_FILE" ]]; then
  set -o allexport; source "$ENV_FILE"; set +o allexport
fi
PORT="${PORT:-8787}"

# Guard: refuse to start if the host port is already taken.
if lsof -ti ":${PORT}" -sTCP:LISTEN &>/dev/null; then
  err "Host port ${PORT} is already in use — is the host already running? Stop it with: npm run stop"
fi

DIST_FILE="${PROJECT_DIR}/dist/index.js"

# ── Start systemd units (user, then system), else manual nohup ──────────────
if systemctl --user cat agentvoice.service &>/dev/null; then
  section "Starting systemd user units"
  systemctl --user start agentvoice.service
  systemctl --user start agentvoice-watch.path 2>/dev/null || \
    warn "agentvoice-watch.path not started (auto-restart on rebuild disabled)."
  sleep 1
  if systemctl --user is-active --quiet agentvoice.service; then
    ok "agentvoice.service started."
  else
    warn "Service may have failed. Check: journalctl --user -u agentvoice -n 30"
    systemctl --user status agentvoice.service --no-pager -l | tail -15
  fi

elif systemctl cat agentvoice.service &>/dev/null 2>&1; then
  section "Starting systemd system unit"
  sudo systemctl start agentvoice.service
  sudo systemctl start agentvoice-watch.path 2>/dev/null || true
  sleep 1
  systemctl status agentvoice.service --no-pager -l | head -12
  ok "system agentvoice.service started."

else
  section "Starting bridge manually (no systemd unit)"
  warn "No systemd service found. Run 'bash scripts/setup.sh' to install it."
  [[ -f "$DIST_FILE" ]] || err "dist/index.js not found — build first: npm run build"
  mkdir -p "${PROJECT_DIR}/logs"
  NODE_BIN="$(command -v node || echo node)"
  nohup "$NODE_BIN" "$DIST_FILE" >> "${PROJECT_DIR}/logs/bridge.log" 2>&1 &
  PID=$!
  sleep 1
  if kill -0 "$PID" 2>/dev/null; then
    mkdir -p "${PROJECT_DIR}/data"
    echo "$PID" > "${PROJECT_DIR}/data/.bridge.pid"
    ok "Bridge started (pid ${PID}). Log: ${PROJECT_DIR}/logs/bridge.log"
  else
    err "Bridge exited immediately — check ${PROJECT_DIR}/logs/bridge.log"
  fi
fi

# ── Health check ────────────────────────────────────────────────────────────
section "Health check"
sleep 2
HEALTHZ="http://127.0.0.1:${PORT}/healthz"
if curl -sf --max-time 5 "$HEALTHZ" | python3 -m json.tool 2>/dev/null; then
  ok "Bridge healthy at ${HEALTHZ}"
else
  warn "Health check failed at ${HEALTHZ} — bridge may still be starting."
  warn "Retry: curl ${HEALTHZ}"
fi

if $TAIL_LOGS; then
  echo ""
  info "Tailing logs (Ctrl-C to stop)..."
  journalctl --user -u agentvoice -f --no-pager
fi

echo ""
ok "Done."
echo -e "  ${BLU}Logs:${NC} journalctl --user -u agentvoice -f"
echo ""
