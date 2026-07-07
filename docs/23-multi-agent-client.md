# 23 — Multi-Agent Client Support

> Added: July 2026

CursorVoice supports three AI coding agent clients that can be used interchangeably
for both voice agent sessions and worker jobs. All three support the shared
cursor-voice MCP server via their global configuration files.

## Supported Clients

| Client      | Binary   | MCP Config Path             | Config Format |
| ----------- | -------- | --------------------------- | ------------- |
| `cursor`    | `cursor-agent` | `~/.cursor/mcp.json`   | JSON          |
| `codex`     | `codex`  | `~/.codex/config.toml`      | TOML          |
| `claude-code` | `claude` | `~/.claude/settings.json` | JSON          |

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
cursor-agent -p --output-format stream-json --workspace <path> [--resume <id>] [--mode plan|ask] <prompt>
```

### Codex

```bash
codex exec [resume <id>] --json --sandbox workspace-write --cd <path> <prompt>
```

Output: JSONL event stream on stdout.

### Claude Code

```bash
claude -p --output-format stream-json [--resume <id>] <prompt>
```

MCP servers are auto-discovered from `~/.claude/settings.json`.

## MCP Registration

When you start a voice session, the bridge automatically writes the cursor-voice
MCP server entry to the active client's global config file:

- **Cursor**: adds/updates `cursor-voice` in `~/.cursor/mcp.json`
- **Codex**: adds/updates `[mcp_servers.cursor-voice]` in `~/.codex/config.toml`
- **Claude Code**: adds/updates `mcpServers.cursor-voice` in `~/.claude/settings.json`

The entry contains the bridge MCP URL (`http://localhost:<port>/mcp`) and the
Bearer token from `APP_TOKEN`. No manual configuration is needed.

## Session Resumption

All three clients support session resumption to maintain conversation context:

- **Cursor**: `--resume <session_id>`
- **Codex**: `exec resume <session_id>`
- **Claude Code**: `--resume <session_id>`

The bridge stores the session ID in SQLite after each run and passes it on the
next spawn.

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
