#!/bin/sh
# Out of the box: enable the user unit for every user's systemd user manager
# (`systemctl --global enable`), so AgentVoice starts at login for whoever
# uses this machine, and start it right away for the user who ran the install
# through sudo. It is a *user* service on purpose — the bridge runs as the
# developer, with their agent CLI sign-ins and projects — and it listens on
# 127.0.0.1 only; nothing is exposed until `agentvoice setup` sets up hosting.
#
# Only on a fresh install: an upgrade leaves an admin's choice (e.g.
# `systemctl --global disable agentvoice`) alone. Opt out entirely with
#   sudo AGENTVOICE_NO_SERVICE=1 apt install agentvoice
# Never fails the package operation.
set -u

fresh=false
case "${1:-}" in
  configure) [ -z "${2:-}" ] && fresh=true ;;   # deb: configure <old-version>; empty on first install
  1) fresh=true ;;                               # rpm: 1 = install, 2 = upgrade
esac

started=false
if $fresh && [ -z "${AGENTVOICE_NO_SERVICE:-}" ] && command -v systemctl >/dev/null 2>&1; then
  systemctl --global enable agentvoice.service >/dev/null 2>&1 || true

  # The installing user (sudo), if their user manager is running: start it now
  # rather than at their next login.
  user="${SUDO_USER:-}"
  if [ -n "$user" ] && [ "$user" != "root" ]; then
    uid="$(id -u "$user" 2>/dev/null || true)"
    if [ -n "$uid" ] && [ -d "/run/user/$uid" ]; then
      if systemctl --user --machine="${user}@" daemon-reload >/dev/null 2>&1 &&
         systemctl --user --machine="${user}@" start agentvoice.service >/dev/null 2>&1; then
        started=true
      fi
    fi
  fi
fi

if $started; then
  cat <<'MSG'

AgentVoice is installed and running as your background service
on http://127.0.0.1:5089 (this machine only).

  Next:   agentvoice setup     # agent CLI, projects, and hosting such as Tailscale
  Pair:   agentvoice token     # paste it when the app asks

  Keep it running after you log out:   loginctl enable-linger "$USER"

MSG
else
  cat <<'MSG'

AgentVoice is installed. It is enabled as a user service and starts at your
next login; to start it now, as yourself (not root):

    systemctl --user daemon-reload
    systemctl --user enable --now agentvoice
    loginctl enable-linger "$USER"      # keep it running after logout

  Then:   agentvoice setup     # agent CLI, projects, and hosting such as Tailscale

MSG
fi

exit 0
