# 46 — Rename: Squeakr → Squeaky

> Added: October 2026. Follows [`45-rename-squeakr.md`](./45-rename-squeakr.md)
> (AgentVoice → Squeakr), whose compatibility layer this extends: everything an
> AgentVoice install left behind is still read, and now everything a Squeakr
> install left behind is too.

## Notes on the name

**Squeaky** is an ordinary English word, and one the Vosk wake-word model
knows — "squeakr" was not, which is why the Squeakr default wake phrase was
"hey squeaker". The default is now simply **"hey squeaky"**.

The bare npm name `squeaky` belongs to an unrelated package (an NSQ client),
so the npm package is **`squeaky-cli`**. The command it installs is still
`squeaky`.

## What was renamed

| Surface | Squeakr (0.2.0–0.2.3) | Squeaky | What an old install keeps |
| --- | --- | --- | --- |
| Display name (PWA, CallKit, push titles, CLI output, channels, docs, site) | Squeakr | Squeaky | — |
| npm package | `squeakr` | `squeaky-cli` | `npm i -g squeaky-cli` over it, then `squeaky upgrade-from-squeakr` |
| CLI command | `squeakr` | `squeaky` | `bin/squeakr.mjs` forwards, for a unit in a clone that runs it by path |
| GitHub repo | `dixonSolutions/Squeakr` | `dixonSolutions/Squeaky` | GitHub redirects repo, clone, issue and PR URLs |
| Environment variables | `SQUEAKR_*` | `SQUEAKY_*` | every reader falls back to `SQUEAKR_*`, then `AGENTVOICE_*` (`src/brand.ts#brandEnv`, `${SQUEAKY_X:-${SQUEAKR_X:-${AGENTVOICE_X:-…}}}` in scripts) |
| Bridge home | `~/.squeakr` | `~/.squeaky` | used until `squeaky upgrade-from-squeakr` moves it; then a symlink |
| systemd units | `squeakr.service`, `-watch.path`, `-tunnel`, `-caddy` | `squeaky.service`, `squeaky-watch.path`, … | retired by `squeaky service install` / the upgrade (`src/cli/legacyService.ts`) |
| launchd label | `com.squeakr.bridge` | `com.squeaky.bridge` | same |
| Windows service | `Squeakr` | `Squeaky` | same (elevated terminal) |
| .deb / .rpm | `squeakr`, `/usr/lib/squeakr` | `squeaky`, `/usr/lib/squeaky` | Conflicts/Replaces (deb) and Obsoletes (rpm) both `squeakr` and `agentvoice` |
| apt / dnf repository | `dixonsolutions.github.io/Squeakr/` | `dixonsolutions.github.io/Squeaky/` | **GitHub Pages does not redirect** — `scripts/migrate-to-squeaky.sh` moves the source |
| MCP server key | `squeakr` (`mcp__squeakr__*`) | `squeaky` (`mcp__squeaky__*`) | the bridge strips `squeakr`, `agent-voice` and `cursor-voice` from every agent CLI's config at startup |
| Cursor rule file | `squeakr.mdc` | `squeaky.mdc` | old file blanked |
| Prompt files | `prompts/squeakr/` | `prompts/squeaky/` | — |
| Default wake phrase | "hey squeaker" | "hey squeaky" | an untouched "hey squeaker" (or "cursor listen") default is migrated on load; a phrase you chose is left alone |
| Discord private call rooms | `🎙️ Squeakr · <name>` | `🎙️ Squeaky · <name>` | an old room is still recognised as yours and renamed the next time `call` uses it |
| Cloudflare named tunnel | `squeakr-<host>` | `squeaky-<host>` | an existing `squeakr-*` (or `agent-voice-*`) tunnel is reused (its DNS route points at it) |
| PWA model caches | `squeakr-vosk-v2`, `squeakr-models-v1` | `squeaky-*` | the service worker copies them over, so the 41 MB wake-word model is not fetched again |
| Workspace packages | `@squeakr/client`, `@squeakr/call-session` | `@squeaky/client`, `@squeaky/call-session` | not published |
| Demo video | `docs/demo/squeakr-demo.*` | `docs/demo/squeaky-demo.*` | — |

Kept on purpose:

- the mobile app id `com.squeakr.app`, the Android package
  `com.squeakr.callsession` and its notification channel — changing them means
  reinstalling the app and registering a new push token, for a name nobody sees
  (`APNS_BUNDLE_ID` stays `com.squeakr.app`);
- the speech-server container: a config that set it up without naming it stays
  pinned to `agentvoice-speech` exactly as before (docs/45), and one that named
  `squeakr-speech` keeps that name;
- spoken project matching folds "squeakr", "squeaker" and "squeaky" together,
  so a folder under either name is found by voice.

## Moving an install over

### One command, any install

```bash
curl -fsSL https://raw.githubusercontent.com/dixonSolutions/Squeaky/main/scripts/migrate-to-squeaky.sh | bash -s -- --dry-run   # see the plan
curl -fsSL https://raw.githubusercontent.com/dixonSolutions/Squeaky/main/scripts/migrate-to-squeaky.sh | bash
```

It works out which generation you have — Squeakr or AgentVoice, npm, .deb /
.rpm or a clone — and does only what applies; every step is safe to repeat:

1. **apt / dnf source** pointing at `…github.io/Squeakr` or
   `…github.io/AgentVoice` → `…github.io/Squeaky` (only once the new URL
   answers).
2. **.deb / .rpm** — `apt-get install squeaky` / `dnf install squeaky`, which
   replaces `squeakr` or `agentvoice`.
3. **npm** — `squeakr` or `@ratitisrad/agentvoice` installed globally →
   `npm install -g squeaky-cli`.
4. **clone** — `origin` → `dixonSolutions/Squeaky`, `git pull --ff-only`,
   `npm ci`, `npm run build`.
5. **your install** — `squeaky upgrade-from-squeakr`.

### `squeaky upgrade-from-squeakr`

(`squeaky upgrade-from-agentvoice` is the same command.) It stops the bridge,
moves `~/.squeakr` — or `~/.agentvoice` — to `~/.squeaky` with one `rename`
(config, `.env` with the pairing `APP_TOKEN` so paired devices keep working,
`data/state.db`, logs, transcripts, the Vosk model) and leaves a symlink
behind; replaces the old service with `squeaky.service` for this install and
home; switches a clone's `origin`; and removes the old global npm package.
A custom `$SQUEAKY_HOME` / `$SQUEAKR_HOME` / `$AGENTVOICE_HOME` is left where it
is. `--dry-run`, `--keep-old` and `--keep-remote` work as before.

## Releasing it — the order matters

1. **Publish `squeaky-cli`** — a new package name, so Trusted Publishing
   cannot create it: set `NPM_TOKEN` and merge, or `npm publish` by hand from
   a maintainer's terminal, then push the tag. Configure Trusted Publishing on
   `squeaky-cli` afterwards.
2. **Hand over `squeakr`**: a final `squeakr` release whose commands point at
   `npm i -g squeaky-cli && squeaky upgrade-from-squeakr`, then
   `npm deprecate squeakr "Renamed to squeaky-cli. Run: npm i -g squeaky-cli && squeaky upgrade-from-squeakr"`.
   Like the AgentVoice hand-over, it has to go out through the Trusted
   Publisher **before** the repo is renamed.
3. **Rename the GitHub repo** to `Squeaky`. Pages moves to `/Squeaky/`;
   `/Squeakr/` 404s from then on, which is what step 1 of the migration
   script is for.
4. **Rename the Discord application** in the Developer Portal (the bot's
   username can be changed through the API; the application's name cannot).
