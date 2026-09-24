#!/usr/bin/env bash
#
# Build the signed apt and dnf repositories that GitHub Pages serves (docs/43).
#
#   packaging/repos/build-repos.sh <site-dir> <incoming-dir>
#
#   <site-dir>      the packages currently published (fetch-published.sh puts
#                   them there; empty on the first run). Updated in place: new
#                   packages added, old versions pruned, all metadata
#                   regenerated and re-signed.
#   <incoming-dir>  new .deb / .rpm files, typically one release's assets.
#
# Environment:
#   GNUPGHOME          keyring with the signing key(s) — import-signing-key.sh
#   SIGNING_KEYS       space-separated fingerprints; default: every secret key
#                      in GNUPGHOME, in keyring order. All of them sign the apt
#                      Release and repomd.xml; the first one signs the RPMs.
#   BASE_URL           public URL of the site
#                      (default https://dixonsolutions.github.io/AgentVoice)
#   KEEP_VERSIONS      newest versions to keep (default 3)
#   SITE_BUDGET_MB     GitHub Pages refuses sites over 1 GB, and each version is
#                      four ~70 MB packages; after KEEP_VERSIONS, the oldest
#                      versions are dropped until the packages fit this budget
#                      (default 900). The newest version is never dropped.
#
# Layout produced:
#   apt/dists/stable/{Release,InRelease,Release.gpg}
#   apt/dists/stable/main/binary-{amd64,arm64}/Packages{,.gz}
#   apt/pool/main/a/agentvoice/*.deb
#   apt/agentvoice.sources          deb822 source for /etc/apt/sources.list.d/
#   rpm/packages/*.rpm              (signed)
#   rpm/repodata/…, repomd.xml.asc
#   rpm/agentvoice.repo             for /etc/yum.repos.d/
#   agentvoice.asc                  the public key(s)
#   manifest.txt                    sha256 + path of every package, read back
#                                   by fetch-published.sh on the next run
#   index.html

set -euo pipefail

site="${1:?usage: build-repos.sh <site-dir> <incoming-dir>}"
incoming="${2:?usage: build-repos.sh <site-dir> <incoming-dir>}"
base_url="${BASE_URL:-https://dixonsolutions.github.io/AgentVoice}"
base_url="${base_url%/}"
keep="${KEEP_VERSIONS:-3}"
budget_mb="${SITE_BUDGET_MB:-900}"
package=agentvoice
suite=stable
component=main
deb_arches=(amd64 arm64)

fail() { echo "::error::$*" >&2; exit 1; }

for tool in apt-ftparchive createrepo_c dpkg-deb rpm rpmkeys rpmsign gpg gpgv gzip; do
  command -v "${tool}" >/dev/null || fail "${tool} is required (apt-get install apt-utils createrepo-c rpm gnupg)"
done
[[ -n "${GNUPGHOME:-}" ]] || fail "GNUPGHOME is not set — import the key with import-signing-key.sh first"

if [[ -n "${SIGNING_KEYS:-}" ]]; then
  read -r -a keys <<<"${SIGNING_KEYS}"
else
  mapfile -t keys < <(gpg --batch --with-colons --list-secret-keys \
    | awk -F: '$1=="sec"{want=1; next} want && $1=="fpr"{print $10; want=0}')
fi
[[ ${#keys[@]} -gt 0 ]] || fail "no signing key in ${GNUPGHOME} — refusing to build an unsigned repository"
signer_args=()
for k in "${keys[@]}"; do signer_args+=(--local-user "${k}"); done

mkdir -p "${site}"
site="$(cd "${site}" && pwd)"
incoming="$(cd "${incoming}" && pwd)"
pool="${site}/apt/pool/${component}/${package:0:1}/${package}"
rpms="${site}/rpm/packages"
mkdir -p "${pool}" "${rpms}"

# Scratch space for the signature checks in steps 3 and 7: throwaway keyrings
# that must not end up in GNUPGHOME or on the site.
scratch="$(mktemp -d)"
trap 'rm -rf "${scratch}"' EXIT

# ── 1. Add the incoming packages ──────────────────────────────────────────────
shopt -s nullglob
added=0
for deb in "${incoming}"/*.deb; do
  name="$(dpkg-deb -f "${deb}" Package)"
  arch="$(dpkg-deb -f "${deb}" Architecture)"
  [[ "${name}" == "${package}" ]] || fail "$(basename "${deb}"): package is '${name}', expected '${package}'"
  [[ " ${deb_arches[*]} " == *" ${arch} "* ]] || fail "$(basename "${deb}"): unsupported architecture '${arch}'"
  cp -f "${deb}" "${pool}/"
  echo "added $(basename "${deb}")"
  added=$((added + 1))
done

for rpmfile in "${incoming}"/*.rpm; do
  name="$(rpm -qp --qf '%{NAME}' "${rpmfile}" 2>/dev/null)"
  [[ "${name}" == "${package}" ]] || fail "$(basename "${rpmfile}"): package is '${name}', expected '${package}'"
  dest="${rpms}/$(basename "${rpmfile}")"
  cp -f "${rpmfile}" "${dest}"
  # Only newly added RPMs are signed here: the ones already published were
  # signed when they arrived, and re-signing would change their bytes (the
  # signature carries a timestamp) for no reason. Step 3 signs the ones the
  # current key no longer verifies.
  # Output captured: rpmsign warns about GPG_TTY on every call in CI, which is
  # noise unless the signing actually failed.
  if ! out="$(rpmsign --define "_gpg_name ${keys[0]}" --define "_gpg_path ${GNUPGHOME}" \
      --addsign "${dest}" 2>&1)"; then
    fail "rpmsign failed for $(basename "${rpmfile}"): ${out}"
  fi
  echo "added and signed $(basename "${rpmfile}")"
  added=$((added + 1))
done
echo "${added} package(s) added"

# ── 2. Prune to the newest versions, then to the size budget ─────────────────
# One version = every arch and format of it; they come and go together.
deb_version() { dpkg-deb -f "$1" Version | sed 's/-[^-]*$//'; }
rpm_version() { rpm -qp --qf '%{VERSION}' "$1" 2>/dev/null; }

declare -A version_of=()
for f in "${pool}"/*.deb; do version_of["${f}"]="$(deb_version "${f}")"; done
for f in "${rpms}"/*.rpm; do version_of["${f}"]="$(rpm_version "${f}")"; done
[[ ${#version_of[@]} -gt 0 ]] || fail "no packages at all — nothing to publish"

mapfile -t versions < <(printf '%s\n' "${version_of[@]}" | sort -uV)

drop_version() {
  local v="$1" f
  for f in "${!version_of[@]}"; do
    if [[ "${version_of[${f}]}" == "${v}" ]]; then
      rm -f "${f}"
      unset "version_of[${f}]"
      echo "pruned $(basename "${f}")"
    fi
  done
}

while [[ ${#versions[@]} -gt ${keep} ]]; do
  drop_version "${versions[0]}"
  versions=("${versions[@]:1}")
done

packages_mb() {
  local total=0 f
  for f in "${!version_of[@]}"; do total=$((total + $(stat -c %s "${f}"))); done
  echo $((total / 1024 / 1024))
}
while [[ $(packages_mb) -gt ${budget_mb} && ${#versions[@]} -gt 1 ]]; do
  echo "packages total $(packages_mb) MB > ${budget_mb} MB budget"
  drop_version "${versions[0]}"
  versions=("${versions[@]:1}")
done
[[ $(packages_mb) -le ${budget_mb} ]] \
  || fail "the newest version alone is $(packages_mb) MB, over the ${budget_mb} MB budget (GitHub Pages sites max out at 1 GB)"
echo "publishing versions: ${versions[*]} ($(packages_mb) MB)"

# ── 3. Re-sign the RPMs the current key does not verify ──────────────────────
# Rotation (docs/43): packages published under an earlier key come back from
# fetch-published.sh still signed by it, and once that key leaves
# PACKAGE_SIGNING_KEY nothing accepts that signature any more — not a client,
# not step 7 — so they are signed again with the current key. This is what
# lets a rotation without an overlap, the one a compromise calls for, publish
# at all. While the old key is still in the secret they verify as they are and
# their bytes stay untouched. Before step 5, so the repodata records the bytes
# that are actually published.
gpg --batch --armor --export "${keys[@]}" > "${scratch}/signing-keys.asc"
rpmkeys --dbpath "${scratch}/signing-rpmdb" --initdb 2>/dev/null || true
rpmkeys --dbpath "${scratch}/signing-rpmdb" --import "${scratch}/signing-keys.asc"
for f in "${rpms}"/*.rpm; do
  out="$(rpmkeys --dbpath "${scratch}/signing-rpmdb" --checksig "${f}" 2>&1)" || true
  if [[ "${out}" != *"signatures OK"* ]]; then
    # Only the signature may be stale. A package whose own digests do not add
    # up came back damaged, and signing it again would paper over that.
    out="$(rpmkeys --dbpath "${scratch}/signing-rpmdb" --checksig --nosignature "${f}" 2>&1)" || true
    [[ "${out}" == *"digests OK"* ]] || fail "$(basename "${f}") is damaged: ${out}"
    # --addsign replaces the signature already there, it does not add a second.
    if ! out="$(rpmsign --define "_gpg_name ${keys[0]}" --define "_gpg_path ${GNUPGHOME}" \
        --addsign "${f}" 2>&1)"; then
      fail "rpmsign failed for $(basename "${f}"): ${out}"
    fi
    echo "re-signed $(basename "${f}") with ${keys[0]}"
  fi
done

# ── 4. apt metadata ───────────────────────────────────────────────────────────
dists="${site}/apt/dists/${suite}"
rm -rf "${site}/apt/dists"
for arch in "${deb_arches[@]}"; do
  dir="${dists}/${component}/binary-${arch}"
  mkdir -p "${dir}"
  # Paths in Packages are relative to apt/, the repository root.
  (cd "${site}/apt" && apt-ftparchive --arch "${arch}" packages "pool/${component}") > "${dir}/Packages"
  gzip -9nkf "${dir}/Packages"
done

release_tmp="$(mktemp)"
(cd "${dists}" && apt-ftparchive \
  -o APT::FTPArchive::Release::Origin=AgentVoice \
  -o APT::FTPArchive::Release::Label=AgentVoice \
  -o APT::FTPArchive::Release::Suite="${suite}" \
  -o APT::FTPArchive::Release::Codename="${suite}" \
  -o APT::FTPArchive::Release::Architectures="${deb_arches[*]}" \
  -o APT::FTPArchive::Release::Components="${component}" \
  -o APT::FTPArchive::Release::Description="AgentVoice packages" \
  release .) > "${release_tmp}"
mv "${release_tmp}" "${dists}/Release"
chmod 644 "${dists}/Release"

gpg --batch --yes --digest-algo SHA512 "${signer_args[@]}" \
  --clearsign --output "${dists}/InRelease" "${dists}/Release"
gpg --batch --yes --digest-algo SHA512 "${signer_args[@]}" \
  --armor --detach-sign --output "${dists}/Release.gpg" "${dists}/Release"

# ── 5. dnf metadata ───────────────────────────────────────────────────────────
# gz, not the zstd newer createrepo_c defaults to, so EL8's dnf can read it.
# No sqlite databases: dnf never reads them and they only cost Pages space.
rm -rf "${site}/rpm/repodata"
createrepo_c --quiet --no-database --general-compress-type=gz "${site}/rpm" >/dev/null
gpg --batch --yes --digest-algo SHA512 "${signer_args[@]}" \
  --armor --detach-sign --output "${site}/rpm/repodata/repomd.xml.asc" "${site}/rpm/repodata/repomd.xml"

# ── 6. Key, client config, landing page ───────────────────────────────────────
gpg --batch --armor --export "${keys[@]}" > "${site}/agentvoice.asc"

cat > "${site}/rpm/${package}.repo" <<REPO
[${package}]
name=AgentVoice
baseurl=${base_url}/rpm
enabled=1
gpgcheck=1
repo_gpgcheck=1
gpgkey=${base_url}/agentvoice.asc
metadata_expire=6h
REPO

cat > "${site}/apt/${package}.sources" <<SOURCES
Types: deb
URIs: ${base_url}/apt
Suites: ${suite}
Components: ${component}
Architectures: ${deb_arches[*]}
Signed-By: /etc/apt/keyrings/${package}.asc
SOURCES

newest="${versions[${#versions[@]}-1]}"
fingerprints="$(printf '%s<br>\n' "${keys[@]}")"
cat > "${site}/index.html" <<HTML
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AgentVoice package repositories</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 48rem; margin: 2rem auto; padding: 0 1rem; color: #1b1b1b; }
  pre { background: #f3f3f3; padding: .75rem 1rem; overflow-x: auto; border-radius: 6px; }
  code { font-family: ui-monospace, monospace; font-size: .9em; }
  @media (prefers-color-scheme: dark) { body { background: #151515; color: #e6e6e6; } pre { background: #242424; } }
</style>
</head>
<body>
<h1>AgentVoice package repositories</h1>
<p>Signed apt and dnf repositories for
<a href="https://github.com/dixonSolutions/AgentVoice">AgentVoice</a>, amd64 and arm64.
Newest version: <strong>${newest}</strong>. Published versions: ${versions[*]}.</p>

<h2>Debian / Ubuntu (apt)</h2>
<pre><code>sudo install -d -m 0755 /etc/apt/keyrings
sudo curl -fsSL ${base_url}/agentvoice.asc -o /etc/apt/keyrings/agentvoice.asc
sudo curl -fsSL ${base_url}/apt/agentvoice.sources -o /etc/apt/sources.list.d/agentvoice.sources
sudo apt update
sudo apt install agentvoice</code></pre>
<p>Upgrades then arrive with <code>sudo apt update &amp;&amp; sudo apt upgrade</code>.</p>

<h2>Fedora / RHEL (dnf)</h2>
<pre><code>sudo curl -fsSL ${base_url}/rpm/agentvoice.repo -o /etc/yum.repos.d/agentvoice.repo
sudo dnf install agentvoice</code></pre>
<p>Upgrades then arrive with <code>sudo dnf upgrade</code>. dnf asks you to confirm the key on first use.</p>

<h2>After installing</h2>
<pre><code>systemctl --user enable --now agentvoice
loginctl enable-linger "\$USER"
agentvoice status</code></pre>

<h2>Signing key</h2>
<p><a href="agentvoice.asc">agentvoice.asc</a> — fingerprint(s):<br>
<code>${fingerprints}</code></p>
</body>
</html>
HTML

# What the next run's fetch-published.sh downloads to keep older versions.
(cd "${site}" && find apt/pool rpm/packages -type f \( -name '*.deb' -o -name '*.rpm' \) \
  | sort | xargs -r sha256sum) > "${site}/manifest.txt"

# ── 7. Verify what is about to be published, with only the public key ────────
gpg --batch --quiet --dearmor --output "${scratch}/keyring.gpg" < "${site}/agentvoice.asc"
gpgv --quiet --keyring "${scratch}/keyring.gpg" "${dists}/InRelease" 2>/dev/null \
  || fail "InRelease does not verify against agentvoice.asc"
gpgv --quiet --keyring "${scratch}/keyring.gpg" "${dists}/Release.gpg" "${dists}/Release" 2>/dev/null \
  || fail "Release.gpg does not verify against agentvoice.asc"
gpgv --quiet --keyring "${scratch}/keyring.gpg" \
  "${site}/rpm/repodata/repomd.xml.asc" "${site}/rpm/repodata/repomd.xml" 2>/dev/null \
  || fail "repomd.xml.asc does not verify against agentvoice.asc"

rpmkeys --dbpath "${scratch}/rpmdb" --initdb 2>/dev/null || true
rpmkeys --dbpath "${scratch}/rpmdb" --import "${site}/agentvoice.asc"
for f in "${rpms}"/*.rpm; do
  out="$(rpmkeys --dbpath "${scratch}/rpmdb" --checksig "${f}" 2>&1)" || fail "$(basename "${f}"): ${out}"
  [[ "${out}" == *"signatures OK"* ]] || fail "$(basename "${f}") is not signed by the published key: ${out}"
done

for arch in "${deb_arches[@]}"; do
  count="$(grep -c "^Package: ${package}$" "${dists}/${component}/binary-${arch}/Packages" || true)"
  echo "apt ${arch}: ${count} package(s)"
done
echo "dnf: $(find "${rpms}" -name '*.rpm' | wc -l) package(s)"
echo "repositories built and verified in ${site}"
