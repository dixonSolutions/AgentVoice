#!/usr/bin/env bash
#
# Import the package-signing key into a throwaway GNUPGHOME so the repository
# build can sign without prompting (docs/43).
#
#   PACKAGE_SIGNING_KEY         armored private key(s) — required. May hold more
#                               than one key during a rotation; the FIRST one
#                               signs the RPMs, all of them sign the apt Release
#                               files and repomd.xml (docs/43, "Rotation").
#   PACKAGE_SIGNING_PASSPHRASE  optional — preset into gpg-agent so neither
#                               gpg nor rpmsign ever asks for it.
#   GNUPGHOME                   required, and must be a directory nobody else
#                               uses: the key is imported into it.
#
# Prints the fingerprints of the imported secret keys, one per line, first key
# first. A missing or unusable key is a hard failure: an unsigned repository is
# never published.

set -euo pipefail

fail() { echo "::error::$*" >&2; exit 1; }

[[ -n "${GNUPGHOME:-}" ]] || fail "GNUPGHOME must be set to a private, temporary directory"
if [[ -z "${PACKAGE_SIGNING_KEY:-}" ]]; then
  fail "PACKAGE_SIGNING_KEY is not set. The apt/dnf repositories are never published unsigned — see docs/43-package-repos.md for the one-time key setup (gh secret set PACKAGE_SIGNING_KEY < key.asc)."
fi
case "${PACKAGE_SIGNING_KEY}" in
  *"BEGIN PGP PRIVATE KEY BLOCK"*) ;;
  *) fail "PACKAGE_SIGNING_KEY is not an armored private key (expected '-----BEGIN PGP PRIVATE KEY BLOCK-----'; export it with gpg --armor --export-secret-keys)" ;;
esac

mkdir -p "${GNUPGHOME}"
chmod 700 "${GNUPGHOME}"

# Preset passphrases instead of --passphrase on every call: rpmsign builds its
# own gpg command line, and this is the one mechanism both it and gpg honour.
cat > "${GNUPGHOME}/gpg-agent.conf" <<'CONF'
allow-preset-passphrase
default-cache-ttl 7200
max-cache-ttl 7200
CONF
# apt rejects SHA-1 signatures; never let a default pick it.
cat > "${GNUPGHOME}/gpg.conf" <<'CONF'
personal-digest-preferences SHA512 SHA384 SHA256
cert-digest-algo SHA512
CONF
gpgconf --kill gpg-agent >/dev/null 2>&1 || true

printf '%s\n' "${PACKAGE_SIGNING_KEY}" | gpg --batch --quiet --import 2>/dev/null \
  || fail "PACKAGE_SIGNING_KEY could not be imported by gpg"

mapfile -t fprs < <(gpg --batch --with-colons --list-secret-keys \
  | awk -F: '$1=="sec"{want=1; next} want && $1=="fpr"{print $10; want=0}')
[[ ${#fprs[@]} -gt 0 ]] || fail "PACKAGE_SIGNING_KEY contained no secret key"

if [[ -n "${PACKAGE_SIGNING_PASSPHRASE:-}" ]]; then
  preset="$(gpgconf --list-dirs libexecdir)/gpg-preset-passphrase"
  [[ -x "${preset}" ]] || fail "gpg-preset-passphrase not found at ${preset}"
  gpg-connect-agent /bye >/dev/null 2>&1
  # Every secret keygrip — primary and subkeys — since gpg may pick a signing
  # subkey rather than the primary.
  while read -r grip; do
    printf '%s' "${PACKAGE_SIGNING_PASSPHRASE}" | "${preset}" --preset "${grip}"
  done < <(gpg --batch --with-colons --with-keygrip --list-secret-keys | awk -F: '$1=="grp"{print $10}')
fi

# Prove every key can actually sign now, non-interactively — a wrong
# passphrase should fail here with a clear message, not halfway through.
for fpr in "${fprs[@]}"; do
  if ! echo probe | gpg --batch --pinentry-mode error --local-user "${fpr}" --clearsign >/dev/null 2>&1; then
    fail "key ${fpr} cannot sign non-interactively — is PACKAGE_SIGNING_PASSPHRASE set and correct? Is the key expired?"
  fi
done

printf '%s\n' "${fprs[@]}"
