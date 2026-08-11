#!/usr/bin/env bash
# Forward LOCAL_BIND_PORT on this machine to REMOTE_BIND_PORT on REMOTE_SSH.
# Long-running — intended for systemd user service (Restart=always).
set -euo pipefail

CONFIG="${AGENTVOICE_TUNNEL_ENV:-${CURSOR_VOICE_TUNNEL_ENV:-${HOME}/.config/agentvoice/tunnel.env}}"

if [[ ! -f "$CONFIG" ]]; then
  echo "agentvoice tunnel: missing config ${CONFIG}" >&2
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
