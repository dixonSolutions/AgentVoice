#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# AgentVoice — restart script (Linux)
#
# What this script does:
#   1. Builds the project (backend + PWA)
#   2. Restarts the bridge service via systemd
#   3. Runs a /healthz check to confirm startup
#   4. Optionally tails the log
#
# Usage:
#   bash scripts/restart.sh [--no-build] [--tail]
#
# Options:
#   --no-build   Skip the build (restart only — handy for config-only changes)
#   --tail       Stream journald logs after restart (Ctrl-C to stop)
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "$PROJECT_DIR"

# ── Colours ───────────────────────────────────────────────────────────────
GRN='\033[0;32m'
YEL='\033[1;33m'
BLU='\033[0;34m'
CYN='\033[0;36m'
BLD='\033[1m'
NC='\033[0m'

info()    { echo -e "${BLU}[info]${NC}  $*"; }
ok()      { echo -e "${GRN}[ok]${NC}    $*"; }
warn()    { echo -e "${YEL}[warn]${NC}  $*"; }
err()     { echo -e "\033[0;31m[err]${NC}   $*" >&2; exit 1; }
section() { echo -e "\n${CYN}${BLD}── $* ──${NC}"; }

# ── Args ──────────────────────────────────────────────────────────────────
NO_BUILD=false
TAIL_LOGS=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-build) NO_BUILD=true; shift;;
    --tail)     TAIL_LOGS=true; shift;;
    -h|--help)
      grep '^#' "$0" | grep -v '!/usr/bin' | sed 's/^# \?//'
      exit 0;;
    *) err "Unknown option: $1";;
  esac
done

if [[ "$(uname -s)" != "Linux" ]]; then
  err "This script is Linux-only. Use restart.ps1 on Windows."
fi

echo -e "${CYN}${BLD}AgentVoice — restart${NC}  |  Project: ${BLD}${PROJECT_DIR}${NC}"

# ── Load .env for PORT ────────────────────────────────────────────────────
ENV_FILE="${PROJECT_DIR}/.env"
if [[ -f "$ENV_FILE" ]]; then
  set -o allexport; source "$ENV_FILE"; set +o allexport
fi
PORT="${PORT:-8787}"

# Detect the Node binary used by the service (if installed)
SERVICE_NODE=""
SERVICE_FILE="${HOME}/.config/systemd/user/agentvoice.service"
if [[ -f "$SERVICE_FILE" ]]; then
  SERVICE_NODE=$(grep -oP '(?<=ExecStart=)\S+node' "$SERVICE_FILE" || true)
fi
# Also check system-wide service
if [[ -z "$SERVICE_NODE" && -f /etc/systemd/system/agentvoice.service ]]; then
  SERVICE_NODE=$(grep -oP '(?<=ExecStart=)\S+node' /etc/systemd/system/agentvoice.service || true)
fi
NODE_BIN="${SERVICE_NODE:-node}"
NPM_BIN="$(dirname "$NODE_BIN")/npm"
# Fallback if npm not alongside node
[[ -x "$NPM_BIN" ]] || NPM_BIN="npm"

# ── 1. Build ──────────────────────────────────────────────────────────────
if $NO_BUILD; then
  section "Skipping build (--no-build)"
  warn "Using existing dist/index.js"
else
  section "Building"
  info "Using NODE_BIN=${NODE_BIN}  NPM_BIN=${NPM_BIN}"
  info "Checking dependencies..."
  "$NPM_BIN" ci --no-audit --prefer-offline 2>/dev/null || "$NPM_BIN" install --no-audit --legacy-peer-deps
  "$NPM_BIN" rebuild

  info "Building backend + PWA..."
  START=$SECONDS
  "$NPM_BIN" run build
  ok "Build done in $(( SECONDS - START ))s → dist/index.js"
fi

# ── 2. Restart service ────────────────────────────────────────────────────
section "Restarting service"

if systemctl --user is-enabled agentvoice.service &>/dev/null; then
  # Normal path: systemd user unit installed by setup.sh
  # Note: if agentvoice-watch.path is running, a build alone would already
  # trigger a restart. --no-build is the fast path for config-only changes.
  systemctl --user restart agentvoice.service
  sleep 1
  if systemctl --user is-active --quiet agentvoice.service; then
    ok "agentvoice.service restarted."
  else
    warn "Service may have failed. Check: journalctl --user -u agentvoice -n 30"
    systemctl --user status agentvoice.service --no-pager -l | tail -15
  fi

elif systemctl is-enabled agentvoice.service &>/dev/null 2>&1; then
  # System-wide service (e.g. installed as root)
  sudo systemctl restart agentvoice.service
  sleep 1
  systemctl status agentvoice.service --no-pager -l | head -12
  ok "System agentvoice.service restarted."

else
  # No service found — fallback to manual background process
  warn "No systemd service found. Run 'bash scripts/setup.sh' to install it."
  warn "Starting bridge manually in the background..."
  mkdir -p "${PROJECT_DIR}/logs"
  nohup "$NODE_BIN" "${PROJECT_DIR}/dist/index.js" \
    >> "${PROJECT_DIR}/logs/bridge.log" 2>&1 &
  PID=$!
  sleep 1
  if kill -0 "$PID" 2>/dev/null; then
    ok "Bridge started (pid ${PID}). Log: ${PROJECT_DIR}/logs/bridge.log"
    echo "$PID" > "${PROJECT_DIR}/data/.bridge.pid"
  else
    err "Bridge exited immediately — check ${PROJECT_DIR}/logs/bridge.log"
  fi
fi

# ── 3. Health check ───────────────────────────────────────────────────────
section "Health check"

sleep 2
HEALTHZ="http://127.0.0.1:${PORT}/healthz"
if curl -sf --max-time 5 "$HEALTHZ" | python3 -m json.tool 2>/dev/null; then
  ok "Bridge healthy at ${HEALTHZ}"
else
  warn "Health check failed at ${HEALTHZ} — bridge may still be starting."
  warn "Retry: curl ${HEALTHZ}"
fi

# ── 4. Tailscale Serve (serve mode / split-host upstream) ─────────────────
if command -v tailscale &>/dev/null; then
  bash "${SCRIPT_DIR}/sync-tailscale-serve.sh" || warn "Tailscale Serve sync failed — run: bash scripts/sync-tailscale-serve.sh"
fi

# ── 5. Optional log tail ──────────────────────────────────────────────────
if $TAIL_LOGS; then
  echo ""
  info "Tailing logs (Ctrl-C to stop)..."
  journalctl --user -u agentvoice -f --no-pager
fi

echo ""
ok "Done."
echo -e "  ${BLU}Logs:${NC} journalctl --user -u agentvoice -f"
echo ""
