# 45 — Rename: AgentVoice → Squeakr

> Added: October 2026. Follows [`26-rename-agentvoice.md`](./26-rename-agentvoice.md)
> (Cursor Voice → AgentVoice).

## Why

"AgentVoice" is an established commercial product name: an AI call-automation
platform listed on G2, Capterra and TrustRadius. It owns the search results, and
it sits close enough to this project (AI + voice agents) to be a trademark risk
once the npm package and the VS Code extension get noticed. **Squeakr** was
free on npm (plain and `-cli`), the VS Code Marketplace, Open VSX, PyPI and
crates.io, as a GitHub account, and had no product of that name in a web
search — the only other users are a 2018 k-mer counter and an R package for
rodent vocalisations, neither near this space.

## What was renamed (0.2.0)

Everything that carried the old names, in one release:

| Surface | Before | Now | What an old install keeps |
| --- | --- | --- | --- |
| Display name (PWA, CallKit, push titles, CLI output, channels, docs, site) | AgentVoice | Squeakr | — |
| npm package | `@ratitisrad/agentvoice` | `squeakr` (unscoped) | the final 0.1.6 hands over — below |
| CLI command | `agentvoice` | `squeakr` | — |
| GitHub repo | `dixonSolutions/AgentVoice` | `dixonSolutions/Squeakr` | GitHub redirects repo, clone, issue and PR URLs |
| Environment variables | `AGENTVOICE_*` | `SQUEAKR_*` | every reader falls back to `AGENTVOICE_*` (`src/brand.ts#brandEnv`, `${SQUEAKR_X:-${AGENTVOICE_X:-…}}` in scripts) |
| Bridge home | `~/.agentvoice` | `~/.squeakr` | used until `squeakr upgrade-from-agentvoice` moves it; then a symlink |
| systemd units | `agentvoice.service`, `-watch.path`, `-tunnel`, `-caddy` | `squeakr.service`, `squeakr-watch.path`, … | retired by `squeakr service install` / the upgrade (`src/cli/legacyService.ts`) |
| launchd label | `com.agentvoice.bridge` | `com.squeakr.bridge` | same |
| Windows service | `AgentVoice` | `Squeakr` | same (elevated terminal) |
| .deb / .rpm | `agentvoice`, `/usr/lib/agentvoice` | `squeakr`, `/usr/lib/squeakr` | `squeakr` Conflicts/Replaces (deb) and Obsoletes (rpm) `agentvoice` |
| apt / dnf repository | `dixonsolutions.github.io/AgentVoice/` | `dixonsolutions.github.io/Squeakr/` | **GitHub Pages does not redirect** — the source has to be moved (below) |
| MCP server key | `agent-voice` (`mcp__agent-voice__*`) | `squeakr` (`mcp__squeakr__*`) | the bridge strips the old key from every agent CLI's config at startup |
| Cursor rule file | `agent-voice.mdc` | `squeakr.mdc` | old file blanked |
| Prompt files | `prompts/agentvoice/` | `prompts/squeakr/` | — |
| "Play the agent's replies aloud" | `agentVoiceEnabled` | `agentSpeechEnabled` | config migrated on load; the API accepts both |
| Speech server container / model volume | `agentvoice-speech`, `agentvoice-speech-models` | `squeakr-speech`, `squeakr-speech-models` | an existing config is pinned to the old names, so models are not downloaded again |
| Cloudflare named tunnel | `agent-voice-<host>` | `squeakr-<host>` | an existing tunnel is reused (its DNS route points at it) |
| PWA model caches | `agentvoice-vosk-v2`, `agentvoice-models-v1` | `squeakr-*` | the service worker copies them over, so the 41 MB wake-word model is not fetched again |
| Mobile app id | `com.cursorvoice.app` | `com.squeakr.app` | a new app id: reinstall the app; it registers a fresh push token |
| Workspace packages | `@agentvoice/client`, `@agentvoice/call-session` | `@squeakr/client`, `@squeakr/call-session` | not published |
| Demo video | `docs/demo/agentvoice-demo.*` | `docs/demo/squeakr-demo.*` | — |

Kept on purpose: `bin/agentvoice.mjs` (a two-line forward to `bin/squeakr.mjs`,
because an AgentVoice-era unit in a clone runs it by path), the legacy readers
in the table's last column, and the spoken project aliases ("agent voice") —
those match a *folder* someone named that, not the product.

## Moving an install over

### One command, any install

```bash
curl -fsSL https://raw.githubusercontent.com/dixonSolutions/Squeakr/main/scripts/migrate-to-squeakr.sh | bash
```

Run it as yourself (it uses `sudo` for the system steps). `--dry-run` shows
the plan first. It works out what you have and does only what applies — every
step is safe to repeat:

1. **apt / dnf source** — any source pointing at `…github.io/AgentVoice` is
   rewritten to `…github.io/Squeakr` (`agentvoice.sources` → `squeakr.sources`,
   `agentvoice.repo` → `squeakr.repo`, the keyring copied to
   `/etc/apt/keyrings/squeakr.asc` — the signing key is the same). Only once
   the new URL answers, so running it early changes nothing.
2. **.deb / .rpm** — `apt-get install squeakr` / `dnf install squeakr`, which
   replaces `agentvoice`.
3. **npm** — `@ratitisrad/agentvoice` installed globally → `npm install -g
   squeakr`; its postinstall points the background service at Squeakr straight
   away.
4. **clone** — `origin` → `dixonSolutions/Squeakr` (keeping https vs ssh),
   `git pull --ff-only`, `npm ci`, `npm run build`.
5. **your install** — `squeakr upgrade-from-agentvoice` (below).

### `squeakr upgrade-from-agentvoice`

The part that runs as you:

- stops the bridge (old or new service), so nothing writes mid-move;
- **moves the home** `~/.agentvoice` → `~/.squeakr` — `config.json`, `.env`
  (provider keys and the pairing `APP_TOKEN`, so paired devices keep working),
  `data/state.db` (jobs, sessions, history), `logs/`, transcripts and the
  `vosk/` model — with one `rename`, so nothing is copied or re-encoded, and
  leaves `~/.agentvoice` as a **symlink** to it;
- **replaces the service**: the AgentVoice unit / agent / Windows service is
  stopped, disabled and removed, its companion units are re-created under
  their `squeakr-*` names (enabled again if they were), and `squeakr.service`
  is written for this install and this home and started;
- on a .deb / .rpm install, runs step 1–2 of the script above;
- in a clone, switches `origin`;
- runs `npm rm -g @ratitisrad/agentvoice`.

It refuses to merge if both `~/.agentvoice` and `~/.squeakr` hold a home;
carry just the config and keys with `squeakr migrate ~/.agentvoice --with-data`
instead. A custom `$AGENTVOICE_HOME` is left where it is (the env fallback
keeps finding it). `--keep-old` leaves the old npm package, `--keep-remote`
leaves `origin` alone, `--dry-run` changes nothing.

### From the old package

`@ratitisrad/agentvoice@0.1.6` — the last release under that name — adds:

```bash
agentvoice migrate-to-squeakr
```

which installs `squeakr` and hands over to `squeakr upgrade-from-agentvoice`.
Every other command of 0.1.6 prints that Squeakr replaces it, and its in-app
update installs `squeakr`.

### .deb / .rpm by hand

```bash
# Debian / Ubuntu
sudo sed -i 's#github.io/AgentVoice#github.io/Squeakr#; s#keyrings/agentvoice.asc#keyrings/squeakr.asc#' /etc/apt/sources.list.d/agentvoice.sources
sudo mv /etc/apt/keyrings/agentvoice.asc /etc/apt/keyrings/squeakr.asc
sudo mv /etc/apt/sources.list.d/agentvoice.sources /etc/apt/sources.list.d/squeakr.sources
sudo apt update && sudo apt install squeakr        # removes agentvoice

# Fedora / RHEL
sudo rm /etc/yum.repos.d/agentvoice.repo
sudo curl -fsSL https://dixonsolutions.github.io/Squeakr/rpm/squeakr.repo -o /etc/yum.repos.d/squeakr.repo
sudo dnf install squeakr                           # obsoletes agentvoice
```

The `squeakr` package's postinstall also moves the source and hands the user
service over (stops `agentvoice.service` for every logged-in user, starts
`squeakr.service` where it ran).

## Releasing it — the order matters

1. **Publish `squeakr@0.2.0`, merge, tag.** It is the first version of a
   **new package name**, which Trusted Publishing cannot create. Either set
   the `NPM_TOKEN` repository secret (granular, allowed to publish new
   packages, "bypass 2FA" on) and merge — `npm-publish.yml` publishes — or, as
   was done: `npm login` and `npm publish` from a maintainer's terminal (in a
   TTY, so npm's browser 2FA works), then merge, then push tag `v0.2.0`: a
   hand-pushed tag builds the .deb / .rpm and deploys the Pages site even
   though npm already has the version. Configure Trusted Publishing on
   `squeakr` on npmjs.com afterwards. The site is still served at
   `/AgentVoice/` until step 4, with every link already pointing at
   `/Squeakr/`.
2. **Release the hand-over**: push tag `v0.1.6` on `release/agentvoice-final`
   (cut from v0.1.5). It publishes `@ratitisrad/agentvoice@0.1.6` through the
   existing Trusted Publisher — which is bound to the repo name, so **before
   step 4** — and, with `NPM_TOKEN` set, deprecates the package. It builds no
   .deb / .rpm and deploys no site.
3. **Deprecate**, if step 2 could not:
   ```bash
   npm deprecate @ratitisrad/agentvoice "Renamed to squeakr. Run: agentvoice migrate-to-squeakr (or npm i -g squeakr && squeakr upgrade-from-agentvoice)"
   ```
4. **Rename the GitHub repo** to `Squeakr`. The Pages site moves to
   `/Squeakr/` with it; `/AgentVoice/` 404s from here on, which is what step 1
   of the migration script is for.
5. After a few weeks: **archive** — delete `release/agentvoice-final`
   (the `v0.1.6` tag keeps the code), and leave the deprecation in place.
6. The VS Code extension is not in this repo; rename it wherever it is
   published, the same way (new extension id, a final release of the old one
   pointing over).
