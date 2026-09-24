#!/usr/bin/env bash
#
# Download the packages the live site currently serves, so the next build
# keeps them (docs/43).
#
#   packaging/repos/fetch-published.sh <base-url> <site-dir>
#
# The site is deployed as a Pages artifact, not kept in git (docs/43 explains
# why), so the published state is read back from the site itself, using the
# manifest.txt that build-repos.sh writes: "<sha256>  <path>" per package.
#
#   404 on the manifest   nothing published yet — start empty, exit 0
#   anything else failing hard failure. Carrying on would publish a repository
#                         that silently lost every older version.
#
# Old RPMs come back already signed, so they are not re-signed (and their bytes
# do not change) on every release.

set -euo pipefail

base_url="${1:?usage: fetch-published.sh <base-url> <site-dir>}"
site="${2:?usage: fetch-published.sh <base-url> <site-dir>}"
base_url="${base_url%/}"

fail() { echo "::error::$*" >&2; exit 1; }

mkdir -p "${site}"
site="$(cd "${site}" && pwd)"
manifest="${site}/.published-manifest"

# Pages sits behind a CDN with a ~10 minute max-age; bust it so a release
# right after another one does not read the older manifest and drop a version.
bust="$(date +%s)"
status="$(curl -sS -o "${manifest}" -w '%{http_code}' --retry 3 --retry-all-errors \
  "${base_url}/manifest.txt?nocache=${bust}")" || fail "could not reach ${base_url}/manifest.txt"

case "${status}" in
  200) ;;
  404)
    rm -f "${manifest}"
    echo "no manifest at ${base_url} — first publish, starting empty"
    exit 0
    ;;
  *) fail "${base_url}/manifest.txt answered HTTP ${status}; refusing to publish without the current state" ;;
esac

count=0
while read -r sum path; do
  [[ -n "${sum}" ]] || continue
  # Only package paths the build itself writes: the manifest is fetched over
  # the network and must not be able to write anywhere else.
  if [[ ! "${sum}" =~ ^[0-9a-f]{64}$ ]] \
     || [[ ! "${path}" =~ ^(apt/pool/main/a/agentvoice/[A-Za-z0-9._+~-]+\.deb|rpm/packages/[A-Za-z0-9._+~-]+\.rpm)$ ]]; then
    fail "unexpected manifest line: ${sum} ${path}"
  fi
  mkdir -p "${site}/$(dirname "${path}")"
  curl -fsSL --retry 3 --retry-all-errors -o "${site}/${path}" "${base_url}/${path}?nocache=${bust}" \
    || fail "could not download ${base_url}/${path}"
  echo "${sum}  ${site}/${path}" | sha256sum --check --quiet \
    || fail "${path} does not match its manifest checksum"
  count=$((count + 1))
done < "${manifest}"
rm -f "${manifest}"

echo "fetched ${count} published package(s)"
