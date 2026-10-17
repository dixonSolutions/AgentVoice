#!/usr/bin/env bash
# Forward LOCAL_BIND_PORT on this machine to REMOTE_BIND_PORT on REMOTE_SSH.
# Long-running — intended for systemd user service (Restart=always).
set -euo pipefail

DEFAULT_TUNNEL_ENV="${HOME}/.config/squeaky/tunnel.env"
# Pre-rename locations (docs/45, docs/46), newest first.
for old in squeakr agentvoice; do
  [[ -f "${DEFAULT_TUNNEL_ENV}" ]] && break
  [[ -f "${HOME}/.config/${old}/tunnel.env" ]] && DEFAULT_TUNNEL_ENV="${HOME}/.config/${old}/tunnel.env"
done
CONFIG="${SQUEAKY_TUNNEL_ENV:-${SQUEAKR_TUNNEL_ENV:-${AGENTVOICE_TUNNEL_ENV:-${CURSOR_VOICE_TUNNEL_ENV:-${DEFAULT_TUNNEL_ENV}}}}}"

if [[ ! -f "$CONFIG" ]]; then
  echo "squeaky tunnel: missing config ${CONFIG}" >&2
  echo "Run: bash scripts/install-remote-tunnel.sh" >&2
  exit 1
fi

# shellcheck disable=SC1090
source "$CONFIG"

: "${REMOTE_SSH:?REMOTE_SSH required in ${CONFIG}}"
: "${REMOTE_BIND_HOST:=127.0.0.1}"
: "${REMOTE_BIND_PORT:?REMOTE_BIND_PORT required}"
: "${LOCAL_BIND_HOST:=127.0.0.1}"
: "${LOCAL_BIND_PORT:?LOCAL_BIND_PORT required}"

exec ssh -N \
  -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 \
  -o BatchMode=yes \
  -o StrictHostKeyChecking=accept-new \
  -L "${LOCAL_BIND_HOST}:${LOCAL_BIND_PORT}:${REMOTE_BIND_HOST}:${REMOTE_BIND_PORT}" \
  "$REMOTE_SSH"
