#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# AgentVoice — THE update script.
#
# This is the single, centralized update path. The Serve config page calls it
# for both of its buttons; run it by hand and you get exactly the same thing.
# Nothing else in this repo pulls, rebases, installs, builds and restarts.
#
# What it does, in order:
#   1. preflight   — repo sanity, git/node/npm resolution
#   2. git_fetch   — fetch origin (pruned)
#   3. git_target  — resolve the branch to rebase onto (origin/<branch>)
#   4. git_scan    — local changes, incoming changes, and the overlap of the two
#   5. git_stash   — only with --stash, and only when the tree is dirty
#   6. git_rebase  — rebase onto origin/<branch>
#   7. git_stash_pop — restore the stash (rebase failure restores it too)
#   8. deps        — npm ci, falling back to npm install
#   9. build       — npm run build (backend + PWA)
#  10. restart     — systemctl restart, user unit or system unit (auto-detected)
#  11. health      — GET /healthz on the configured backend port
#
# Usage:
#   bash scripts/update.sh                      # rebase & update (clean tree required)
#   bash scripts/update.sh --stash              # stash, rebase & update, restore stash
#   bash scripts/update.sh --branch main        # override the track branch
#   bash scripts/update.sh --dry-run            # report only; changes nothing
#   bash scripts/update.sh --force              # rebuild/restart even with no new commits
#   bash scripts/update.sh --no-restart         # update + build, leave the service alone
#
# Options:
#   --stash             Stash local changes (including untracked) before the rebase
#                       and pop them afterwards. Without it, a dirty tree is a
#                       hard failure — that is what the two Serve buttons are.
#   --branch <name>     Rebase onto origin/<name>. Default: settings.serve.branch
#                       from config.json, else origin's default branch, else main.
#   --repo <dir>        Repository root. Default: the parent of this script.
#   --run-id <id>       Correlation id stamped on every structured step line.
#   --log-file <path>   NDJSON step log. Default: <repo>/data/serve-update.jsonl.
#   --dry-run           Report what would happen; never writes the worktree,
#                       never installs, builds or restarts.
#   --force             Do the full deps/build/restart even when already up to date.
#   --no-restart        Skip the systemd restart (and the health check).
#
# Every step emits one NDJSON line to the log file and one human line to stdout:
#   {"runId":…,"ts":…,"step":"git_rebase","status":"ok","detail":"…"}
# status is one of ok | skip | warn | error. The bridge ingests this file into
# the serve_event step log, which is what the Serve page streams.
#
# Exit status: 0 on success (including "already up to date"), 1 on any failure.
# See docs/21-serve-self-hosting.md.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── Options ───────────────────────────────────────────────────────────────
STASH_MODE=false
DRY_RUN=false
FORCE=false
DO_RESTART=true
TRACK_BRANCH=""
PROJECT_DIR=""
RUN_ID=""
LOG_FILE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --stash)      STASH_MODE=true; shift;;
    --dry-run)    DRY_RUN=true; shift;;
    --force)      FORCE=true; shift;;
    --no-restart) DO_RESTART=false; shift;;
    --branch)     TRACK_BRANCH="${2:-}"; shift 2;;
    --repo)       PROJECT_DIR="${2:-}"; shift 2;;
    --run-id)     RUN_ID="${2:-}"; shift 2;;
    --log-file)   LOG_FILE="${2:-}"; shift 2;;
    -h|--help)
      grep '^#' "$0" | grep -v '!/usr/bin' | sed 's/^# \?//'
      exit 0;;
    *) echo "Unknown option: $1" >&2; exit 2;;
  esac
done

PROJECT_DIR="$(cd "${PROJECT_DIR:-${SCRIPT_DIR}/..}" && pwd)"
cd "$PROJECT_DIR"

RUN_ID="${RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)-$$}"
LOG_FILE="${LOG_FILE:-${PROJECT_DIR}/data/serve-update.jsonl}"
MODE_LABEL=$([[ "$STASH_MODE" == true ]] && echo 'stash-update' || echo 'update')

GRN='\033[0;32m'; YEL='\033[1;33m'; BLU='\033[0;34m'; RED='\033[0;31m'
CYN='\033[0;36m'; BLD='\033[1m'; NC='\033[0m'

# ── Structured step emission ──────────────────────────────────────────────
# One NDJSON line per step for the bridge, one coloured line for a human.
json_escape() {
  # Portable JSON string escaping without depending on node/jq being usable yet.
  printf '%s' "$1" | LC_ALL=C sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' \
    -e 's/\t/\\t/g' -e "s/$(printf '\r')/\\\\r/g" | awk 'BEGIN{ORS=""} {if (NR>1) print "\\n"; print}'
}

emit() {
  local step="$1" status="$2" detail="${3:-}"
  local ts; ts="$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)"
  if [[ -n "$LOG_FILE" ]]; then
    mkdir -p "$(dirname "$LOG_FILE")" 2>/dev/null || true
    printf '{"runId":"%s","ts":"%s","step":"%s","status":"%s","detail":"%s"}\n' \
      "$(json_escape "$RUN_ID")" "$ts" "$(json_escape "$step")" \
      "$(json_escape "$status")" "$(json_escape "$detail")" >> "$LOG_FILE" 2>/dev/null || true
  fi
  local colour="$BLU"
  case "$status" in
    ok)    colour="$GRN";;
    warn)  colour="$YEL";;
    skip)  colour="$CYN";;
    error) colour="$RED";;
  esac
  echo -e "${colour}[${step}]${NC} ${status}${detail:+ — ${detail}}"
}

FINISHED=false

fail() {
  local step="$1" detail="$2"
  emit "$step" error "$detail"
  FINISHED=true
  emit finish error "Update failed at ${step}: ${detail}"
  exit 1
}

# Anything that kills the script without going through fail() (an unguarded
# non-zero command under set -e, a signal) still writes a terminal step, so the
# Serve step log never just stops mid-run with no explanation.
on_exit() {
  local rc=$?
  if [[ $rc -ne 0 && "$FINISHED" != true ]]; then
    emit finish error "Update aborted (exit ${rc})"
  fi
}
trap on_exit EXIT

# ── 1. Preflight ──────────────────────────────────────────────────────────
emit start ok "${MODE_LABEL}$([[ "$DRY_RUN" == true ]] && echo ' (dry run)') in ${PROJECT_DIR}"

command -v git >/dev/null 2>&1 || fail preflight "git not found on PATH"
[[ -f "${PROJECT_DIR}/package.json" ]] || fail preflight "package.json not found in ${PROJECT_DIR}"
git -C "$PROJECT_DIR" rev-parse --git-dir >/dev/null 2>&1 \
  || fail preflight "${PROJECT_DIR} is not a git repository"
git -C "$PROJECT_DIR" remote get-url origin >/dev/null 2>&1 \
  || fail preflight "no 'origin' remote configured in ${PROJECT_DIR}"

# A rebase or merge left half-finished would corrupt everything below it.
GIT_DIR_ABS="$(git -C "$PROJECT_DIR" rev-parse --absolute-git-dir)"
if [[ -d "${GIT_DIR_ABS}/rebase-merge" || -d "${GIT_DIR_ABS}/rebase-apply" ]]; then
  fail preflight "a rebase is already in progress — resolve it (git rebase --abort) and re-run"
fi

# Prefer the Node the service actually runs, so the build matches the runtime.
SERVICE_NODE=""
for unit in "${HOME}/.config/systemd/user/agentvoice.service" /etc/systemd/system/agentvoice.service; do
  [[ -f "$unit" ]] || continue
  SERVICE_NODE="$(grep -oP '(?<=ExecStart=)\S+node' "$unit" 2>/dev/null || true)"
  [[ -n "$SERVICE_NODE" ]] && break
done
NODE_BIN="${SERVICE_NODE:-$(command -v node || true)}"
[[ -n "$NODE_BIN" ]] || fail preflight "node not found on PATH"
NPM_BIN="$(dirname "$NODE_BIN")/npm"
[[ -x "$NPM_BIN" ]] || NPM_BIN="$(command -v npm || true)"
[[ -n "$NPM_BIN" ]] || fail preflight "npm not found on PATH"

emit preflight ok "node=${NODE_BIN} npm=${NPM_BIN}"

# ── 2. Fetch ──────────────────────────────────────────────────────────────
if [[ "$DRY_RUN" == true ]]; then
  git -C "$PROJECT_DIR" fetch --dry-run origin >/dev/null 2>&1 \
    || fail git_fetch "git fetch --dry-run origin failed"
  emit git_fetch skip "dry run — refs left untouched"
else
  FETCH_ERR="$(git -C "$PROJECT_DIR" fetch --prune origin 2>&1 >/dev/null)" \
    || fail git_fetch "${FETCH_ERR:-git fetch origin failed}"
  # origin/HEAD is what "follow origin's default branch" resolves through.
  git -C "$PROJECT_DIR" remote set-head origin -a >/dev/null 2>&1 || true
  emit git_fetch ok "fetched origin"
fi

# ── 3. Resolve the track branch ───────────────────────────────────────────
if [[ -z "$TRACK_BRANCH" && -f "${PROJECT_DIR}/config.json" ]]; then
  TRACK_BRANCH="$(
    "$NODE_BIN" -e '
      try {
        const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
        process.stdout.write(String(c?.settings?.serve?.branch ?? "").trim());
      } catch {}
    ' "${PROJECT_DIR}/config.json" 2>/dev/null || true
  )"
fi
if [[ -z "$TRACK_BRANCH" ]]; then
  TRACK_BRANCH="$(
    git -C "$PROJECT_DIR" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null \
      | sed 's|^origin/||' || true
  )"
fi
TRACK_BRANCH="${TRACK_BRANCH:-main}"
UPSTREAM_REF="origin/${TRACK_BRANCH}"

git -C "$PROJECT_DIR" rev-parse --verify --quiet "${UPSTREAM_REF}^{commit}" >/dev/null \
  || fail git_target "${UPSTREAM_REF} does not exist — check the track branch setting"

HEAD_BRANCH="$(git -C "$PROJECT_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo HEAD)"
HEAD_SHA="$(git -C "$PROJECT_DIR" rev-parse HEAD)"
UPSTREAM_SHA="$(git -C "$PROJECT_DIR" rev-parse "$UPSTREAM_REF")"
COUNTS="$(git -C "$PROJECT_DIR" rev-list --left-right --count "HEAD...${UPSTREAM_REF}" 2>/dev/null || echo '0	0')"
AHEAD="$(echo "$COUNTS" | cut -f1)"
BEHIND="$(echo "$COUNTS" | cut -f2)"
emit git_target ok "head=${HEAD_BRANCH}@${HEAD_SHA:0:8} track=${UPSTREAM_REF}@${UPSTREAM_SHA:0:8} ahead=${AHEAD} behind=${BEHIND}"

# ── 4. Scan: local changes vs incoming changes ────────────────────────────
# "Conflicting" here means a file that is dirty locally AND touched by the
# commits we are about to rebase onto — the files the rebase would fight over.
# LC_ALL=C throughout: comm refuses to run unless both inputs were sorted with
# the same collation, and git paths are raw bytes.
LOCAL_FILES="$(git -C "$PROJECT_DIR" status --porcelain --untracked-files=all \
  | sed 's/^.\{3\}//' | sed 's/^.* -> //' | sed 's/^"\(.*\)"$/\1/' | LC_ALL=C sort -u)"
INCOMING_FILES="$(git -C "$PROJECT_DIR" diff --name-only "HEAD..${UPSTREAM_REF}" 2>/dev/null | LC_ALL=C sort -u)"
CONFLICT_FILES=""
if [[ -n "$LOCAL_FILES" && -n "$INCOMING_FILES" ]]; then
  CONFLICT_FILES="$(LC_ALL=C comm -12 \
    <(printf '%s\n' "$LOCAL_FILES") <(printf '%s\n' "$INCOMING_FILES") || true)"
fi
LOCAL_COUNT="$([[ -n "$LOCAL_FILES" ]] && printf '%s\n' "$LOCAL_FILES" | wc -l || echo 0)"
CONFLICT_COUNT="$([[ -n "$CONFLICT_FILES" ]] && printf '%s\n' "$CONFLICT_FILES" | wc -l || echo 0)"
DIRTY=false
[[ "$LOCAL_COUNT" -gt 0 ]] && DIRTY=true

if [[ "$CONFLICT_COUNT" -gt 0 ]]; then
  emit git_scan warn "${LOCAL_COUNT} local change(s), ${CONFLICT_COUNT} also changed upstream: $(printf '%s' "$CONFLICT_FILES" | tr '\n' ' ')"
else
  emit git_scan ok "${LOCAL_COUNT} local change(s), no overlap with incoming commits"
fi

# Without --stash a dirty tree is a hard stop: git rebase would refuse anyway,
# and half-refusing is worse than saying so plainly.
if [[ "$DIRTY" == true && "$STASH_MODE" != true ]]; then
  DIRTY_MSG="local changes present — re-run with --stash (Serve: 'Stash, rebase & update') or commit them first: $(printf '%s' "$LOCAL_FILES" | tr '\n' ' ')"
  if [[ "$DRY_RUN" == true ]]; then
    emit git_scan warn "$DIRTY_MSG"
  else
    fail git_scan "$DIRTY_MSG"
  fi
fi

# ── Nothing to do? ────────────────────────────────────────────────────────
if [[ "$BEHIND" -eq 0 && "$HEAD_SHA" == "$UPSTREAM_SHA" && "$FORCE" != true && -f "${PROJECT_DIR}/dist/index.js" ]]; then
  emit git_rebase skip "already at ${UPSTREAM_REF}"
  emit finish ok "Already up to date with ${UPSTREAM_REF} — nothing to build or restart (--force overrides)"
  trap - EXIT
  exit 0
fi

if [[ "$DRY_RUN" == true ]]; then
  emit git_rebase skip "dry run — would rebase ${HEAD_BRANCH} onto ${UPSTREAM_REF}"
  [[ "$STASH_MODE" == true && "$DIRTY" == true ]] && emit git_stash skip "dry run — would stash ${LOCAL_COUNT} local change(s)"
  emit deps skip "dry run — would run npm ci"
  emit build skip "dry run — would run npm run build"
  emit restart skip "dry run — would restart agentvoice.service"
  emit finish ok "Dry run complete — ${BEHIND} commit(s) behind ${UPSTREAM_REF}"
  trap - EXIT
  exit 0
fi

# ── 5. Stash ──────────────────────────────────────────────────────────────
STASHED=false
if [[ "$STASH_MODE" == true && "$DIRTY" == true ]]; then
  if git -C "$PROJECT_DIR" stash push --include-untracked \
       -m "agentvoice update ${RUN_ID}" >/dev/null 2>&1; then
    STASHED=true
    emit git_stash ok "stashed ${LOCAL_COUNT} local change(s)"
  else
    fail git_stash "could not stash local changes"
  fi
elif [[ "$STASH_MODE" == true ]]; then
  emit git_stash skip "working tree already clean"
fi

restore_stash() {
  [[ "$STASHED" == true ]] || return 0
  if git -C "$PROJECT_DIR" stash pop >/dev/null 2>&1; then
    emit git_stash_pop ok "restored local changes"
  else
    emit git_stash_pop warn "stash could not be popped cleanly — it is kept; resolve with: git stash list / git stash pop"
  fi
  STASHED=false
}

# ── 6. Rebase ─────────────────────────────────────────────────────────────
if REBASE_ERR="$(git -C "$PROJECT_DIR" rebase "$UPSTREAM_REF" 2>&1 >/dev/null)"; then
  NEW_SHA="$(git -C "$PROJECT_DIR" rev-parse HEAD)"
  emit git_rebase ok "rebased onto ${UPSTREAM_REF} (${HEAD_SHA:0:8} → ${NEW_SHA:0:8})"
else
  git -C "$PROJECT_DIR" rebase --abort >/dev/null 2>&1 || true
  restore_stash
  fail git_rebase "${REBASE_ERR:-rebase failed}"
fi

# ── 7. Restore the stash ──────────────────────────────────────────────────
restore_stash

# ── 8. Dependencies ───────────────────────────────────────────────────────
# npm ci is the honest install for a lockfile that just moved; it fails on a
# lockfile/package.json mismatch, where npm install is the documented fallback
# this repo already uses (see .github/workflows and scripts/restart.sh).
if ! "$NPM_BIN" ci --no-audit --no-fund --prefer-offline >/dev/null 2>&1; then
  emit deps warn "npm ci failed — falling back to npm install --legacy-peer-deps"
  "$NPM_BIN" install --no-audit --no-fund --legacy-peer-deps \
    || fail deps "npm install failed"
fi
"$NPM_BIN" rebuild >/dev/null 2>&1 || emit deps warn "npm rebuild reported errors (native modules may be stale)"
emit deps ok "dependencies installed"

# ── 9. Build ──────────────────────────────────────────────────────────────
BUILD_START=$SECONDS
if BUILD_ERR="$("$NPM_BIN" run build 2>&1 >/dev/null)"; then
  emit build ok "backend + PWA built in $((SECONDS - BUILD_START))s"
else
  fail build "${BUILD_ERR:-npm run build failed}"
fi
[[ -f "${PROJECT_DIR}/dist/index.js" ]] || fail build "dist/index.js missing after build"

# ── 10. Restart ───────────────────────────────────────────────────────────
if [[ "$DO_RESTART" != true ]]; then
  emit restart skip "--no-restart"
else
  UNIT='agentvoice.service'
  if systemctl --user cat "$UNIT" >/dev/null 2>&1; then
    systemctl --user restart "$UNIT" || fail restart "systemctl --user restart ${UNIT} failed"
    sleep 1
    if systemctl --user is-active --quiet "$UNIT"; then
      emit restart ok "user unit ${UNIT} restarted"
    else
      fail restart "user unit ${UNIT} did not come back — journalctl --user -u ${UNIT} -n 50"
    fi
  elif systemctl cat "$UNIT" >/dev/null 2>&1; then
    SUDO=()
    [[ "$(id -u)" -eq 0 ]] || SUDO=(sudo -n)
    "${SUDO[@]}" systemctl restart "$UNIT" \
      || fail restart "systemctl restart ${UNIT} failed (passwordless sudo required for a system unit)"
    sleep 1
    if systemctl is-active --quiet "$UNIT"; then
      emit restart ok "system unit ${UNIT} restarted"
    else
      fail restart "system unit ${UNIT} did not come back — journalctl -u ${UNIT} -n 50"
    fi
  else
    fail restart "no ${UNIT} found (user or system) — install one with: bash scripts/install-systemd.sh"
  fi
fi

# ── 11. Health ────────────────────────────────────────────────────────────
if [[ "$DO_RESTART" != true ]]; then
  emit health skip "--no-restart"
else
  # The listener binds settings.runModes.serve.backendPort from config.json,
  # which is independent of .env's PORT — probing PORT reports false failures.
  BACKEND_PORT="$(
    "$NODE_BIN" -e '
      try {
        const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
        process.stdout.write(String(c?.settings?.runModes?.serve?.backendPort ?? ""));
      } catch {}
    ' "${CONFIG_PATH:-${PROJECT_DIR}/config.json}" 2>/dev/null || true
  )"
  if [[ -z "$BACKEND_PORT" && -f "${PROJECT_DIR}/.env" ]]; then
    BACKEND_PORT="$(grep -E '^PORT=' "${PROJECT_DIR}/.env" | tail -1 | cut -d= -f2 | tr -d '[:space:]' || true)"
  fi
  BACKEND_PORT="${BACKEND_PORT:-8787}"

  # The bridge serves HTTPS itself when it holds a cert (src/tls.ts); those are
  # usually self-signed, so -k. This is a loopback liveness probe, not identity.
  SCHEME=http; CURL_TLS=()
  if grep -qE '^HTTPS_(CERT|KEY)_PATH=.+' "${PROJECT_DIR}/.env" 2>/dev/null; then
    SCHEME=https; CURL_TLS=(-k)
  fi
  HEALTH_URL="${SCHEME}://127.0.0.1:${BACKEND_PORT}/healthz"

  HEALTHY=false
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if curl -sf "${CURL_TLS[@]}" --max-time 4 "$HEALTH_URL" >/dev/null 2>&1; then
      HEALTHY=true; break
    fi
    sleep 2
  done
  if [[ "$HEALTHY" == true ]]; then
    emit health ok "$HEALTH_URL"
  else
    emit health warn "no healthy response from ${HEALTH_URL} after 20s — check the service logs"
  fi
fi

NEW_SHA="$(git -C "$PROJECT_DIR" rev-parse HEAD)"
NEW_SUBJECT="$(git -C "$PROJECT_DIR" log -1 --pretty=%s)"
emit finish ok "Updated to ${UPSTREAM_REF} @ ${NEW_SHA:0:8} — ${NEW_SUBJECT}"
trap - EXIT

echo -e "\n${GRN}${BLD}Update complete.${NC}  ${BLU}Logs:${NC} journalctl --user -u agentvoice -f"
exit 0
