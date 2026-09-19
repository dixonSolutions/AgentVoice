#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# AgentVoice — prepare the solution end to end (Linux / macOS)
#
# What this script does:
#   1. Checks prerequisites (Node >= 20, npm, openssl or node for token gen)
#   2. Installs npm dependencies   (npm install --legacy-peer-deps — plain
#      `npm install` fails on an optimus-ui / @angular/cdk peer conflict)
#   3. Builds backend + PWA        (npm run build)
#   4. Prepares the Vosk wake-word model and copies it into
#      $AGENTVOICE_HOME/vosk/ — the production bridge serves /vosk/ ONLY from
#      there (src/webDispatch.ts registerUserVoskDir); `prepare-vosk` in a
#      clone writes to web/public/vosk, which a packaged bridge never serves.
#      Without the copy /vosk/model.tar.gz returns index.html (text/html) and
#      the PWA hangs at "unpacking".
#   5. Creates/updates .env        (APP_TOKEN, optional provider keys)
#   6. Creates/updates config.json (agentClient, permissionModes, hotPaths)
#
# Usage:
#   bash scripts/prepare.sh [options]
#
# Options:
#   -y, --yes, --non-interactive   No prompts; keep existing values / defaults
#   --skip-install                 Do not run npm install
#   --skip-build                   Do not run npm run build
#   --skip-vosk                    Do not prepare the wake-word model
#   --rebuild                      Force npm install + npm run build even when
#                                  build artifacts already exist
#   --port PORT                    Bridge port written to a NEW .env (default 5089)
#   --interactive                  Prompt even when stdin is not a terminal
#   -h, --help                     This screen
#
# Environment overrides (useful for testing against a scratch copy):
#   AGENTVOICE_CONFIG     path to config.json        (default ./config.json)
#   AGENTVOICE_ENV_FILE   path to .env               (default ./.env)
#   AGENTVOICE_HOME       user data dir for vosk/    (default ~/.agentvoice)
#
# Re-running is safe — existing .env values and config.json settings are
# preserved; finished steps are detected and skipped.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "$PROJECT_DIR"

# ── Colours ───────────────────────────────────────────────────────────────
GRN='\033[0;32m'; YEL='\033[1;33m'; BLU='\033[0;34m'; CYN='\033[0;36m'; RED='\033[0;31m'; BLD='\033[1m'; NC='\033[0m'
info()    { echo -e "${BLU}[info]${NC}  $*"; }
ok()      { echo -e "${GRN}[ok]${NC}    $*"; }
warn()    { echo -e "${YEL}[warn]${NC}  $*" >&2; }
err()     { echo -e "${RED}[err]${NC}   $*" >&2; exit 1; }
section() { echo -e "\n${CYN}${BLD}── $* ──${NC}"; }

# ── Args ──────────────────────────────────────────────────────────────────
INTERACTIVE=true
FORCE_INTERACTIVE=false   # --interactive: prompt even when stdin is not a tty (piped answers)
SKIP_INSTALL=false
SKIP_BUILD=false
SKIP_VOSK=false
FORCE_REBUILD=false
DEFAULT_PORT=5089

while [[ $# -gt 0 ]]; do
  case "$1" in
    -y|--yes|--non-interactive) INTERACTIVE=false; shift;;
    --interactive) FORCE_INTERACTIVE=true; shift;;
    --skip-install) SKIP_INSTALL=true; shift;;
    --skip-build)   SKIP_BUILD=true; shift;;
    --skip-vosk)    SKIP_VOSK=true; shift;;
    --rebuild)      FORCE_REBUILD=true; shift;;
    --port)         [[ $# -ge 2 ]] || err "--port needs a value"; DEFAULT_PORT="$2"; shift 2;;
    --port=*)       DEFAULT_PORT="${1#*=}"; shift;;
    -h|--help)
      grep '^#' "$0" | grep -v '!/usr/bin' | sed 's/^# \?//'
      exit 0;;
    *) err "Unknown option: $1 (see --help)";;
  esac
done

# A non-tty stdin cannot answer prompts — fall back to defaults instead of hanging.
if $INTERACTIVE && ! $FORCE_INTERACTIVE && [[ ! -t 0 ]]; then
  warn "stdin is not a terminal — running non-interactively."
  INTERACTIVE=false
fi

# ── Paths (env overrides for testability) ─────────────────────────────────
CONFIG_FILE="${AGENTVOICE_CONFIG:-${PROJECT_DIR}/config.json}"
ENV_FILE="${AGENTVOICE_ENV_FILE:-${PROJECT_DIR}/.env}"
AV_HOME="${AGENTVOICE_HOME:-${HOME}/.agentvoice}"
VOSK_DIR="${AV_HOME}/vosk"
EXAMPLE_CONFIG="${PROJECT_DIR}/config.example.json"

info "Project: ${BLD}${PROJECT_DIR}${NC}"
info "config:  ${CONFIG_FILE}"
info ".env:    ${ENV_FILE}"
info "home:    ${AV_HOME}"

# ── Helpers ───────────────────────────────────────────────────────────────

# ask VAR "Prompt" "default"  — read a line; non-interactive uses the default.
ask() {
  local __var="$1" __prompt="$2" __default="${3:-}" __answer=""
  if $INTERACTIVE; then
    if [[ -n "$__default" ]]; then
      read -r -p "$(echo -e "${BLD}${__prompt}${NC} [${__default}]: ")" __answer || true
    else
      read -r -p "$(echo -e "${BLD}${__prompt}${NC}: ")" __answer || true
    fi
  fi
  [[ -n "$__answer" ]] || __answer="$__default"
  printf -v "$__var" '%s' "$__answer"
}

# ask_secret VAR "Prompt" — read without echo; value is never printed.
ask_secret() {
  local __var="$1" __prompt="$2" __answer=""
  if $INTERACTIVE; then
    read -r -s -p "$(echo -e "${BLD}${__prompt}${NC} (input hidden, blank = skip): ")" __answer || true
    echo ""
  fi
  printf -v "$__var" '%s' "$__answer"
}

# choose VAR "Prompt" default_index item1 item2 ...  — numbered menu.
choose() {
  local __var="$1" __prompt="$2" __default_idx="$3"; shift 3
  local __items=("$@") __i __pick=""
  if $INTERACTIVE; then
    echo -e "${BLD}${__prompt}${NC}"
    for __i in "${!__items[@]}"; do
      printf '  %d) %s\n' "$((__i + 1))" "${__items[$__i]}"
    done
    while :; do
      read -r -p "Choice [${__default_idx}]: " __pick || true
      [[ -n "$__pick" ]] || __pick="$__default_idx"
      if [[ "$__pick" =~ ^[0-9]+$ ]] && (( __pick >= 1 && __pick <= ${#__items[@]} )); then
        break
      fi
      echo "  Enter a number between 1 and ${#__items[@]}."
    done
  else
    __pick="$__default_idx"
  fi
  printf -v "$__var" '%s' "${__items[$((__pick - 1))]}"
}

# env_get KEY  — value of KEY in ENV_FILE (empty if unset).
env_get() {
  [[ -f "$ENV_FILE" ]] || return 0
  grep -E "^${1}=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- | sed 's/[[:space:]]*#.*$//' | tr -d '"'"'" | tr -d '[:space:]'
}

# env_set KEY VALUE — replace or append KEY in ENV_FILE. Value is never printed.
env_set() {
  local key="$1" value="$2" tmp
  tmp="$(mktemp "${ENV_FILE}.XXXXXX")"
  if [[ -f "$ENV_FILE" ]] && grep -qE "^#?[[:space:]]*${key}=" "$ENV_FILE"; then
    # Replace the first (possibly commented-out) occurrence; drop any other duplicates.
    # ENVIRON, not -v: awk would interpret backslash escapes in a -v value.
    AV_ENV_VALUE="$value" awk -v k="$key" '
      BEGIN { done = 0; v = ENVIRON["AV_ENV_VALUE"] }
      $0 ~ "^#?[[:space:]]*" k "=" {
        if (!done) { print k "=" v; done = 1 }
        next
      }
      { print }
    ' "$ENV_FILE" > "$tmp"
  else
    [[ -f "$ENV_FILE" ]] && cat "$ENV_FILE" > "$tmp"
    printf '%s=%s\n' "$key" "$value" >> "$tmp"
  fi
  mv "$tmp" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
}

# cfg_get DOTTED.PATH — print a JSON-encoded value (or nothing) from CONFIG_FILE.
cfg_get() {
  node -e '
    const fs = require("fs");
    const [file, path] = process.argv.slice(1);
    let o; try { o = JSON.parse(fs.readFileSync(file, "utf8")); } catch { process.exit(0); }
    for (const k of path.split(".")) { if (o == null || typeof o !== "object") { o = undefined; break; } o = o[k]; }
    if (o === undefined) process.exit(0);
    process.stdout.write(typeof o === "string" ? o : JSON.stringify(o));
  ' "$CONFIG_FILE" "$1"
}

# cfg_set DOTTED.PATH JSON_VALUE — set a value (JSON literal) in CONFIG_FILE.
cfg_set() {
  node -e '
    const fs = require("fs");
    const [file, path, raw] = process.argv.slice(1);
    const o = JSON.parse(fs.readFileSync(file, "utf8"));
    const keys = path.split(".");
    let c = o;
    for (const k of keys.slice(0, -1)) {
      if (c[k] == null || typeof c[k] !== "object") c[k] = {};
      c = c[k];
    }
    c[keys[keys.length - 1]] = JSON.parse(raw);
    fs.writeFileSync(file, JSON.stringify(o, null, 2) + "\n");
  ' "$CONFIG_FILE" "$1" "$2"
}

# json_string STR — JSON-encode a shell string.
json_string() { node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$1"; }

file_size() { stat -c %s "$1" 2>/dev/null || stat -f %z "$1" 2>/dev/null || echo 0; }

# ── 1. Prerequisites ──────────────────────────────────────────────────────
section "Prerequisites"

command -v node >/dev/null 2>&1 || err "node not found on PATH — install Node.js >= 20 (https://nodejs.org)"
NODE_MAJOR="$(node --version | tr -d 'v' | cut -d. -f1)"
[[ "$NODE_MAJOR" -ge 20 ]] || err "Node.js >= 20 required (found $(node --version))"
ok "node $(node --version)"

command -v npm >/dev/null 2>&1 || err "npm not found on PATH"
ok "npm $(npm --version)"

if command -v openssl >/dev/null 2>&1; then ok "openssl $(openssl version | awk '{print $2}')"
else warn "openssl not found — APP_TOKEN will be generated with node instead."; fi

# ── 2. Dependencies ───────────────────────────────────────────────────────
section "npm dependencies"

if $SKIP_INSTALL; then
  warn "Skipping npm install (--skip-install)."
elif ! $FORCE_REBUILD && [[ -d node_modules && -f node_modules/.package-lock.json ]] \
     && [[ ! package.json -nt node_modules/.package-lock.json ]] \
     && [[ ! package-lock.json -nt node_modules/.package-lock.json ]]; then
  ok "node_modules up to date — skipping npm install (use --rebuild to force)."
else
  info "Running npm install --legacy-peer-deps (plain npm install fails on a peer conflict)..."
  npm install --no-audit --no-fund --legacy-peer-deps
  ok "Dependencies installed."
fi

# ── 3. Build ──────────────────────────────────────────────────────────────
section "Build"

if $SKIP_BUILD; then
  warn "Skipping build (--skip-build)."
elif ! $FORCE_REBUILD && [[ -f dist/index.js && -f dist/cli.js && -f web/dist/index.html ]]; then
  ok "Build artifacts present (dist/index.js, dist/cli.js, web/dist/) — skipping build."
  NEWER="$(find src web/src -type f \( -name '*.ts' -o -name '*.html' -o -name '*.scss' -o -name '*.css' \) -newer dist/index.js 2>/dev/null | head -1 || true)"
  if [[ -n "$NEWER" ]]; then
    warn "Sources newer than dist/index.js (e.g. ${NEWER}) — run with --rebuild to pick them up."
  fi
else
  info "Running npm run build (backend + PWA)..."
  npm run build
  ok "Build complete → dist/index.js + web/dist/"
fi

# ── 4. Vosk wake-word model ───────────────────────────────────────────────
section "Vosk wake-word model"

MIN_MODEL_BYTES=$((10 * 1024 * 1024))
USER_MODEL="${VOSK_DIR}/model.tar.gz"

if $SKIP_VOSK; then
  warn "Skipping wake-word model (--skip-vosk)."
else
  if [[ -f "$USER_MODEL" ]] && [[ "$(file_size "$USER_MODEL")" -ge "$MIN_MODEL_BYTES" ]]; then
    ok "Model already in place: ${USER_MODEL} ($(( $(file_size "$USER_MODEL") / 1024 / 1024 )) MB)"
  else
    # Look for a copy prepare-vosk already produced in the clone.
    SRC_MODEL=""
    for cand in web/public/vosk/model.tar.gz web/dist/vosk/model.tar.gz; do
      if [[ -f "$cand" ]] && [[ "$(file_size "$cand")" -ge "$MIN_MODEL_BYTES" ]]; then SRC_MODEL="$cand"; break; fi
    done

    if [[ -z "$SRC_MODEL" ]]; then
      [[ -f dist/cli.js ]] || err "dist/cli.js missing — cannot run prepare-vosk (build first, or drop --skip-build)."
      info "Downloading the model (~41 MB) via: node bin/agentvoice.mjs prepare-vosk"
      # The CLI honours AGENTVOICE_HOME itself for packaged installs; in a clone
      # it writes web/public/vosk, which is why we copy below.
      AGENTVOICE_HOME="$AV_HOME" node bin/agentvoice.mjs prepare-vosk
      for cand in web/public/vosk/model.tar.gz web/dist/vosk/model.tar.gz "$USER_MODEL"; do
        if [[ -f "$cand" ]] && [[ "$(file_size "$cand")" -ge "$MIN_MODEL_BYTES" ]]; then SRC_MODEL="$cand"; break; fi
      done
      [[ -n "$SRC_MODEL" ]] || err "prepare-vosk finished but no model.tar.gz was found."
    fi

    if [[ "$SRC_MODEL" != "$USER_MODEL" ]]; then
      mkdir -p "$VOSK_DIR"
      info "Copying ${SRC_MODEL} → ${USER_MODEL} (the bridge serves /vosk/ from here)"
      cp -f "$SRC_MODEL" "${USER_MODEL}.tmp"
      mv -f "${USER_MODEL}.tmp" "$USER_MODEL"
    fi
    ok "Model installed: ${USER_MODEL} ($(( $(file_size "$USER_MODEL") / 1024 / 1024 )) MB)"
  fi

  # Sanity: a gzip file starts with 1f 8b.
  MAGIC="$(head -c 2 "$USER_MODEL" 2>/dev/null | od -An -tx1 | tr -d ' \n' || true)"
  if [[ "$MAGIC" == "1f8b" ]]; then
    ok "model.tar.gz has a gzip header."
  else
    warn "model.tar.gz does not look like gzip (header ${MAGIC:-none}) — re-run with: node bin/agentvoice.mjs prepare-vosk --force"
  fi

  # If a bridge is up, verify it actually serves the model as application/gzip.
  LIVE_PORT="$(env_get PORT)"; LIVE_PORT="${LIVE_PORT:-$DEFAULT_PORT}"
  if curl -sf --max-time 3 "http://127.0.0.1:${LIVE_PORT}/healthz" >/dev/null 2>&1; then
    CT="$(curl -s --max-time 20 -o /dev/null -w '%{content_type}' "http://127.0.0.1:${LIVE_PORT}/vosk/model.tar.gz" 2>/dev/null || true)"
    case "$CT" in
      application/gzip*|application/x-gzip*|application/octet-stream*)
        ok "Bridge on :${LIVE_PORT} serves /vosk/model.tar.gz as ${CT}";;
      *)
        warn "Bridge on :${LIVE_PORT} serves /vosk/model.tar.gz as '${CT:-no response}' (expected application/gzip)."
        warn "The bridge registers ${VOSK_DIR} at startup — restart it: systemctl --user restart agentvoice";;
    esac
  else
    info "No bridge on 127.0.0.1:${LIVE_PORT} — skipping the served content-type check (doctor.sh checks it later)."
  fi
fi

# ── 5. Environment (.env) ─────────────────────────────────────────────────
section "Environment (.env)"

gen_token() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 32 | tr -d '=+/' | head -c 43
  else
    node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64url'))"
  fi
}

if [[ ! -f "$ENV_FILE" ]]; then
  info "Creating ${ENV_FILE}..."
  mkdir -p "$(dirname "$ENV_FILE")"
  ( umask 077; cat > "$ENV_FILE" <<EOF
# AgentVoice — secrets + machine-specific paths
# chmod 600 this file and never commit it.

APP_TOKEN=

# Bridge port + bootstrap paths
PORT=${DEFAULT_PORT}
CONFIG_PATH=${CONFIG_FILE}
DB_PATH=${PROJECT_DIR}/data/state.db

# Provider keys (set only what you use)
EOF
  )
  chmod 600 "$ENV_FILE"
  ok ".env created."
else
  ok ".env exists — preserving existing values."
  chmod 600 "$ENV_FILE" 2>/dev/null || true
fi

if [[ -z "$(env_get APP_TOKEN)" ]]; then
  env_set APP_TOKEN "$(gen_token)"
  ok "APP_TOKEN generated (view later with: node bin/agentvoice.mjs token)."
else
  ok "APP_TOKEN already set."
fi
[[ -n "$(env_get PORT)" ]] || { env_set PORT "$DEFAULT_PORT"; info "Added PORT=${DEFAULT_PORT}."; }

# Provider keys — names are shown, values never are.
PROVIDER_LABELS=(
  "OpenAI        (OPENAI_API_KEY — Codex CLI, Whisper STT, TTS)"
  "Anthropic     (ANTHROPIC_API_KEY — Claude)"
  "Google Gemini (GEMINI_API_KEY)"
  "Groq          (GROQ_API_KEY — fast Whisper STT / PlayAI TTS)"
  "AWS Bedrock   (AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY + AWS_REGION)"
)
PROVIDER_KEYS=(OPENAI_API_KEY ANTHROPIC_API_KEY GEMINI_API_KEY GROQ_API_KEY AWS_ACCESS_KEY_ID)

echo ""
info "Provider keys currently set (names only):"
for k in OPENAI_API_KEY ANTHROPIC_API_KEY GEMINI_API_KEY GROQ_API_KEY AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_REGION; do
  if [[ -n "$(env_get "$k")" ]]; then echo -e "    ${GRN}set${NC}    $k"; else echo -e "    ${YEL}unset${NC}  $k"; fi
done

if $INTERACTIVE; then
  echo ""
  echo -e "${BLD}Add or update provider keys?${NC} Pick numbers separated by spaces (blank = none):"
  for i in "${!PROVIDER_LABELS[@]}"; do
    state=""
    [[ -n "$(env_get "${PROVIDER_KEYS[$i]}")" ]] && state=" ${GRN}[set]${NC}"
    echo -e "  $((i + 1))) ${PROVIDER_LABELS[$i]}${state}"
  done
  read -r -p "Selection: " SELECTION || true
  for pick in $SELECTION; do
    [[ "$pick" =~ ^[0-9]+$ ]] || { warn "Ignoring '${pick}'"; continue; }
    case "$pick" in
      1|2|3|4)
        key="${PROVIDER_KEYS[$((pick - 1))]}"
        ask_secret val "$key"
        if [[ -n "$val" ]]; then env_set "$key" "$val"; ok "$key saved."; else info "$key skipped."; fi
        ;;
      5)
        ask_secret val "AWS_ACCESS_KEY_ID"
        [[ -n "$val" ]] && { env_set AWS_ACCESS_KEY_ID "$val"; ok "AWS_ACCESS_KEY_ID saved."; }
        ask_secret val "AWS_SECRET_ACCESS_KEY"
        [[ -n "$val" ]] && { env_set AWS_SECRET_ACCESS_KEY "$val"; ok "AWS_SECRET_ACCESS_KEY saved."; }
        ask val "AWS_REGION" "$(env_get AWS_REGION)"
        [[ -n "$val" ]] || val="us-east-1"
        env_set AWS_REGION "$val"; ok "AWS_REGION=${val}"
        ;;
      *) warn "Ignoring '${pick}' (no such option)";;
    esac
    unset val
  done
else
  info "Non-interactive — provider keys left as they are (edit ${ENV_FILE} to add them)."
fi

# ── 6. Config (config.json) ───────────────────────────────────────────────
section "Config (config.json)"

if [[ ! -f "$CONFIG_FILE" ]]; then
  [[ -f "$EXAMPLE_CONFIG" ]] || err "config.example.json not found — cannot create ${CONFIG_FILE}"
  mkdir -p "$(dirname "$CONFIG_FILE")"
  cp "$EXAMPLE_CONFIG" "$CONFIG_FILE"
  ok "config.json created from config.example.json"
else
  node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$CONFIG_FILE" 2>/dev/null \
    || err "${CONFIG_FILE} is not valid JSON — fix or remove it and re-run."
  ok "config.json exists — updating in place."
fi

# Agent CLI detection: config id → binary on PATH.
AGENT_IDS=(claude-code codex cursor codewhale)
AGENT_BINS=(claude codex cursor-agent codewhale)
DETECTED=()
MENU=()
for i in "${!AGENT_IDS[@]}"; do
  if command -v "${AGENT_BINS[$i]}" >/dev/null 2>&1; then
    DETECTED+=("${AGENT_IDS[$i]}")
    MENU+=("${AGENT_IDS[$i]}  (${AGENT_BINS[$i]} found: $(command -v "${AGENT_BINS[$i]}"))")
  else
    MENU+=("${AGENT_IDS[$i]}  (${AGENT_BINS[$i]} NOT on PATH)")
  fi
done

# agent_index ID — 1-based position of ID in AGENT_IDS (0 if unknown).
agent_index() {
  local i
  for i in "${!AGENT_IDS[@]}"; do
    if [[ "${AGENT_IDS[$i]}" == "$1" ]]; then echo $((i + 1)); return; fi
  done
  echo 0
}

CURRENT_CLIENT="$(cfg_get settings.agentClient)"
CURRENT_IDX="$(agent_index "$CURRENT_CLIENT")"
DEFAULT_IDX=1
if [[ "$CURRENT_IDX" -gt 0 ]] && command -v "${AGENT_BINS[$((CURRENT_IDX - 1))]}" >/dev/null 2>&1; then
  DEFAULT_IDX="$CURRENT_IDX"            # configured client is installed — keep it
elif [[ ${#DETECTED[@]} -gt 0 ]]; then
  DEFAULT_IDX="$(agent_index "${DETECTED[0]}")"   # first installed CLI
elif [[ "$CURRENT_IDX" -gt 0 ]]; then
  DEFAULT_IDX="$CURRENT_IDX"            # nothing installed — leave the config alone
fi

if [[ ${#DETECTED[@]} -eq 0 ]]; then
  warn "No agent CLI found on PATH (claude / codex / cursor-agent / codewhale) — install one before starting the bridge."
else
  ok "Agent CLIs detected: ${DETECTED[*]}"
fi

choose AGENT_PICK "Agent client (settings.agentClient)" "$DEFAULT_IDX" "${MENU[@]}"
AGENT_CLIENT="${AGENT_PICK%% *}"
cfg_set settings.agentClient "$(json_string "$AGENT_CLIENT")"
ok "settings.agentClient = ${AGENT_CLIENT}"

# Permission modes per client (ids from src/providers/agents/*.ts).
case "$AGENT_CLIENT" in
  claude-code) MODES=(auto bypass acceptEdits manual dontAsk);;
  codex)       MODES=(workspace approve-for-me full);;
  cursor)      MODES=(auto-review yolo default);;
  codewhale)   MODES=(auto);;
  *)           MODES=(auto);;
esac
CURRENT_MODE="$(cfg_get "settings.permissionModes.${AGENT_CLIENT}")"
MODE_IDX=1
for i in "${!MODES[@]}"; do [[ "${MODES[$i]}" == "$CURRENT_MODE" ]] && MODE_IDX=$((i + 1)); done
choose PERM_MODE "Permission mode for ${AGENT_CLIENT} (settings.permissionModes.${AGENT_CLIENT})" "$MODE_IDX" "${MODES[@]}"
cfg_set "settings.permissionModes.${AGENT_CLIENT}" "$(json_string "$PERM_MODE")"
ok "settings.permissionModes.${AGENT_CLIENT} = ${PERM_MODE}"

# Project discovery hot paths.
CURRENT_HOT="$(cfg_get settings.projectDiscovery.hotPaths)"
DEFAULT_HOT="~/Projects"
if [[ -n "$CURRENT_HOT" && "$CURRENT_HOT" != "[]" ]]; then
  DEFAULT_HOT="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).join(","))' "$CURRENT_HOT")"
fi
ask HOT_INPUT "Project hot paths (comma-separated; parents of your git repos)" "$DEFAULT_HOT"
HOT_JSON="$(node -e '
  const parts = process.argv[1].split(",").map(s => s.trim()).filter(Boolean);
  process.stdout.write(JSON.stringify(parts.length ? parts : ["~/Projects"]));
' "$HOT_INPUT")"
cfg_set settings.projectDiscovery.hotPaths "$HOT_JSON"
cfg_set settings.projectDiscovery.enabled true
ok "settings.projectDiscovery.hotPaths = ${HOT_JSON}"

mkdir -p "${PROJECT_DIR}/data"

# ── Done ──────────────────────────────────────────────────────────────────
section "Prepare complete"
echo -e "  ${GRN}✔${NC} dependencies + build"
if ! $SKIP_VOSK; then echo -e "  ${GRN}✔${NC} wake-word model → ${USER_MODEL}"; fi
KEYS_SET=""
for k in OPENAI_API_KEY ANTHROPIC_API_KEY GEMINI_API_KEY GROQ_API_KEY AWS_ACCESS_KEY_ID; do
  [[ -n "$(env_get "$k")" ]] && KEYS_SET="${KEYS_SET}${k} "
done
echo -e "  ${GRN}✔${NC} ${ENV_FILE} (APP_TOKEN set; provider keys: ${KEYS_SET:-none})"
echo -e "  ${GRN}✔${NC} ${CONFIG_FILE} (agentClient=${AGENT_CLIENT}, mode=${PERM_MODE})"
echo ""
echo -e "  Next: ${BLD}bash scripts/hosting-setup.sh${NC} to expose the bridge, or ${BLD}bash scripts/doctor.sh${NC} to verify."
echo ""
