# 33 — Permission modes, relayed permission prompts, and askpass

> Added: September 2026. Companion to [`24-agent-providers.md`](./24-agent-providers.md).

Three things that used to be implicit are now explicit and per CLI:

1. **How much the agent may do without asking** — a permission mode, chosen
   on the Voice tab (or by voice via `agent_permission_mode`), defaulting to
   *run everything* for every CLI, exactly as before.
2. **What happens when the CLI would ask** — relayed to the phone where the
   CLI supports it (Claude Code), refused where it does not (Cursor, Codex in
   their non-YOLO modes). The UI says which.
3. **Password prompts from inside the agent's shell** — `sudo`, `git`, `ssh`
   — reach the phone instead of dying on a terminal nobody has.

## Permission modes

Each provider declares the modes its CLI can run *headlessly*, run-everything
first (`provider.permissionModes()`), and owns the argv for each. The choice
is stored per client in `settings.permissionModes[<client>]`; unset means
the run-everything entry. `ask` / `plan` jobs keep their read-only
enforcement regardless of the mode.

| CLI | Mode id | Flags | When the CLI would ask |
| --- | --- | --- | --- |
| **Claude Code** | `bypass` (default) | `--permission-mode bypassPermissions` | never asks |
| | `auto` | `--permission-mode auto --permission-prompt-tool mcp__agent-voice__approve_permission` | classifier decides; leftovers → **phone** |
| | `acceptEdits` | `--permission-mode acceptEdits --permission-prompt-tool …` | edits free; other commands → **phone** |
| | `manual` | `--permission-mode manual --permission-prompt-tool …` | everything non-read-only → **phone** |
| | `dontAsk` | `--permission-mode dontAsk` | refused |
| **Cursor** | `yolo` (default) | `--force` | never asks (deny rules in `cli-config.json` still apply) |
| | `auto-review` | `--auto-review` | Smart Auto runs safe calls; the rest would prompt, which print mode cannot show → skipped |
| | `default` | *(none)* | allow-list only; the rest skipped |
| **Codex** | `full` (default) | `--dangerously-bypass-approvals-and-sandbox` | never asks |
| | `approve-for-me` | `--approve-for-me --sandbox workspace-write` | Codex reviews its own requests |
| | `workspace` | `--sandbox workspace-write` | `codex exec` auto-denies |
| **Codewhale** | `auto` (only) | `--auto` | never asks |

Cursor's `--force` / `--yolo` used to ride in `settings.preRunFlags`
(default `['--force', '--trust']`). The mode owns it now: the config loader
migrates the flag out of `preRunFlags`, and `providers/agents/cursor.ts`
filters it defensively so a hand-edited config cannot re-add it behind the
mode's back. `--trust` stays where it was.

Why the mode is bridge-wide rather than per session: it is a *policy*, like
the allowlist, and the single-user bridge has exactly one operator. A voice
session can still change it (`agent_permission_mode(mode)`) and the change
applies to the next spawn.

### Surfaces

- `GET /api/providers/permission-modes` → `{ provider, displayName, active, modes[] }`
- `POST /api/providers/permission-mode { mode }` → same shape; 400 with the
  accepted ids on an unknown mode
- MCP `agent_permission_mode(mode?)` — read (no args) or set; also in the
  `llm_intelligence` function-tool list
- Voice tab → *Project & session* → **Permissions** select, with a one-line
  hint of what a would-be prompt turns into in the active mode; disabled
  when the CLI has only one mode (Codewhale)

## Relayed permission prompts (Claude Code)

`claude -p` cannot draw a prompt, but it accepts `--permission-prompt-tool
<mcp tool>`: whenever its permission mode would ask, it calls that MCP tool
with `{ tool_name, input, tool_use_id }` and expects the tool's text to be
the JSON decision — `{"behavior":"allow","updatedInput":…}` or
`{"behavior":"deny","message":"…"}` (the CLI validates exactly that shape).

`mcp/server/index.ts` registers `approve_permission` on the `agent-voice`
server for this purpose. It reuses the approval registry
(`mcp/server/approvalRegistry.ts`, kind `permission`):

1. push `permission_request` to the phone (WS + push notification, VoIP
   priority) and a spoken narration ("Claude Code wants to run npm install.
   Say yes or no, or answer on your phone.");
2. wait up to 5 minutes for the card's **Allow** / **Deny**;
3. a spoken turn while the card is open is classified — "yes / go ahead /
   allow" → allow, "no / stop / deny" → deny, anything else → deny with the
   user's words in the message so the model treats them as the new request;
4. timeout → deny with "nobody answered … do not retry".

AgentVoice's own MCP tools stay on `--allowedTools` in every mode, so the
voice loop (`speak`, `next_voice_turn`, …) never trips a prompt. The model
is told in the tool description not to call `approve_permission` itself.

Cursor and Codex have no headless hook: Cursor's print mode skips what it
would have asked about, `codex exec` denies it. Their non-YOLO modes are
therefore labelled "prompts are refused", not relayed.

## Password prompts: `sudo`, `git`, `ssh`

An agent running `sudo apt install …` in a headless shell used to get
`sudo: a terminal is required to read the password` — or, worse, hang. sudo
1.8+ falls back to the `$SUDO_ASKPASS` helper automatically when it has no
TTY (verified with 1.9.17: no `-A` needed). git honours `$GIT_ASKPASS`; ssh
honours `$SSH_ASKPASS` when `SSH_ASKPASS_REQUIRE=force`.

`executor/askpass.ts` generates the helper into the bridge data dir
(`askpass.sh` → `askpass.mjs`, run with the bridge's own node binary so the
agent's `PATH` does not matter) and adds to every agent child process:

```
SUDO_ASKPASS / GIT_ASKPASS / SSH_ASKPASS = <data>/askpass.sh
SSH_ASKPASS_REQUIRE = force
AGENTVOICE_BRIDGE_URL   = loopback bridge URL
AGENTVOICE_ASKPASS_TOKEN = APP_TOKEN
```

The helper POSTs the prompt text to `POST /api/askpass`
(`routes/askpass.ts`), which registers a `secret_input` approval, pushes it
to the phone with a narration ("Claude Code needs your sudo password — enter
it on your phone"), and returns `{ secret }` when the user submits the
masked field on the card. Cancel → 409 → the helper exits 1 → sudo reports a
failed password and the agent sees that. Timeout is 290 s, just under sudo's
default `passwd_timeout`.

The secret's path is phone → control WebSocket → registry promise → HTTP
response → helper stdout → sudo. It is never written to the DB, never logged
(`server.ts` resolves the response without echoing it; the registry logs
only `request_id` and `kind`), and the PWA clears the field the moment it
sends.

Limits worth knowing:

- Commands run through Codex's or Cursor's sandbox may not have the env at
  all; Claude Code's Bash tool inherits it.
- Cloud environments (issue #40) cannot reach the loopback URL — the helper
  fails fast rather than hanging.
- `sudo -S` (password on stdin) and `NOPASSWD` sudoers rules bypass the
  helper entirely, as they should.

## Files

- `src/providers/agents/permissions.ts` — resolution, persistence, `PERMISSION_PROMPT_TOOL_REF`
- `src/providers/agents/{claude,codex,cursor,codewhale}.ts` — `permissionModes()` + argv
- `src/mcp/server/index.ts` — `approve_permission`, `agent_permission_mode`
- `src/mcp/server/approvalRegistry.ts` — `permission` / `secret_input` kinds
- `src/executor/askpass.ts`, `src/routes/askpass.ts`
- `src/routes/providerPermissions.ts`, `src/mcp/tools/permission.ts`
- `web/src/app/components/approval-panel/` — the two new cards
- `web/src/app/components/voice-tab/` — the Permissions select
