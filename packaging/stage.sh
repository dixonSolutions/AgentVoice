#!/usr/bin/env bash
#
# Stage the payload a .deb / .rpm ships, into packaging/root/ (docs/38, #58).
#
# Four parts go in:
#
#   dist/ + bin/      the bridge and the management CLI
#   web/dist/         the PWA — architecture-independent, but carried in both
#                     arch packages rather than split into a noarch one
#   node_modules/     production-only, for the one native module we have
#   node/             the Node runtime itself, because Debian 12 and Ubuntu
#                     24.04 ship Node 18 while engines needs >= 20, and
#                     better-sqlite3's binding is bound to the ABI it was
#                     built against
#
# What is deliberately NOT in here: the ~41 MB Vosk wake-word model. It would
# more than double the package for every install, including the many that never
# turn wake words on, and it cannot live under /usr/lib anyway — the bridge
# serves it from ~/.agentvoice/vosk after `agentvoice prepare-vosk`.
#
# Usage: packaging/stage.sh <node-tarball-dir>
#   where <node-tarball-dir> holds an extracted node-vNN-linux-<arch> tree.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
staging="${repo_root}/packaging/root"
prefix="${staging}/usr/lib/agentvoice"
node_src="${1:-}"

if [[ -z "${node_src}" || ! -x "${node_src}/bin/node" ]]; then
  echo "usage: packaging/stage.sh <extracted-node-dir>   (must contain bin/node)" >&2
  exit 2
fi

for required in "${repo_root}/dist/index.js" "${repo_root}/web/dist/index.html"; do
  if [[ ! -f "${required}" ]]; then
    echo "missing ${required} — run 'npm run build' first" >&2
    exit 1
  fi
done

rm -rf "${staging}"
mkdir -p "${prefix}" "${staging}/usr/bin" "${staging}/usr/lib/systemd/user"

cp -r "${repo_root}/dist" "${prefix}/dist"
cp -r "${repo_root}/bin" "${prefix}/bin"
cp -r "${repo_root}/web" "${prefix}/web"
cp "${repo_root}/package.json" "${prefix}/package.json"
cp "${repo_root}/config.example.json" "${prefix}/config.example.json"
cp "${repo_root}/cli-config.example.json" "${prefix}/cli-config.example.json"
cp "${repo_root}/README.md" "${repo_root}/LICENSE" "${prefix}/"

# The model must never ride along — see the header, and the same assertion in
# the npm packaging step.
rm -f "${prefix}/web/dist/vosk/model.tar.gz"
rm -rf "${prefix}/web/public"

# Production-only dependencies: everything the server actually imports, and in
# particular better-sqlite3's compiled binding for this architecture.
#
# Run with the *bundled* Node's npm, not the build host's. Two reasons, both
# of which produced a package that could not open its own database when this
# was done with whatever node happened to be on PATH:
#
#   1. better-sqlite3's binding is ABI-bound. prebuild-install picks the binary
#      matching the Node that runs it, so installing under Node 24 and shipping
#      Node 20 gives a NODE_MODULE_VERSION mismatch at boot.
#   2. npm 12 blocks install scripts unless approved, so the binding is not
#      fetched at all. The Node we bundle carries npm 10, which runs them.
#
# --legacy-peer-deps for the same reason every other install in this repo uses
# it: @openng/optimus-ui declares a peer on @angular/cdk ^21 while the app is
# on 22. Those are devDependencies and none of them end up installed here, but
# npm still resolves the whole tree before deciding what to omit.
echo "Installing production dependencies with the bundled Node…"
(
  cd "${prefix}"
  PATH="${node_src}/bin:${PATH}" "${node_src}/bin/node" "${node_src}/bin/npm" \
    install --omit=dev --omit=optional --no-audit --no-fund --legacy-peer-deps
)

# Prove the binding loads on the runtime that will actually load it, here,
# rather than finding out on a user's machine.
echo "Verifying the native binding against the bundled runtime…"
PATH="${node_src}/bin:${PATH}" "${node_src}/bin/node" -e "
  const db = require('${prefix}/node_modules/better-sqlite3');
  const handle = new db(':memory:');
  handle.prepare('select 1 as ok').get();
  handle.close();
  console.log('better-sqlite3 loads on ' + process.version);
"

# The runtime. Trimmed of everything a running bridge does not read.
mkdir -p "${prefix}/node"
cp -r "${node_src}/bin" "${node_src}/lib" "${prefix}/node/"
rm -rf "${prefix}/node/lib/node_modules/npm/docs" "${prefix}/node/lib/node_modules/npm/man"

cp "${repo_root}/packaging/agentvoice.launcher.sh" "${staging}/usr/bin/agentvoice"
chmod 0755 "${staging}/usr/bin/agentvoice"
cp "${repo_root}/packaging/agentvoice.user.service" \
   "${staging}/usr/lib/systemd/user/agentvoice.service"

# Read by src/serve/installMode.ts. Authoritative: a path check alone would
# also claim a hand-extracted tarball in /opt.
printf '%s\n' "${PKG_FORMAT:-deb}" > "${prefix}/.install-source"

echo "Staged $(du -sh "${staging}" | cut -f1) into ${staging}"
