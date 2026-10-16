#!/usr/bin/env bash
# Move an AgentVoice install to Squeakr (docs/45) — npm, .deb / .rpm, or a
# clone. Run it as yourself, not root: the system steps use sudo, and the last
# step (moving ~/.agentvoice and the background service) has to run as the
# user the bridge runs as.
#
#   curl -fsSL https://raw.githubusercontent.com/dixonSolutions/Squeakr/main/scripts/migrate-to-squeakr.sh | bash
#   bash scripts/migrate-to-squeakr.sh --dry-run        # from a clone
#
# What it does, each step only when it applies, each one safe to repeat:
#
#   1. apt / dnf source   dixonsolutions.github.io/AgentVoice → /Squeakr (GitHub
#                         Pages does not redirect after the repo rename, so the
#                         old source 404s). Same signing key, renamed file.
#   2. system package     apt / dnf: install `squeakr`, which replaces
#                         `agentvoice` (Conflicts + Replaces / Obsoletes).
#   3. npm package        @ratitisrad/agentvoice installed globally →
#                         `npm install -g squeakr`.
#   4. clone              origin → dixonSolutions/Squeakr, pull, build.
#   5. your install       `squeakr upgrade-from-agentvoice`: ~/.agentvoice →
#                         ~/.squeakr (config, keys, pairing token, history,
#                         logs, wake-word model; a symlink is left behind),
#                         the agentvoice service replaced by squeakr's, the old
#                         npm package removed.
#
# Options:
#   --dry-run       print what would happen, change nothing
#   --clone DIR     migrate the clone in DIR (default: the current directory,
#                   when it is one)
#   --keep-old      leave @ratitisrad/agentvoice installed
#   --repo-only     step 1 only, as root, no sudo, quiet when there is nothing
#                   to do — what the squeakr package's postinstall runs
#   --system-only   steps 1 and 2 only — what `squeakr upgrade-from-agentvoice`
#                   runs when it finds the agentvoice .deb / .rpm
set -euo pipefail

OLD_URL='https://dixonsolutions.github.io/AgentVoice'
NEW_URL='https://dixonsolutions.github.io/Squeakr'
OLD_PKG_NPM='@ratitisrad/agentvoice'
NEW_PKG='squeakr'
NEW_REPO='dixonSolutions/Squeakr'

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
    -h|--help) sed -n '2,40p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//'; exit 0 ;;
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

# ── 1. apt / dnf source ──────────────────────────────────────────────────────
migrate_repo_source() {
  local files=() f
  for f in /etc/apt/sources.list /etc/apt/sources.list.d/*.list /etc/apt/sources.list.d/*.sources /etc/yum.repos.d/*.repo; do
    [ -f "$f" ] && grep -qF "$OLD_URL" "$f" 2>/dev/null && files+=("$f")
  done
  if [ ${#files[@]} -eq 0 ]; then
    skip "no apt / dnf source points at ${OLD_URL}"
    return 0
  fi

  # Before the GitHub rename the new URL does not exist yet and the old one
  # still works: switching then would break `apt update` until it does.
  if ! url_answers "${NEW_URL}/squeakr.asc"; then
    skip "${NEW_URL} does not answer yet — your source stays on ${OLD_URL}, which still works; run this again after the move"
    return 0
  fi

  for f in "${files[@]}"; do
    local dir base new
    dir="$(dirname "$f")"; base="$(basename "$f")"
    case "$base" in
      agentvoice.sources) new="${dir}/squeakr.sources" ;;
      agentvoice.list)    new="${dir}/squeakr.list" ;;
      agentvoice.repo)    new="${dir}/squeakr.repo" ;;
      *)                  new="$f" ;;
    esac
    if $dry; then would "rewrite ${f} → ${new} (${OLD_URL} → ${NEW_URL})"; continue; fi

    local tmp; tmp="$(mktemp)"
    sed -e "s#${OLD_URL}#${NEW_URL}#g" \
        -e 's#/etc/apt/keyrings/agentvoice\.asc#/etc/apt/keyrings/squeakr.asc#g' \
        -e 's#/agentvoice\.asc#/squeakr.asc#g' \
        -e 's#^\[agentvoice\]$#[squeakr]#' \
        -e 's#^name=AgentVoice$#name=Squeakr#' "$f" > "$tmp"
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
  if grep -qsF '/etc/apt/keyrings/squeakr.asc' /etc/apt/sources.list.d/* /etc/apt/sources.list 2>/dev/null \
     && [ ! -f /etc/apt/keyrings/squeakr.asc ]; then
    if $dry; then would "write /etc/apt/keyrings/squeakr.asc"; return 0; fi
    as_root install -d -m 0755 /etc/apt/keyrings
    if [ -f /etc/apt/keyrings/agentvoice.asc ]; then
      as_root cp /etc/apt/keyrings/agentvoice.asc /etc/apt/keyrings/squeakr.asc
    else
      local key; key="$(mktemp)"
      curl -fsSL "${NEW_URL}/squeakr.asc" -o "$key" || die "could not download ${NEW_URL}/squeakr.asc"
      as_root install -m 0644 "$key" /etc/apt/keyrings/squeakr.asc
      rm -f "$key"
    fi
    as_root rm -f /etc/apt/keyrings/agentvoice.asc
    done_ key /etc/apt/keyrings/squeakr.asc
  fi
}

# ── 2. the .deb / .rpm ───────────────────────────────────────────────────────
deb_installed() { dpkg-query -W -f='${Status}' "$1" 2>/dev/null | grep -q 'install ok installed'; }
rpm_installed() { rpm -q "$1" >/dev/null 2>&1; }

migrate_system_package() {
  if command -v dpkg-query >/dev/null 2>&1 && deb_installed agentvoice; then
    if $dry; then would "apt-get install squeakr (replaces agentvoice)"; return 0; fi
    as_root apt-get update || warn "apt-get update reported errors — trying the install anyway"
    as_root apt-get install -y squeakr || die "apt-get install squeakr failed"
    deb_installed agentvoice && as_root apt-get remove -y agentvoice
    done_ package "agentvoice → squeakr (apt)"
  elif command -v rpm >/dev/null 2>&1 && rpm_installed agentvoice; then
    if $dry; then would "dnf install squeakr (obsoletes agentvoice)"; return 0; fi
    as_root dnf install -y squeakr || die "dnf install squeakr failed"
    rpm_installed agentvoice && as_root dnf remove -y agentvoice
    done_ package "agentvoice → squeakr (dnf)"
  else
    skip "no agentvoice .deb / .rpm installed"
  fi
}

# ── 3. the npm package ───────────────────────────────────────────────────────
npm_has() { npm ls -g "$1" --depth=0 >/dev/null 2>&1; }

migrate_npm_package() {
  if ! command -v npm >/dev/null 2>&1; then skip "npm not found"; return 0; fi
  if ! npm_has "$OLD_PKG_NPM"; then skip "${OLD_PKG_NPM} is not installed globally"; return 0; fi
  if npm_has "$NEW_PKG"; then done_ ok "squeakr is already installed"; return 0; fi
  if $dry; then would "npm install -g squeakr"; return 0; fi
  # Its postinstall sees the old package beside it and points the background
  # service at Squeakr straight away (bin/postinstall.mjs).
  npm install -g "$NEW_PKG" || die "npm install -g squeakr failed"
  done_ installed "squeakr (npm)"
}

# ── 4. a clone ───────────────────────────────────────────────────────────────
migrate_clone() {
  local dir="$1" origin
  origin="$(git -C "$dir" remote get-url origin 2>/dev/null || true)"
  case "$origin" in
    *dixonSolutions/AgentVoice*|*dixonSolutions/Cursor-Voice*|*dixonSolutions/Squeakr*) ;;
    *) skip "${dir} is not a clone of ${NEW_REPO}"; return 1 ;;
  esac
  local next
  next="$(printf '%s' "$origin" | sed -E 's#dixonSolutions/(AgentVoice|Cursor-Voice)#dixonSolutions/Squeakr#')"
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
say "  ${B}AgentVoice → Squeakr${R}$($dry && printf ' — dry run, nothing will change')"
say ''

if [ "$mode" != repo ] && [ "$(id -u)" = 0 ] && [ "$mode" = all ]; then
  warn "running as root: only the system steps run. Afterwards, as the user the bridge runs as:"
  warn "    squeakr upgrade-from-agentvoice"
  mode=system
fi

migrate_repo_source
migrate_system_package
[ "$mode" = system ] && exit 0

migrate_npm_package

# A clone: the one asked for, or the current directory when it is one.
squeakr_cmd=(squeakr)
if [ -z "$clone" ] && git rev-parse --show-toplevel >/dev/null 2>&1; then
  top="$(git rev-parse --show-toplevel)"
  if [ -f "${top}/package.json" ] && grep -qE '"name": "(squeakr|@ratitisrad/agentvoice)"' "${top}/package.json"; then
    clone="$top"
  fi
fi
if [ -n "$clone" ] && migrate_clone "$clone"; then
  squeakr_cmd=(node "${clone}/bin/squeakr.mjs")
fi

# ── 5. home, service, old npm package ────────────────────────────────────────
if ! $dry && [ "${squeakr_cmd[0]}" = squeakr ] && ! command -v squeakr >/dev/null 2>&1; then
  if [ ! -d "${HOME}/.agentvoice" ]; then
    say ''
    say "  Nothing to migrate: no AgentVoice install found. New here? ${B}npm install -g squeakr${R}"
    exit 0
  fi
  die "squeakr is not installed — install it first:  npm install -g squeakr"
fi
args=(upgrade-from-agentvoice --skip-system)
$dry && args+=(--dry-run)
$keep_old && args+=(--keep-old)
if $dry && ! command -v "${squeakr_cmd[0]}" >/dev/null 2>&1; then
  would "${squeakr_cmd[*]} ${args[*]}"
  exit 0
fi
exec "${squeakr_cmd[@]}" "${args[@]}"
