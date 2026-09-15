#!/bin/sh
# A package script runs as root and cannot reach into another user's systemd
# session, so it cannot stop the unit it printed instructions for. Say so
# rather than failing, and leave ~/.agentvoice alone — the config, the database
# and the pairing token are the user's, not the package's.
set -e

cat <<'MSG'

Removing AgentVoice. If you have it running, stop it as your own user:

    systemctl --user disable --now agentvoice

Your bridge home (~/.agentvoice) is left untouched — it holds your config,
your database and your pairing token.

MSG

exit 0
