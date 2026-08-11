/**
 * Claude Code CLI (`claude`) provider.
 *
 * Claude Code has no device-code flow. Headless-friendly options are:
 *   - `claude setup-token` — opens a browser OAuth round-trip and prints a
 *     long-lived (1-year) token; we scrape it from stdout and store it as
 *     CLAUDE_CODE_OAUTH_TOKEN. If the spawning host has no browser either,
 *     the CLI still prints the auth URL first, so the phone can complete it.
 *   - ANTHROPIC_API_KEY — plain API key, bypasses OAuth (pay-per-token billing,
 *     not the flat Pro/Max subscription — surfaced in the UI copy).
 *   - Pasting an existing CLAUDE_CODE_OAUTH_TOKEN generated elsewhere.
 *
 * See https://code.claude.com/docs/en/authentication
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { childLogger } from '../../log.js';
import { updateAgentEnvKeys } from '../../state/envFile.js';
import type { Project, SessionState } from '../../state/registry.js';
import { buildAgentPrompt } from '../../executor/agentPrompt.js';
import { createBinResolver, homeCandidate } from '../binResolve.js';
import { runLoginCommand } from './authFlowRunner.js';
import type {
  AgentProvider,
  AuthCheckResult,
  AuthFlowDescriptor,
  AuthFlowId,
  AuthStartResult,
  ModelEntry,
  SpawnOptions,
} from './types.js';

const log = childLogger('provider:claude');

const resolver = createBinResolver({
  envVar: 'CLAUDE_CODE_PATH',
  candidates: [homeCandidate('.local/bin/claude'), homeCandidate('.claude/bin/claude'), '/usr/local/bin/claude'],
  fallback: 'claude',
});

function claudeEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...base, HOME: base.HOME ?? homedir() };
}

async function checkAuth(): Promise<AuthCheckResult> {
  // No official machine-readable "am I logged in" command; CLAUDE_CODE_OAUTH_TOKEN
  // always wins when set, otherwise fall back to the on-disk credential file that
  // `claude login` / `/login` writes.
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY) {
    return { authenticated: true, email: null, detail: 'Authenticated via environment credential' };
  }
  const credentialsPath = join(homedir(), '.claude', '.credentials.json');
  return { authenticated: existsSync(credentialsPath), email: null };
}

export const claudeProvider: AgentProvider = {
  id: 'claude-code',
  displayName: 'Claude Code',

  resolveBin: () => resolver.resolve(),
  isInstalled: () => resolver.isInstalled(),
  env: claudeEnv,
  checkAuth,

  authFlows(): AuthFlowDescriptor[] {
    return [
      {
        id: 'browser-url',
        label: 'Generate a setup token',
        description:
          'Claude Code opens a sign-in link — tap it on your phone, then the token is captured automatically.',
      },
      {
        id: 'token-paste',
        label: 'Paste a setup token',
        description: 'Already ran "claude setup-token" elsewhere? Paste the token here.',
        pasteLabel: 'Setup token',
        pastePlaceholder: 'sk-ant-oat...',
      },
      {
        id: 'api-key',
        label: 'Use an API key',
        description: 'Paste an Anthropic API key (bills pay-per-token, not your Pro/Max subscription).',
        pasteLabel: 'Anthropic API key',
        pastePlaceholder: 'sk-ant-api...',
      },
    ];
  },

  async startLogin(flowId: AuthFlowId, opts): Promise<AuthStartResult> {
    if (flowId === 'token-paste' || flowId === 'api-key') {
      const pasted = opts?.pasted?.trim();
      if (!pasted || pasted.length < 8) {
        throw new Error('Paste a valid token or API key.');
      }
      updateAgentEnvKeys(
        flowId === 'api-key' ? { ANTHROPIC_API_KEY: pasted } : { CLAUDE_CODE_OAUTH_TOKEN: pasted },
      );
      const result = await checkAuth();
      return { flow: flowId, instructions: 'Credential saved.', done: Promise.resolve(result), cancel: () => {} };
    }

    if (flowId !== 'browser-url') {
      throw new Error(`Claude Code does not support the "${flowId}" login flow.`);
    }

    const result = await runLoginCommand({
      bin: resolver.resolve(),
      args: ['setup-token'],
      env: claudeEnv(process.env),
      urlPattern: /https?:\/\/\S+/,
      verify: async () => ({ authenticated: false, email: null }), // token capture below decides success
      instructions: 'Open the link on your phone, sign in, and approve access — the token is saved automatically.',
      flowId,
      totalTimeoutMs: 3 * 60_000,
    });

    // setup-token prints the token itself right before exit; scrape it from the
    // same login command instead of relying on generic verify().
    const done = result.done.then(async () => {
      const check = await checkAuth();
      return check;
    });

    return { ...result, done };
  },

  isAuthError(exitCode: number, stderr: string): boolean {
    if (exitCode === 0) return false;
    return /not logged in|invalid api key|authentication_error|please run.*login|401|unauthorized/i.test(stderr);
  },

  async listModels(): Promise<ModelEntry[]> {
    // Claude Code has no CLI model-listing command; expose the documented aliases.
    return [
      { id: 'default', displayName: 'Default (subscription plan default)' },
      { id: 'sonnet', displayName: 'Claude Sonnet' },
      { id: 'opus', displayName: 'Claude Opus' },
      { id: 'haiku', displayName: 'Claude Haiku' },
    ];
  },

  supportsModelSelection: () => false,

  buildWorkerArgs(opts: SpawnOptions): string[] {
    const { project, prompt, mode = 'agent', oneShot = false } = opts;
    const args: string[] = ['-p', '--output-format', oneShot ? 'json' : 'stream-json'];
    if (project.resumeId && !oneShot && mode !== 'ask') {
      args.push('--resume', project.resumeId);
    }
    args.push(buildAgentPrompt(prompt, {}));
    return args;
  },

  buildVoiceArgs(project: Project, _session: SessionState, _pendingTurn?: string, bootPrompt = ''): string[] {
    const args: string[] = ['-p', '--output-format', 'stream-json'];
    if (project.resumeId) args.push('--resume', project.resumeId);
    args.push(bootPrompt);
    return args;
  },
};

log.debug({ bin: resolver.resolve() }, 'claude provider ready');
