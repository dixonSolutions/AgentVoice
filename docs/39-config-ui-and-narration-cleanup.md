# 39 — Config UI cleanup and bridge narration

> Added: September 2026. **Implemented** — see the status section at the
> bottom for the handful of findings deliberately left. Companion to
> [`30-speech-output-providers.md`](./30-speech-output-providers.md) and
> [`12-stream-json-watcher.md`](./12-stream-json-watcher.md).

## Decisions (2026-09-15)

Config cleanup is tracked in [#60](https://github.com/dixonSolutions/AgentVoice/issues/60); narration toggles and templates in [#61](https://github.com/dixonSolutions/AgentVoice/issues/61).

| Question | Decision |
| --- | --- |
| Speech tab intro paragraph | **Removed** (this PR) |
| How to track the config cleanup | **One issue** covering all findings |
| Hardcoded bridge narration | **Per-event toggles plus editable templates** (templates follow the reply language) |

Severity: **bug**, **confusing**, **cosmetic**. `ts` / `html` =
`web/src/app/components/config-tab/config-tab.component.{ts,html}`.

## Part A — Config UI findings

### Dead or broken settings

1. **bug — Narrator "Cadence interval" does nothing.** It only gates
   `progress_tick`, which is never emitted (`startCadenceTicks` is a no-op and
   uncalled) and `narrator.ts` drops anyway. `file_read` / `shell_run` are never
   emitted either, so "N commands run" in the replay summary is always 0.
   → remove `narratorCadenceMs` from UI, schema and `/api/settings`.
2. **bug — "Plan first" is dead.** `planFirst` is only echoed by
   `src/server.ts`; nothing reads it. It overlaps "Default agent mode: Plan".
   → remove or fold into default mode.
3. **bug — Log level lives in Job Settings** while "Debug & Logs" advertises
   it, so search lands in the wrong section. → move to Debug.
4. **bug — Voice section save buttons don't match their fields.** Three saves;
   "Save voice settings" silently covers Activation, Turn submit and worker
   poll; "Wake words enabled" gates Activation but is saved by "Save controls".
   → one save per section or per fieldset, consistently.
5. **confusing — server browser-voice defaults are uneditable.** The Voice
   section round-trips `voice.tts.webkit` with no UI while the Speech tab edits
   per-device copies with identical labels. → expose once in Speech out as
   "default for new devices".
6. **bug (provider parity) — Cursor-only pre-run flags** with a Cursor
   `--trust` default sit in generic Job Settings. → provider-declared extra
   args keyed per client, like `permissionModes`, under Agent client.
7. **bug (provider parity) — Agent client shows three clients.** "All three
   clients" copy; env-override list omits `CURSOR_AGENT_PATH` and
   `CODEWHALE_PATH`; `EnvSchema` declares only Codex and Claude Code; the
   section description omits Codewhale. → render from each provider's
   `envVar`.
8. **bug — inconsistent offline gating.** Sections load over HTTP
   (`canUseApi`) but most fields disable on WebSocket state; during a WS
   reconnect forms are visible but uneditable. → gate on `canUseApi()`.
9. **bug (minor) — "Clear all sessions"** has no confirmation.

### Duplicated or misplaced

10. **Three places decide what is spoken about work** — Agent voice
    (`readAloud`), Narrator (`narratorEnabled`), Speech out. "Replies only"
    claims to speak only what the agent chose, yet narration still speaks
    (Part B). → one "What gets spoken" section.
11. **Four region settings in two sections** (LLM region, AWS audio region,
    `AWS_REGION` in Keys). → audio region into the Amazon provider scope in
    Speech.
12. **Worker status poll interval** sits in "Turn submit"; it is agent
    behaviour. → Agent section.
13. **"AWS Bedrock Keys"** also powers Polly / Transcribe while all other
    speech keys live in Speech. → rename "AWS credentials", link from Speech.
14. **Health check** appears three times with two implementations; one isn't
    offline-gated. → keep one.
15. **"Default workflow" vs "Active workflow"** naming; Bedrock fields show
    under Agent Native. → one name; show Bedrock fields only for
    `llm_intelligence`.
16. **Personal** is a whole section with its own save for one field. → fold
    into Agent ("How the agent addresses you").
17. **Voice & Controls and Speech** both claim TTS and transcription in their
    descriptions and keywords.

### Stale descriptions, keywords, help text

- Voice keywords `polly, transcribe, sfm, stt, browser, tts, interrupt` are
  stale (`interrupt` refers to removed deafen settings).
- Workflow description says "audio settings" (only a region is left); its
  keywords make "tts" match three sections.
- Serve description says "rebase onto origin" though npm installs cannot
  rebase; "scripts/restart.sh" hint shown for npm installs.
- "Advanced providers stay collapsed until you pick one" — nothing collapses.
- Public URL label says "Tailscale / reverse proxy" with seven hosting providers.
- "Debug & Logs" contains no logs.
- Jargon: "Controls MCP speak() playback", a raw `docs/23-…` path in the UI.
- Narrator hint promises start / finish / file-write announcements that the
  voice prompt assigns to the agent.
- Stale HTML comments: `<!-- Voice & Wake Words -->` above the Voice section
  and "Speech-to-Text" / "Speech (in + out)" above the Speech block.
- Agent Client description omits Codewhale.

### Cosmetic consistency

- **Help text** — long paragraphs next to one-liners; Agent Client alone uses
  `<p class="cv-cfg-hint">` instead of `p-message`. Rule: one sentence per hint.
- **Save buttons** — "Save controls" (pi-check), "Save TTS settings"
  (pi-volume-up), "Save voice settings" / "Save keys" / "Save workflow
  settings" (pi-save), "Save name" (pi-user), "Save", "Save server settings",
  "Save key" (pi-key); Agent client applies instantly. → "Save" + `pi-save` at
  the end of its group.
- **Icons** — LLM & Workflow and Agent Client share `pi-microchip-ai`; Jobs
  uses `pi-cog` like the app's Config tab; Narrator's `pi-volume-up` collides
  with Speech out; `pi-language` on Speech reads as "language".
- **Casing** — Title Case section labels vs sentence-case legends and tabs;
  tags mix "disabled", "update available" with "Active", "Running"; "Behaviour"
  beside "Color"; "Job Settings" repeats "Settings".
- **Units** — job timeout and model cache TTL entered in milliseconds → minutes.
- **Dev-only fields** — "Test mode (local dev)" and "Angular dev server port"
  → behind an advanced toggle.

### Settings with no UI

`defaultActiveModel` / `defaultActiveEffort` / `defaultActiveFast` (voice
only); `hosting.cloudflare.tunnelName`, `ngrok.domain`, `devtunnel.tunnelId`,
`lan.useTls`; `runModes.serve.webPort`. Speech-server container internals may
stay raw-JSON only.

### Proposed section structure

1. Appearance
2. Connection
3. Listening & controls — wake / cancel / end phrases, confidence, on-screen
   controls, start muted, turn submit / VAD (one save)
4. Speech engines — the Speech tab, plus AWS audio region and browser-voice
   defaults
5. What gets spoken — agent voice, read-aloud level, error sound / speech, job
   announcements (replaces Narrator; toggles and templates from Part B)
6. Agent — client picker for all four CLIs with per-provider binary env var and
   extra args, default model / effort / fast, default mode, worker poll
   interval, your name
7. Jobs — concurrency, timeout (minutes), ghost kill, model cache TTL
8. Projects
9. LLM Intelligence — workflow, Bedrock model / region / tokens, memory, read
   limit; AWS credentials subsection
10. Hosting & network — provider with all its fields, run mode, ports, public URL
11. Updates & service — status, update, restart, journal, action log
12. Data & diagnostics — database, sessions, audit, log level, raw config.json
13. Disconnect & background work — from
    [`36`](./36-disconnect-and-background-work.md)

## Part B — Bridge narration

### How it reaches the user

`spawn_agent` → `submitJob` → `Watcher` → `Narrator.receive` (gated only by
`narratorEnabled`) → `notifyPhone({type:'narration', text, kind})` → PWA
`narration$` → `voiceSession.injectNarration` → `enqueueSpeak`.

- A second handler in `web/src/llm-intelligence-session.ts` also speaks
  `narration` arriving on the intelligence WebSocket — if both sockets receive
  it, lines are spoken twice. **Needs verifying.**
- `notifyPhone` turns `job_done` / `job_error` narration into push
  notifications, so disabling the narrator also kills those pushes.
- `app.component.ts` uses narration `kind` for `notifyJobRunning`.
- `permission` / `secret_input` narration bypasses `narratorEnabled`.

### It duplicates the voice agent

The AgentVoice prompt makes the agent the narrator (speak before spawning, on
file written / command done / phase change / error, summarise the diff at the
end). The watcher independently speaks `job_started` right after the agent's
own "starting" line, every `file_write` with the raw path, `job_done` ending in
"Want to see the diff?", and `job_error` with the raw provider error. Both land
in one TTS queue with no dedup; the `isSpeaking` deferral never engages
because nothing calls `setSpeaking`; `readAloud: 'replies'` gates none of it.

### Every hardcoded spoken string in `src/`

| File | Kind | Text |
| --- | --- | --- |
| `executor/watcher.ts` | job_started | `${agent} started working on ${project}.` |
| `executor/watcher.ts` | job_done | `Done — ${agent} changed N file(s). Want to see the diff?` |
| `executor/watcher.ts` | job_done | `Done — ${agent} finished with no file changes.` |
| `executor/watcher.ts` | job_error | `Something went wrong. ${agent} said: ${message}` |
| `executor/watcher.ts` | ghost_killed | `Stopped — ${agent} tried to spawn extra agents (${reason}). Budget protection kicked in.` |
| `executor/watcher.ts` | file_write | `${agent} just wrote ${path}.` |
| `executor/narrator.ts` | replay | `While you were away: N files written, N commands run.` |
| `executor/narrator.ts` | replay | `${agent} is still working. So far: N files written.` |
| `executor/voiceAgent.ts` | fallback | `${provider} needs you to sign in — I sent a sign-in link…` |
| `executor/voiceAgent.ts` | fallback | `That ${provider} conversation is no longer available…` |
| `executor/voiceAgent.ts` | fallback | `I finished but did not speak aloud — please try again.` |
| `mcp/server/index.ts` | permission | `${provider} wants to run ${summary}. Say yes or no, or answer on your phone.` |
| `routes/askpass.ts` | secret_input | `${agent} needs your sudo password / a password — enter it on your phone.` |
| `intelligence/ws.ts` | busy | `One moment — I'm still working on your last request.` |

Also: `push/notifyPhone.ts` push text `'New screenshots from Cursor'` is a
provider-parity bug.

### Design (chosen: toggles + templates)

1. **Separate the event from its speech.** Always send
   `{ type: 'narration', kind, data, speak: boolean }` so push and
   `notifyJobRunning` work regardless of speech settings.
2. **Per-event toggles** in "What gets spoken": `job_started`, `job_done`,
   `job_error`, `file_write`, `ghost_killed`, `away_replay`, `permission`,
   `secret_input`, `fallback`. Each is `auto | always | off`; `auto` speaks only
   when no voice agent owns narration (the `llm_intelligence` workflow, or no
   agent attached). Replaces `narratorEnabled` and the dead cadence field.
3. **Templates** — every string above moves to one phrase catalog
   (`src/voice/phrases.ts`, `phrase(kind, params, lang)`) with English
   defaults and per-kind overrides in config, keyed by
   `speechOutputLanguage()` so replies in Polish get Polish narration. Named
   placeholders only (`{agent}`, `{project}`, `{count}`), validated on save
   with a live preview; unknown placeholders are rejected rather than spoken.
4. **Never speak raw error messages or file paths** by default — short phrase
   spoken, detail in the transcript.
5. Fix the Cursor push string and verify the double-delivery path.

## Status — implemented September 2026

Part B shipped in full: `src/voice/phrases.ts` is the single catalog, every
spoken bridge string goes through it, each event has an `auto | always | off`
toggle and a user-editable template keyed by the speech output language, and a
template naming a placeholder its event does not supply is rejected on save
rather than read out with a `{hole}` in it. The event and its speech are now
separate fields on the wire, so turning narration off no longer also kills the
`job_done` push and the PWA's job-running state. Raw provider errors and raw
file paths are not spoken unless the user asks for them. The Cursor-specific
push string is fixed.

The double-delivery path this document asked to verify: **verified, and closed
off.** Narration reaches the PWA only over the control socket today, so the
second handler in `web/src/llm-intelligence-session.ts` was a latent duplicate
rather than a live one — it would have spoken every line twice the moment
narration was also delivered on the intelligence socket, with no dedup between
the two paths. That handler is now transcript-only; speech has exactly one
route.

Part A: the dead settings (narrator cadence, plan-first) are gone from the
schema, the API and the screen; log level moved to the Debug section that
advertised it; the Narrator section became "What gets spoken" and absorbed the
agent-voice and read-aloud controls; extra launch flags and the worker poll
interval moved to Agent, which also absorbed Personal; "Clear all sessions"
asks first; timeouts are entered in minutes; forms gate on `canUseApi()`; and
the stale descriptions, keywords and duplicate icons are corrected. Provider
parity (A7) is fixed at the root: each provider declares its own binary env
var, `EnvSchema` accepts all four, and the screen renders the list from the
providers.

Deliberately left, as smaller-value cosmetics that would churn the template
without changing behaviour: the full 13-section restructure (the sections
exist, but the ordering is not yet the proposed one), the region-settings
consolidation (A11), the three health-check copies (A14), and surfacing the
handful of settings that still have no UI.
