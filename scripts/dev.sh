#!/usr/bin/env bash
# Local dev entry — test-mode ports; avoid fighting the production systemd unit on :8787.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "$PROJECT_DIR"

YEL='\033[1;33m'
BLU='\033[0;34m'
NC='\033[0m'

warn() { echo -e "${YEL}[warn]${NC}  $*"; }
info() { echo -e "${BLU}[info]${NC}  $*"; }

if systemctl --user is-active --quiet agentvoice.service 2>/dev/null; then
  warn "agentvoice.service is running on :8787 (serve mode)."
  warn "Stopping it so npm run dev can use test ports (:5089 bridge, :4200 Angular)."
  systemctl --user stop agentvoice.service
fi

info "Dev: open http://localhost:4200 — API/WS proxy to bridge on :5089"
exec env NODE_ENV=development npx concurrently -n web,server -c cyan,magenta \
  "ng serve agentvoice-web" \
  "nodemon"
