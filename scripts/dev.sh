#!/usr/bin/env bash
# Local dev entry — test-mode ports, read from config.json (settings.runModes.test).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "$PROJECT_DIR"

YEL='\033[1;33m'
BLU='\033[0;34m'
NC='\033[0m'

warn() { echo -e "${YEL}[warn]${NC}  $*"; }
info() { echo -e "${BLU}[info]${NC}  $*"; }

# The bridge and the Angular proxy both take the dev port from config.json; read it
# here too so this banner (and the conflict warning) can never drift from reality.
read_backend_port() {
  node -e '
    const { readFileSync } = require("node:fs");
    try {
      const cfg = JSON.parse(readFileSync("config.json", "utf8"));
      process.stdout.write(String(cfg.settings?.runModes?.test?.backendPort ?? 5089));
    } catch {
      process.stdout.write("5089");
    }
  ' 2>/dev/null || echo 5089
}

BRIDGE_PORT="$(read_backend_port)"

if systemctl --user is-active --quiet agentvoice.service 2>/dev/null; then
  warn "agentvoice.service is running (serve mode)."
  warn "Stopping it so npm run dev can use test ports (:${BRIDGE_PORT} bridge, :4200 Angular)."
  systemctl --user stop agentvoice.service
fi

info "Dev: open http://localhost:4200 — API/WS proxy to bridge on :${BRIDGE_PORT}"
exec env NODE_ENV=development npx concurrently -n web,server -c cyan,magenta \
  "ng serve agentvoice-web" \
  "nodemon"
