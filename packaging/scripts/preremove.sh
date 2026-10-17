#!/bin/sh
# Undo what postinstall did, on removal only (not on upgrade): disable the
# user unit globally and stop it for the user running the removal through
# sudo. ~/.squeaky is left alone — the config, the database and the pairing
# token are the user's, not the package's. Never fails the package operation.
set -u

removing=false
case "${1:-}" in
  remove|purge) removing=true ;;   # deb: remove | upgrade <new-version> | …
  0) removing=true ;;              # rpm: 0 = erase, 1 = upgrade
esac

if $removing; then
  # Tells postinstall that a later install is a reinstall, not an upgrade, so
  # the service is enabled again (dpkg reports both as "configure <old>").
  mkdir -p /var/lib/squeaky 2>/dev/null && : > /var/lib/squeaky/reenable-service 2>/dev/null || true
fi

if $removing && command -v systemctl >/dev/null 2>&1; then
  systemctl --global disable squeaky.service >/dev/null 2>&1 || true
  user="${SUDO_USER:-}"
  if [ -n "$user" ] && [ "$user" != "root" ]; then
    systemctl --user --machine="${user}@" disable --now squeaky.service >/dev/null 2>&1 || true
  fi
  cat <<'MSG'

Removing Squeaky. The service is disabled for every user; if another user
still has it running, it stops at their next logout — or now, as that user:

    systemctl --user disable --now squeaky

Your bridge home (~/.squeaky) is left untouched — it holds your config,
your database and your pairing token.

MSG
fi

exit 0
