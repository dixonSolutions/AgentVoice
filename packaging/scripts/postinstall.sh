#!/bin/sh
# Printed, not done. See packaging/nfpm.yaml for why the unit is not enabled:
# the bridge runs as the developer, and the package has no way to know which
# human on this machine that is.
set -e

cat <<'MSG'

AgentVoice is installed.

  Start it as yourself (not as root):

    systemctl --user enable --now agentvoice
    loginctl enable-linger "$USER"

  The linger line matters: without it systemd stops your user services when you
  log out, which is exactly when you want to reach the bridge from your phone.

  Then pair your phone:

    agentvoice status      # shows the URL and the pairing token
    agentvoice token       # prints the token on its own

  Wake words need a 41 MB model that is not in the package:

    agentvoice prepare-vosk

MSG

exit 0
