#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# AgentVoice — setup entrypoint (Linux)
#
#   1. bash scripts/prepare.sh        deps, build, wake-word model, .env, config.json
#   2. then either
#        a) bash scripts/hosting-setup.sh   (tailscale / caddy / lan / local)
#        b) a local run: start (or verify) the bridge on 127.0.0.1:PORT, no hosting
#
# Usage:
#   bash scripts/setup.sh [options]
#
# Options:
#   -y, --yes, --non-interactive   No prompts; defaults to the local run (b)
#   --hosting[=<provider>]         Go to hosting setup (a); optional provider:
#                                  tailscale | caddy | lan | local
#   --local                        Local run (b), skip hosting setup
#   --skip-install, --skip-build, --skip-vosk, --rebuild, --port PORT
#                                  Passed through to prepare.sh
#   --interactive                  Prompt even when stdin is not a terminal
#   -h, --help                     This screen
#
# Environment overrides (AGENTVOICE_CONFIG, AGENTVOICE_ENV_FILE, AGENTVOICE_HOME)
# are honoured by both child scripts. Re-running is safe.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "$PROJECT_DIR"

GRN='\033[0;32m'; YEL='\033[1;33m'; BLU='\033[0;34m'; CYN='\033[0;36m'; RED='\033[0;31m'; BLD='\033[1m'; NC='\033[0m'
info()    { echo -e "${BLU}[info]${NC}  $*"; }
ok()      { echo -e "${GRN}[ok]${NC}    $*"; }
warn()    { echo -e "${YEL}[warn]${NC}  $*" >&2; }
err()     { echo -e "${RED}[err]${NC}   $*" >&2; exit 1; }
section() { echo -e "\n${CYN}${BLD}── $* ──${NC}"; }

INTERACTIVE=true
FORCE_INTERACTIVE=false   # --interactive: prompt even when stdin is not a tty (piped answers)
NEXT=""            # hosting | local | "" (ask)
HOSTING_PROVIDER=""
PREPARE_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    -y|--yes|--non-interactive) INTERACTIVE=false; PREPARE_ARGS+=(--non-interactive); shift;;
    --interactive) FORCE_INTERACTIVE=true; PREPARE_ARGS+=(--interactive); shift;;
    --hosting)    NEXT=hosting; shift;;
    --hosting=*)  NEXT=hosting; HOSTING_PROVIDER="${1#*=}"; shift;;
    --local)      NEXT=local; shift;;
    --skip-install|--skip-build|--skip-vosk|--rebuild) PREPARE_ARGS+=("$1"); shift;;
    --port)       [[ $# -ge 2 ]] || err "--port needs a value"; PREPARE_ARGS+=(--port "$2"); PORT_ARG="$2"; shift 2;;
    --port=*)     PREPARE_ARGS+=("$1"); PORT_ARG="${1#*=}"; shift;;
    -h|--help)
      grep '^#' "$0" | grep -v '!/usr/bin' | sed 's/^# \?//'
      exit 0;;
    *) err "Unknown option: $1 (see --help)";;
  esac
done

if $INTERACTIVE && ! $FORCE_INTERACTIVE && [[ ! -t 0 ]]; then
  warn "stdin is not a terminal — running non-interactively."
  INTERACTIVE=false
  PREPARE_ARGS+=(--non-interactive)
fi

[[ "$(uname -s)" == "Linux" ]] || err "Linux only. Use setup.ps1 on Windows."

# ── 1. Prepare ────────────────────────────────────────────────────────────
section "Step 1/2 — prepare"
bash "${SCRIPT_DIR}/prepare.sh" ${PREPARE_ARGS[@]+"${PREPARE_ARGS[@]}"}

# ── 2. What next? ─────────────────────────────────────────────────────────
section "Step 2/2 — run"
if [[ -z "$NEXT" ]]; then
  if $INTERACTIVE; then
    echo -e "${BLD}What next?${NC}"
    echo "  1) Hosting setup — expose the bridge (tailscale / caddy / lan / local)"
    echo "  2) Local run     — start/verify the bridge on 127.0.0.1 only, no hosting"
    while :; do
      read -r -p "Choice [2]: " pick || true
      case "${pick:-2}" in
        1) NEXT=hosting; break;;
        2) NEXT=local; break;;
        *) echo "  Enter 1 or 2.";;
      esac
    done
  else
    NEXT=local
    info "Non-interactive — attempting a local run (use --hosting=<provider> for hosting)."
  fi
fi

ENV_FILE="${AGENTVOICE_ENV_FILE:-${PROJECT_DIR}/.env}"
PORT="${PORT_ARG:-}"
if [[ -z "$PORT" && -f "$ENV_FILE" ]]; then
  PORT="$(grep -E '^PORT=' "$ENV_FILE" | head -1 | cut -d= -f2 | tr -d '[:space:]' || true)"
fi
PORT="${PORT:-5089}"

if [[ "$NEXT" == "hosting" ]]; then
  HOST_ARGS=()
  $INTERACTIVE || HOST_ARGS+=(--non-interactive)
  [[ -n "$HOSTING_PROVIDER" ]] && HOST_ARGS+=("--provider=${HOSTING_PROVIDER}")
  HOST_ARGS+=(--port "$PORT")
  bash "${SCRIPT_DIR}/hosting-setup.sh" "${HOST_ARGS[@]}"
  exit 0
fi

# ── Local run ─────────────────────────────────────────────────────────────
healthy() { curl -sf --max-time 4 "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1; }

if healthy; then
  ok "Bridge already running on http://127.0.0.1:${PORT}"
else
  if command -v systemctl >/dev/null 2>&1 && systemctl --user cat agentvoice.service >/dev/null 2>&1; then
    info "Starting agentvoice.service..."
    systemctl --user start agentvoice.service || warn "systemctl start failed — journalctl --user -u agentvoice -n 30"
  elif [[ -f "${SCRIPT_DIR}/start.sh" ]]; then
    info "No systemd unit — starting via scripts/start.sh (install one later with scripts/install-systemd.sh)"
    bash "${SCRIPT_DIR}/start.sh" || warn "start.sh failed"
  else
    info "Starting the bridge in the background: node dist/index.js"
    ( set -a; [[ -f "$ENV_FILE" ]] && . "$ENV_FILE"; set +a; nohup node dist/index.js >/dev/null 2>&1 & )
  fi
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    healthy && break
    sleep 1
  done
  if healthy; then ok "Bridge is up on http://127.0.0.1:${PORT}"
  else err "Bridge did not come up on 127.0.0.1:${PORT} — see: journalctl --user -u agentvoice -n 30, or run: node dist/index.js"; fi
fi

section "Setup complete"
echo -e "  Open   ${BLD}http://127.0.0.1:${PORT}${NC} on this machine (pairing token: node bin/agentvoice.mjs token)"
echo -e "  Verify ${BLD}bash scripts/doctor.sh${NC}   Expose later: ${BLD}bash scripts/hosting-setup.sh${NC}"
echo ""
