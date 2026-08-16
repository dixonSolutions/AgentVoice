# 01 — Critical Analysis

A deliberately critical, component-by-component review of the original proposal.
Verdict up front: **the concept is feasible and the technology choices are
largely correct.** The biggest wins come from *removing* complexity the original
plan assumed it needed, and from tightening the security boundary. Findings below
were validated against current docs (June 2026).

Legend: ✅ sound · ⚠️ needs change/attention · ❌ wrong assumption

---

## 1. Overall concept — ✅ Feasible

A non-technical person directing a coding agent by voice is a strong fit for a
speech-to-speech model that can ask clarifying questions and narrate results.
Nothing here is research-grade; every piece is an integration of existing,
documented products. The main risks are **latency**, **error/ambiguity
handling**, and **safety of autonomous execution** — all addressable.

---

## 2. Phone / web app — ✅ with caveats

- ✅ iOS Safari **requires HTTPS (secure context)** for `getUserMedia()`.
  Confirmed; `navigator.mediaDevices` is `undefined` on insecure origins. The
  Tailscale HTTPS plan resolves this.
- ✅ Add-to-Home-Screen PWA is a fine delivery mechanism.
- ⚠️ **AudioWorklet + manual PCM chunking over WebSocket** is the *harder* path.
  Since we chose **WebRTC** (see Decisions), the browser handles capture,
  encoding, echo cancellation, jitter buffering, and playback natively. This
  removes a whole class of bugs (resampling to 24 kHz, base64 framing, glitchy
  playback). Net: **less custom audio code, lower latency.**
- ⚠️ **Wake word "Cursor…" as always-on listening** in foreground Safari is
  unreliable and battery-hungry, and Safari aggressively suspends background
  tabs. Resolved by using a **latching push-to-talk toggle** as the primary
  control and treating "Cursor…" as an *intent prefix* the model keys on while
  the mic is open. See `06`.

---

## 3. Network / Tailscale — ✅ Correct and the right call

- ✅ Tailscale provides private mesh connectivity + **automatic TLS** via
  `tailscale serve`, satisfying the HTTPS-for-mic requirement with **no port
  forwarding** and no manual cert rotation.
- ⚠️ **Funnel (public exposure)** should be avoided unless strictly necessary.
  It would only be needed if we used the provider's *remote-MCP-by-URL* feature
  (provider servers calling our MCP endpoint). We deliberately **do not** rely on
  that for the default design, keeping the home machine off the public internet.
  See `03-security.md`.

---

## 4. Bridge (Node.js/TypeScript) — ✅ Good, but simplify

- ✅ Node 20+, TypeScript, Fastify + websocket, `simple-git`, `strip-ansi`,
  SQLite for state — all reasonable, lightweight, well-supported choices.
- ❌ **"Uses `node-pty` to satisfy cursor-agent's TTY requirement."** This is
  likely an **incorrect assumption.** Cursor's own docs state print mode is
  *inferred for non-TTY stdout or piped stdin*, and `--print`/`--output-format
  json` are explicitly designed for scripts and CI (no TTY). **Action:** treat
  `node-pty` as *not required* and validate with a spike (see `05`). Dropping it
  removes a native dependency, simplifies the build, and avoids ANSI noise
  (a real TTY is what *produces* the ANSI codes the plan then has to strip).
- ⚠️ **ANSI stripping before `JSON.parse`** — with `--output-format json` on a
  non-TTY pipe there should be little/no ANSI. Keep `strip-ansi` as defensive
  hygiene, but the parsing strategy should be "read stdout stream → parse the
  single JSON object (`json`) or NDJSON lines (`stream-json`)", not "scrub a
  terminal screen."
- ⚠️ **One process serving web app + WS + MCP** is fine for a single-user home
  setup. Just keep the MCP execution path isolated behind token auth and an
  allowlist.

---

## 5. MCP server / tools — ✅ This is the heart of the safety model

- ✅ Exposing a **small, constrained tool set** (`agent_submit`,
  `agent_job_status`, `agent_job_stop`, `agent_revert`, `agent_new_session`,
  `agent_diff`) is exactly right. **This — not raw shell access — is the safety
  boundary.** The voice model can only do what these tools allow.
- ⚠️ Each tool must **validate inputs at the API level**: `project` must be in an
  **allowlist registry** (never an arbitrary path), and the tool must run
  `cursor-agent` with a fixed `--workspace` derived from that registry, not from
  user-supplied strings. This directly satisfies the project security rule
  ("enforce security at the API level").
- ⚠️ **Schema adapter (MCP ↔ realtime function-calling).** The original plan
  budgets for a hand-written adapter. Two realities in the GA Realtime API
  reduce this cost: (a) tools are defined directly in the session config as
  function tools, so we can generate the function-tool definitions from the same
  TypeScript source of truth as the MCP tools (one schema, two emitters);
  (b) the API also supports remote MCP servers by URL, though we avoid that for
  security. Net: keep a **single source of truth** for tool schemas (DRY).

---

## 6. Speech-to-speech model — ⚠️ Schema is outdated; capabilities improved

- ❌ **Beta session schema.** The original snippets imply the *beta* Realtime
  shape (`modalities`, `OpenAI-Beta: realtime=v1`). The API went **GA (April
  2026)**: use `session.type: "realtime"`, audio config under
  `session.audio.input` / `session.audio.output`, `output_modalities`, and the
  newer event names (`response.output_audio.delta`,
  `response.output_audio_transcript.delta`, etc.). **Action:** target the GA
  interface from day one.
- ✅ **New capabilities help us:** native **remote MCP support** and
  **async function calling** (the conversation keeps going — "give me a
  second…" — while a long `agent_submit` runs). Async function calling is the
  clean answer to the "cursor-agent jobs are slow" problem.
- ✅ **Provider independence** from the model `cursor-agent` uses is correct and
  important — two separate accounts/keys/billing. Keep the provider behind an
  interface so OpenAI Realtime ↔ Gemini Live is a config swap (both handle
  Polish + English).
- ⚠️ **Ephemeral tokens are mandatory for WebRTC from the browser.** The browser
  must never hold the provider API key. The bridge mints short-lived client
  secrets (`POST /v1/realtime/client_secrets`) with the session/tool config
  baked in. See `06`.

---

## 7. cursor-agent (CLI) — ✅ Flags confirmed, but it's beta

Confirmed against Cursor CLI docs:

- ✅ `-p/--print`, `--output-format text|json|stream-json`,
  `--stream-partial-output`, `--resume [chatId]`, `--continue`, `--model`,
  `--mode plan|ask` (agent is default), `--force`/`--yolo`, `--trust`,
  `--sandbox enabled|disabled`, `--approve-mcps`, `--workspace <dir>`,
  `agent ls`, `agent resume`.
- ⚠️ **Officially beta — "flags may change between releases."** Pin the CLI
  version, add a startup capability check (`--help`/`--list-models`), and isolate
  all CLI knowledge in one module so a flag rename is a one-file change.
- ⚠️ **`json` waits for completion**; `thinking` events are suppressed in print
  mode. For voice UX we want progress, so prefer **`stream-json`** to surface
  tool-call start/finish events for "still working…" narration, and read the
  final result object for the spoken summary.
- ⚠️ **Non-interactive needs `--force` (and `--trust` for headless)** or the
  agent stalls on approval prompts. This is safe *because* the tool wrapper +
  project allowlist constrain what can be asked, not because the agent is
  individually sandboxed. (Optionally layer `--sandbox enabled` for defense in
  depth.)
- ✅ **Session continuity** via persisted `--resume <id>` per project is the
  right model. **Important:** CLI sessions are scoped to `--workspace` (cwd if
  omitted) — `agent ls` lists sessions for that workspace only, not projects.
  Recovery: `cursor-agent ls --workspace <project path>`. Resume IDs must
  always be used with the matching workspace path.

---

## 8. Speech/agent safety — ⚠️ Reframed (per your guidance)

The original framing ("how autonomous / `--yolo` is scary") was the wrong axis.
**Correct framing:** this is an **MCP wrapper**, not unlimited shell access. The
agent's blast radius is bounded by:

1. **Tool surface** — only the small, fixed set of constrained tools exists.
2. **Project allowlist** — `cursor-agent` only ever runs inside known workspaces.
3. **Git revert** — `agent_revert` is a fast, reliable undo for any edit.
4. **Token auth** — only the authenticated phone can invoke tools at all.

Residual risk: a *valid* tool call can still ask the agent to do something
destructive *within* an allowlisted project (e.g., "delete all tests"). Mitigated
by git revert + (optional, recommended) plan-mode-first for `agent_submit` so
the model can describe intent before applying. Documented as a config toggle.

---

## 9. Deployment — ✅ Standard and fine

- ✅ systemd unit running a compiled bundle, `.env` for the *provider* key
  (separate from Cursor's account), Tailscale for transport. Nothing exotic.
- ⚠️ Add: log rotation, a health endpoint, graceful handling of `cursor-agent`
  crashes/zombie processes, and secret hygiene (`.env` perms `600`, never
  committed).

---

## 10. What the original plan got most right / most wrong

**Most right**
- MCP-as-safety-boundary; provider independence; Tailscale for private HTTPS;
  per-project resume sessions; lightweight stack.

**Most wrong / changed**
- `node-pty` assumed mandatory → likely unnecessary (validate & drop).
- Beta Realtime schema → use GA schema + WebRTC + ephemeral tokens.
- Always-on wake word → latching push-to-talk + "Cursor…" prefix + voice
  start/end.
- "ANSI scrubbing of a terminal" → straightforward JSON/NDJSON stream parsing.

**Net effect:** a *simpler*, lower-latency, more secure system than originally
specified.
