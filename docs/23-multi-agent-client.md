# 23 — Multi-Agent Client Support

> Added: July 2026. See also [`24-agent-providers.md`](./24-agent-providers.md)
> for the in-app auth, live model selection, and generic MCP tools built on
> top of this.

AgentVoice supports three AI coding agent clients that can be used interchangeably
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

Valid values: `"cursor"` (default), `"codex"`, `"claude-code"`.

You can also change the active client from the PWA config tab under **Agent Client**.

## Binary Path Overrides

If the client binary is not on your `PATH`, set the path in `.env`:

```env
CODEX_PATH=/home/you/.local/bin/codex
CLAUDE_CODE_PATH=/home/you/.local/bin/claude
```

The bridge checks these environment variables before searching common locations:
- `~/.local/bin/<binary>`
- `~/.codex/bin/codex` (Codex), `~/.claude/bin/claude` (Claude Code)
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
  [--model <alias>] [--resume <id>] --permission-mode acceptEdits|plan <prompt>
```

Three flags here are not optional:

- `--verbose` — print mode rejects `--output-format stream-json` without it.
- `--allowedTools mcp__agent-voice` — print mode cannot show a permission
  prompt, so an un-allowlisted MCP tool is denied. Without this, `speak()`,
  `done()` and `next_voice_turn()` are all unavailable and the session is mute.
- `--permission-mode` — `acceptEdits` for work, `plan` for read-only `ask`.

## Execution Modes

`agent_ask` must be read-only. Each provider declares what it can actually
enforce (`supportedModes()`), and a mode the CLI cannot enforce is **refused**,
never silently downgraded to a writing agent under a read-only-sounding name.

| Client        | agent | plan | ask | Enforcement                      |
| ------------- | ----- | ---- | --- | -------------------------------- |
| `cursor`      | ✅    | ✅   | ✅  | `--mode plan` / `--mode ask`     |
| `codex`       | ✅    | ❌   | ✅  | `--sandbox read-only`            |
| `claude-code` | ✅    | ✅   | ✅  | `--permission-mode plan` + `--disallowedTools` |

## Stream Parsing

The three CLIs emit three different NDJSON dialects. Providers translate their
own dialect into the normalized events in `src/providers/agents/events.ts`; no
code outside `providers/agents/` parses raw CLI JSON.

Notably, **Codex never puts the session id at the top level** — it is nested
under `msg.session_id` (or `thread_id` in newer builds). Earlier builds only
read `raw.session_id`, so Codex resume never worked at all.

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

Each prepare also strips any leftover `cursor-voice` entry so a stale
registration pointing at a dead port cannot shadow the live one.

The entry contains the bridge MCP URL (`http://localhost:<port>/mcp`) and the
Bearer token from `APP_TOKEN`. No manual configuration is needed.

## Session Resumption

All three clients support session resumption to maintain conversation context:

- **Cursor**: `--resume <session_id>`
- **Codex**: `exec resume <session_id>`
- **Claude Code**: `--resume <session_id>`

The bridge stores the session ID in SQLite after each run and passes it on the
next spawn.

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
    { "id": "claude-code", "label": "Claude Code", "available": false, "binPath": null }
  ]
}
```

The PWA config tab shows a green dot next to available clients and an orange dot
for clients whose binary is not found.
