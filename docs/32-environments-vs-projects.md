# 32 — Environment selection vs. the project registry (issue #40)

> Diagnosis, September 2026. Nothing here is implemented yet — this records
> *why* the request in [#40](https://github.com/dixonSolutions/AgentVoice/issues/40)
> collides with the current model and what the least-damaging path looks like.

## The ask

Let the user pick **where the agent runs** — desktop (this host), remote
(another machine), or a CLI's cloud environment — "dependent on readily
available options", and do it without breaking the way projects work today.

## Why it fights the whole model

Everything below `projects[]` in `config.json` assumes one invariant: **a
project is an absolute path on the host the bridge runs on**.

| Layer | What it assumes | Where |
| --- | --- | --- |
| Registry | `path` is local, `existsSync(path)` is meaningful, aliases map to *that* checkout | `state/registry.ts`, `state/projectsConfig.ts` |
| Spawn | the CLI is a local binary launched with `--workspace <path>` / `--cd <path>` / `-C <path>` | every `providers/agents/*.ts` `buildWorkerArgs` |
| Worktrees | parallel agents get `git worktree add` inside that checkout | `executor/git.ts`, `SpawnOptions.worktree` |
| Diff / revert | `simple-git` opens the same path for `agent_diff`, `agent_revert`, checkpoints | `executor/git.ts`, `mcp/tools/*` |
| Watcher | stdout of a local child process is the only progress signal | `executor/watcher.ts`, `executor/agentProcess.ts` |
| Resume | `resume_id` is a thread in the *local* CLI's store (`~/.claude/projects`, `~/.codex/sessions`, …); `sessionStatus()` inspects that store | `providers/agents/*.ts sessionStatus`, `state/resumeMigration.ts` |
| MCP registration | the CLI's config on this host gets the `agent-voice` server entry so the spawned process can call back | `providers/agents/mcpRegistration.ts` |
| Auth | `checkAuth()` / login flows talk to the CLI on this host; tokens land in this host's `.env` / keyring | `providers/agents/*.ts`, `state/envFile.ts` |
| Deployment | systemd `ReadWritePaths` whitelists exactly those local paths | `agentvoice.service` |

An "environment" changes the answer to *where does the path live and who runs
the binary*, which is the one thing all eight layers hard-code. That is the
sense in which #40 "fights the folder project setup": it is not one feature,
it is a new axis under every feature.

Concretely, for each candidate environment:

- **Desktop** — what exists today. Nothing to add.
- **Remote host (SSH)** — the checkout, the CLI binary, its auth store, its
  session store and the MCP callback all move to the other machine. The
  bridge would have to launch `ssh host -- cursor-agent …` (or run a thin
  agent there), and the MCP server it registers must be reachable *from* that
  host — today it is registered as a local URL. Worktrees, diff and revert
  become remote git operations. `resume_id` is only valid on that host.
- **Cloud (Claude Code `--environment ccpool_…`, Cursor / Codex cloud agents)**
  — there is no path at all. The repo is whatever the cloud environment
  cloned; local diff/revert/worktree cannot apply; progress comes back over
  the CLI's stream (fine) but the MCP callback has to be a public URL (see
  ADR-006 in `08-decisions-and-risks.md`, which rejected exactly that);
  resume ids are cloud session ids. Of the three CLIs, only Claude Code
  currently exposes this as a flag we can drive headlessly; Cursor and
  Codex cloud agents are launched from their own UIs and would need a
  different integration entirely.

The other half of the request — "dependent on readily available options" —
is detection: whether SSH hosts are configured, whether the active CLI has
cloud environments the account can use. That part is cheap and does not
conflict with anything, but it is pointless until an environment can be
*used*.

## What not to do

- Do not add `environment` to `SessionState` next to `activeModel` and
  branch on it in each provider. The branches would land in the eight
  layers above and every project would silently be "desktop" until someone
  noticed the resume id or the diff was for the wrong machine.
- Do not make the project registry environment-agnostic by dropping `path`.
  The allowlist *is* the safety model ("paths are never sent to the phone",
  `assertValidProjectPath`, systemd `ReadWritePaths`); a project without a
  trusted location has nothing to be checked against.

## Recommended path

Treat the environment as a property of the **project**, not of the session,
and make the desktop case the only one that carries a path:

```jsonc
{
  "name": "cursorvoice",
  "environment": { "kind": "desktop", "path": "/home/…/CursorVoice" },   // today's shape, explicit
  // or
  "environment": { "kind": "ssh", "host": "devbox", "path": "/srv/…" },
  // or
  "environment": { "kind": "claude-cloud", "environmentId": "ccpool_…", "repo": "org/repo" }
}
```

Then, in order:

1. **Capabilities, not branches.** Extend `AgentProvider` with
   `supportedEnvironments(): EnvironmentKind[]` (Claude Code:
   `desktop | claude-cloud`; the others: `desktop`) and give each
   environment kind a small executor interface — `spawn`, `diff`, `revert`,
   `worktree?`, `sessionStore?` — so the layers above call the environment
   rather than assuming a local path. Missing members mean "not offered
   here" and the corresponding MCP tools refuse cleanly, the way
   `supportedModes()` already makes `agent_ask` refuse on a CLI that cannot
   enforce read-only.
2. **Desktop first, unchanged behaviour.** Migrate `path` into
   `environment: { kind: "desktop", path }` with the same config
   migration pattern used for `defaultActiveModel` / `hosting`; nothing
   else changes. This is the whole first PR.
3. **Claude Code cloud second.** It is the only environment a CLI already
   exposes headlessly (`claude --environment <id>`), it needs no SSH
   plumbing, and its limits are honest: no local diff/revert (the tools
   refuse), resume via the cloud session id, MCP callback via the existing
   hosting provider's public URL (`25-hosting-providers.md`) — which is
   precisely the ADR-006 trade-off, now scoped to one environment kind
   instead of the whole bridge.
4. **"Readily available" detection last.** `GET /api/environments` lists the
   kinds the active provider supports and which are usable right now
   (SSH host reachable, cloud environments the account can see). The
   Config tab's project editor offers only those.
5. **SSH only if still wanted after 3.** It is the most invasive kind
   (remote git, remote CLI auth, remote session store, a reachable MCP
   endpoint) and the one with the fewest advantages over running a second
   bridge on that host and pointing the phone at it — which already works.

## Related

- [`23-multi-agent-client.md`](./23-multi-agent-client.md) — per-CLI spawn flags
- [`24-agent-providers.md`](./24-agent-providers.md) — the provider contract this would extend
- [`08-decisions-and-risks.md`](./08-decisions-and-risks.md) — ADR-006 (no public remote-MCP)
- [`22-split-host-tunnel.md`](./22-split-host-tunnel.md) — the "second bridge on the other host" alternative
