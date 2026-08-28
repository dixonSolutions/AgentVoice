# 23 — Multi-Agent Client Support

> Added: July 2026. See also [`24-agent-providers.md`](./24-agent-providers.md)
> for the in-app auth, live model selection, and generic MCP tools built on
> top of this.

AgentVoice supports four AI coding agent clients that can be used interchangeably
for both voice agent sessions and worker jobs. Each registers the shared
`agent-voice` MCP server through its own provider
(`src/providers/agents/<client>.ts`). The server key was `cursor-voice` before
August 2026; stale entries are stripped on every session prepare — see
[`docs/26-rename-agentvoice.md`](./26-rename-agentvoice.md).

## Supported Clients

| Client        | Binary         | MCP Config Path                 | Config Format |
| ------------- | -------------- | ------------------------------- | ------------- |
| `cursor`      | `cursor-agent` | `~/.cursor/mcp.json`            | JSON          |
| `codex`       | `codex`        | `~/.codex/config.toml`          | TOML          |
| `claude-code` | `claude`       | `~/.claude.json` + `--mcp-config` | JSON        |
| `codewhale`   | `codewhale`    | `~/.codewhale/mcp.json`         | JSON          |

> **Claude Code does not read MCP servers from `~/.claude/settings.json`.**
> Builds before August 2026 wrote the entry there, so Claude Code never saw the
> bridge and every voice session under it was silently mute. Registration now
> writes `~/.claude.json` (what `claude mcp add --scope user` writes) *and*
> passes a generated `--mcp-config` file on every spawn, which is authoritative
> regardless of the user's global config.

## Configuration

Set the active client in `config.json`:

```json
{
  "settings": {
    "agentClient": "cursor"
  }
}
```

Valid values: `"cursor"` (default), `"codex"`, `"claude-code"`, `"codewhale"`.

You can also change the active client from the PWA config tab under **Agent Client**.

## Binary Path Overrides

If the client binary is not on your `PATH`, set the path in `.env`:

```env
CODEX_PATH=/home/you/.local/bin/codex
CLAUDE_CODE_PATH=/home/you/.local/bin/claude
CODEWHALE_PATH=/home/you/.local/bin/codewhale
```

The bridge checks these environment variables before searching common locations:
- `~/.local/bin/<binary>`
- `~/.codex/bin/codex` (Codex), `~/.claude/bin/claude` (Claude Code)
- `~/.codewhale/bin/codewhale`, `~/.cargo/bin/codewhale`, and the `codew`
  shorthand the release installers also expose (Codewhale)
- `/usr/local/bin/<binary>`
- Falls back to bare binary name on `PATH`

## Installation

### Cursor (cursor-agent)

Install via the Cursor IDE CLI tools or download from the Cursor website.

```bash
# Check installation
cursor-agent --version
```

### Codex CLI

```bash
npm install -g @openai/codex
# or
curl -fsSL https://codex.openai.com/install.sh | sh
```

### Claude Code

```bash
npm install -g @anthropic-ai/claude-code
# or via curl
curl -fsSL https://claude.ai/install.sh | sh
```

### Codewhale

A single Rust binary, installed as both `codewhale` and the `codew` shorthand.

```bash
codewhale --version
```

Codewhale routes across many model providers (DeepSeek, OpenAI, Anthropic,
OpenRouter, Ollama, …) rather than being tied to one vendor, so "signed in" is
a *per-provider* question — see the auth notes in
[`24-agent-providers.md`](./24-agent-providers.md).

## How Each Client Is Invoked

### Cursor

```bash
cursor-agent -p --output-format stream-json --workspace <path> [--resume <id>] [--mode plan|ask] [--approve-mcps] <prompt>
```

### Codex

```bash
codex exec [resume <id>] --json --sandbox workspace-write|read-only --cd <path> [-m <model>] <prompt>
```

Output: JSONL event stream on stdout. `ask` mode uses `--sandbox read-only`;
Codex has no plan mode, so `plan` is refused rather than silently downgraded.

### Claude Code

```bash
claude -p --output-format stream-json --verbose \
  --mcp-config <generated>.json --allowedTools mcp__agent-voice \
  [--model <alias>] [--resume <id>] --permission-mode bypassPermissions|plan <prompt>
```

Three flags here are not optional:

- `--verbose` — print mode rejects `--output-format stream-json` without it.
- `--allowedTools mcp__agent-voice` — print mode cannot show a permission
  prompt, so an un-allowlisted MCP tool is denied. Without this, `speak()`,
  `done()` and `next_voice_turn()` are all unavailable and the session is mute.
- `--permission-mode` — `bypassPermissions` for work, `plan` for read-only
  `ask`. Print mode has no permission UI at all, so anything less than
  `bypassPermissions` (e.g. `acceptEdits`) still blocks the first Bash,
  browser, or other non-edit tool call — the agent stalls mute with no way
  to approve it. Work mode needs every action pre-approved to stay hands-free.

### Codewhale

```bash
codewhale exec --auto --output-format stream-json [--model <id>] [--resume <id>] <prompt>
```

`--auto` is what turns `exec` into a tool-backed agent. Withholding it is how
`ask` is enforced: a plain `codewhale exec` is a one-shot model response with no
filesystem or shell access at all, and `--sandbox read-only` backs that up.

cwd (project path, or the worktree for parallel workers) is set by
`executor/agentProcess.ts`, so no `-C/--workspace` is passed — the registry owns
the workspace, never the caller.

## Execution Modes

`agent_ask` must be read-only. Each provider declares what it can actually
enforce (`supportedModes()`), and a mode the CLI cannot enforce is **refused**,
never silently downgraded to a writing agent under a read-only-sounding name.

| Client        | agent | plan | ask | Enforcement                      |
| ------------- | ----- | ---- | --- | -------------------------------- |
| `cursor`      | ✅    | ✅   | ✅  | `--mode plan` / `--mode ask`     |
| `codex`       | ✅    | ❌   | ✅  | `--sandbox read-only`            |
| `claude-code` | ✅    | ✅   | ✅  | `--permission-mode plan` + `--disallowedTools` |
| `codewhale`   | ✅    | ❌   | ✅  | omit `--auto` (no tools at all) + `--sandbox read-only` |

## Stream Parsing

The four CLIs emit four different NDJSON dialects. Providers translate their
own dialect into the normalized events in `src/providers/agents/events.ts`; no
code outside `providers/agents/` parses raw CLI JSON.

Notably, **Codex never puts the session id at the top level** — it is nested
under `msg.session_id` (or `thread_id` in newer builds). Earlier builds only
read `raw.session_id`, so Codex resume never worked at all.

**Codewhale redacts the session id outright.** Both `session_capture.content`
and `metadata.session_id` are FNV fingerprints (`<redacted:…>`) and
`metadata.resume_command` is the literal string
`codewhale exec --resume <redacted-session-id>`, so no id usable with `--resume`
can be read off the stream at all. `metadata.workspace` is *not* redacted, so
the provider recovers the id from Codewhale's own session store instead — see
`resolveSessionId()` in `src/providers/agents/codewhale.ts`.

**Codewhale has no run-start event.** The other three open with an
`init`-shaped line; Codewhale's first line is whatever the model produced.
`turn_usage` carries a 1-based `turn`, so `turn === 1` is used as the run-start
marker. It fires after the first model call rather than at spawn, so the
"started working on …" narration lands a few seconds late — which still beats
the silence a missing `init` produces.

## MCP Registration

When you start a voice session, the bridge automatically writes the agent-voice
MCP server entry to the active client's global config file:

- **Cursor**: adds/updates `agent-voice` in `~/.cursor/mcp.json`, and writes the
  voice system prompt to `~/.cursor/rules/agent-voice.mdc`
- **Codex**: adds/updates `[mcp_servers."agent-voice"]` in `~/.codex/config.toml`
  with `experimental_use_rmcp_client = true` (required for streamable-HTTP MCP)
  and `bearer_token_env_var`, so the token stays out of the file
- **Claude Code**: writes `data/claude-code-mcp.json` (passed as `--mcp-config`)
  and merges the same entry into `~/.claude.json`
- **Codewhale**: adds/updates `agent-voice` in `~/.codewhale/mcp.json` with
  `bearer_token_env_var`, so the token stays out of the file. Codewhale's root
  key is `servers`, with `mcpServers` as a serde *alias* for the same field —
  writing both spellings makes the file fail to parse as a duplicate field, so
  the entry goes into whichever key the file already uses

Each prepare also strips any leftover `cursor-voice` entry so a stale
registration pointing at a dead port cannot shadow the live one.

The entry contains the bridge MCP URL (`http://localhost:<port>/mcp`) and the
Bearer token from `APP_TOKEN`. No manual configuration is needed.

## Session Resumption

All three clients support session resumption to maintain conversation context:

- **Cursor**: `--resume <session_id>`
- **Codex**: `exec resume <session_id>`
- **Claude Code**: `--resume <session_id>`
- **Codewhale**: `--resume <session_id>` (a unique id *prefix* is also accepted)

The bridge stores the session ID in SQLite after each run and passes it on the
next spawn.

Codewhale is the one client whose id does not come from its own stream. It is
read from `~/.codewhale/sessions/*.json` by matching the unredacted
`metadata.workspace` and taking the most recently updated match. That is a
heuristic — two concurrent runs in one workspace could race and the loser would
resume the winner's thread — bounded by AgentVoice already running one voice
session per project, and backstopped at runtime by `executor/resumeGuard.ts`.

Only Cursor persists AgentVoice's rules in a file the CLI reloads. On a resumed
thread, Codex and Claude Code are therefore re-sent the full system prompt —
otherwise a resumed session carries no voice instructions at all and the agent
answers as text the user never hears.

## Switching Clients

You can switch clients at any time without losing project data. The session
resume IDs are stored per-project in the database and are client-agnostic at
the storage level; switching clients will start a fresh conversation since
session IDs are not portable across different CLI tools.

## Availability Check

The Admin API exposes client availability at `GET /api/admin/agent-client`:

```json
{
  "active": "cursor",
  "clients": [
    { "id": "cursor", "label": "Cursor", "available": true, "binPath": "~/.local/bin/cursor-agent" },
    { "id": "codex", "label": "Codex", "available": false, "binPath": null },
    { "id": "claude-code", "label": "Claude Code", "available": false, "binPath": null },
    { "id": "codewhale", "label": "Codewhale", "available": false, "binPath": null }
  ]
}
```

The PWA config tab shows a green dot next to available clients and an orange dot
for clients whose binary is not found.
