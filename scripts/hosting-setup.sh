#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# AgentVoice — hosting setup (Linux)
#
# Chooses how the bridge (127.0.0.1:PORT) is exposed and records the choice in
# config.json (settings.hosting.provider, settings.runModes.serve.publicBaseUrl).
#
#   tailscale  tailscale serve --bg PORT  → https://<machine>.<tailnet>.ts.net
#              (needs a one-time `sudo tailscale set --operator=$USER`)
#   caddy      mkcert cert + Caddy TLS terminator on :8443 → 127.0.0.1:PORT,
#              installed as the agentvoice-caddy.service systemd --user unit.
#              Recorded as hosting.provider=manual.
#   lan        hosting.provider=lan (plain LAN access; no TLS is set up here)
#   local      hosting.provider=local — loopback only, nothing exposed
#
# Usage:
#   bash scripts/hosting-setup.sh [options]
#
# Options:
#   --provider <tailscale|caddy|lan|local|none>   Skip the menu
#   --non-interactive, -y     No prompts (needs --provider, else 'local')
#   --port PORT               Bridge port (default: PORT from .env, else 5089)
#   --tls-port PORT           Caddy listen port (default 8443)
#   --no-start                caddy: write cert/Caddyfile/unit but do not start it
#   --interactive             Prompt even when stdin is not a terminal
#   -h, --help                This screen
#
# Environment overrides (for testing against a scratch copy):
#   AGENTVOICE_CONFIG        config.json path      (default ./config.json)
#   AGENTVOICE_ENV_FILE      .env path             (default ./.env)
#   AGENTVOICE_TLS_DIR       cert/Caddyfile dir    (default ~/.config/agentvoice-tls)
#   AGENTVOICE_SYSTEMD_DIR   user unit dir         (default ~/.config/systemd/user)
#
# Re-running is safe.
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

# ── Args ──────────────────────────────────────────────────────────────────
INTERACTIVE=true
FORCE_INTERACTIVE=false   # --interactive: prompt even when stdin is not a tty (piped answers)
PROVIDER=""
PORT_OVERRIDE=""
TLS_PORT=8443
START_SERVICES=true

while [[ $# -gt 0 ]]; do
  case "$1" in
    -y|--yes|--non-interactive) INTERACTIVE=false; shift;;
    --interactive) FORCE_INTERACTIVE=true; shift;;
    --provider)   [[ $# -ge 2 ]] || err "--provider needs a value"; PROVIDER="$2"; shift 2;;
    --provider=*) PROVIDER="${1#*=}"; shift;;
    --port)       [[ $# -ge 2 ]] || err "--port needs a value"; PORT_OVERRIDE="$2"; shift 2;;
    --port=*)     PORT_OVERRIDE="${1#*=}"; shift;;
    --tls-port)   [[ $# -ge 2 ]] || err "--tls-port needs a value"; TLS_PORT="$2"; shift 2;;
    --tls-port=*) TLS_PORT="${1#*=}"; shift;;
    --no-start)   START_SERVICES=false; shift;;
    -h|--help)
      grep '^#' "$0" | grep -v '!/usr/bin' | sed 's/^# \?//'
      exit 0;;
    *) err "Unknown option: $1 (see --help)";;
  esac
done

if $INTERACTIVE && ! $FORCE_INTERACTIVE && [[ ! -t 0 ]]; then
  warn "stdin is not a terminal — running non-interactively."
  INTERACTIVE=false
fi

[[ "$(uname -s)" == "Linux" ]] || err "Linux only."

CONFIG_FILE="${AGENTVOICE_CONFIG:-${PROJECT_DIR}/config.json}"
ENV_FILE="${AGENTVOICE_ENV_FILE:-${PROJECT_DIR}/.env}"
TLS_DIR="${AGENTVOICE_TLS_DIR:-${HOME}/.config/agentvoice-tls}"
SYSTEMD_DIR="${AGENTVOICE_SYSTEMD_DIR:-${HOME}/.config/systemd/user}"

[[ -f "$CONFIG_FILE" ]] || err "${CONFIG_FILE} not found — run: bash scripts/prepare.sh"
command -v node >/dev/null 2>&1 || err "node not found on PATH (needed to edit config.json)"

# ── Helpers ───────────────────────────────────────────────────────────────
env_get() {
  [[ -f "$ENV_FILE" ]] || return 0
  grep -E "^${1}=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- | sed 's/[[:space:]]*#.*$//' | tr -d '"'"'" | tr -d '[:space:]'
}

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

json_string() { node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$1"; }

confirm() {  # confirm "Question" [default y|n]
  local q="$1" d="${2:-y}" a=""
  $INTERACTIVE || { [[ "$d" == "y" ]]; return; }
  read -r -p "$(echo -e "${BLD}${q}${NC} [$([[ "$d" == y ]] && echo Y/n || echo y/N)]: ")" a || true
  [[ -n "$a" ]] || a="$d"
  [[ "$a" =~ ^[Yy] ]]
}

lan_ip() {
  ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i <= NF; i++) if ($i == "src") { print $(i + 1); exit }}' \
    || hostname -I 2>/dev/null | awk '{print $1}' || true
}

http_code() { curl -sk -o /dev/null --max-time "${2:-8}" -w '%{http_code}' "$1" 2>/dev/null || echo 000; }

# ── Bridge port ───────────────────────────────────────────────────────────
PORT="${PORT_OVERRIDE:-$(env_get PORT)}"
PORT="${PORT:-5089}"

section "Hosting setup"
info "config: ${CONFIG_FILE}"
info "bridge: http://127.0.0.1:${PORT}"
if curl -sf --max-time 3 "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1; then
  ok "Bridge is up on :${PORT}."
else
  warn "Bridge not responding on 127.0.0.1:${PORT} — hosting can still be configured; start it afterwards."
fi

CURRENT="$(cfg_get settings.hosting.provider)"
[[ -n "$CURRENT" ]] && info "Current settings.hosting.provider = ${CURRENT}"

# ── Menu ──────────────────────────────────────────────────────────────────
if [[ -z "$PROVIDER" ]]; then
  if $INTERACTIVE; then
    echo ""
    echo -e "${BLD}How should the bridge be reached?${NC}"
    echo "  1) tailscale  — HTTPS on your tailnet via 'tailscale serve' (recommended)"
    echo "  2) caddy      — local TLS (mkcert) on :${TLS_PORT}, forward from your router yourself"
    echo "  3) lan        — plain LAN access, no TLS"
    echo "  4) local      — loopback only, nothing exposed"
    while :; do
      read -r -p "Choice [4]: " pick || true
      case "${pick:-4}" in
        1) PROVIDER=tailscale; break;;
        2) PROVIDER=caddy; break;;
        3) PROVIDER=lan; break;;
        4) PROVIDER=local; break;;
        *) echo "  Enter 1-4.";;
      esac
    done
  else
    PROVIDER=local
    info "Non-interactive with no --provider — defaulting to 'local'."
  fi
fi
case "$PROVIDER" in
  none) PROVIDER=local;;
  tailscale|caddy|lan|local) ;;
  *) err "Unknown provider '${PROVIDER}' (tailscale|caddy|lan|local|none)";;
esac

# ── tailscale ─────────────────────────────────────────────────────────────
setup_tailscale() {
  section "Tailscale serve"
  command -v tailscale >/dev/null 2>&1 || err "tailscale CLI not found — install from https://tailscale.com/download"
  if ! tailscale status >/dev/null 2>&1; then
    err "Tailscale is not connected — run: sudo tailscale up"
  fi

  local out rc=0 fqdn
  out="$(tailscale serve --bg "$PORT" 2>&1)" || rc=$?
  if [[ $rc -ne 0 ]]; then
    if echo "$out" | grep -qiE 'access denied|operator|permission denied|not permitted'; then
      warn "tailscale serve refused: $(echo "$out" | head -1)"
      echo -e "  This user must be the Tailscale operator (one-time): ${BLD}sudo tailscale set --operator=${USER}${NC}"
      if confirm "Run that now (needs sudo)?" y; then
        sudo tailscale set --operator="$USER" || err "sudo tailscale set --operator failed."
        rc=0
        out="$(tailscale serve --bg "$PORT" 2>&1)" || rc=$?
      fi
    fi
    if [[ $rc -ne 0 ]]; then
      if echo "$out" | grep -qi 'not enabled'; then
        warn "Serve is not enabled on your tailnet. Visit the link below, then re-run this script:"
      fi
      echo "$out" | sed 's/^/    /'
      err "tailscale serve --bg ${PORT} failed."
    fi
  fi
  ok "tailscale serve --bg ${PORT} configured."
  tailscale serve status 2>/dev/null | sed 's/^/    /' || true

  fqdn="$(tailscale status --json 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write((JSON.parse(s).Self||{}).DNSName||"")}catch{}})' \
    | sed 's/\.$//')"
  [[ -n "$fqdn" ]] || err "Could not read Self.DNSName from 'tailscale status --json' — is MagicDNS enabled?"
  PUBLIC_URL="https://${fqdn}"

  cfg_set settings.hosting.provider '"tailscale"'
  cfg_set settings.runModes.serve.publicBaseUrl "$(json_string "$PUBLIC_URL")"
  ok "config: hosting.provider=tailscale, runModes.serve.publicBaseUrl=${PUBLIC_URL}"

  info "Verifying ${PUBLIC_URL}/ (first HTTPS cert issue can take ~30s)..."
  local code="000" i
  for i in 1 2 3 4 5 6; do
    code="$(http_code "${PUBLIC_URL}/" 15)"
    [[ "$code" == "200" ]] && break
    sleep 5
  done
  if [[ "$code" == "200" ]]; then
    ok "${PUBLIC_URL}/ → 200"
  else
    warn "${PUBLIC_URL}/ → ${code}. Check MagicDNS + HTTPS certs at https://login.tailscale.com/admin/dns and that the bridge is up."
  fi
}

# ── caddy ─────────────────────────────────────────────────────────────────
setup_caddy() {
  section "Caddy TLS front (:${TLS_PORT} → 127.0.0.1:${PORT})"
  command -v caddy  >/dev/null 2>&1 || err "caddy not found — brew install caddy / dnf install caddy"
  command -v mkcert >/dev/null 2>&1 || err "mkcert not found — brew install mkcert"

  local ip cert key caddyfile unit
  ip="$(lan_ip)"
  mkdir -p "$TLS_DIR"
  chmod 700 "$TLS_DIR"
  cert="${TLS_DIR}/bridge.pem"; key="${TLS_DIR}/bridge-key.pem"; caddyfile="${TLS_DIR}/Caddyfile"

  # `mkcert -install` is idempotent but may ask for sudo, so only run it when a
  # human is present; otherwise say what to run.
  if $INTERACTIVE; then
    info "Ensuring the mkcert local CA is trusted (may prompt for your password)..."
    mkcert -install || warn "mkcert -install failed — browsers will not trust the cert until the CA is installed."
  else
    warn "Non-interactive: skipping 'mkcert -install'. Run it once so browsers on this machine trust the cert."
  fi

  if [[ -f "$cert" && -f "$key" ]] && openssl x509 -in "$cert" -noout -checkend 2592000 >/dev/null 2>&1 \
     && { [[ -z "$ip" ]] || openssl x509 -in "$cert" -noout -ext subjectAltName 2>/dev/null | grep -q "$ip"; }; then
    ok "Certificate present and valid for >30 days: ${cert}"
  else
    info "Issuing certificate for 127.0.0.1 localhost ${ip:-}"
    # shellcheck disable=SC2086
    mkcert -cert-file "$cert" -key-file "$key" 127.0.0.1 localhost ::1 ${ip:-}
    chmod 600 "$key"
    ok "Certificate written: ${cert}"
  fi

  cat > "$caddyfile" <<EOF
{
	admin off
	auto_https off
}

# AgentVoice bridge — TLS terminator in front of the loopback-only bridge.
# WAN :443 (router forward) -> this host :${TLS_PORT} -> 127.0.0.1:${PORT}
:${TLS_PORT} {
	tls ${cert} ${key}

	encode gzip
	header {
		Strict-Transport-Security "max-age=31536000; includeSubDomains"
		X-Content-Type-Options nosniff
		X-Frame-Options SAMEORIGIN
		Referrer-Policy no-referrer
		-Server
	}

	# WebSockets (/ws) and the API proxy transparently through reverse_proxy.
	reverse_proxy 127.0.0.1:${PORT} {
		header_up Host {host}
		header_up X-Real-IP {remote_host}
		header_up X-Forwarded-For {remote_host}
		header_up X-Forwarded-Proto https
	}
}
EOF
  ok "Caddyfile written: ${caddyfile}"
  caddy validate --config "$caddyfile" --adapter caddyfile >/dev/null 2>&1 \
    && ok "Caddyfile validates." || warn "caddy validate reported a problem — check ${caddyfile}"

  mkdir -p "$SYSTEMD_DIR"
  unit="${SYSTEMD_DIR}/agentvoice-caddy.service"
  cat > "$unit" <<EOF
[Unit]
Description=Caddy TLS front for AgentVoice bridge (:${TLS_PORT} -> 127.0.0.1:${PORT})
After=network-online.target agentvoice.service

[Service]
Type=simple
ExecStart=$(command -v caddy) run --config ${caddyfile} --adapter caddyfile
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
EOF
  ok "Unit written: ${unit}"

  cfg_set settings.hosting.provider '"manual"'
  ok "config: hosting.provider=manual"
  if [[ -z "$(cfg_get settings.runModes.serve.publicBaseUrl)" && -n "$ip" ]]; then
    cfg_set settings.runModes.serve.publicBaseUrl "$(json_string "https://${ip}:${TLS_PORT}")"
    ok "config: runModes.serve.publicBaseUrl=https://${ip}:${TLS_PORT}"
  fi

  if ! $START_SERVICES; then
    warn "--no-start: not enabling agentvoice-caddy.service. Start later: systemctl --user enable --now agentvoice-caddy"
    return
  fi
  if [[ "$SYSTEMD_DIR" != "${HOME}/.config/systemd/user" ]]; then
    warn "Unit written outside the systemd user dir — not starting it."
    return
  fi
  systemctl --user daemon-reload
  systemctl --user enable --now agentvoice-caddy.service
  sleep 2
  if systemctl --user is-active --quiet agentvoice-caddy.service; then
    ok "agentvoice-caddy.service is active."
  else
    warn "agentvoice-caddy.service failed — journalctl --user -u agentvoice-caddy -n 30"
  fi
  local code
  code="$(http_code "https://127.0.0.1:${TLS_PORT}/healthz" 8)"
  if [[ "$code" == "200" ]]; then ok "https://127.0.0.1:${TLS_PORT}/healthz → 200"
  else warn "https://127.0.0.1:${TLS_PORT}/healthz → ${code} (bridge down, or caddy not started)"; fi
  echo -e "  Reach it at ${BLD}https://${ip:-<lan-ip>}:${TLS_PORT}${NC} — clients must trust the mkcert CA ($(mkcert -CAROOT 2>/dev/null)/rootCA.pem)."
}

# ── lan / local ───────────────────────────────────────────────────────────
setup_lan() {
  section "LAN"
  local ip; ip="$(lan_ip)"
  cfg_set settings.hosting.provider '"lan"'
  ok "config: hosting.provider=lan"
  info "The bridge itself binds 127.0.0.1:${PORT}; the lan provider handles exposure on ${ip:-<lan-ip>} when the bridge (re)starts."
  info "Microphone access needs a secure context — prefer tailscale or caddy for phones."
}

setup_local() {
  section "Local only"
  cfg_set settings.hosting.provider '"local"'
  ok "config: hosting.provider=local (loopback only; nothing exposed)"
  if command -v tailscale >/dev/null 2>&1 && tailscale serve status 2>/dev/null | grep -q "127.0.0.1:${PORT}"; then
    if confirm "tailscale serve still proxies :${PORT} — reset it?" n; then
      tailscale serve reset && ok "tailscale serve reset." || warn "tailscale serve reset failed."
    fi
  fi
}

case "$PROVIDER" in
  tailscale) setup_tailscale;;
  caddy)     setup_caddy;;
  lan)       setup_lan;;
  local)     setup_local;;
esac

section "Hosting setup complete"
echo -e "  provider: ${BLD}${PROVIDER}${NC}   config: ${CONFIG_FILE}"
echo -e "  Restart the bridge to apply: ${BLD}systemctl --user restart agentvoice${NC}   Verify: ${BLD}bash scripts/doctor.sh${NC}"
echo ""
