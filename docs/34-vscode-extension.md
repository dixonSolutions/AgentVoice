# 34 — VS Code / Cursor extension: the desk client

> Added: September 2026. Companion to [`23-multi-agent-client.md`](./23-multi-agent-client.md),
> [`33-permissions-and-prompt-relay.md`](./33-permissions-and-prompt-relay.md) and
> [`32-environments-vs-projects.md`](./32-environments-vs-projects.md).

AgentVoice started as a phone-first, hands-free bridge. Half the day, though,
is spent at the desk with an editor open, and there the phone is the wrong
surface: you have a keyboard, you want the agent to see the file you are
looking at, and you want its permission prompt to land where your hands are.
This doc records the second frontend — a VS Code extension that also loads in
Cursor — and what the bridge grew to support it. **The phone model is
unchanged**: the extension is a third client of the same bridge, not a
replacement, and a session started at the desk is the same session the phone
sees (same project, same resume id, same approvals).

## What it is

`vscode/` — a text-first extension packaged as `agentvoice.vsix`:

| Surface | What it does |
| --- | --- |
| Status bar | agent · model/effort/fast · project · pending-approval badge · running jobs; click for a menu |
| **Agent** panel (side bar webview) | read-along transcript of the agent's `speak()` lines, approval cards, activity feed (files written, commands run), a composer |
| **Changes** view | files the agent wrote this session; click → native diff editor against `HEAD` (built-in git extension); *Show all changes* → the full patch; *Revert* → `git stash` |
| **Agents, jobs & sessions** view | conversational agent + worker jobs, recent job history, resumable CLI threads (select one to continue it) |
| Commands | send selection / active file / file diagnostics / free prompt as a turn; use this workspace as the project; pick project, model+effort+fast, permission mode; new session; stop; answer pending approval |
| Notifications | permission prompts (Allow / Deny / Details), questions (yes-no, choice, free text), plan reviews (approve / modify / reject with notes), password prompts (masked input) |

Nothing in the extension is CLI-specific. It talks only to the bridge, so
Cursor, Codex, Claude Code and Codewhale all work through the same code
path (provider rule in `CLAUDE.md`). Model lists, effort levels and
permission modes are whatever the bridge probed from the active CLI.

Cursor is a VS Code fork with the same extension API; the same `.vsix`
installs with `cursor --install-extension`. (Not exercised on this machine —
see *Verified* below.)

### Read-along shading

The agent speaks in single sentences (`speak()` is called once per sentence).
The panel shows them as a page: **read text bright, unread text dim, the word
being read underlined**. "Read" is driven by whichever voice is active:

- `agentvoice.readAloud: "off"` (default) — a silent pacer advances the
  highlight at reading speed (~185 wpm, punctuation pauses), so text you have
  not caught up with stays dim; clicking a line marks everything up to it read.
- `"bridge"` — the extension host fetches audio from `POST /api/intelligence/tts`
  (the bridge's configured speech-output provider) and the webview plays it;
  word progress is spread across the clip duration.
- `"browser"` — the editor's own `speechSynthesis` voices, with real word
  boundary events. Availability depends on the OS (on this Linux/Flatpak
  install there are no voices; the panel falls back to the pacer).

The model behind it (`ReadAlongModel`) is pure TypeScript in the shared
package so the PWA can adopt the same page view later.

### Why text-first: no microphone in webviews

VS Code webviews refuse `getUserMedia` (Permissions-Policy: microphone is
not delegated to the webview iframe; long-standing upstream issue). The
extension host is plain Node with no audio device. So push-to-talk stays on
the phone; the desk gets keyboard input and optional audio *output*. This
was checked before designing, not assumed.

## What the bridge grew

### Why a third WebSocket

`/ws/control` and `/ws/intelligence` are single-client by construction:
authenticating registers *the* narrator session and *the* control-socket
broadcaster (last writer wins). A second connection from the editor would
silently take the phone's narration and approval pushes away. Rather than
make those multi-client (and change what "the phone" means everywhere), the
desk gets its own observe-and-submit socket.

**`/ws/events`** (`src/routes/eventsSocket.ts`) — multi-client. On auth it:

1. registers as a *voice session* (`registerVoiceSession`) so `speak()`,
   `done()`, `thinking`, `turn_complete`, `tool_activity`,
   `voice_agent_status` reach it — and so `speak()` succeeds when only the desk
   is connected (the agent's lines land in the panel instead of
   `NO_VOICE_SESSION`);
2. subscribes to the **event bus** (`src/state/eventBus.ts`), a plain fan-out
   that `notifyPhone()` publishes every phone-bound payload to (approval
   requests, `approval_cancelled`, narration, images, auth-required) and that
   the voice agent and worker spawns publish their normalized stream events to
   (`agent_event`: init / tool_start / tool_done / assistant_text / result /
   error, de-duplicated `session`).

It never touches the narrator or the control-socket broadcaster.

Frames the client can send: `user_turn`, `approval_response`, `ping`
(returns the state snapshot). `auth_ok` carries the same snapshot:
provider, workflow, active project/model/effort/fast, permission mode,
pending approvals, voice agent, listening flag, queued turns, running jobs.

### Shared turn and approval paths

- `src/executor/agentTurns.ts` — `submitAgentNativeTurn(text, {source})`:
  the spawn-or-queue logic that used to live inline in `/ws/intelligence`,
  now used by the phone socket, the desk socket and `POST /api/turns`. It
  publishes a `user_turn` event so every desk client sees turns from every
  surface (a phone utterance shows up in the editor transcript as `(phone) …`).
- `src/mcp/server/approvalResponses.ts` — `applyApprovalResponse(id, body, source)`:
  parse + resolve once; then `approval_cancelled` goes to the phone *and*
  the bus so every other card dismisses. **First answer wins**, phone or desk.

### REST added

| Route | Purpose |
| --- | --- |
| `POST /api/turns { text, is_interrupt? }` | typed turn (agent_native only; 409 otherwise, 409 `NO_PROJECT` when nothing is selected) |
| `GET /api/agent/state` | the desk snapshot |
| `GET /api/jobs?project=&limit=&status=` | job history rows (same as `list_jobs_history`) |
| `POST /api/approvals/:id/respond` | answer an approval over HTTP (fallback while the socket reconnects) |
| `POST /api/tools/:name` | any `agent_*` tool through `dispatchTool` — same allowlist, zod schema and audit log as the phone's `tool_call` relay; voice I/O tools are not reachable here |
| `POST /api/workspace/project { path }` / `GET …?path=` | workspace-as-project (below) |

### Workspace as project

The user's ask: *the active folder is the project; nothing to save first.*
`POST /api/workspace/project` resolves the folder (must exist on the bridge
host — remote workspaces are out, see docs/32). If an enabled project already
has that path it is reused; otherwise an **ephemeral** registry row is
inserted (DB only, `enabled = 1`, description `Workspace: <path>`), and made
active. It behaves like any project (resume ids, jobs, history) but is not
written to `config.json`, so `reconcileRegistry()` disables it on the next
bridge restart; the extension re-registers on every connect, and the desk
snapshot reports `activeProject: null` for a name that no longer resolves so
the client knows to. This adds no capability the admin API did not already
have (any token holder could allowlist any host path); it skips the config
write.

### Orphaned turns → respawn

Found in the first live run: Claude Code, after `done()`, sometimes finishes
the process instead of polling `next_voice_turn()`. A turn typed in that
second landed in the queue, and the *next* turn cleared the queue before
spawning — the typed turn vanished. `voiceAgent.ts` now exposes an exit
hook; `agentTurns.ts` uses it to respawn immediately with whatever was queued
(joined into one opening request, `source: "requeue"`) when the agent exited
cleanly on its own. Killed or errored exits do not respawn (no crash loops).
This is protocol-level and applies to every CLI and to the phone as well.

## Shared TypeScript, separate frontends

`packages/client/` (`@agentvoice/client`, no build step — consumed through
`tsconfig` `paths` and an esbuild alias):

- `protocol.ts` — approval request/response types, `approvalFromPush()`,
  agent stream events, desk snapshot, every `/ws/events` frame, REST shapes.
  The PWA's `bridge.service.ts` now re-exports these instead of owning copies.
- `http.ts` — `BridgeHttp`: the REST surface over an injectable `fetch`
  (browser, extension host, webview).
- `events.ts` — `EventSocket`: reconnecting `/ws/events` client over an
  injectable WebSocket constructor (browser `WebSocket` or `ws`).
- `readAlong.ts` — `ReadAlongModel`: segments, read/reading/unread state,
  word-level progress, silent pacer.

Frontends stay separate: Angular for the phone, plain DOM in the webview,
`vscode` API in the extension host.

## Verified on this machine (September 9, 2026)

Bridge from this branch in test mode on `:5089` (`config.json` runMode
`test`, `agentClient: claude-code`, `permissionModes.claude-code:
acceptEdits`), Claude Code 2.1.263 signed in, Flatpak VS Code 1.129.1.

- REST: 401 without token; `agent/state`, `workspace/project` (create,
  reuse of a config project, bad path 400), `tools/*` (list projects, unknown
  tool 404, schema 400), `jobs`, `approvals` (404 / 400), `turns` (400 empty),
  permission modes, sessions.
- `/ws/events`: wrong token → close 4001; `auth_ok` + `pong` snapshots; empty
  turn → `error EMPTY` + `turn_complete`; unknown approval → `approval_ack ok:false`.
- Live: typed turn → Claude spawned with `--permission-mode acceptEdits
  --permission-prompt-tool …`, `speak()` line streamed to the desk in 2.7 s,
  `done()` → `turn_complete`; a second turn queued during exit → respawn with
  it (`user_turn source: requeue`).
- Extension, headless, inside a downloaded VS Code 1.136.2 under Xvfb
  (`AGENTVOICE_LIVE=1 dbus-run-session -- xvfb-run -a node test/runTest.mjs`):
  9/9 passing — activation + API, commands, token → connect → snapshot,
  workspace-as-project, REST client, approval bookkeeping, Changes tree,
  panel, and the live turn: Claude Code ran `curl`, the permission prompt
  reached the extension's relay, *allow* was sent from the editor side, the
  spoken "status ok" line and `turn_complete` arrived (8 s end to end).
- The `.vsix` installs into the Flatpak VS Code 1.129.1 on this machine
  (`flatpak run com.visualstudio.code --install-extension …`).

Environment note for whoever repeats this: on this desktop both the Flatpak
VS Code and the downloaded test build **hung at startup with no window**
(main process spinning, no logs) when launched from an agent shell that
inherited the GNOME session bus — the same session in which the screenshot
portal was unresponsive. Launching under `dbus-run-session` with
`DBUS_SESSION_BUS_ADDRESS` / `WAYLAND_DISPLAY` unset started instantly.
That is a desktop-session problem, not an extension one, but it is why the
verification is headless rather than a screenshot of the side bar.

Not verified: Cursor (the only Cursor build on this machine is an aarch64
AppImage on an x86-64 host), the `browser` read-aloud mode (no
speechSynthesis voices in the Flatpak runtime), Codex / Cursor / Codewhale
providers (only Claude Code is signed in here — the extension has no
provider-specific code, so the risk is in the bridge providers, which docs/28
covers).

## Testing it

Two layers, both against a real bridge (no mocks of the protocol):

1. **Bridge-side** — `curl` against the REST routes and a 40-line `ws` script
   against `/ws/events` (auth, snapshot, error frames, a typed turn, a relayed
   permission prompt answered from the socket). The transcript of the run that
   validated this branch is in the PR.
2. **Extension-side** — `vscode/test/runTest.mjs` downloads a VS Code build
   with `@vscode/test-electron` (cached in `vscode/.vscode-test/`) and runs
   `src/test/suite.ts` *inside* it, on this repo as the workspace:
   activation and exported API, command registration, token → connect →
   snapshot, workspace-as-project, REST client calls, approval relay
   bookkeeping, the Changes tree, showing the panel. With `AGENTVOICE_LIVE=1`
   it also submits a typed turn that makes Claude Code run `curl`, waits for
   the relayed permission prompt to reach the extension's `ApprovalRelay`,
   answers *allow* from the editor side, and asserts the spoken result and
   `turn_complete` arrive.

   ```bash
   # bridge running on :5089 (npm run dev, or NODE_ENV=development npx tsx src/index.ts)
   cd vscode && npm run build
   AGENTVOICE_LIVE=1 xvfb-run -a node test/runTest.mjs     # headless
   node test/runTest.mjs                                    # with a display
   ```

   Token and URL come from `AGENTVOICE_TOKEN` / `AGENTVOICE_BRIDGE_URL`,
   defaulting to the repo `.env` and the dev port.

## Releasing

`.github/workflows/vscode-extension.yml` has two jobs:

- **check** — on every pull request and push to `main`: root `npm ci
  --legacy-peer-deps` (same peer-dependency stance as `scripts/setup.sh`),
  `npm run typecheck`, `npm run lint`, then `npm ci && npm run package` in
  `vscode/` (typecheck, esbuild bundles, `vsce package`). The `.vsix` is
  uploaded as a workflow artifact (`agentvoice.vsix`) so any PR build can be
  installed by hand.
- **release** — on a tag `vscode-vX.Y.Z`: same build, a GitHub Release with
  `agentvoice-X.Y.Z.vsix` attached, then `vsce publish` (Marketplace) and
  `ovsx publish` (Open VSX). Each publish step runs only when its secret is
  set (`VSCE_PAT`, `OVSX_PAT`); otherwise it is skipped with a warning, so the
  GitHub Release alone works before the publisher accounts exist. The job
  fails if the tag does not match `vscode/package.json`.

To cut a release:

```bash
cd vscode
npm version patch          # or minor / major — updates package.json + lock, no git tag (private package)
# add the entry to vscode/CHANGELOG.md, commit, merge to main, then:
git tag vscode-v$(node -p "require('./package.json').version")
git push origin main --tags
```

`workflow_dispatch` with `publish: true` publishes the build of any ref
without a tag (no GitHub Release is created in that case).

Secrets (repository settings → Actions):

| Secret | Where it comes from |
| --- | --- |
| `VSCE_PAT` | Azure DevOps personal access token with *Marketplace → Manage* scope, for the `dixonsolutions` publisher (`vsce login` is not needed; the token is passed with `-p`) |
| `OVSX_PAT` | open-vsx.org access token; the `dixonsolutions` namespace must exist first (`npx ovsx create-namespace dixonsolutions -p $OVSX_PAT`) |

The publisher id in `vscode/package.json` must match the Marketplace
publisher the token belongs to.

## Limits and follow-ups

1. **Notifications cannot be dismissed programmatically.** If the phone
   answers first, the editor notification stays until clicked; clicking then
   reports "already answered". The panel card does dismiss (via
   `approval_cancelled`).
2. **`turn_complete` fires on agent exit** even when a queued turn is about to
   respawn; the client sees `user_turn (requeue)` + `thinking` right after.
   Acceptable, but a `respawning` frame would be cleaner.
3. **Ephemeral projects do not survive a bridge restart** (by design —
   `config.json` stays authoritative). If that turns out annoying, keep rows
   with the `Workspace:` marker whose path still exists.
4. **Worker prose** (`agent_event assistant_text` from jobs) goes to the
   activity feed, not the read-along page; only `speak()` lines are "spoken".
5. The extension's *stop* for the conversational agent sends an interrupt
   turn (`stop`), which is what the phone does; there is no hard-kill REST
   route for the voice agent on purpose (`stop_agent` is gated on a recent
   user stop command).
6. Publish: the release workflow (see *Releasing*) handles Marketplace +
   Open VSX once the `VSCE_PAT` / `OVSX_PAT` secrets exist; until then the
   GitHub Release carries the `.vsix`. `npm run build:vscode` builds it locally.
7. `npm run lint` is error-free across `src/`, `web/src`, `packages/` and
   `vscode/` (the four `web/src` type-only-import errors and the unused
   `MS_PER_WORD_ESTIMATE` were fixed on this branch).

## Files

- `vscode/` — extension (`src/extension.ts`, `bridge.ts`, `approvals.ts`,
  `statusBar.ts`, `commands.ts`, `panel.ts`, `changes.ts`, `sessions.ts`,
  `webview/main.ts`, `media/panel.css`)
- `packages/client/src/` — shared protocol, HTTP, socket, read-along model
- `src/routes/eventsSocket.ts`, `approvals.ts`, `turns.ts`, `tools.ts`, `workspace.ts`
- `src/state/eventBus.ts`, `src/executor/agentTurns.ts`, `src/mcp/server/approvalResponses.ts`
- `src/executor/voiceAgent.ts` (exit hook, event publish), `src/executor/agentProcess.ts` (event publish),
  `src/push/notifyPhone.ts` (bus publish), `src/intelligence/ws.ts` (uses the shared turn path),
  `src/server.ts` (route registration, shared approval path), `src/webDispatch.ts` (`/ws/events` is backend)
