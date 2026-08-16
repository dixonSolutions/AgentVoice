# 28 — Provider Parity, Branding, and the AgentVoice Interrupt Hook

> Added: August 2026. Completes the rename started in
> [`26-rename-agentvoice.md`](./26-rename-agentvoice.md) and closes the gaps
> that made "multi-agent support" true on paper only.

Three problems ran together and are fixed together here.

1. **Cursor was hardcoded far past the provider seam.** `settings.agentClient`
   selected a CLI, but stream parsing, MCP registration, execution modes, the
   session-id capture and half the UI copy still assumed `cursor-agent`.
2. **Branding was scattered and conflated.** "AgentVoice" was spelled out in
   three places, and the *coding agent's* name was hardcoded as "Cursor" in the
   session log, the approval card, the typed-request dialog and the narrator.
3. **A mid-work user turn was delivered by reaching into other tools.** The turn
   queue hijacked whichever approval/input call happened to be pending, which
   covered two tools and conflated "you answered my question" with "I have
   something new to say".

---

## 1. The provider seam now actually holds

`AgentProvider` (`src/providers/agents/types.ts`) gained four members. Each one
existed as Cursor-shaped code somewhere outside the provider directory before.

| Member                   | What it replaced                                              |
| ------------------------ | ------------------------------------------------------------- |
| `parseStreamEvent()`     | `watcher.ts` reading Cursor's `writeToolCall` keys directly    |
| `ensureMcpRegistration()`| a `switch (client)` in `globalMcpSetup.ts`                     |
| `supportedModes()`       | `mode` being silently ignored by Codex and Claude Code         |
| `createSession()`        | `agent_new_session` shelling out to `cursor-agent create-chat` |

Nothing outside `src/providers/agents/` parses raw CLI JSON or knows a CLI's
config path any more.

### Normalized stream events

`src/providers/agents/events.ts` defines one event vocabulary
(`session` / `init` / `tool_start` / `tool_done` / `assistant_text` /
`result` / `error`). Consequences:

- **Narration works for all three CLIs.** Previously the watcher recognised only
  Cursor's tool-call shape, so a Codex or Claude Code worker produced *zero*
  narration — the hands-free user heard silence for the whole run.
- **Codex resume works.** Codex never puts `session_id` at the top level; it is
  under `msg.session_id` (or `thread_id`). The old capture only read
  `raw.session_id`, so the id was never stored and every run started fresh.
- **Ghost-agent detection is CLI-agnostic** — it keys off `action: 'task'`
  rather than Cursor-specific key names.

### Fixes that were outright breakage

| Client      | Was                                                     | Now |
| ----------- | ------------------------------------------------------- | --- |
| Claude Code | MCP written to `~/.claude/settings.json`, which does not define MCP servers → **bridge never connected, every session mute** | `~/.claude.json` + a generated `--mcp-config` on every spawn |
| Claude Code | `--output-format stream-json` with no `--verbose` → **CLI refuses to start** | `--verbose` always passed in print mode |
| Claude Code | no permission flags → MCP tools denied silently in print mode | `--allowedTools mcp__agent-voice`, `--permission-mode` |
| Claude Code | `supportsModelSelection: false` while listing models | `--model <alias>` passed; picker live |
| Codex       | `session_id` never captured → resume dead                | nested id parsed |
| Codex       | `-m/--model` never passed                                | passed when not `auto` |
| Codex/Claude| `mode: 'ask'` ignored → `agent_ask` could **write files** | read-only enforced, or the mode is refused |
| Codex/Claude| `worktree` ignored → parallel workers hit the main tree   | worktree becomes the spawn cwd |
| Codex/Claude| resumed threads got Cursor's `@cursor-voice` mention and no system prompt | full prompt re-sent on resume |
| all         | `/healthz` always probed `cursor-agent`                  | probes the active provider |
| all         | `agent_mcp_list` shelled out to `cursor-agent` regardless | refuses unless Cursor is active |

---

## 2. One interrupt hook, ours

`src/mcp/server/pendingWaits.ts` is now the single place a mid-work user turn is
delivered. Every blocking AgentVoice tool registers there under one of two
policies:

- **`resolve`** — the wait is *about* the user (`request_user_input`,
  `submit_plan_for_approval`). A new utterance makes the question moot, so the
  tool returns immediately carrying it.
- **`annotate`** — the wait is *work* (`agent_ask`). Nothing is cancelled; the
  turn rides back on the tool's own result as `interrupted: true` + `user_turn`.

Delivery order for one incoming turn is: a waiting `next_voice_turn()` poll →
the interrupt hook → the buffer.

**Why this works on every CLI:** it is pure MCP-protocol behaviour. There is no
dependency on a CLI's stream format, flags, or injection support — which is why
the previous approval-registry hijack behaved the same on Cursor, Codex and
Claude Code too. What did *not* work equally was everything around it: on Claude
Code the MCP server was never registered, so no tool was ever in flight to
interrupt. That is the fix in §1, not here.

---

## 3. Branding lives in one place

- `web/src/app/branding.ts` holds the app's name and mark. `<cv-brand>` renders
  them; the top bar is the only place both appear. The token dialog reuses the
  same component instead of its own literal, and the separate `<p-tag
  value="AgentVoice">` beside the logo is gone.
- The **coding agent's** name is runtime state, not a constant:
  `AgentProviderService.activeProviderName()` feeds the session log, the
  approval card, the typed-request dialog and the one provider chip. The bridge
  also ships `provider` / `provider_name` with every `voice_agent_status` event,
  so the log names the right CLI even before the provider list loads.
- The session log no longer says "Cursor agent starting" (wrong under Codex and
  Claude Code) nor "voice agent starting" (reads as AgentVoice narrating its own
  internals). It says e.g. `Claude Code starting — pid 4821, run 3f9c1a2b…`.

### Theme

The orb takes **only** app-theme tokens (`--p-primary-*`, from Config →
Appearance). Agent-provider brand colours are never applied: changing agent
client changes what runs the work, not what the app looks like. The palette is
now resolved once per orb state and invalidated by the
`cv-appearance-changed` event, instead of a `getComputedStyle()` call on every
one of ~30 animation frames per second.

---

## 4. Renames and migrations

| Before                                | After                        | Migration |
| ------------------------------------- | ---------------------------- | --------- |
| MCP server `cursor-voice`             | `agent-voice`                | stale entry stripped on every session prepare |
| tools `cursor_*`                      | `agent_*`                    | old names still accepted by `dispatchTool`; see `LEGACY_TOOL_ALIASES` |
| `settings.voice.tts.cursorVoiceEnabled` | `agentVoiceEnabled`        | rewritten on config load |
| `workflow.default: cursor_native`     | `agent_native`               | rewritten on config load; API also accepts the old value |
| `/api/cursor-sessions/*`              | `/api/agent-sessions/*`      | old paths still served |
| `~/.cursor/rules/cursor-voice.mdc`    | `agent-voice.mdc`            | legacy rule body blanked so it cannot re-inject old tool names |

`cursor_*` tool names are deliberately **not** advertised on the MCP server. The
tool list is read by the model on every turn, and 18 duplicate deprecated
entries would cost context permanently; the system prompt and the CLI rule file
always carry the canonical names.

`agent_mcp_list` / `agent_mcp_tools` keep inspecting *Cursor's* MCP config —
that is what they are for — but now refuse with a clear message when another
client is active, instead of quietly describing a CLI that is not running.
