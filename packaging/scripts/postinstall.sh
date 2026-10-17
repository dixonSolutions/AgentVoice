#!/bin/sh
# Out of the box: enable the user unit for every user's systemd user manager
# (`systemctl --global enable`), so Squeaky starts at login for whoever
# uses this machine, and start it right away for the user who ran the install
# through sudo. It is a *user* service on purpose — the bridge runs as the
# developer, with their agent CLI sign-ins and projects — and it listens on
# 127.0.0.1 only; nothing is exposed until `squeaky setup` sets up hosting.
#
# Only on a fresh install (or a reinstall after removal): an upgrade leaves an
# admin's choice (e.g. `systemctl --global disable squeaky`) alone. Opt out
# entirely with
#   sudo SQUEAKY_NO_SERVICE=1 apt install squeaky
# Never fails the package operation.
set -u

# preremove leaves this behind on a removal (not an upgrade). dpkg reports a
# reinstall after `apt remove` as "configure <old-version>" — exactly like an
# upgrade — so without it the service would never come back.
REENABLE_MARKER=/var/lib/squeaky/reenable-service

fresh=false
case "${1:-}" in
  configure) [ -z "${2:-}" ] && fresh=true ;;   # deb: configure <old-version>; empty on first install
  1) fresh=true ;;                               # rpm: 1 = install, 2 = upgrade
esac
if [ -f "$REENABLE_MARKER" ]; then
  fresh=true
  rm -f "$REENABLE_MARKER"
fi

# ── Coming from the squeakr or agentvoice package (docs/45, docs/46) ─────────
# This package replaced it (Conflicts/Replaces, Obsoletes). Point the apt / dnf
# source at the new URL — GitHub Pages does not redirect after the repo rename
# — and hand the user service over: the old unit stops for every logged-in
# user (it would hold the port), the new one starts where the old one ran.
/usr/lib/squeaky/scripts/migrate-to-squeaky.sh --repo-only >/dev/null 2>&1 || true

# The old package's preremove left its reinstall marker behind; nothing reads it.
for old in squeakr agentvoice; do
  rm -f "/var/lib/${old}/reenable-service" 2>/dev/null
  rmdir "/var/lib/${old}" 2>/dev/null
done

handover_users=""
if command -v systemctl >/dev/null 2>&1; then
  for old in squeakr agentvoice; do
    if [ -e "/etc/systemd/user/default.target.wants/${old}.service" ]; then
      systemctl --global disable "${old}.service" >/dev/null 2>&1 || rm -f "/etc/systemd/user/default.target.wants/${old}.service"
      fresh=true                   # it was on for everyone: so is this
    fi
  done
  for dir in /run/user/*; do
    uid="${dir##*/}"
    user="$(id -nu "$uid" 2>/dev/null || true)"
    [ -n "$user" ] && [ "$user" != root ] || continue
    for old in squeakr agentvoice; do
      if systemctl --user --machine="${user}@" is-active --quiet "${old}.service" 2>/dev/null; then
        systemctl --user --machine="${user}@" stop "${old}.service" >/dev/null 2>&1 || true
        case " ${handover_users} " in *" ${user} "*) ;; *) handover_users="${handover_users} ${user}" ;; esac
      fi
    done
  done
fi

state=upgrade                    # upgrade | optout | nosystemd | enabled | started
if $fresh; then
  if [ -n "${SQUEAKY_NO_SERVICE:-${SQUEAKR_NO_SERVICE:-${AGENTVOICE_NO_SERVICE:-}}}" ]; then
    state=optout
  elif ! command -v systemctl >/dev/null 2>&1; then
    state=nosystemd
  elif systemctl --global enable squeaky.service >/dev/null 2>&1; then
    state=enabled
    # The installing user (sudo), if their user manager is running: start it
    # now rather than at their next login.
    user="${SUDO_USER:-}"
    if [ -n "$user" ] && [ "$user" != "root" ]; then
      uid="$(id -u "$user" 2>/dev/null || true)"
      if [ -n "$uid" ] && [ -d "/run/user/$uid" ] &&
         systemctl --user --machine="${user}@" daemon-reload >/dev/null 2>&1 &&
         systemctl --user --machine="${user}@" start squeaky.service >/dev/null 2>&1; then
        state=started
      fi
    fi
  else
    state=nosystemd
  fi
fi

for user in $handover_users; do
  systemctl --user --machine="${user}@" daemon-reload >/dev/null 2>&1 || true
  systemctl --user --machine="${user}@" start squeaky.service >/dev/null 2>&1 || true
done
if [ -n "$handover_users" ]; then
  cat <<'MSG'

Squeakr (formerly AgentVoice) is now Squeaky. The background service moved
over to squeaky with the same settings (~/.squeakr or ~/.agentvoice is still
read). To move the home to ~/.squeaky as well, as yourself:
    squeaky upgrade-from-squeakr
MSG
fi

case "$state" in
  started)
    cat <<'MSG'

Squeaky is installed and running as your background service
on http://127.0.0.1:5089 (this machine only).

  Next:   squeaky setup     # agent CLI, projects, and hosting such as Tailscale
  Pair:   squeaky token     # paste it when the app asks

  Keep it running after you log out:   loginctl enable-linger "$USER"

MSG
    ;;
  enabled)
    cat <<'MSG'

Squeaky is installed and enabled as a user service; it starts at your next
login. To start it now, as yourself (not root):

    systemctl --user daemon-reload
    systemctl --user start squeaky
    loginctl enable-linger "$USER"      # keep it running after logout

  Then:   squeaky setup     # agent CLI, projects, and hosting such as Tailscale

MSG
    ;;
  optout)
    cat <<'MSG'

Squeaky is installed. SQUEAKY_NO_SERVICE is set, so no background
service was enabled. Run it in the foreground with `squeaky run`, or set
it up later with `squeaky setup`.

MSG
    ;;
  nosystemd)
    cat <<'MSG'

Squeaky is installed. No systemd user manager was available, so no
background service was enabled. Run it in the foreground with `squeaky run`.

MSG
    ;;
  upgrade)
    cat <<'MSG'

Squeaky is upgraded. If it runs as your background service, restart it to
load the new version (as yourself):  squeaky restart

MSG
    ;;
esac

exit 0
