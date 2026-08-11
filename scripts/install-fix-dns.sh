#!/usr/bin/env bash
# Install fix-dns.service + timer — run INSIDE the incus/LXC container where
# agentvoice.service runs (not on the Tailscale tunnel machine).
#
# Required for AWS Transcribe/Polly/Bedrock when systemd-resolved stub breaks DNS.
#
# Usage (inside container): sudo bash scripts/install-fix-dns.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_SRC="${SCRIPT_DIR}/fix-dns.service.example"
SERVICE_DST="/etc/systemd/system/fix-dns.service"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run as root: sudo bash scripts/install-fix-dns.sh" >&2
  exit 1
fi

cp "$SERVICE_SRC" "$SERVICE_DST"
TIMER_SRC="${SCRIPT_DIR}/fix-dns.timer.example"
TIMER_DST="/etc/systemd/system/fix-dns.timer"
cp "$TIMER_SRC" "$TIMER_DST"
systemctl daemon-reload
systemctl enable fix-dns.service fix-dns.timer
systemctl start fix-dns.service fix-dns.timer

echo "resolv.conf:"
cat /etc/resolv.conf

if getent hosts aws.amazon.com >/dev/null 2>&1; then
  echo "OK: DNS resolves aws.amazon.com"
else
  echo "WARN: DNS still failing — check container network" >&2
  exit 1
fi
