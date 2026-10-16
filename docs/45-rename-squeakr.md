# 44 — Rename: AgentVoice → Squeakr

> Added: October 2026. Follows [`26-rename-agentvoice.md`](./26-rename-agentvoice.md)
> (Cursor Voice → AgentVoice).

## Why

"AgentVoice" is an established commercial product name: an AI call-automation
platform listed on G2, Capterra and TrustRadius. It owns the search results, and
it sits close enough to this project (AI + voice agents) to be a trademark risk
once the npm package and the VS Code extension get noticed. **Squeakr** was
clear on npm (plain and `-cli`) and had no product of that name in a web search.

## Stage A — this release (0.2.0)

What people see and type:

| Surface | Before | Now | Old name still works? |
| --- | --- | --- | --- |
| Display name (PWA, CallKit, push titles, CLI output, docs, site, banner) | AgentVoice | Squeakr | — |
| npm package | `@ratitisrad/agentvoice` | `squeakr` (unscoped) | final 0.1.6 release hands over — see below |
| CLI command | `agentvoice` | `squeakr` | `/usr/bin/agentvoice` in the .deb/.rpm; npm installs only `squeakr` (two packages sharing one bin name would collide on `npm i -g`) |
| Environment variables | `AGENTVOICE_*` | `SQUEAKR_*` | yes — every reader falls back to `AGENTVOICE_*` (`src/brand.ts#brandEnv`, `${SQUEAKR_X:-${AGENTVOICE_X:-…}}` in scripts) |
| Bridge home | `~/.agentvoice` | `~/.squeakr` | yes — used until `squeakr upgrade-from-agentvoice` moves it, then a symlink |
| Askpass helper env | `AGENTVOICE_BRIDGE_URL` / `_ASKPASS_TOKEN` | `SQUEAKR_*` | regenerated on every boot |
| Spoken project aliases | "agent voice" | adds "squeakr", "squeaker" | yes |
| Version | 0.1.5 | 0.2.0 | — |

## Stage B — deliberately not yet

Each of these is load-bearing for an install that is running right now.
Renaming them needs its own migration and its own release:

| Surface | Kept as | Why |
| --- | --- | --- |
| systemd unit | `agentvoice.service` (+ `-watch.path`, `-tunnel`, `-caddy`) | a renamed unit orphans the enabled one; `serve/index.ts`, `update.sh`, the .deb all restart it by name |
| launchd label | `com.agentvoice.bridge` | same, on macOS |
| Windows service | `AgentVoice` | NSSM service; renaming needs an elevated reinstall |
| .deb / .rpm package | `agentvoice` | a new package name stops `apt upgrade` / `dnf upgrade` moving installs forward; needs a transitional package |
| apt/dnf repo + landing page | `dixonsolutions.github.io/AgentVoice/` | GitHub Pages does **not** redirect after a repo rename — every configured apt/dnf source would 404 |
| MCP server key / tool prefix | `agent-voice`, `mcp__agent-voice__*` | users' agent permission allowlists name it |
| Config keys, internal symbols | `agentVoiceEnabled`, `agentVoice` bookkeeping, `agentVoicePrompt.ts` | internal; a rename buys nothing |
| Shim file | `bin/agentvoice.mjs` | existing units' `ExecStart` point at it by path |
| Browser caches | `agentvoice-vosk-v2`, `agentvoice-models-v1` | renaming them re-downloads the 41 MB wake-word model on every device |
| Mobile bundle id | `com.cursorvoice.app` | unchanged since docs/26 — changing it invalidates APNs device tokens |

## Moving an install over

### npm (global) — the common case

```bash
npm install -g squeakr
squeakr upgrade-from-agentvoice --dry-run   # see the plan
squeakr upgrade-from-agentvoice
```

Or, from the old install, one command that does both:

```bash
agentvoice migrate-to-squeakr               # needs @ratitisrad/agentvoice 0.1.6
```

What happens, step by step:

1. **`npm install -g squeakr`.** Its postinstall sees
   `node_modules/@ratitisrad/agentvoice` beside it and re-points the
   background service at Squeakr (`service install --force --now`), then
   restarts it. The bridge is now Squeakr, still reading `~/.agentvoice`.
2. **`squeakr upgrade-from-agentvoice`**:
   - stops the service, so nothing writes mid-move;
   - **moves the home** `~/.agentvoice` → `~/.squeakr` — `config.json`, `.env`
     (provider keys and the pairing `APP_TOKEN`, so paired devices keep
     working), `data/state.db` (jobs, sessions, history), `logs/`,
     transcripts and the `vosk/` model — with one `rename`, so nothing is
     copied or re-encoded;
   - leaves `~/.agentvoice` as a **symlink** to `~/.squeakr`;
   - rewrites the service for this install and this home, and starts it;
   - in a clone, switches `origin` to `dixonSolutions/Squeakr` (below);
   - runs `npm rm -g @ratitisrad/agentvoice`.

Every step is idempotent — a second run reports "already" for each. It
refuses to merge if both `~/.agentvoice` and `~/.squeakr` hold a home; carry
just the config and keys with `squeakr migrate ~/.agentvoice --with-data`
instead. A custom `$AGENTVOICE_HOME` is left where it is (the env fallback
keeps finding it). `--keep-old` leaves the old package installed,
`--keep-remote` leaves `origin` alone.

The in-app update on the Serve page of 0.1.6 does step 1 for you; run step 2
from a terminal afterwards.

### Clone

```bash
git pull                                    # main is Squeakr
npm ci --legacy-peer-deps && npm run build
node bin/agentvoice.mjs upgrade-from-agentvoice
```

A clone is its own home, so only `~/.agentvoice/vosk` moves. The **remote**:
`origin` is switched from `dixonSolutions/AgentVoice` (or `Cursor-Voice`) to
`dixonSolutions/Squeakr`, keeping https vs ssh — but only once the new URL
answers `git ls-remote`, so running it before the GitHub rename is harmless.
By hand:

```bash
git remote set-url origin https://github.com/dixonSolutions/Squeakr.git
```

### .deb / .rpm

`sudo apt upgrade` / `sudo dnf upgrade` — the package keeps the name
`agentvoice` in stage A, so it moves forward as usual and adds
`/usr/bin/squeakr`. `squeakr upgrade-from-agentvoice` moves the home when
you like; until then `~/.agentvoice` keeps being used.

### Windows

Same as npm, from an **elevated** terminal (the service is NSSM-wrapped and
keeps the name `AgentVoice`).

## Releasing it — the order matters

1. **Merge** this PR. `npm-publish.yml` publishes `squeakr@0.2.0` — the
   first version of a **new package name**, so Trusted Publishing cannot do
   it: set the `NPM_TOKEN` repository secret (granular, allowed to publish
   new packages, "bypass 2FA" on) first. Then configure Trusted Publishing on
   `squeakr` on npmjs.com and delete the secret again.
2. **Release the hand-over**: branch `release/agentvoice-final` (cut from
   v0.1.5) holds `@ratitisrad/agentvoice@0.1.6` — `migrate-to-squeakr`, a
   notice on every command, and an in-app update that installs `squeakr`.
   Push tag `v0.1.6` on that branch to publish it. It must ship *after*
   step 1, because it installs `squeakr`.
3. **Deprecate** the old package so every install and `npm view` points over:
   ```bash
   npm deprecate @ratitisrad/agentvoice "Renamed to squeakr. Run: agentvoice migrate-to-squeakr (or npm i -g squeakr && squeakr upgrade-from-agentvoice)"
   ```
4. **Rename the GitHub repo** (Settings → General → Repository name →
   `Squeakr`). Repo, clone, issue and PR URLs redirect. Pages URLs do not —
   see stage B.
5. After a few weeks: **archive** — delete `release/agentvoice-final`
   (the `v0.1.6` tag keeps the code), and leave the deprecation in place.
6. The VS Code extension is not in this repo; rename it wherever it is published, the
   same way (new extension id, final release of the old one pointing over).
