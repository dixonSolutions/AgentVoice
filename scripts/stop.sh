#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# AgentVoice — stop script (Linux)
#
# Stops the production HOST bridge (the long-running agentvoice service).
#   1. Stops the systemd watch unit (so it won't auto-restart the service)
#   2. Stops the agentvoice.service systemd unit
#   3. Falls back to killing the manual nohup process (data/.bridge.pid)
#   4. Frees the host bridge port (PORT, default 8787) as a safety net
#
# The local dev server (`npm run dev`) runs on a SEPARATE port (test profile,
# default 5089) and is unaffected by this script — the two can run side by side.
# Start the host back up with: npm run start:service
#
# Usage:
#   bash scripts/stop.sh [--quiet]
#
# Options:
#   --quiet   Only print warnings/errors
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "$PROJECT_DIR"

# ── Colours ───────────────────────────────────────────────────────────────
GRN='\033[0;32m'; YEL='\033[1;33m'; BLU='\033[0;34m'
CYN='\033[0;36m'; RED='\033[0;31m'; BLD='\033[1m'; NC='\033[0m'

QUIET=false
info()    { $QUIET || echo -e "${BLU}[info]${NC}  $*"; }
ok()      { $QUIET || echo -e "${GRN}[ok]${NC}    $*"; }
warn()    { echo -e "${YEL}[warn]${NC}  $*" >&2; }
err()     { echo -e "${RED}[err]${NC}   $*" >&2; exit 1; }
section() { $QUIET || echo -e "\n${CYN}${BLD}── $* ──${NC}"; }

# ── Args ──────────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --quiet) QUIET=true; shift;;
    -h|--help)
      grep '^#' "$0" | grep -v '!/usr/bin' | sed 's/^# \?//'
      exit 0;;
    *) err "Unknown option: $1";;
  esac
done

if [[ "$(uname -s)" != "Linux" ]]; then
  err "This script is Linux-only. Use stop.ps1 on Windows."
fi

# ── Load .env for ports ─────────────────────────────────────────────────────
ENV_FILE="${PROJECT_DIR}/.env"
if [[ -f "$ENV_FILE" ]]; then
  set -o allexport; source "$ENV_FILE"; set +o allexport
fi
PORT="${PORT:-8787}"   # production host (serve) bridge port

$QUIET || echo -e "${CYN}${BLD}AgentVoice — stop host${NC}  |  Project: ${BLD}${PROJECT_DIR}${NC}"

# ── 1 + 2. Stop systemd units (user, then system) ───────────────────────────
stopped_via_systemd=false

if systemctl --user list-unit-files agentvoice.service &>/dev/null && \
   systemctl --user cat agentvoice.service &>/dev/null; then
  section "Stopping systemd user units"
  # Stop the watch path first so it can't re-trigger the service.
  if systemctl --user is-active --quiet agentvoice-watch.path; then
    systemctl --user stop agentvoice-watch.path || warn "Could not stop agentvoice-watch.path"
    ok "agentvoice-watch.path stopped."
  else
    info "agentvoice-watch.path already inactive."
  fi
  if systemctl --user is-active --quiet agentvoice.service; then
    systemctl --user stop agentvoice.service || warn "Could not stop agentvoice.service"
    ok "agentvoice.service stopped."
  else
    info "agentvoice.service already inactive."
  fi
  stopped_via_systemd=true
elif systemctl cat agentvoice.service &>/dev/null 2>&1; then
  section "Stopping systemd system unit"
  sudo systemctl stop agentvoice-watch.path 2>/dev/null || true
  sudo systemctl stop agentvoice.service || warn "Could not stop system agentvoice.service"
  ok "system agentvoice.service stopped."
  stopped_via_systemd=true
fi

# ── 3. Stop manual nohup process (restart.sh fallback path) ─────────────────
PID_FILE="${PROJECT_DIR}/data/.bridge.pid"
if [[ -f "$PID_FILE" ]]; then
  PID="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [[ -n "${PID:-}" ]] && kill -0 "$PID" 2>/dev/null; then
    section "Stopping manual bridge process"
    kill "$PID" 2>/dev/null || true
    sleep 1
    kill -0 "$PID" 2>/dev/null && kill -9 "$PID" 2>/dev/null || true
    ok "Stopped bridge pid ${PID}."
  fi
  rm -f "$PID_FILE"
fi

# ── 4. Free ports as a final safety net ─────────────────────────────────────
free_port() {
  local port="$1" label="$2"
  local pids
  pids="$(lsof -ti ":${port}" -sTCP:LISTEN 2>/dev/null || true)"
  [[ -z "$pids" ]] && { info "Port ${port} (${label}) already free."; return; }
  warn "Port ${port} (${label}) still held by: ${pids//$'\n'/ } — terminating."
  # shellcheck disable=SC2086
  kill $pids 2>/dev/null || true
  sleep 1
  pids="$(lsof -ti ":${port}" -sTCP:LISTEN 2>/dev/null || true)"
  if [[ -n "$pids" ]]; then
    # shellcheck disable=SC2086
    kill -9 $pids 2>/dev/null || true
    sleep 1
  fi
  if lsof -ti ":${port}" -sTCP:LISTEN &>/dev/null; then
    err "Port ${port} (${label}) is STILL in use — investigate manually: lsof -i :${port}"
  fi
  ok "Port ${port} (${label}) freed."
}

section "Freeing host port"
free_port "$PORT" "host bridge"

$QUIET || { echo ""; ok "AgentVoice host stopped. Start it again with: npm run start:service"; echo ""; }
