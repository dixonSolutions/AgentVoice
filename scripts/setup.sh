#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# AgentVoice — host setup (Linux)
#
# What this script does:
#   1. Checks prerequisites (Node ≥ 20, npm, git, cursor-agent)
#   2. Installs Tailscale if missing
#   3. Builds the project (backend + PWA)
#   4. Creates .env with a generated APP_TOKEN if not already present
#   5. Installs systemd user units:
#        agentvoice.service      — bridge process (auto-restart on crash)
#        agentvoice-watch.path   — restarts service when dist/index.js changes
#   6. Configures tailscale serve (HTTPS proxy to the bridge)
#   7. Opens UFW firewall port on the tailscale0 interface
#   8. Prints a next-step checklist
#
# Usage:
#   bash scripts/setup.sh [--port PORT] [--no-tailscale]
#
# Options:
#   --port PORT        Bridge listen port (default: 8787)
#   --no-tailscale     Skip Tailscale installation / tailscale serve setup
#
# Re-running is safe — existing .env values are preserved.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "$PROJECT_DIR"

# ── Colours ───────────────────────────────────────────────────────────────
RED='\033[0;31m'
GRN='\033[0;32m'
YEL='\033[1;33m'
BLU='\033[0;34m'
CYN='\033[0;36m'
BLD='\033[1m'
NC='\033[0m'

info()    { echo -e "${BLU}[info]${NC}  $*"; }
ok()      { echo -e "${GRN}[ok]${NC}    $*"; }
warn()    { echo -e "${YEL}[warn]${NC}  $*"; }
err()     { echo -e "${RED}[err]${NC}   $*" >&2; exit 1; }
section() { echo -e "\n${CYN}${BLD}── $* ──${NC}"; }

# ── Argument parsing ──────────────────────────────────────────────────────
PORT=8787
SKIP_TAILSCALE=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port)         PORT="$2"; shift 2;;
    --no-tailscale) SKIP_TAILSCALE=true; shift;;
    -h|--help)
      grep '^#' "$0" | grep -v '!/usr/bin' | sed 's/^# \?//'
      exit 0;;
    *) err "Unknown option: $1";;
  esac
done

# ── OS guard ──────────────────────────────────────────────────────────────
if [[ "$(uname -s)" != "Linux" ]]; then
  err "This script is Linux-only. Use setup.ps1 on Windows."
fi

RUN_USER="${USER:-$(id -un)}"

info "Platform: Linux  |  User: ${BLD}${RUN_USER}${NC}  |  Project: ${BLD}${PROJECT_DIR}${NC}"

# ── 1. Prerequisites ──────────────────────────────────────────────────────
section "Checking prerequisites"

# Node.js ≥ 20
if ! command -v node &>/dev/null; then
  err "Node.js not found. Install from https://nodejs.org (v20 LTS recommended)"
fi
NODE_MAJOR="$(node --version | tr -d 'v' | cut -d. -f1)"
if [[ "$NODE_MAJOR" -lt 20 ]]; then
  err "Node.js >= 20 required (found $(node --version)). Upgrade at https://nodejs.org"
fi
ok "Node.js $(node --version)"

command -v npm &>/dev/null || err "npm not found — install Node.js"
ok "npm $(npm --version)"

command -v git &>/dev/null || err "git not found — sudo apt install git"
ok "git $(git --version | awk '{print $3}')"

if command -v cursor-agent &>/dev/null; then
  ok "cursor-agent $(cursor-agent --version 2>/dev/null || echo '(version unknown)')"
else
  warn "cursor-agent not found on PATH."
  warn "Install Cursor IDE, then ensure cursor-agent is on PATH before starting the service."
fi

# ── 2. Tailscale ──────────────────────────────────────────────────────────
section "Tailscale"

if $SKIP_TAILSCALE; then
  warn "Skipping Tailscale setup (--no-tailscale)."
elif command -v tailscale &>/dev/null; then
  ok "Tailscale already installed: $(tailscale --version | head -1)"
else
  info "Installing Tailscale via official install script..."
  curl -fsSL https://tailscale.com/install.sh | sh
  ok "Tailscale installed."
fi

if ! $SKIP_TAILSCALE; then
  if ! systemctl is-active --quiet tailscaled 2>/dev/null; then
    sudo systemctl enable --now tailscaled
    ok "tailscaled enabled and started."
  fi
  if ! tailscale status &>/dev/null 2>&1; then
    info "Tailscale not yet authenticated — signing in..."
    sudo tailscale up
  fi
  # Enable MagicDNS so *.ts.net hostnames resolve locally (needed for HTTPS URL).
  tailscale set --accept-dns=true 2>/dev/null \
    && ok "Tailscale MagicDNS enabled (*.ts.net resolves locally)." \
    || warn "Could not enable MagicDNS — run: tailscale set --accept-dns=true"
  ok "Tailscale is up: $(tailscale ip -4 2>/dev/null || echo 'IP pending')"
fi

# Detect the Node binary used by an existing service (if installed)
SERVICE_NODE=""
SERVICE_FILE="${HOME}/.config/systemd/user/agentvoice.service"
if [[ -f "$SERVICE_FILE" ]]; then
  SERVICE_NODE=$(grep -oP '(?<=ExecStart=)\S+node' "$SERVICE_FILE" || true)
fi
if [[ -z "$SERVICE_NODE" && -f /etc/systemd/system/agentvoice.service ]]; then
  SERVICE_NODE=$(grep -oP '(?<=ExecStart=)\S+node' /etc/systemd/system/agentvoice.service || true)
fi
NODE_BIN="${SERVICE_NODE:-$(command -v node 2>/dev/null || true)}"
NPM_BIN="$(dirname "$NODE_BIN")/npm"
[[ -x "$NPM_BIN" ]] || NPM_BIN="npm"

# ── 3. Build ──────────────────────────────────────────────────────────────
section "Building project"

info "Using NODE_BIN=${NODE_BIN}  NPM_BIN=${NPM_BIN}"
info "Installing npm dependencies..."
"$NPM_BIN" ci --no-audit --prefer-offline 2>/dev/null \
  || "$NPM_BIN" install --no-audit --legacy-peer-deps
"$NPM_BIN" rebuild

info "Building backend + PWA..."
"$NPM_BIN" run build
ok "Build complete → dist/index.js + web/dist/"

# ── 4. Environment file ───────────────────────────────────────────────────
section "Environment (.env)"

ENV_FILE="${PROJECT_DIR}/.env"

if [[ ! -f "$ENV_FILE" ]]; then
  info "Creating .env with a generated APP_TOKEN..."

  if command -v openssl &>/dev/null; then
    APP_TOKEN="$(openssl rand -base64 32 | tr -d '=+/' | head -c 43)"
  else
    APP_TOKEN="$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64url'))")"
  fi

  cat > "$ENV_FILE" <<EOF
# AgentVoice — secrets + machine-specific paths
# chmod 600 this file and never commit it.

APP_TOKEN=${APP_TOKEN}

PORT=${PORT}
CONFIG_PATH=${PROJECT_DIR}/config.json
DB_PATH=${PROJECT_DIR}/data/state.db

# AWS credentials (optional — only needed for Polly/Transcribe/Bedrock)
# AWS_ACCESS_KEY_ID=
# AWS_SECRET_ACCESS_KEY=
# AWS_REGION=us-east-1
EOF

  chmod 600 "$ENV_FILE"
  ok ".env created."
  warn "APP_TOKEN=${BLD}${APP_TOKEN}${NC}"
  warn "Copy this token into the PWA settings screen."
else
  ok ".env already exists — preserving existing values."
  if ! grep -q "^PORT=" "$ENV_FILE"; then
    echo "PORT=${PORT}" >> "$ENV_FILE"
    info "Added PORT=${PORT} to existing .env."
  fi
fi

ACTUAL_PORT="$(grep -E '^PORT=' "$ENV_FILE" | cut -d= -f2 | tr -d '[:space:]' || echo "$PORT")"

# ── 5. Config skeleton ────────────────────────────────────────────────────
section "Config (config.json)"

if [[ ! -f "${PROJECT_DIR}/config.json" ]]; then
  if [[ -f "${PROJECT_DIR}/config.example.json" ]]; then
    cp "${PROJECT_DIR}/config.example.json" "${PROJECT_DIR}/config.json"
    ok "config.json created from config.example.json"
  else
    cat > "${PROJECT_DIR}/config.json" <<'CONF'
{
  "settings": {
    "runMode": "serve",
    "runModes": {
      "serve": {
        "backendPort": 8787,
        "publicBaseUrl": "https://REPLACE-WITH-YOUR-TAILSCALE-HOSTNAME"
      }
    },
    "maxConcurrentJobs": 3,
    "jobTimeoutMs": 600000,
    "preRunFlags": ["--force", "--trust"],
    "narratorEnabled": true,
    "narratorCadenceMs": 15000,
    "logLevel": "info"
  },
  "projects": []
}
CONF
    ok "config.json skeleton created — edit projects[] and set publicBaseUrl."
  fi
else
  ok "config.json already exists."
fi

mkdir -p "${PROJECT_DIR}/data"

# ── 6. systemd user units ─────────────────────────────────────────────────
section "systemd user service"

SYSTEMD_DIR="${HOME}/.config/systemd/user"
mkdir -p "$SYSTEMD_DIR"

# ── Main service unit ──────────────────────────────────────────────────────
SERVICE_FILE="${SYSTEMD_DIR}/agentvoice.service"
info "Writing ${SERVICE_FILE}..."
cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=AgentVoice Bridge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${PROJECT_DIR}
Environment=HOME=${HOME}
EnvironmentFile=${ENV_FILE}
ExecStart=${NODE_BIN:-/usr/bin/node} ${PROJECT_DIR}/dist/index.js
Restart=on-failure
RestartSec=3

StandardOutput=journal
StandardError=journal
SyslogIdentifier=agentvoice

[Install]
WantedBy=default.target
EOF

# ── Path watcher unit (auto-restart on new builds) ─────────────────────────
# Whenever npm run build or restart.sh updates dist/index.js, systemd
# automatically restarts agentvoice.service — no manual restart needed.
PATH_FILE="${SYSTEMD_DIR}/agentvoice-watch.path"
info "Writing ${PATH_FILE} (auto-restart on new builds)..."
cat > "$PATH_FILE" <<EOF
[Unit]
Description=Watch AgentVoice build output for changes

[Path]
PathModified=${PROJECT_DIR}/dist/index.js
Unit=agentvoice.service

[Install]
WantedBy=default.target
EOF

# Enable linger so user units survive logout
if command -v loginctl &>/dev/null; then
  loginctl enable-linger "$RUN_USER" 2>/dev/null && ok "User linger enabled (units survive logout)."
fi

systemctl --user daemon-reload
systemctl --user enable agentvoice.service agentvoice-watch.path
systemctl --user restart agentvoice.service
systemctl --user start agentvoice-watch.path

ok "systemd units active."
systemctl --user status agentvoice.service --no-pager -l | head -12 || true

# ── 7. Tailscale serve ────────────────────────────────────────────────────
section "Tailscale HTTPS proxy"

if $SKIP_TAILSCALE; then
  warn "Skipping tailscale serve (--no-tailscale)."
else
  # Allow the current user to run tailscale serve without sudo.
  # This is a one-time system setting; re-running is harmless.
  if sudo -n tailscale set --operator="$USER" 2>/dev/null; then
    ok "tailscale operator set to $USER (serve no longer needs sudo)."
  elif sudo tailscale set --operator="$USER" 2>/dev/null; then
    ok "tailscale operator set to $USER."
  else
    warn "Could not run 'sudo tailscale set --operator=\$USER' — you may need to run it manually."
  fi

  info "Configuring Tailscale Serve (HTTPS → local upstream)..."
  bash "${SCRIPT_DIR}/sync-tailscale-serve.sh" \
    && ok "tailscale serve configured." \
    || warn "tailscale serve failed — run manually: bash scripts/sync-tailscale-serve.sh"

  # Detect Tailscale hostname and patch config.json
  TS_HOST="$(tailscale status --json 2>/dev/null \
    | python3 -c "import sys,json; print(json.load(sys.stdin).get('Self',{}).get('DNSName','').rstrip('.'))" \
    2>/dev/null || true)"

  if [[ -n "$TS_HOST" ]]; then
    PUBLIC_URL="https://${TS_HOST}"
    ok "Bridge is at: ${BLD}${PUBLIC_URL}${NC}"
    if grep -q 'REPLACE-WITH-YOUR-TAILSCALE-HOSTNAME' "${PROJECT_DIR}/config.json" 2>/dev/null; then
      sed -i "s|https://REPLACE-WITH-YOUR-TAILSCALE-HOSTNAME|${PUBLIC_URL}|g" "${PROJECT_DIR}/config.json"
      ok "Updated publicBaseUrl in config.json → ${PUBLIC_URL}"
    fi
  else
    warn "Could not detect Tailscale hostname — set publicBaseUrl in config.json manually."
  fi
fi

# ── 8. UFW firewall ───────────────────────────────────────────────────────
section "UFW firewall"

if ! command -v ufw &>/dev/null; then
  warn "ufw not found — skipping firewall setup."
elif ! sudo -n ufw status &>/dev/null 2>&1 && ! ufw status &>/dev/null 2>&1; then
  warn "Cannot run ufw (no sudo access) — run manually:"
  warn "  sudo ufw allow in on tailscale0 to any port ${ACTUAL_PORT} proto tcp"
  warn "  sudo ufw --force enable"
else
  _ufw() { sudo ufw "$@" 2>/dev/null || ufw "$@" 2>/dev/null || true; }

  # Allow bridge port on Tailscale interface only
  _ufw allow in on tailscale0 to any port "${ACTUAL_PORT}" proto tcp \
    comment "agentvoice bridge"

  # Ensure SSH on tailscale is allowed before enabling (prevents lockout)
  _ufw allow in on tailscale0 to any port 22 proto tcp \
    comment "SSH on tailscale"

  UFW_STATUS="$(ufw status 2>/dev/null | head -1 || true)"
  if echo "$UFW_STATUS" | grep -q "inactive"; then
    info "Enabling UFW..."
    _ufw --force enable
    ok "UFW enabled with tailscale0:${ACTUAL_PORT} open."
  else
    ok "UFW already active — rules added for tailscale0:${ACTUAL_PORT}."
  fi

  ufw status numbered 2>/dev/null | grep -E "8787|${ACTUAL_PORT}" || true
fi

# ── 9. Done ───────────────────────────────────────────────────────────────
section "Setup complete"

TOKEN="$(grep '^APP_TOKEN=' "$ENV_FILE" | cut -d= -f2 | tr -d '[:space:]')"

echo ""
echo -e "${GRN}✔${NC}  Bridge running as a persistent systemd user service"
echo -e "${GRN}✔${NC}  Auto-restarts on crash (Restart=on-failure)"
echo -e "${GRN}✔${NC}  Auto-restarts on new build (agentvoice-watch.path watches dist/index.js)"
echo -e "${GRN}✔${NC}  UFW firewall allows port ${ACTUAL_PORT} on tailscale0"
echo ""
echo -e "${YEL}▶  Action required:${NC}"
echo ""
if ! $SKIP_TAILSCALE; then
  echo "   1. Enable HTTPS certs in the Tailscale admin console:"
  echo "      https://login.tailscale.com/admin/dns  →  HTTPS Certificates  →  Enable"
  echo ""
fi
echo "   2. Add your projects to config.json:"
echo "      nano ${PROJECT_DIR}/config.json"
echo ""
echo "   3. Open the PWA and enter your APP_TOKEN:"
echo -e "      ${BLD}${TOKEN}${NC}"
echo ""
echo "   4. To deploy new code: just run the build — the watcher restarts automatically."
echo "      Or for a manual restart:  bash scripts/restart.sh"
echo ""
echo -e "${BLU}Logs:${NC}  journalctl --user -u agentvoice -f"
echo ""
