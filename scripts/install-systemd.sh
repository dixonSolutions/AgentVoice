#!/usr/bin/env bash
# Install agentvoice as a systemd user service (survives logout/reboot with linger).
#
# Usage:
#   bash scripts/install-systemd.sh
#
# Re-running is safe — refreshes unit files and restarts the service.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "$PROJECT_DIR"

GRN='\033[0;32m'; YEL='\033[1;33m'; BLU='\033[0;34m'; CYN='\033[0;36m'; RED='\033[0;31m'; BLD='\033[1m'; NC='\033[0m'
info() { echo -e "${BLU}[info]${NC}  $*"; }
ok()   { echo -e "${GRN}[ok]${NC}    $*"; }
warn() { echo -e "${YEL}[warn]${NC}  $*" >&2; }
err()  { echo -e "${RED}[err]${NC}   $*" >&2; exit 1; }
section() { echo -e "\n${CYN}${BLD}── $* ──${NC}"; }

if [[ "$(uname -s)" != "Linux" ]]; then
  err "Linux only. Use setup.ps1 on Windows."
fi

RUN_USER="${USER:-$(id -un)}"
ENV_FILE="${PROJECT_DIR}/.env"

[[ -f "$ENV_FILE" ]] || err ".env not found — run setup or copy .env.example first."
[[ -f "${PROJECT_DIR}/dist/index.js" ]] || err "dist/index.js missing — run: npm run build"

# Prefer nvm-managed Node when present (matches dev.sh / manual runs).
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [[ -s "$NVM_DIR/nvm.sh" ]]; then
  unset npm_config_prefix
  # shellcheck disable=SC1090
  . "$NVM_DIR/nvm.sh"
  nvm use --silent 2>/dev/null || true
fi

NODE_BIN="$(command -v node 2>/dev/null || true)"
[[ -n "$NODE_BIN" ]] || err "node not found on PATH"

# systemd user units get a minimal PATH — include cursor-agent and node.
PATH_PARTS=()
for dir in "$(dirname "$NODE_BIN")" "$HOME/.local/bin" "$HOME/.cursor/bin" /usr/local/bin /usr/bin /bin; do
  [[ -d "$dir" ]] || continue
  [[ " ${PATH_PARTS[*]:-} " == *" $dir "* ]] && continue
  PATH_PARTS+=("$dir")
done
SERVICE_PATH="$(IFS=:; echo "${PATH_PARTS[*]}")"

section "Installing systemd user units"
SYSTEMD_DIR="${HOME}/.config/systemd/user"
mkdir -p "$SYSTEMD_DIR"

SERVICE_FILE="${SYSTEMD_DIR}/agentvoice.service"
info "Writing ${SERVICE_FILE}..."
cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=AgentVoice Bridge
After=network-online.target tailscaled.service
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${PROJECT_DIR}
Environment=PATH=${SERVICE_PATH}
EnvironmentFile=${ENV_FILE}
ExecStart=${NODE_BIN} ${PROJECT_DIR}/dist/index.js
Restart=on-failure
RestartSec=3

StandardOutput=journal
StandardError=journal
SyslogIdentifier=agentvoice

[Install]
WantedBy=default.target
EOF

PATH_FILE="${SYSTEMD_DIR}/agentvoice-watch.path"
info "Writing ${PATH_FILE}..."
cat > "$PATH_FILE" <<EOF
[Unit]
Description=Watch AgentVoice build output for changes

[Path]
PathModified=${PROJECT_DIR}/dist/index.js
Unit=agentvoice.service

[Install]
WantedBy=default.target
EOF

section "Enabling user linger (units survive logout/reboot)"
if command -v loginctl &>/dev/null; then
  if loginctl show-user "$RUN_USER" -p Linger 2>/dev/null | grep -q 'Linger=yes'; then
    ok "Linger already enabled for ${RUN_USER}."
  elif loginctl enable-linger "$RUN_USER" 2>/dev/null; then
    ok "Linger enabled for ${RUN_USER}."
  else
    warn "Could not enable linger — run: sudo loginctl enable-linger ${RUN_USER}"
  fi
else
  warn "loginctl not found — enable linger manually if the service stops after logout."
fi

section "Stopping manual bridge (if any)"
bash "${SCRIPT_DIR}/stop.sh" --quiet || true

section "Starting systemd units"
systemctl --user daemon-reload
systemctl --user enable agentvoice.service agentvoice-watch.path
systemctl --user restart agentvoice.service
systemctl --user start agentvoice-watch.path

sleep 2
if systemctl --user is-active --quiet agentvoice.service; then
  ok "agentvoice.service is active."
else
  warn "Service may have failed — check: journalctl --user -u agentvoice -n 30"
  systemctl --user status agentvoice.service --no-pager -l | tail -15 || true
  exit 1
fi

PORT="$(grep -E '^PORT=' "$ENV_FILE" | cut -d= -f2 | tr -d '[:space:]' || echo 8787)"
if curl -sf --max-time 10 "http://127.0.0.1:${PORT}/healthz" >/dev/null; then
  ok "Health check passed on port ${PORT}."
else
  warn "Health check failed — retry: curl http://127.0.0.1:${PORT}/healthz"
fi

echo ""
ok "systemd install complete."
echo -e "  ${BLU}Status:${NC} systemctl --user status agentvoice"
echo -e "  ${BLU}Logs:${NC}   journalctl --user -u agentvoice -f"
echo -e "  ${BLU}Restart:${NC} bash scripts/restart.sh --no-build"
echo ""
