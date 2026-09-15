# 40 — Prompts read aloud, the ask tools, a working orb, and remembered permissions

> Added: September 2026. Design, not yet implemented. Companion to
> [`17-tts-barge-in-and-wake-echo.md`](./17-tts-barge-in-and-wake-echo.md),
> [`19-mobile-session-keepalive.md`](./19-mobile-session-keepalive.md),
> [`20-native-callkit-shell.md`](./20-native-callkit-shell.md) and
> [`33-permissions-and-prompt-relay.md`](./33-permissions-and-prompt-relay.md).

Four questions from a voice session, each with what the code does today and a
proposal.

## Positions (2026-09-15)

Tracked in [#63](https://github.com/dixonSolutions/AgentVoice/issues/63) (prompts read aloud), [#64](https://github.com/dixonSolutions/AgentVoice/issues/64) (ask tools and tool consolidation), [#65](https://github.com/dixonSolutions/AgentVoice/issues/65) (orb working state) and [#66](https://github.com/dixonSolutions/AgentVoice/issues/66) (microphone and audio permissions).

| Question | Position |
| --- | --- |
| Should prompts on screen be read aloud? | **Yes, and configurable** |
| With permissions bridged, do we still need AgentVoice's own ask tools? | **Keep `request_user_input` and `submit_plan_for_approval`; consolidate duplicate tools** |
| Show when an agent is running? | **Yes — a working ring on the orb** |
| Persist microphone and audio permissions? | **Yes — they are required for the app to work** |

## 1. Reading prompts aloud

### Today

- `readAloud` (`replies | titles | summary | everything`) only covers **tool
  activity**: `readActivityAloud()` in `web/src/llm-intelligence-session.ts`
  speaks the headline on start and the output on done.
- `user_input_request`, `plan_approval_request` and `secret_input_request` go
  from `bridge.service.ts` straight to `pendingApproval` and the approval panel.
  **Nothing speaks them.**
- Only two prompts are spoken, and only because the bridge sends a separate
  hardcoded `narration` line: CLI permission prompts (`src/mcp/server/index.ts`)
  and askpass (`src/routes/askpass.ts`).
- The `request_user_input` tool description says the question is "displayed and
  read aloud", then tells the agent *"Do NOT call speak() before this — the PWA
  card is the notification."* **So a question can reach a hands-free user in
  complete silence.** That is a bug, not just a missing option.

### Proposal

- New setting `voice.tts.readPrompts: 'off' | 'announce' | 'question' | 'full'`,
  default **`question`**:
  - `announce` — "There's a question on your phone."
  - `question` — the question and its options ("Yes or no?", "Pick one:
    keep working, finish the task, or stop"); for plans the title and step count.
  - `full` — also every plan step and the estimated impact.
- Spoken **on the phone from the card itself**, so it is identical for every
  workflow and every CLI, and the bridge's hardcoded permission / askpass
  narration lines go away (they become card-driven, see
  [`39`](./39-config-ui-and-narration-cleanup.md) Part B).
- Uses the normal TTS queue, so barge-in and `tts_interrupt` work; a spoken
  answer already resolves the card (`interrupted_by_voice_turn` /
  `classifySpokenDecision`).
- Re-read the open card when the phone reconnects
  ([`36`](./36-disconnect-and-background-work.md) digest).
- Never read secrets: `secret_input` only announces.
- Fix the tool description so agents and the phone don't double-speak.
- Lives in the "What gets spoken" section proposed in docs/39.

## 2. The ask tools vs the permission bridge

### They do different jobs

| | Who starts it | What it asks | Providers |
| --- | --- | --- | --- |
| `approve_permission` | the **CLI** (`--permission-prompt-tool`) | "may I run this tool?" | **Claude Code only** today; Cursor and Codex refuse in non-YOLO modes; Codewhale never asks (docs/33). The provider-agnostic relay is still an active, unmerged lock. |
| askpass | the agent's **shell** | sudo / git / ssh password | all four |
| `request_user_input` | the **agent** | a yes/no, a choice, or free text | all four |
| `submit_plan_for_approval` | the **agent** | approve / reject / modify a plan | all four |

The permission bridge cannot replace the ask tools: a CLI permission prompt is
the CLI's safety gate, while the ask tools are how the agent itself asks you
something. They already share one pipeline (`approvalRegistry.ts`, one
approval panel), which is the right shape. **Keep both.** Later, where a CLI
has its own question or plan-exit tool that can't reach a headless user, map it
onto the same cards as an optional per-provider capability.

### What is actually there: 37 tools

- **Voice** — `speak`, `done`, `next_voice_turn`
- **Ask the user** — `request_user_input`, `submit_plan_for_approval`,
  `show_images`, `approve_permission` (internal)
- **Workers** — `spawn_agent`, `list_agents`, `get_agent_status`,
  `get_agent_output`, `stop_agent`, `inject`, `revert_agent`, `execute_plan`,
  `set_mode`, `list_jobs_history`
- **Agent CLI** — `agent_submit`, `agent_job_status`, `agent_job_stop`,
  `agent_ask`, `agent_recall_answer`, `agent_diff`, `agent_revert`,
  `agent_new_session`, `agent_session_info`, `get_session_ref`, `agent_info`,
  `agent_status`, `agent_list_models`, `agent_set_model`,
  `agent_permission_mode`, `agent_mcp_list`, `agent_mcp_tools`
- **Projects** — `agent_list_projects`, `agent_set_project`,
  `agent_manage_projects`

### Overlaps to consolidate

| Overlap | Proposal |
| --- | --- |
| `spawn_agent` / `agent_submit` — both start a worker | one `spawn_agent`; `agent_submit` becomes an alias, then removed |
| `get_agent_status` / `agent_job_status` | one status tool keyed by agent or job id |
| `stop_agent` / `agent_job_stop` | one stop tool (keeps the user-command guard) |
| `revert_agent` (to the pre-job checkpoint) / `agent_revert` (uncommitted changes) | one `revert` with a `to: 'checkpoint' \| 'head'` argument |
| `get_session_ref` / `agent_session_info` | one session tool |
| `agent_info` / `agent_status` (version vs auth) | one provider-info tool |
| `set_mode` | an argument on `spawn_agent` |
| `agent_mcp_list` — "Cursor-only diagnostic" | implement for all four CLIs or declare unsupported per provider (provider rule) |
| `inject` — never delivers ([#57](https://github.com/dixonSolutions/AgentVoice/issues/57)) | rebuilt per [`37`](./37-session-directory-and-inject.md) |

Fewer, clearer tools means less prompt text and fewer wrong picks. Keep old
names as deprecated aliases for one release.

## 3. Showing that an agent is working on the orb

### Today

- `OrbColorMode` is `idle | ready | listening`
  (`web/src/app/components/voice-orb/voice-orb.component.ts`); `ready` already
  pulses (`cv-orb-pulse-ready`).
- `VoiceSessionService._jobRunning` and app state `working` exist — set from
  narration kinds, tool activity and `onWorking` — but **are not passed to the
  orb**. Nothing on screen shows that work is running.

### Proposal

- Add orb states:
  - **`working`** — a rotating arc / sweeping ring around the orb, visibly
    different from the `ready` breathing pulse.
  - **`waiting_for_you`** — a steady or slow ring while an approval card is
    open.
- Colour from the app theme only (the orb rule: never the agent's brand hue).
- A caption under the orb: "Working — 2 agents", "Waiting for your answer".
- `prefers-reduced-motion`: a static ring plus caption, no animation.
- **Source of truth from the bridge**, not guessed from narration: a single
  `agent_busy` event covering a voice agent turn in progress (user turn received
  → `done()`), running workers (count), and pending approvals. Pushed on the
  control socket and re-sent on reconnect, so the ring is correct after the
  phone comes back.
- Optional small badge with the worker count; tapping it opens the sessions
  list from [`37`](./37-session-directory-and-inject.md).

## 4. Remembering microphone and audio permissions

### Today

- Several owners call `getUserMedia` separately via `captureMicStream()`
  (`web/src/audio.ts`): the session's shared stream
  (`llm-intelligence-session.ts`), `vosk-wake-word.ts`, `server-stt.ts` and the
  wake-word test.
- Stopping a session calls `track.stop()` on every track, so the **next session
  asks the browser for the microphone again**.
- No `navigator.permissions.query({ name: 'microphone' })`: the app never
  checks or shows the permission state before trying.
- Audio output depends on `unlockAudioContext()` and TTS priming inside a tap,
  which the browser requires after every page load (autoplay policy).

### What the platform allows (verify per browser)

- Chrome desktop and Android generally remember a granted microphone per HTTPS
  origin (Android may offer "only this time").
- Safari on iOS defaults to "Ask" per site, and home-screen PWAs have
  historically re-prompted more often; the user can set the site to "Allow".
- Firefox grants are temporary unless "Remember this decision" is ticked.
- No web page can make audio playback permanent: a user gesture is needed after
  each launch. There is no web "volume permission"; the app can't read or set
  system volume.
- The native shell ([`20`](./20-native-callkit-shell.md)) gets OS-level
  microphone permission that persists.

### Proposal

- **One microphone owner** (`MicService`) for the app's lifetime. Wake words,
  server STT, VAD and the test page all take the shared stream instead of
  calling `getUserMedia` themselves.
- **Mute instead of stop** between sessions (`track.enabled = false`), with a
  setting for how long to keep the mic warm (default a few minutes) before
  releasing it, because an open mic keeps the browser's recording indicator on.
- **Check before asking**: query the permission state, listen for `onchange`,
  show it in Connection / Listening settings, and only request inside a tap.
- **Onboarding card** when the state is `prompt` or `denied`, with per-browser
  steps to set the site to "Allow" (iOS Safari, Firefox, Chrome Android).
- **Audio**: unlock on the first tap after launch (the orb tap already does) and
  keep the shared `AudioContext` alive rather than recreating it; the session
  keepalive from docs/19 stays.
- **Native shell** recommended on iPhone for true persistence.
