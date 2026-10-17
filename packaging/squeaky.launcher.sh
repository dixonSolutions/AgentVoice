#!/bin/sh
# /usr/bin/squeaky — run the bridge on the Node runtime shipped alongside it.
#
# The bundled Node is not optional: better-sqlite3's binding is compiled
# against a specific ABI, and a distro Node that moves under us breaks it with
# an error most users cannot read. SQUEAKY_NODE is an escape hatch for
# anyone who knows what they are doing.
set -e
NODE="${SQUEAKY_NODE:-${SQUEAKR_NODE:-${AGENTVOICE_NODE:-/usr/lib/squeaky/node/bin/node}}}"
[ -x "$NODE" ] || NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then
  echo "squeaky: no Node runtime found (expected /usr/lib/squeaky/node/bin/node)" >&2
  exit 1
fi
exec "$NODE" /usr/lib/squeaky/bin/squeaky.mjs "$@"
