#!/usr/bin/env bash
# Repair local AgentVoice hosting: rebuild, restart, sync Tailscale Serve, verify.
#
# Usage: bash scripts/fix-hosting.sh [--no-build]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "$PROJECT_DIR"

NO_BUILD=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-build) NO_BUILD=true; shift;;
    -h|--help)
      echo "Usage: bash scripts/fix-hosting.sh [--no-build]"
      exit 0;;
    *) echo "Unknown option: $1" >&2; exit 1;;
  esac
done

if $NO_BUILD; then
  bash "${SCRIPT_DIR}/restart.sh" --no-build
else
  bash "${SCRIPT_DIR}/restart.sh"
fi

bash "${SCRIPT_DIR}/sync-tailscale-serve.sh"

if command -v nginx &>/dev/null && [[ -f /etc/nginx/sites-enabled/agentvoice ]]; then
  if nginx -t 2>/dev/null; then
    sudo nginx -s reload 2>/dev/null || true
  fi
fi

exec bash "${SCRIPT_DIR}/doctor.sh"
