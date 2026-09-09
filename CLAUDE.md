# AgentVoice — rules for agents working in this repo

Several agents (Claude Code sessions, worktrees under `.claude/worktrees/`, the
AgentVoice bridge's own workers) edit this repository at the same time. The
`agent-locks` MCP server is the coordination point — use it, every time.

## Work-claiming (mandatory)

1. **Before editing**, call `lock_query` (active locks) and `lock_check_conflict`
   with the globs you are about to touch. If another active lock overlaps,
   coordinate (narrow your scope, wait, or work elsewhere) — do not silently
   edit the same files.
2. **Claim** the work with `lock_create` (title, globs, checklist) before the
   first edit. Keep the scope honest: list every path you will change.
3. **Update as you go** — `lock_update` the moment a task completes, not at
   the end. Other agents read `lock_query` to see live state.
4. **Finish** with `lock_finish` and a one-line summary when done, and always
   before ending the session — an abandoned active lock blocks everyone.

Locks live under the shared `.git` directory and are never committed.

## Worktrees and commits

- `.claude/worktrees/*` are other agents' checkouts. Never edit, `git add`, or
  delete them. They are git-ignored; never `git add -A` from the repo root
  without checking `git status` first.
- Commit only what you changed; keep each PR to one lock's scope.
- Never commit `.env`, `config.json`, `data/`, tokens, or anything under
  `.claude/worktrees/`.

## Provider rule (see docs/24 and docs/33)

- Nothing per-CLI is hardcoded as data: model lists, effort levels and speed
  tiers come from the CLI (`listModels()`); permission modes are declared by the
  provider and passed as **launch flags** on every spawn — never by editing the
  CLI's own settings / permissions JSON.
- Every capability must be implemented for all four providers (Cursor, Codex,
  Claude Code, Codewhale) or explicitly declared unsupported by that provider —
  never Claude-only.
