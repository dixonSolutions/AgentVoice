#!/bin/sh
# Out of the box: enable the user unit for every user's systemd user manager
# (`systemctl --global enable`), so AgentVoice starts at login for whoever
# uses this machine, and start it right away for the user who ran the install
# through sudo. It is a *user* service on purpose — the bridge runs as the
# developer, with their agent CLI sign-ins and projects — and it listens on
# 127.0.0.1 only; nothing is exposed until `agentvoice setup` sets up hosting.
#
# Only on a fresh install (or a reinstall after removal): an upgrade leaves an
# admin's choice (e.g. `systemctl --global disable agentvoice`) alone. Opt out
# entirely with
#   sudo AGENTVOICE_NO_SERVICE=1 apt install agentvoice
# Never fails the package operation.
set -u

# preremove leaves this behind on a removal (not an upgrade). dpkg reports a
# reinstall after `apt remove` as "configure <old-version>" — exactly like an
# upgrade — so without it the service would never come back.
REENABLE_MARKER=/var/lib/agentvoice/reenable-service

fresh=false
case "${1:-}" in
  configure) [ -z "${2:-}" ] && fresh=true ;;   # deb: configure <old-version>; empty on first install
  1) fresh=true ;;                               # rpm: 1 = install, 2 = upgrade
esac
if [ -f "$REENABLE_MARKER" ]; then
  fresh=true
  rm -f "$REENABLE_MARKER"
fi

state=upgrade                    # upgrade | optout | nosystemd | enabled | started
if $fresh; then
  if [ -n "${AGENTVOICE_NO_SERVICE:-}" ]; then
    state=optout
  elif ! command -v systemctl >/dev/null 2>&1; then
    state=nosystemd
  elif systemctl --global enable agentvoice.service >/dev/null 2>&1; then
    state=enabled
    # The installing user (sudo), if their user manager is running: start it
    # now rather than at their next login.
    user="${SUDO_USER:-}"
    if [ -n "$user" ] && [ "$user" != "root" ]; then
      uid="$(id -u "$user" 2>/dev/null || true)"
      if [ -n "$uid" ] && [ -d "/run/user/$uid" ] &&
         systemctl --user --machine="${user}@" daemon-reload >/dev/null 2>&1 &&
         systemctl --user --machine="${user}@" start agentvoice.service >/dev/null 2>&1; then
        state=started
      fi
    fi
  else
    state=nosystemd
  fi
fi

case "$state" in
  started)
    cat <<'MSG'

AgentVoice is installed and running as your background service
on http://127.0.0.1:5089 (this machine only).

  Next:   agentvoice setup     # agent CLI, projects, and hosting such as Tailscale
  Pair:   agentvoice token     # paste it when the app asks

  Keep it running after you log out:   loginctl enable-linger "$USER"

MSG
    ;;
  enabled)
    cat <<'MSG'

AgentVoice is installed and enabled as a user service; it starts at your next
login. To start it now, as yourself (not root):

    systemctl --user daemon-reload
    systemctl --user start agentvoice
    loginctl enable-linger "$USER"      # keep it running after logout

  Then:   agentvoice setup     # agent CLI, projects, and hosting such as Tailscale

MSG
    ;;
  optout)
    cat <<'MSG'

AgentVoice is installed. AGENTVOICE_NO_SERVICE is set, so no background
service was enabled. Run it in the foreground with `agentvoice run`, or set
it up later with `agentvoice setup`.

MSG
    ;;
  nosystemd)
    cat <<'MSG'

AgentVoice is installed. No systemd user manager was available, so no
background service was enabled. Run it in the foreground with `agentvoice run`.

MSG
    ;;
  upgrade)
    cat <<'MSG'

AgentVoice is upgraded. If it runs as your background service, restart it to
load the new version (as yourself):  agentvoice restart

MSG
    ;;
esac

exit 0
