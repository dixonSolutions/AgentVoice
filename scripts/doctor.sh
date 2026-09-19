#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# AgentVoice — doctor (Linux)
#
# Standalone health check of an install: pure bash, no build needed, changes
# nothing. Prints green/yellow/red per check and exits 1 if anything is red.
#
# Checks:
#   toolchain   node >= 20, npm
#   install     node_modules, dist/index.js, dist/cli.js, web/dist/
#   vosk        $AGENTVOICE_HOME/vosk/model.tar.gz present, gzip, ~40 MB, and
#               served by the bridge as application/gzip (text/html here is
#               THE classic failure: the PWA hangs at "unpacking")
#   .env        APP_TOKEN present (never printed); provider keys set (names only)
#   config      config.json parses; agentClient CLI on PATH; hosting provider
#   bridge      port listening; /healthz; agentvoice.service active
#   audio       PipeWire default audio source (mic) exists
#   hosting     tailscale serve / agentvoice-caddy.service when configured
#
# Usage: bash scripts/doctor.sh [--quiet]
#
# Environment overrides:
#   AGENTVOICE_CONFIG, AGENTVOICE_ENV_FILE, AGENTVOICE_HOME (see prepare.sh)
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "$PROJECT_DIR"

RED='\033[0;31m'; GRN='\033[0;32m'; YEL='\033[1;33m'; BLU='\033[0;34m'; CYN='\033[0;36m'; BLD='\033[1m'; NC='\033[0m'

FAILURES=0; WARNINGS=0; QUIET=false
pass()    { echo -e "${GRN}✔${NC}  $*"; }
fail()    { echo -e "${RED}✘${NC}  $*"; FAILURES=$((FAILURES + 1)); }
warn()    { echo -e "${YEL}!${NC}  $*"; WARNINGS=$((WARNINGS + 1)); }
info()    { $QUIET || echo -e "${BLU}→${NC}  $*"; }
section() { echo -e "\n${CYN}${BLD}── $* ──${NC}"; }

case "${1:-}" in
  --quiet|-q) QUIET=true;;
  -h|--help) grep '^#' "$0" | grep -v '!/usr/bin' | sed 's/^# \?//'; exit 0;;
  "") ;;
  *) echo "Unknown option: $1" >&2; exit 2;;
esac

CONFIG_FILE="${AGENTVOICE_CONFIG:-${PROJECT_DIR}/config.json}"
ENV_FILE="${AGENTVOICE_ENV_FILE:-${PROJECT_DIR}/.env}"
AV_HOME="${AGENTVOICE_HOME:-${HOME}/.agentvoice}"
VOSK_MODEL="${AV_HOME}/vosk/model.tar.gz"

echo -e "${BLD}AgentVoice — doctor${NC}   ${PROJECT_DIR}"

# ── Helpers ───────────────────────────────────────────────────────────────
env_get() {
  [[ -f "$ENV_FILE" ]] || return 0
  grep -E "^${1}=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- | sed 's/[[:space:]]*#.*$//' | tr -d '"'"'" | tr -d '[:space:]'
}

# cfg_get DOTTED.PATH — value from config.json via python3 or node (whichever exists).
cfg_get() {
  [[ -f "$CONFIG_FILE" ]] || return 0
  if command -v python3 >/dev/null 2>&1; then
    python3 - "$CONFIG_FILE" "$1" <<'PY' 2>/dev/null || true
import json, sys
try:
    o = json.load(open(sys.argv[1]))
except Exception:
    sys.exit(0)
for k in sys.argv[2].split("."):
    if not isinstance(o, dict) or k not in o:
        sys.exit(0)
    o = o[k]
sys.stdout.write(o if isinstance(o, str) else json.dumps(o))
PY
  elif command -v node >/dev/null 2>&1; then
    node -e '
      const fs = require("fs"); const [file, path] = process.argv.slice(1);
      let o; try { o = JSON.parse(fs.readFileSync(file, "utf8")); } catch { process.exit(0); }
      for (const k of path.split(".")) { if (o == null || typeof o !== "object") { o = undefined; break; } o = o[k]; }
      if (o === undefined) process.exit(0);
      process.stdout.write(typeof o === "string" ? o : JSON.stringify(o));
    ' "$CONFIG_FILE" "$1" 2>/dev/null || true
  fi
}

json_valid() {
  if command -v python3 >/dev/null 2>&1; then python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$1" 2>/dev/null
  elif command -v node >/dev/null 2>&1; then node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$1" 2>/dev/null
  else grep -q '{' "$1"; fi
}

file_size() { stat -c %s "$1" 2>/dev/null || stat -f %z "$1" 2>/dev/null || echo 0; }
http_code() { curl -sk -o /dev/null --max-time "${2:-6}" -w '%{http_code}' "$1" 2>/dev/null || echo 000; }

# ── 1. Toolchain ──────────────────────────────────────────────────────────
section "Toolchain"
if command -v node >/dev/null 2>&1; then
  NODE_V="$(node --version)"; NODE_MAJOR="${NODE_V#v}"; NODE_MAJOR="${NODE_MAJOR%%.*}"
  if [[ "$NODE_MAJOR" -ge 20 ]]; then pass "node ${NODE_V} ($(command -v node))"
  else fail "node ${NODE_V} is too old — >= 20 required"; fi
else
  fail "node not found on PATH"
fi
if command -v npm >/dev/null 2>&1; then pass "npm $(npm --version 2>/dev/null)"; else fail "npm not found on PATH"; fi
command -v curl >/dev/null 2>&1 || fail "curl not found — network checks below will fail"

# ── 2. Install / build ────────────────────────────────────────────────────
section "Install & build"
if [[ -d node_modules ]] && [[ "$(find node_modules -maxdepth 1 -mindepth 1 2>/dev/null | head -50 | wc -l)" -ge 20 ]]; then
  pass "node_modules populated"
else
  fail "node_modules missing or empty — run: npm install --legacy-peer-deps"
fi
if [[ -f dist/index.js ]]; then pass "dist/index.js ($(date -r dist/index.js '+%Y-%m-%d %H:%M' 2>/dev/null))"
else fail "dist/index.js missing — run: npm run build"; fi
if [[ -f dist/cli.js ]]; then pass "dist/cli.js (agentvoice CLI)"
else warn "dist/cli.js missing — 'node bin/agentvoice.mjs' will not work until: npm run build"; fi
if [[ -f web/dist/index.html ]]; then pass "web/dist/ (PWA) built"
else fail "web/dist/index.html missing — run: npm run build"; fi
if [[ -f dist/index.js ]]; then
  NEWER="$(find src web/src -type f \( -name '*.ts' -o -name '*.html' -o -name '*.scss' \) -newer dist/index.js 2>/dev/null | head -1 || true)"
  [[ -z "$NEWER" ]] || warn "sources newer than dist/index.js (e.g. ${NEWER}) — rebuild: npm run build"
fi

# ── 3. .env ───────────────────────────────────────────────────────────────
section "Environment (${ENV_FILE})"
PORT=5089
if [[ -f "$ENV_FILE" ]]; then
  pass ".env present"
  PERMS="$(stat -c %a "$ENV_FILE" 2>/dev/null || echo '?')"
  [[ "$PERMS" == "600" || "$PERMS" == "400" ]] && pass ".env permissions ${PERMS}" || warn ".env permissions are ${PERMS} — run: chmod 600 ${ENV_FILE}"
  TOKEN="$(env_get APP_TOKEN)"
  if [[ -n "$TOKEN" ]]; then
    [[ ${#TOKEN} -ge 16 ]] && pass "APP_TOKEN set (${#TOKEN} chars)" || warn "APP_TOKEN is short (${#TOKEN} chars) — regenerate: openssl rand -base64 32"
  else
    fail "APP_TOKEN missing/empty in .env — run: bash scripts/prepare.sh"
  fi
  unset TOKEN
  ENV_PORT="$(env_get PORT)"; [[ -n "$ENV_PORT" ]] && PORT="$ENV_PORT"
  SET_KEYS=""; UNSET_KEYS=""
  for k in OPENAI_API_KEY ANTHROPIC_API_KEY GEMINI_API_KEY GROQ_API_KEY AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_REGION DEEPGRAM_API_KEY ELEVENLABS_API_KEY OPENROUTER_API_KEY; do
    if [[ -n "$(env_get "$k")" ]]; then SET_KEYS="${SET_KEYS}${k} "; else UNSET_KEYS="${UNSET_KEYS}${k} "; fi
  done
  if [[ -n "$SET_KEYS" ]]; then pass "provider keys set: ${SET_KEYS}"; else warn "no provider keys set (browser speech still works; cloud STT/TTS/LLM needs a key)"; fi
  info "unset: ${UNSET_KEYS:-none}"
else
  fail ".env not found — run: bash scripts/prepare.sh"
fi

# ── 4. config.json ────────────────────────────────────────────────────────
section "Config (${CONFIG_FILE})"
AGENT_CLIENT=""; HOSTING=""; RUN_MODE=""; PUBLIC_URL=""
if [[ ! -f "$CONFIG_FILE" ]]; then
  fail "config.json not found — run: bash scripts/prepare.sh"
elif ! json_valid "$CONFIG_FILE"; then
  fail "config.json is not valid JSON"
else
  pass "config.json parses"
  AGENT_CLIENT="$(cfg_get settings.agentClient)"; AGENT_CLIENT="${AGENT_CLIENT:-cursor}"
  case "$AGENT_CLIENT" in
    claude-code) AGENT_BIN=claude;;
    codex)       AGENT_BIN=codex;;
    cursor)      AGENT_BIN=cursor-agent;;
    codewhale)   AGENT_BIN=codewhale;;
    *)           AGENT_BIN="";;
  esac
  if [[ -z "$AGENT_BIN" ]]; then
    fail "settings.agentClient='${AGENT_CLIENT}' is not one of cursor|codex|claude-code|codewhale"
  elif command -v "$AGENT_BIN" >/dev/null 2>&1; then
    pass "agentClient=${AGENT_CLIENT} → ${AGENT_BIN} at $(command -v "$AGENT_BIN")"
  else
    fail "agentClient=${AGENT_CLIENT} but '${AGENT_BIN}' is not on PATH (the systemd unit gets a minimal PATH — see install-systemd.sh)"
  fi
  PERM="$(cfg_get "settings.permissionModes.${AGENT_CLIENT}")"
  [[ -n "$PERM" ]] && info "permissionModes.${AGENT_CLIENT}=${PERM}" || info "permissionModes.${AGENT_CLIENT} unset — provider default applies"
  HOT="$(cfg_get settings.projectDiscovery.hotPaths)"
  if [[ -n "$HOT" && "$HOT" != "[]" ]]; then pass "projectDiscovery.hotPaths=${HOT}"; else warn "projectDiscovery.hotPaths empty — no projects will be discovered"; fi
  RUN_MODE="$(cfg_get settings.runMode)"; RUN_MODE="${RUN_MODE:-test}"
  CFG_PORT="$(cfg_get "settings.runModes.${RUN_MODE}.backendPort")"
  info "runMode=${RUN_MODE} backendPort=${CFG_PORT:-default}"
  if [[ -n "$CFG_PORT" && -n "${ENV_PORT:-}" && "$CFG_PORT" != "$ENV_PORT" ]]; then
    warn "PORT=${ENV_PORT} in .env but runModes.${RUN_MODE}.backendPort=${CFG_PORT} in config.json — checks below use PORT=${ENV_PORT}"
  fi
  HOSTING="$(cfg_get settings.hosting.provider)"
  PUBLIC_URL="$(cfg_get settings.runModes.serve.publicBaseUrl)"
  if [[ -z "$HOSTING" ]]; then
    case "$PUBLIC_URL" in *.ts.net*) HOSTING=tailscale;; *) HOSTING=manual;; esac
    info "hosting.provider unset — auto-detected as '${HOSTING}'"
  else
    info "hosting.provider=${HOSTING}"
  fi
  [[ -n "$PUBLIC_URL" ]] && info "publicBaseUrl=${PUBLIC_URL}"
fi

# ── 5. Bridge ─────────────────────────────────────────────────────────────
section "Bridge (127.0.0.1:${PORT})"
BRIDGE_UP=false
if command -v ss >/dev/null 2>&1; then
  if ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${PORT}\$"; then pass "port ${PORT} is listening"
  else fail "nothing is listening on port ${PORT}"; fi
elif command -v lsof >/dev/null 2>&1; then
  lsof -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 && pass "port ${PORT} is listening" || fail "nothing is listening on port ${PORT}"
fi
HEALTH="$(curl -sf --max-time 6 "http://127.0.0.1:${PORT}/healthz" 2>/dev/null || true)"
if [[ -n "$HEALTH" ]]; then
  BRIDGE_UP=true
  pass "/healthz responds"
  info "$(echo "$HEALTH" | tr -d '\n' | cut -c1-200)"
else
  fail "/healthz not responding on http://127.0.0.1:${PORT} — journalctl --user -u agentvoice -n 30"
fi
if command -v systemctl >/dev/null 2>&1; then
  if systemctl --user is-active --quiet agentvoice.service 2>/dev/null; then
    pass "agentvoice.service active"
    systemctl --user is-enabled --quiet agentvoice.service 2>/dev/null && pass "agentvoice.service enabled" || warn "agentvoice.service not enabled — systemctl --user enable agentvoice"
  elif systemctl --user cat agentvoice.service >/dev/null 2>&1; then
    if $BRIDGE_UP; then warn "agentvoice.service installed but inactive (bridge is running some other way)"
    else fail "agentvoice.service inactive — systemctl --user start agentvoice"; fi
  else
    if $BRIDGE_UP; then warn "no agentvoice.service unit (bridge running manually) — bash scripts/install-systemd.sh for persistence"
    else fail "no agentvoice.service unit and no bridge — bash scripts/install-systemd.sh"; fi
  fi
  if command -v loginctl >/dev/null 2>&1; then
    loginctl show-user "${USER:-$(id -un)}" -p Linger 2>/dev/null | grep -q 'Linger=yes' && pass "linger enabled (service survives logout)" || warn "linger off — service stops at logout: loginctl enable-linger ${USER:-$(id -un)}"
  fi
fi

# ── 6. Vosk wake-word model ───────────────────────────────────────────────
section "Vosk wake-word model"
MIN_MODEL_BYTES=$((10 * 1024 * 1024))
if [[ -f "$VOSK_MODEL" ]]; then
  SIZE="$(file_size "$VOSK_MODEL")"
  MAGIC="$(head -c 2 "$VOSK_MODEL" 2>/dev/null | od -An -tx1 | tr -d ' \n' || true)"
  if [[ "$SIZE" -ge "$MIN_MODEL_BYTES" && "$MAGIC" == "1f8b" ]]; then
    pass "model present: ${VOSK_MODEL} ($((SIZE / 1024 / 1024)) MB, gzip)"
  else
    fail "model file is bad ($((SIZE / 1024 / 1024)) MB, header ${MAGIC:-none}) — node bin/agentvoice.mjs prepare-vosk --force, then copy to ${AV_HOME}/vosk/"
  fi
else
  fail "model missing: ${VOSK_MODEL} — the bridge serves /vosk/ ONLY from ${AV_HOME}/vosk. Fix: bash scripts/prepare.sh (or prepare-vosk + cp web/public/vosk/model.tar.gz ${AV_HOME}/vosk/)"
  for alt in web/public/vosk/model.tar.gz web/dist/vosk/model.tar.gz; do
    [[ -f "$alt" ]] && info "a copy exists at ${alt} — cp it to ${AV_HOME}/vosk/"
  done
fi
if $BRIDGE_UP; then
  CT="$(curl -s --max-time 20 -o /dev/null -w '%{http_code} %{content_type}' "http://127.0.0.1:${PORT}/vosk/model.tar.gz" 2>/dev/null || echo '000 none')"
  CODE="${CT%% *}"; TYPE="${CT#* }"
  case "$TYPE" in
    application/gzip*|application/x-gzip*|application/octet-stream*)
      pass "bridge serves /vosk/model.tar.gz as ${TYPE} (HTTP ${CODE})";;
    text/html*)
      fail "bridge serves /vosk/model.tar.gz as ${TYPE} — that is index.html (SPA fallback), the PWA will hang at 'unpacking'. Put the model in ${AV_HOME}/vosk/ and restart: systemctl --user restart agentvoice";;
    *)
      fail "bridge serves /vosk/model.tar.gz as '${TYPE}' (HTTP ${CODE}) — expected application/gzip";;
  esac
else
  warn "bridge down — cannot verify /vosk/model.tar.gz content-type"
fi

# ── 7. Audio (PipeWire default source = microphone) ───────────────────────
section "Audio input"
if command -v wpctl >/dev/null 2>&1; then
  if VOL="$(wpctl get-volume @DEFAULT_AUDIO_SOURCE@ 2>&1)" && [[ "$VOL" == Volume:* ]]; then
    pass "PipeWire default audio source present (${VOL})"
    echo "$VOL" | grep -q MUTED && warn "default source is MUTED — unmute: wpctl set-mute @DEFAULT_AUDIO_SOURCE@ 0"
  else
    # First "Sources:" block only (the Audio one; Video comes later in wpctl status).
    SRC_LINES="$(wpctl status 2>/dev/null | awk '/Sources:/ { if (seen) exit; seen = 1; next } seen && /^[[:space:]│|]*$/ { exit } seen' \
      | grep -E '[0-9]+\.' | sed 's/^[[:space:]│|*]*//' || true)"
    SRC_COUNT="$(printf '%s\n' "$SRC_LINES" | grep -c . || true)"
    if [[ "${SRC_COUNT:-0}" -gt 0 ]]; then
      warn "no DEFAULT audio source, but ${SRC_COUNT} source(s) exist — pick one: wpctl set-default <id>"
      printf '%s\n' "$SRC_LINES" | sed 's/^/     /'
    else
      warn "no microphone / audio source on this host (wpctl: ${VOL:-no default}) — browsers on this machine will get getUserMedia 'device not found'; remote clients use their own mic"
    fi
  fi
elif command -v pactl >/dev/null 2>&1; then
  DEF_SRC="$(pactl get-default-source 2>/dev/null || true)"
  [[ -n "$DEF_SRC" ]] && pass "PulseAudio default source: ${DEF_SRC}" || warn "no default audio source (pactl)"
else
  warn "wpctl/pactl not found — cannot check for a microphone"
fi

# ── 8. Hosting ────────────────────────────────────────────────────────────
section "Hosting (${HOSTING:-unknown})"
TS_HOST=""
if command -v tailscale >/dev/null 2>&1 && tailscale status >/dev/null 2>&1; then
  TS_HOST="$(tailscale status --json 2>/dev/null | { python3 -c "import sys,json; print(json.load(sys.stdin).get('Self',{}).get('DNSName','').rstrip('.'))" 2>/dev/null || node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log((JSON.parse(s).Self||{}).DNSName.replace(/\.$/,""))}catch{}})' 2>/dev/null || true; })"
fi

if [[ "$HOSTING" == "tailscale" ]]; then
  if ! command -v tailscale >/dev/null 2>&1; then
    fail "hosting=tailscale but tailscale CLI not found"
  elif ! tailscale status >/dev/null 2>&1; then
    fail "Tailscale not connected — sudo tailscale up"
  else
    pass "Tailscale connected ($(tailscale ip -4 2>/dev/null | head -1)) host=${TS_HOST:-?}"
    SERVE="$(tailscale serve status 2>&1 || true)"
    if echo "$SERVE" | grep -q "127.0.0.1:${PORT}"; then
      pass "tailscale serve → http://127.0.0.1:${PORT}"
    elif echo "$SERVE" | grep -qi 'no serve config'; then
      fail "tailscale serve not configured — bash scripts/hosting-setup.sh --provider=tailscale"
    elif echo "$SERVE" | grep -qiE 'access denied|operator'; then
      fail "tailscale serve status: access denied — sudo tailscale set --operator=${USER:-$(id -un)}"
    else
      fail "tailscale serve does not proxy 127.0.0.1:${PORT}: $(echo "$SERVE" | head -2 | tr '\n' ' ')"
    fi
    if [[ -n "$PUBLIC_URL" && "$PUBLIC_URL" != "https://${TS_HOST}" ]]; then
      warn "publicBaseUrl=${PUBLIC_URL} differs from tailscale host https://${TS_HOST}"
    fi
    if [[ -n "$TS_HOST" ]]; then
      CODE="$(http_code "https://${TS_HOST}/healthz" 8)"
      [[ "$CODE" == "200" ]] && pass "https://${TS_HOST}/healthz → 200" || fail "https://${TS_HOST}/healthz → ${CODE} (MagicDNS / HTTPS certs: https://login.tailscale.com/admin/dns)"
    fi
  fi
elif [[ "$HOSTING" == "manual" ]]; then
  if systemctl --user cat agentvoice-caddy.service >/dev/null 2>&1; then
    if systemctl --user is-active --quiet agentvoice-caddy.service; then
      pass "agentvoice-caddy.service active"
      CADDY_PORT="$(grep -oE '^:[0-9]+' "${HOME}/.config/agentvoice-tls/Caddyfile" 2>/dev/null | head -1 | tr -d ':' || true)"
      CADDY_PORT="${CADDY_PORT:-8443}"
      CODE="$(http_code "https://127.0.0.1:${CADDY_PORT}/healthz" 8)"
      [[ "$CODE" == "200" ]] && pass "https://127.0.0.1:${CADDY_PORT}/healthz → 200 (via caddy)" || fail "caddy front https://127.0.0.1:${CADDY_PORT}/healthz → ${CODE}"
    else
      warn "agentvoice-caddy.service installed but inactive — systemctl --user start agentvoice-caddy"
    fi
  else
    info "hosting=manual, no caddy unit — you are responsible for exposing 127.0.0.1:${PORT} over HTTPS"
    [[ -n "$PUBLIC_URL" ]] && { CODE="$(http_code "${PUBLIC_URL}/healthz" 8)"; [[ "$CODE" == "200" ]] && pass "${PUBLIC_URL}/healthz → 200" || warn "${PUBLIC_URL}/healthz → ${CODE}"; }
  fi
elif [[ "$HOSTING" == "lan" ]]; then
  LAN_IP="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}' || true)"
  info "hosting=lan — LAN address ${LAN_IP:-unknown}; mic access needs HTTPS or a localhost origin"
elif [[ "$HOSTING" == "local" ]]; then
  info "hosting=local — bridge is loopback only (http://127.0.0.1:${PORT})"
  if command -v tailscale >/dev/null 2>&1 && tailscale serve status 2>/dev/null | grep -q "127.0.0.1:${PORT}"; then
    warn "tailscale serve still proxies :${PORT} although hosting=local — tailscale serve reset"
  fi
fi

# Stray helpers that are configured but not selected.
if [[ "$HOSTING" != "manual" ]] && systemctl --user is-active --quiet agentvoice-caddy.service 2>/dev/null; then
  info "agentvoice-caddy.service is active too (hosting=${HOSTING})"
fi
if [[ "$HOSTING" != "tailscale" && -n "$TS_HOST" ]] && tailscale serve status 2>/dev/null | grep -q "127.0.0.1:${PORT}"; then
  info "tailscale serve also proxies :${PORT} (hosting=${HOSTING}) at https://${TS_HOST}"
fi

# ── Summary ───────────────────────────────────────────────────────────────
echo ""
if [[ "$FAILURES" -eq 0 && "$WARNINGS" -eq 0 ]]; then
  echo -e "${GRN}${BLD}All checks passed.${NC}"
elif [[ "$FAILURES" -eq 0 ]]; then
  echo -e "${GRN}${BLD}No failures${NC} — ${YEL}${WARNINGS} warning(s)${NC} above."
else
  echo -e "${RED}${BLD}${FAILURES} check(s) failed${NC}, ${WARNINGS} warning(s). Fix the ✘ items, then re-run: bash scripts/doctor.sh"
fi
echo ""
[[ "$FAILURES" -eq 0 ]]
