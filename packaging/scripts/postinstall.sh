#!/bin/sh
# Out of the box: enable the user unit for every user's systemd user manager
# (`systemctl --global enable`), so Squeakr starts at login for whoever
# uses this machine, and start it right away for the user who ran the install
# through sudo. It is a *user* service on purpose — the bridge runs as the
# developer, with their agent CLI sign-ins and projects — and it listens on
# 127.0.0.1 only; nothing is exposed until `squeakr setup` sets up hosting.
#
# Only on a fresh install (or a reinstall after removal): an upgrade leaves an
# admin's choice (e.g. `systemctl --global disable squeakr`) alone. Opt out
# entirely with
#   sudo SQUEAKR_NO_SERVICE=1 apt install squeakr
# Never fails the package operation.
set -u

# preremove leaves this behind on a removal (not an upgrade). dpkg reports a
# reinstall after `apt remove` as "configure <old-version>" — exactly like an
# upgrade — so without it the service would never come back.
REENABLE_MARKER=/var/lib/squeakr/reenable-service

fresh=false
case "${1:-}" in
  configure) [ -z "${2:-}" ] && fresh=true ;;   # deb: configure <old-version>; empty on first install
  1) fresh=true ;;                               # rpm: 1 = install, 2 = upgrade
esac
if [ -f "$REENABLE_MARKER" ]; then
  fresh=true
  rm -f "$REENABLE_MARKER"
fi

# ── Coming from the agentvoice package (docs/45) ─────────────────────────────
# This package replaced it (Conflicts/Replaces, Obsoletes). Point the apt / dnf
# source at the new URL — GitHub Pages does not redirect after the repo rename
# — and hand the user service over: the old unit stops for every logged-in
# user (it would hold the port), the new one starts where the old one ran.
/usr/lib/squeakr/scripts/migrate-to-squeakr.sh --repo-only >/dev/null 2>&1 || true

handover_users=""
if command -v systemctl >/dev/null 2>&1; then
  if [ -e /etc/systemd/user/default.target.wants/agentvoice.service ]; then
    systemctl --global disable agentvoice.service >/dev/null 2>&1 || rm -f /etc/systemd/user/default.target.wants/agentvoice.service
    fresh=true                     # it was on for everyone: so is this
  fi
  for dir in /run/user/*; do
    uid="${dir##*/}"
    user="$(id -nu "$uid" 2>/dev/null || true)"
    [ -n "$user" ] && [ "$user" != root ] || continue
    if systemctl --user --machine="${user}@" is-active --quiet agentvoice.service 2>/dev/null; then
      systemctl --user --machine="${user}@" stop agentvoice.service >/dev/null 2>&1 || true
      handover_users="${handover_users} ${user}"
    fi
  done
fi

state=upgrade                    # upgrade | optout | nosystemd | enabled | started
if $fresh; then
  if [ -n "${SQUEAKR_NO_SERVICE:-${AGENTVOICE_NO_SERVICE:-}}" ]; then
    state=optout
  elif ! command -v systemctl >/dev/null 2>&1; then
    state=nosystemd
  elif systemctl --global enable squeakr.service >/dev/null 2>&1; then
    state=enabled
    # The installing user (sudo), if their user manager is running: start it
    # now rather than at their next login.
    user="${SUDO_USER:-}"
    if [ -n "$user" ] && [ "$user" != "root" ]; then
      uid="$(id -u "$user" 2>/dev/null || true)"
      if [ -n "$uid" ] && [ -d "/run/user/$uid" ] &&
         systemctl --user --machine="${user}@" daemon-reload >/dev/null 2>&1 &&
         systemctl --user --machine="${user}@" start squeakr.service >/dev/null 2>&1; then
        state=started
      fi
    fi
  else
    state=nosystemd
  fi
fi

for user in $handover_users; do
  systemctl --user --machine="${user}@" daemon-reload >/dev/null 2>&1 || true
  systemctl --user --machine="${user}@" start squeakr.service >/dev/null 2>&1 || true
done
if [ -n "$handover_users" ]; then
  cat <<'MSG'

AgentVoice is now Squeakr. The background service moved from agentvoice to
squeakr with the same settings (~/.agentvoice is still read). To move the
home to ~/.squeakr as well, as yourself:  squeakr upgrade-from-agentvoice
MSG
fi

case "$state" in
  started)
    cat <<'MSG'

Squeakr is installed and running as your background service
on http://127.0.0.1:5089 (this machine only).

  Next:   squeakr setup     # agent CLI, projects, and hosting such as Tailscale
  Pair:   squeakr token     # paste it when the app asks

  Keep it running after you log out:   loginctl enable-linger "$USER"

MSG
    ;;
  enabled)
    cat <<'MSG'

Squeakr is installed and enabled as a user service; it starts at your next
login. To start it now, as yourself (not root):

    systemctl --user daemon-reload
    systemctl --user start squeakr
    loginctl enable-linger "$USER"      # keep it running after logout

  Then:   squeakr setup     # agent CLI, projects, and hosting such as Tailscale

MSG
    ;;
  optout)
    cat <<'MSG'

Squeakr is installed. SQUEAKR_NO_SERVICE is set, so no background
service was enabled. Run it in the foreground with `squeakr run`, or set
it up later with `squeakr setup`.

MSG
    ;;
  nosystemd)
    cat <<'MSG'

Squeakr is installed. No systemd user manager was available, so no
background service was enabled. Run it in the foreground with `squeakr run`.

MSG
    ;;
  upgrade)
    cat <<'MSG'

Squeakr is upgraded. If it runs as your background service, restart it to
load the new version (as yourself):  squeakr restart

MSG
    ;;
esac

exit 0
