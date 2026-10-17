#!/usr/bin/env bash
# Move a Squeakr or AgentVoice install to Squeaky (docs/45, docs/46) — npm,
# .deb / .rpm, or a clone. Run it as yourself, not root: the system steps use
# sudo, and the last step (moving ~/.squeakr or ~/.agentvoice and the
# background service) has to run as the user the bridge runs as.
#
#   curl -fsSL https://raw.githubusercontent.com/dixonSolutions/Squeaky/main/scripts/migrate-to-squeaky.sh | bash
#   bash scripts/migrate-to-squeaky.sh --dry-run        # from a clone
#
# What it does, each step only when it applies, each one safe to repeat:
#
#   1. apt / dnf source   dixonsolutions.github.io/Squeakr or /AgentVoice →
#                         /Squeaky (GitHub Pages does not redirect after a repo
#                         rename, so the old source 404s). Same signing key,
#                         renamed file.
#   2. system package     apt / dnf: install `squeaky`, which replaces
#                         `squeakr` and `agentvoice` (Conflicts + Replaces /
#                         Obsoletes).
#   3. npm package        squeakr or @ratitisrad/agentvoice installed globally
#                         → `npm install -g squeaky-cli`.
#   4. clone              origin → dixonSolutions/Squeaky, pull, build.
#   5. your install       `squeaky upgrade-from-squeakr`: ~/.squeakr or
#                         ~/.agentvoice → ~/.squeaky (config, keys, pairing
#                         token, history, logs, wake-word model; a symlink is
#                         left behind), the old service replaced by squeaky's,
#                         the old npm package removed.
#
# Options:
#   --dry-run       print what would happen, change nothing
#   --clone DIR     migrate the clone in DIR (default: the current directory,
#                   when it is one)
#   --keep-old      leave the old npm package (squeakr / @ratitisrad/agentvoice)
#                   installed
#   --repo-only     step 1 only, as root, no sudo, quiet when there is nothing
#                   to do — what the squeaky package's postinstall runs
#   --system-only   steps 1 and 2 only — what `squeaky upgrade-from-squeakr`
#                   runs when it finds the squeakr / agentvoice .deb / .rpm
set -euo pipefail

# Every earlier name, newest first.
OLD_URLS=('https://dixonsolutions.github.io/Squeakr' 'https://dixonsolutions.github.io/AgentVoice')
OLD_NAMES=(squeakr agentvoice)
OLD_PKGS_NPM=(squeakr '@ratitisrad/agentvoice')
NEW_URL='https://dixonsolutions.github.io/Squeaky'
NEW_PKG='squeaky-cli'
NEW_REPO='dixonSolutions/Squeaky'
KEYRINGS=/etc/apt/keyrings

dry=false
mode=all
clone=''
keep_old=false
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) dry=true ;;
    --repo-only) mode=repo ;;
    --system-only) mode=system ;;
    --keep-old) keep_old=true ;;
    --clone) shift; clone="${1:?--clone needs a directory}" ;;
    --clone=*) clone="${1#--clone=}" ;;
    -h|--help) sed -n '2,37p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
  shift
done

quiet=false
[ "$mode" = repo ] && quiet=true

if [ -t 1 ]; then B=$'\e[1m'; G=$'\e[32m'; Y=$'\e[33m'; D=$'\e[2m'; R=$'\e[0m'; else B='' G='' Y='' D='' R=''; fi
say()  { $quiet || printf '%s\n' "$*"; }
done_() { say "  ${G}$1${R}  $2"; }
would() { say "  ${Y}would${R}  $*"; }
skip() { say "  ${D}skip${R}  $*"; }
warn() { printf '  %swarn%s  %s\n' "$Y" "$R" "$*" >&2; }
die()  { printf '  error  %s\n' "$*" >&2; exit 1; }

# Root for the system steps: already root (postinstall), else sudo.
as_root() {
  if [ "$(id -u)" = 0 ]; then "$@"; else sudo "$@"; fi
}

url_answers() { curl -fsSL -o /dev/null --max-time 15 "$1" 2>/dev/null; }

APT_SOURCES=(/etc/apt/sources.list /etc/apt/sources.list.d/*.list /etc/apt/sources.list.d/*.sources)
# Does any apt source mention $1?
apt_mentions() { grep -qsF "$1" "${APT_SOURCES[@]}" 2>/dev/null; }

# ── 1. apt / dnf source ──────────────────────────────────────────────────────
migrate_repo_source() {
  local files=() f u
  for f in "${APT_SOURCES[@]}" /etc/yum.repos.d/*.repo; do
    [ -f "$f" ] || continue
    for u in "${OLD_URLS[@]}"; do
      if grep -qF "$u" "$f" 2>/dev/null; then files+=("$f"); break; fi
    done
  done
  if [ ${#files[@]} -eq 0 ]; then
    skip "no apt / dnf source points at ${OLD_URLS[*]}"
    return 0
  fi

  # Before the GitHub rename the new URL does not exist yet and the old one
  # still works: switching then would break `apt update` until it does.
  if ! url_answers "${NEW_URL}/squeaky.asc"; then
    skip "${NEW_URL} does not answer yet — your source stays where it is, which still works; run this again after the move"
    return 0
  fi

  local apt_touched=false
  for f in "${files[@]}"; do
    local dir base new
    dir="$(dirname "$f")"; base="$(basename "$f")"
    case "$base" in
      squeakr.sources|agentvoice.sources) new="${dir}/squeaky.sources" ;;
      squeakr.list|agentvoice.list)       new="${dir}/squeaky.list" ;;
      squeakr.repo|agentvoice.repo)       new="${dir}/squeaky.repo" ;;
      *)                                  new="$f" ;;
    esac
    case "$new" in *.repo) ;; *) apt_touched=true ;; esac
    if $dry; then would "rewrite ${f} → ${new} (→ ${NEW_URL})"; continue; fi

    local tmp sed_args=() u
    tmp="$(mktemp)"
    for u in "${OLD_URLS[@]}"; do sed_args+=(-e "s#${u}#${NEW_URL}#g"); done
    sed "${sed_args[@]}" \
        -e "s#${KEYRINGS}/\\(squeakr\\|agentvoice\\)\\.asc#${KEYRINGS}/squeaky.asc#g" \
        -e 's#/\(squeakr\|agentvoice\)\.asc#/squeaky.asc#g' \
        -e 's#^\[\(squeakr\|agentvoice\)\]$#[squeaky]#' \
        -e 's#^name=\(Squeakr\|AgentVoice\)$#name=Squeaky#' "$f" > "$tmp"
    # dnf fails the whole command on one unreachable repo unless told not to.
    case "$new" in
      *.repo) grep -q '^skip_if_unavailable=' "$tmp" || printf 'skip_if_unavailable=1\n' >> "$tmp" ;;
    esac
    as_root install -m 0644 "$tmp" "$new"
    rm -f "$tmp"
    [ "$new" != "$f" ] && as_root rm -f "$f"
    done_ source "${new} → ${NEW_URL}"
  done

  # apt: the key is trusted for this repository only (signed-by). Same key,
  # new file name.
  if [ ! -f "${KEYRINGS}/squeaky.asc" ] && { $apt_touched || apt_mentions "${KEYRINGS}/squeaky.asc"; }; then
    if $dry; then
      would "write ${KEYRINGS}/squeaky.asc"
    else
      as_root install -d -m 0755 "$KEYRINGS"
      local old copied=false
      for old in "${OLD_NAMES[@]}"; do
        if [ -f "${KEYRINGS}/${old}.asc" ]; then
          as_root cp "${KEYRINGS}/${old}.asc" "${KEYRINGS}/squeaky.asc"
          copied=true
          break
        fi
      done
      if ! $copied; then
        local key; key="$(mktemp)"
        curl -fsSL "${NEW_URL}/squeaky.asc" -o "$key" || die "could not download ${NEW_URL}/squeaky.asc"
        as_root install -m 0644 "$key" "${KEYRINGS}/squeaky.asc"
        rm -f "$key"
      fi
      done_ key "${KEYRINGS}/squeaky.asc"
    fi
  fi

  # The old key files, once no source points at them any more.
  if ! $dry; then
    local old
    for old in "${OLD_NAMES[@]}"; do
      if [ -f "${KEYRINGS}/${old}.asc" ] && [ -f "${KEYRINGS}/squeaky.asc" ] && ! apt_mentions "${KEYRINGS}/${old}.asc"; then
        as_root rm -f "${KEYRINGS}/${old}.asc"
        done_ removed "${KEYRINGS}/${old}.asc"
      fi
    done
  fi
}

# ── 2. the .deb / .rpm ───────────────────────────────────────────────────────
deb_installed() { dpkg-query -W -f='${Status}' "$1" 2>/dev/null | grep -q 'install ok installed'; }
rpm_installed() { rpm -q "$1" >/dev/null 2>&1; }

migrate_system_package() {
  local old
  for old in "${OLD_NAMES[@]}"; do
    if command -v dpkg-query >/dev/null 2>&1 && deb_installed "$old"; then
      if $dry; then would "apt-get install squeaky (replaces ${old})"; return 0; fi
      as_root apt-get update || warn "apt-get update reported errors — trying the install anyway"
      as_root apt-get install -y squeaky || die "apt-get install squeaky failed"
      if deb_installed "$old"; then as_root apt-get remove -y "$old"; fi
      done_ package "${old} → squeaky (apt)"
      return 0
    elif command -v rpm >/dev/null 2>&1 && rpm_installed "$old"; then
      if $dry; then would "dnf install squeaky (obsoletes ${old})"; return 0; fi
      as_root dnf install -y squeaky || die "dnf install squeaky failed"
      if rpm_installed "$old"; then as_root dnf remove -y "$old"; fi
      done_ package "${old} → squeaky (dnf)"
      return 0
    fi
  done
  skip "no squeakr / agentvoice .deb / .rpm installed"
}

# ── 3. the npm package ───────────────────────────────────────────────────────
npm_has() { npm ls -g "$1" --depth=0 >/dev/null 2>&1; }

migrate_npm_package() {
  if ! command -v npm >/dev/null 2>&1; then skip "npm not found"; return 0; fi
  local old found=''
  for old in "${OLD_PKGS_NPM[@]}"; do
    if npm_has "$old"; then found="$old"; break; fi
  done
  if [ -z "$found" ]; then skip "neither ${OLD_PKGS_NPM[0]} nor ${OLD_PKGS_NPM[1]} is installed globally"; return 0; fi
  if npm_has "$NEW_PKG"; then done_ ok "${NEW_PKG} is already installed"; return 0; fi
  if $dry; then would "npm install -g ${NEW_PKG} (beside ${found})"; return 0; fi
  # Its postinstall sees the old package beside it and points the background
  # service at Squeaky straight away (bin/postinstall.mjs).
  npm install -g "$NEW_PKG" || die "npm install -g ${NEW_PKG} failed"
  done_ installed "${NEW_PKG} (npm)"
}

# ── 4. a clone ───────────────────────────────────────────────────────────────
migrate_clone() {
  local dir="$1" origin
  origin="$(git -C "$dir" remote get-url origin 2>/dev/null || true)"
  case "$origin" in
    *dixonSolutions/AgentVoice*|*dixonSolutions/Cursor-Voice*|*dixonSolutions/Squeakr*|*dixonSolutions/Squeaky*) ;;
    *) skip "${dir} is not a clone of ${NEW_REPO}"; return 1 ;;
  esac
  local next
  next="$(printf '%s' "$origin" | sed -E 's#dixonSolutions/(AgentVoice|Cursor-Voice|Squeakr)#dixonSolutions/Squeaky#')"
  if [ "$next" != "$origin" ]; then
    if git ls-remote --heads "$next" >/dev/null 2>&1; then
      if $dry; then would "git remote set-url origin ${next}"; else
        git -C "$dir" remote set-url origin "$next"; done_ remote "origin → ${next}"; fi
    else
      skip "${next} does not answer yet — origin stays ${origin} (GitHub redirects it)"
    fi
  fi
  if $dry; then would "git pull --ff-only, npm ci, npm run build in ${dir}"; return 0; fi
  git -C "$dir" pull --ff-only || die "git pull failed in ${dir} — commit or stash your changes, then re-run"
  (cd "$dir" && npm ci --no-audit --no-fund --legacy-peer-deps && npm run build) || die "build failed in ${dir}"
  done_ built "${dir}"
}

# ── run ──────────────────────────────────────────────────────────────────────
if [ "$mode" = repo ]; then
  migrate_repo_source || true
  exit 0
fi

say ''
say "  ${B}Squeakr / AgentVoice → Squeaky${R}$($dry && printf ' — dry run, nothing will change')"
say ''

if [ "$(id -u)" = 0 ] && [ "$mode" = all ]; then
  warn "running as root: only the system steps run. Afterwards, as the user the bridge runs as:"
  warn "    squeaky upgrade-from-squeakr"
  mode=system
fi

migrate_repo_source
migrate_system_package
[ "$mode" = system ] && exit 0

migrate_npm_package

# A clone: the one asked for, or the current directory when it is one. The
# name in package.json is any generation's (a clone not pulled yet still says
# squeakr or @ratitisrad/agentvoice).
squeaky_cmd=(squeaky)
if [ -z "$clone" ] && git rev-parse --show-toplevel >/dev/null 2>&1; then
  top="$(git rev-parse --show-toplevel)"
  if [ -f "${top}/package.json" ] && grep -qE '"name": "(squeaky-cli|squeakr|@ratitisrad/agentvoice)"' "${top}/package.json"; then
    clone="$top"
  fi
fi
if [ -n "$clone" ] && migrate_clone "$clone"; then
  squeaky_cmd=(node "${clone}/bin/squeaky.mjs")
fi

# ── 5. home, service, old npm package ────────────────────────────────────────
legacy_home=''
for name in "${OLD_NAMES[@]}"; do
  if [ -d "${HOME}/.${name}" ]; then legacy_home="${HOME}/.${name}"; break; fi
done
if [ "${squeaky_cmd[0]}" = squeaky ] && ! command -v squeaky >/dev/null 2>&1; then
  if [ -z "$legacy_home" ]; then
    say ''
    say "  Nothing to migrate: no Squeakr or AgentVoice install found. New here? ${B}npm install -g ${NEW_PKG}${R}"
    exit 0
  fi
  $dry || die "squeaky is not installed — install it first:  npm install -g ${NEW_PKG}"
fi
args=(upgrade-from-squeakr --skip-system)
$dry && args+=(--dry-run)
$keep_old && args+=(--keep-old)
# A dry run cannot use a CLI that is not there yet: not installed, or a clone
# that is not pulled to the Squeaky layout and built (step 4 only said it would).
if $dry && { ! command -v "${squeaky_cmd[0]}" >/dev/null 2>&1 ||
             { [ "${squeaky_cmd[0]}" = node ] && { [ ! -f "${squeaky_cmd[1]}" ] || [ ! -f "${clone}/dist/cli.js" ]; }; }; }; then
  would "${squeaky_cmd[*]} ${args[*]}"
  exit 0
fi
exec "${squeaky_cmd[@]}" "${args[@]}"
