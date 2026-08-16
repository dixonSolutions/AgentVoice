# 10 — Cursor CLI Reference (useful surface for AgentVoice)

Live-verified against `cursor-agent 2026.06.04-5fd875e` (June 2026, Ultra account).
The CLI is **beta** — flags and output may change between releases.
All CLI interaction is isolated in `src/executor/agentProcess.ts`.

> Binary name: `cursor-agent` (also aliased as `agent`). On PATH after install.

---

## Complete command reference (`cursor-agent --help`)

```
Usage: agent [options] [command] [prompt...]

Arguments:
  prompt                       Initial prompt for the agent

Options:
  -v, --version
  --api-key <key>              (can also use CURSOR_API_KEY env var)
  -H, --header <header>        Custom header (format: 'Name: Value', repeatable)
  -p, --print                  Non-interactive / headless mode. Full tool access.
  --output-format <format>     text | json | stream-json  (only with --print)
  --stream-partial-output      Char-level deltas (only with --print + stream-json)
  --mode <mode>                plan | ask  (agent is default, no flag needed)
  --plan                       Shorthand for --mode=plan
  --resume [chatId]            Resume a session (default: false)
  --continue                   Resume most recent session
  --model <model>              Model ID (e.g. gpt-5.2, claude-opus-4-8-thinking-high)
  --list-models                List models and exit
  -f, --force / --yolo         Auto-run + apply; deny list still applies
  --sandbox <mode>             enabled | disabled
  --approve-mcps               Auto-approve all MCP servers
  --trust                      Skip workspace-trust prompt (headless only)
  --workspace <path>           Workspace dir (defaults to cwd)
  --plugin-dir <path>          Load a local plugin dir (repeatable)
  -w, --worktree [name]        Run in isolated git worktree at ~/.cursor/worktrees/
  --worktree-base <branch>     Base branch for new worktree (default: HEAD)
  --skip-worktree-setup        Skip setup scripts from .cursor/worktrees.json

Commands:
  install-shell-integration    Add shell integration to ~/.zshrc
  uninstall-shell-integration  Remove shell integration from ~/.zshrc
  login                        Authenticate with Cursor
  logout                       Sign out
  mcp                          Manage MCP servers (sub-commands below)
  worker [options]             Start a private cloud worker
  status|whoami [options]      View authentication status (--format text|json)
  models                       List available models
  about [options]              Version + system + account info (--format text|json)
  update                       Update to latest CLI version (manual only in prod)
  create-chat                  Create a new empty chat, return its ID
  generate-rule|rule           Generate a Cursor rule (interactive TTY only)
  agent [prompt]               Start Cursor Agent (interactive)
  ls                           List/resume chat sessions (interactive TTY only)
  resume                       Resume latest chat (interactive TTY only)
```

---

## Commands used by AgentVoice

### `cursor-agent models`

```bash
cursor-agent models
# or
cursor-agent --list-models
```

**Output (live, June 2026):** plain text, one line per model, format `<id> - <display name>`.
143 models on this Ultra account. No JSON output available — parse manually.

```
Available models

auto - Auto
gpt-5.3-codex-low - Codex 5.3 Low
...
kimi-k2.5 - Kimi K2.5

Tip: use --model <id> (or /model <id> in interactive mode) to switch.
```

**Parsing rules:**
- Strip the first line "Available models" (and any blank lines after it).
- Strip the last "Tip: …" line.
- Each remaining non-blank line: split at the **first** ` - ` to get `{ id, displayName }`.
- `auto - Auto` is always first — valid model ID, means "Cursor chooses default".

---

### `cursor-agent -p` (print / headless mode)

```bash
cursor-agent -p [flags] "prompt"
```

All AgentVoice executor calls use this path.

| Flag | AgentVoice use |
| --- | --- |
| `-p, --print` | Always required for headless. |
| `--output-format stream-json` | **Preferred** — NDJSON, events during run. |
| `--output-format json` | Single JSON at completion (used for `agent_ask`). |
| `--model <id>` | From `session_state.active_model`. |
| `--workspace <dir>` | **Always** from registry path — never from caller. |
| `--force` / `--yolo` | Auto-run + apply; deny list still applies. |
| `--trust` | Skips workspace-trust prompt (headless only). |
| `--sandbox enabled\|disabled` | Optional OS-level sandboxing. |
| `--resume [chatId]` | Resume a session (must pair with same `--workspace`). |
| `--continue` | Resume most recent in workspace. |
| `--mode plan\|ask` | `plan` = no edits; `ask` = read-only Q&A. |
| `--approve-mcps` | Only if the executor agent itself uses MCPs. |

---

### `cursor-agent about --format json`

```bash
cursor-agent about --format json
```

**Live output (June 2026):**
```json
{
  "cliVersion": "2026.06.04-5fd875e",
  "model": "Composer 2.5 Fast",
  "subscriptionTier": "Ultra",
  "osPlatform": "linux",
  "osArch": "x64",
  "userEmail": "user@example.com",
  "terminalProgram": "unknown",
  "shell": "bash",
  "lastRequestId": null
}
```

Used by the health endpoint and the `agent_info` MCP tool.

---

### `cursor-agent status --format json`

```bash
cursor-agent status --format json
```

**Live output (June 2026):**
```json
{
  "status": "authenticated",
  "isAuthenticated": true,
  "hasAccessToken": true,
  "hasRefreshToken": true,
  "userInfo": {
    "email": "user@example.com",
    "userId": 123456789,
    "firstName": "Firstname",
    "lastName": "Lastname",
    "createdAt": "2025-01-01T00:00:00.000Z"
  }
}
```

Used by the health endpoint and the `agent_status` MCP tool.

---

### `cursor-agent mcp` subcommands

```bash
cursor-agent mcp list                     # list configured MCP servers + status
cursor-agent mcp list-tools <identifier>  # list tools for a specific server
cursor-agent mcp enable <identifier>      # add to local approved list
cursor-agent mcp disable <identifier>     # disable (won't load or prompt)
cursor-agent mcp login <identifier>       # authenticate with an MCP server
```

Used by `agent_mcp_list` and `agent_mcp_tools` MCP tools (informational only).

---

### `cursor-agent create-chat`

```bash
cursor-agent create-chat
```

Creates a new empty chat, prints its ID. Used by `agent_new_session` to pre-create
a session ID before any prompt.

---

### `cursor-agent ls` ⚠️ REQUIRES INTERACTIVE TTY

```
⚠️ Cannot be used headlessly.
cursor-agent ls exits with a raw-mode error when stdin is not a TTY.
```

Session IDs are captured from `system:init` and `result` events in the stream-json
output and persisted to the DB. **Never call `ls` from the bridge.**

Use for **manual session recovery over SSH only** (outside the voice flow).

---

## `stream-json` event reference (live-verified, June 2026)

`cursor-agent -p --output-format stream-json` emits one JSON object per line.

```jsonc
// Run started
{"type":"system","subtype":"init","session_id":"...","model":"..."}

// Tool call starting
{"type":"assistant","subtype":"tool_use_start","tool_call":{"writeToolCall":{"path":"src/app.ts"}}}

// Tool call completed
{"type":"assistant","subtype":"tool_use_done","tool_call":{...},"success":true}

// Aggregated assistant message (between tool calls)
{"type":"assistant","message":{"content":[{"text":"Done. Added dark mode..."}]}}

// Run complete
{"type":"result","session_id":"...","usage":{...}}

// Run failed
{"type":"error","message":"..."}
```

**Key fields:**
- `session_id` — on `system:init` and `result`; persist as `project.resume_id`.
- `tool_call` keys: `writeToolCall`, `readToolCall`, `shellToolCall`, etc.
- `thinking` events are **suppressed** in print mode.
- Unknown fields: **ignore** (forward-compatible).
- Buffer until `\n`; run `strip-ansi` defensively before `JSON.parse`.

---

## Permissions config (`cli-config.json`)

```
Global (service user):  ~/.cursor/cli-config.json
Per project (only `permissions` honoured): <workspace>/.cursor/cli.json
```

```json
{
  "version": 1,
  "permissions": {
    "allow": ["Shell(git)", "Shell(ls)"],
    "deny": [
      "Shell(rm)", "Shell(sudo)", "Shell(git:push*)",
      "Read(.env*)", "Write(**/*.key)", "Write(**/*.pem)"
    ]
  }
}
```

Token types: `Shell(<cmd>)`, `Read(<glob>)`, `Write(<glob>)`, `WebFetch(<domain>)`, `Mcp(<server>:<tool>)`.
`--force` honors deny rules. Deny beats allow.

---

## Model ID conventions (observed June 2026)

Pattern: `<family>-<version>[-<variant>][-<effort>][-fast]`

| Family | Examples |
| --- | --- |
| gpt | `gpt-5.2`, `gpt-5.3-codex-high`, `gpt-5.5-medium` |
| claude | `claude-opus-4-8-thinking-high`, `claude-4-sonnet`, `claude-fable-5-thinking-high` |
| gemini | `gemini-3-flash`, `gemini-3.1-pro`, `gemini-3.5-flash` |
| composer | `composer-2.5-fast` (account default as of June 2026) |
| kimi | `kimi-k2.5` |

Special: `auto` = Cursor chooses (safe default for `session_state.active_model`).

---

## Commands NOT ported and why

| Command | Why not ported |
| --- | --- |
| `cursor-agent ls` | **Requires interactive TTY** — raw-mode error headlessly. |
| `cursor-agent resume` (interactive) | TTY only; bridge uses `--resume` flag instead. |
| `cursor-agent login` / `logout` | Operator-only setup via SSH. |
| `cursor-agent update` | Never auto-update the service — manual only. |
| `cursor-agent worker` | Cloud worker mode; AgentVoice uses local `cursor-agent -p`. |
| `cursor-agent generate-rule` | Interactive TTY only. |
| `cursor-agent acp` | Evaluated and rejected (ADR-017 in `08`); `--print` is simpler. |
