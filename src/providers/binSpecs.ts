/**
 * Where each agent CLI lives — the one table the providers and
 * `agentvoice doctor` both read.
 *
 * Its own module, with no imports beyond binResolve, because the management
 * CLI must not load the provider registry (that drags in the whole executor
 * stack, @aws-sdk included) just to ask where `codex` is. It used to keep a
 * copy of this table instead, which drifted the first time a candidate moved.
 */

import { homeCandidate, type BinResolveSpec } from './binResolve.js';

export const AGENT_BIN_SPECS = {
  cursor: {
    envVar: 'CURSOR_AGENT_PATH',
    candidates: [
      homeCandidate('.local/bin/cursor-agent'),
      homeCandidate('.cursor/bin/cursor-agent'),
      '/usr/local/bin/cursor-agent',
    ],
    fallback: 'cursor-agent',
  },
  codex: {
    envVar: 'CODEX_PATH',
    candidates: [homeCandidate('.local/bin/codex'), homeCandidate('.codex/bin/codex'), '/usr/local/bin/codex'],
    fallback: 'codex',
  },
  'claude-code': {
    envVar: 'CLAUDE_CODE_PATH',
    candidates: [homeCandidate('.local/bin/claude'), homeCandidate('.claude/bin/claude'), '/usr/local/bin/claude'],
    fallback: 'claude',
  },
  /** Release installs expose the same runtime as both `codewhale` and `codew`. */
  codewhale: {
    envVar: 'CODEWHALE_PATH',
    candidates: [
      homeCandidate('.local/bin/codewhale'),
      homeCandidate('.codewhale/bin/codewhale'),
      homeCandidate('.cargo/bin/codewhale'),
      '/usr/local/bin/codewhale',
      homeCandidate('.local/bin/codew'),
      '/usr/local/bin/codew',
    ],
    fallback: 'codewhale',
  },
} satisfies Record<string, BinResolveSpec>;

export type AgentBinId = keyof typeof AGENT_BIN_SPECS;
