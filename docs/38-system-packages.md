# 38 — System packages (.deb / .rpm)

> Added: September 2026. **Implemented** through step 3 of the plan below —
> see the status section at the bottom. Companion to
> [`21-serve-self-hosting.md`](./21-serve-self-hosting.md) and
> [`35-cli.md`](./35-cli.md).

Should AgentVoice ship as a system package for `apt` and `dnf`, alongside the
npm package and git clone?

## Decision (2026-09-15)

Tracked in [#58](https://github.com/dixonSolutions/AgentVoice/issues/58); the `http-proxy` bug is [#59](https://github.com/dixonSolutions/AgentVoice/issues/59).

**Build .deb and .rpm packages now.** (The brainstorm recommended an
`install.sh` one-liner first and packages later; the maintainer chose
packages now. The npm fixes below are prerequisites either way.)

## Prerequisites found while investigating

- **`http-proxy` is a devDependency but imported at runtime.**
  `src/webDispatch.ts` has a top-level `import httpProxy from 'http-proxy'`,
  and the built `dist/index.js` keeps it, while `package.json` lists it only
  under `devDependencies`. A production-only install (`npm i -g`, or a
  package's pruned `node_modules`) likely fails at startup. Verify with a clean
  global install; fix by moving it to `dependencies` or loading it lazily in
  dev mode only.
- **Runtime dependencies are bloated.** Angular, Capacitor, `vosk-browser`,
  `vad-web`, `primeicons` sit in `dependencies` though the server never
  imports them. The only native runtime module is `better-sqlite3` (external
  in `tsup.config.ts`, checked by `checkNativeBinding()`).
- **npm installs have no service installer.** `noUnitAdvice()` points at
  `scripts/install-systemd.sh`, which npm users don't have — port it to
  `agentvoice service install`.

## Package contents

| Part | Source | Note |
| --- | --- | --- |
| Bridge + CLI | `dist/index.js`, `dist/cli.js` | trivial |
| PWA | `web/dist/` (~85 MB, mostly Silero VAD / onnxruntime wasm) | architecture-independent |
| Native module | `better-sqlite3` | ABI-bound → one package per arch (amd64, arm64) |
| Node runtime | bundled in `/usr/lib/agentvoice/node` (~100 MB) | Debian 12 / Ubuntu 24.04 ship Node 18; `engines` needs ≥ 20 |
| Vosk wake model (~41 MB) | `agentvoice prepare-vosk` | today writes into `<root>/web/dist/vosk` — read-only under `/usr/lib`; move to `~/.agentvoice/vosk` |
| Speech server | Docker / Podman image | not packaged; `Suggests: podman` |

Bundling Node is the realistic option: the `better-sqlite3` binary always
matches its runtime, at the cost of owning Node security updates.

## Service integration

The bridge must run **as the developer**: it spawns `claude`, `cursor-agent`,
`codex` with their credentials, writes `~/.cursor/mcp.json`,
`~/.codex/config.toml`, `~/.claude.json`, and edits the user's projects. The
repo's system unit (`agentvoice.service`, `User=agentvoice`) only suits a
dedicated server.

- Ship a **user** unit at `/usr/lib/systemd/user/agentvoice.service`
  (`ExecStart=/usr/bin/agentvoice run`), **enabled out of the box**: on a fresh
  install (not upgrades) post-install runs `systemctl --global enable`, so it
  starts at every user's login, and starts it at once for the `SUDO_USER`
  when their user manager is running. It listens on 127.0.0.1 only.
  `AGENTVOICE_NO_SERVICE=1` skips it; pre-remove disables it again. Linger
  (`loginctl enable-linger`) stays the user's choice and is suggested, not set.
- Config stays per user in `~/.agentvoice` (`resolveHome()`).
- A user unit's minimal `PATH` won't find `~/.local/bin/claude`: add a drop-in
  or make agent-CLI discovery independent of `PATH`.
- Optionally ship a disabled `agentvoice@.service` template for servers.

## A third install mode: `system`

- `src/serve/installMode.ts`: `InstallMode = 'git' | 'npm' | 'system' |
  'unknown'`. Detect by root under `/usr/lib/agentvoice` / `/opt/agentvoice` or
  a shipped marker file (`<root>/.install-source` = `deb` | `rpm`), checked
  **before** the `node_modules` test.
- `updateCommand` from `/etc/os-release`:
  `sudo apt install --only-upgrade agentvoice` or `sudo dnf upgrade agentvoice`.
- `canSelfUpdate()` is false; the Serve UI shows a copyable command instead of
  an update button (today's "Reinstall with npm" message must change);
  `agentvoice update` prints the command or runs it via `sudo -n`.
- `src/cli/versions.ts` can still query the npm registry for display.
- Package scripts cannot restart other users' user units → `status` shows
  "restart required" after an upgrade.

## Build and publish

| Step | Effort | Note |
| --- | --- | --- |
| **nfpm in GitHub Actions**, attach .deb/.rpm to the GitHub Release | 2–3 days | job after `release` in `.github/workflows/npm-publish.yml`: `npm ci --omit=dev`, fetch Node, nfpm, per arch |
| **Hosted repo** for `apt upgrade` / `dnf upgrade` — Cloudsmith or packagecloud | +1 day | hosted signing; free OSS tiers |
| Self-hosted repo (Pages/R2 + `reprepro` / `createrepo_c` + GPG) | +2–4 days, ongoing | own key rotation |
| Fedora COPR | 3–5 days | offline builds; vendoring npm deps is painful |
| Ubuntu PPA | 1–2 weeks | source-only offline builds — not recommended |
| Also cheap: Homebrew tap, AUR `PKGBUILD`, Nix flake | 0.5–3 days each | community channels |
| Flatpak / Snap | — | sandbox blocks spawning host CLIs and reading `~/.claude` — not suitable |

## Plan

1. Fix `http-proxy`, trim runtime `dependencies`, add `agentvoice service
   install`.
2. Add the `system` install mode and move the Vosk model under the user home.
3. nfpm .deb/.rpm with bundled Node (amd64 + arm64) on each GitHub Release.
4. Hosted signed apt/dnf repository.
5. Optional: Homebrew tap, AUR.

## Open questions

- Target audience: headless servers (system unit, dedicated user) or developer
  laptops (user unit)?
- arm64 from day one (Raspberry Pi, Graviton)?
- Bundle the Vosk model in the package?
- Who owns the signing key and repo hosting?
- May the in-app update ever run `sudo`, or only show the command?

## Status — implemented September 2026

Plan steps 1–3 shipped:

1. **`http-proxy`** ([#59](https://github.com/dixonSolutions/AgentVoice/issues/59))
   is loaded lazily inside the dev-only proxy path, so a production install no
   longer crashes at boot. Angular, Capacitor, `vosk-browser`, `vad-web`,
   `primeicons` and `zone.js` moved out of runtime `dependencies`; what is left
   is only what the server imports. `agentvoice service install` writes a
   systemd **user** unit from whatever install is running, which is the answer
   for npm and package users alike — `noUnitAdvice()` used to point them at a
   shell script that only exists in a clone.
2. **The `system` install mode** is detected from a shipped `.install-source`
   marker, checked *before* the `node_modules` test — a .deb carries a pruned
   `node_modules`, so the npm heuristic would otherwise claim it and offer
   `npm i -g`, installing a second copy the service does not run.
   `canSelfUpdate()` is false for it and the Serve page shows the `apt` / `dnf`
   command with a copy button. The Vosk model moved to `~/.agentvoice/vosk`,
   which the bridge serves in preference to the packaged copy.
3. **nfpm .deb and .rpm** with a bundled Node, amd64 and arm64, built and
   attached to each GitHub Release by `.github/workflows/npm-publish.yml`.

One more prerequisite turned up while testing the package, and it was worse
than the `http-proxy` one: **`prompts/` was neither published nor resolvable
outside a clone**, so `readAgentVoicePrompt` looked only next to `config.json`
and every MCP `initialize` on an npm or package install answered 500. No agent
could connect at all. Prompts are now published, staged into the package, and
resolved from the bridge home first and the install root second.

Not shipped:

4. **A hosted signed apt / dnf repository.** It needs a signing key and hosting
   that the maintainer owns; the packages are attached to each GitHub Release
   and install with `apt install ./agentvoice_*.deb` in the meantime.
5. Homebrew tap and AUR, which were optional in the plan.

Open questions answered by the implementation: the target is developer laptops
(hence a user unit, not a system one), arm64 is in from day one, the Vosk model
is not bundled, and the in-app update never runs `sudo` — it shows the command.
