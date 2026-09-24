#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# AgentVoice — setup from a clone (Linux / macOS)
#
# This script only builds. Everything after that is `agentvoice setup`, the
# same guided wizard an npm or .deb/.rpm install runs:
#
#   1. install dependencies and compile the backend + web client
#   2. agentvoice setup
#        - asks whether to install a background service
#        - project config: agent CLI, where your repos live
#        - only if you said yes: the service, then hosting (e.g. Tailscale)
#
# Usage:
#   bash scripts/setup.sh [options] [-- <agentvoice setup options>]
#
# Options:
#   --skip-install     Do not run npm install
#   --skip-build       Do not build (use the existing dist/ and web/dist/)
#   --rebuild          Reinstall dependencies even when node_modules exists
#   -y, --yes          Wizard takes every default without asking
#   --local            Wizard: no background service, no hosting
#   --hosting[=<id>]   Wizard: install the service, then this hosting provider
#                      (tailscale | cloudflare | ngrok | devtunnel | lan)
#   -h, --help         This screen
#
# Anything after `--` goes to `agentvoice setup` unchanged
# (e.g. `-- --agent claude-code --projects-dir ~/code`). Re-running is safe.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "$PROJECT_DIR"

GRN='\033[0;32m'; BLU='\033[0;34m'; CYN='\033[0;36m'; RED='\033[0;31m'; BLD='\033[1m'; NC='\033[0m'
info()    { echo -e "${BLU}[info]${NC}  $*"; }
ok()      { echo -e "${GRN}[ok]${NC}    $*"; }
err()     { echo -e "${RED}[err]${NC}   $*" >&2; exit 1; }
section() { echo -e "\n${CYN}${BLD}── $* ──${NC}"; }

SKIP_INSTALL=false
SKIP_BUILD=false
REBUILD=false
WIZARD_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-install) SKIP_INSTALL=true; shift;;
    --skip-build)   SKIP_BUILD=true; shift;;
    --rebuild)      REBUILD=true; shift;;
    -y|--yes|--non-interactive) WIZARD_ARGS+=(--yes); shift;;
    --local)        WIZARD_ARGS+=(--no-service); shift;;
    --hosting)      WIZARD_ARGS+=(--service); shift;;
    --hosting=*)    WIZARD_ARGS+=(--service --hosting "${1#*=}"); shift;;
    --)             shift; WIZARD_ARGS+=("$@"); break;;
    -h|--help)
      grep '^#' "$0" | grep -v '!/usr/bin' | sed 's/^# \?//'
      exit 0;;
    *) err "Unknown option: $1 (see --help)";;
  esac
done

# ── Prerequisites ──────────────────────────────────────────────────────────
command -v node >/dev/null 2>&1 || err "Node.js 20+ is required (https://nodejs.org)."
command -v npm  >/dev/null 2>&1 || err "npm is required."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[[ "$NODE_MAJOR" -ge 20 ]] || err "Node.js 20+ is required (found $(node -v))."

# ── 1. Build ───────────────────────────────────────────────────────────────
section "Build"
if ! $SKIP_INSTALL && { $REBUILD || [[ ! -d node_modules ]]; }; then
  info "Installing dependencies…"
  # --legacy-peer-deps: plain `npm install` fails on an optimus-ui /
  # @angular/cdk peer conflict.
  npm install --legacy-peer-deps
  ok "Dependencies installed"
else
  info "Dependencies present — skipping npm install (--rebuild to force)"
fi

if ! $SKIP_BUILD; then
  info "Compiling the backend and the web client…"
  npm run build
  ok "Built dist/ and web/dist/"
else
  [[ -f dist/cli.js && -d web/dist ]] || err "--skip-build, but dist/ or web/dist/ is missing — run without it."
  info "Skipping the build"
fi

# ── 2. The wizard ──────────────────────────────────────────────────────────
section "Setup"
exec node "${PROJECT_DIR}/bin/agentvoice.mjs" setup ${WIZARD_ARGS[@]+"${WIZARD_ARGS[@]}"}
