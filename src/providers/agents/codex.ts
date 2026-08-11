/**
 * OpenAI Codex CLI (`codex`) provider.
 *
 * Auth: `codex login --device-auth` prints a URL + short one-time code that
 * can be completed from ANY browser (true RFC 8628-style device flow — no
 * localhost callback), which is exactly what a phone-only user needs. Device
 * code auth must be enabled on the account/workspace; if it is not, the CLI
 * reports that clearly and we surface it as the login instructions.
 * Fallback: OPENAI_API_KEY env var.
 *
 * See https://developers.openai.com/codex/auth
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
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

const execFileAsync = promisify(execFile);
const log = childLogger('provider:codex');

const resolver = createBinResolver({
  envVar: 'CODEX_PATH',
  candidates: [homeCandidate('.local/bin/codex'), homeCandidate('.codex/bin/codex'), '/usr/local/bin/codex'],
  fallback: 'codex',
});

function codexEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // Codex reads OPENAI_API_KEY itself for API-key auth — never strip it here.
  return { ...base, HOME: base.HOME ?? homedir() };
}

async function checkAuth(): Promise<AuthCheckResult> {
  try {
    const { stdout } = await execFileAsync(resolver.resolve(), ['login', 'status'], {
      timeout: 10_000,
      env: codexEnv(process.env),
    });
    const authenticated = /authenticated:\s*yes/i.test(stdout);
    const emailMatch = stdout.match(/account:\s*(\S+@\S+)/i);
    return { authenticated, email: emailMatch?.[1] ?? null };
  } catch (err) {
    return { authenticated: false, email: null, detail: err instanceof Error ? err.message : String(err) };
  }
}

export const codexProvider: AgentProvider = {
  id: 'codex',
  displayName: 'Codex',

  resolveBin: () => resolver.resolve(),
  isInstalled: () => resolver.isInstalled(),
  env: codexEnv,
  checkAuth,

  authFlows(): AuthFlowDescriptor[] {
    return [
      {
        id: 'device-code',
        label: 'Sign in with a device code',
        description: 'Open the link on any device, enter the one-time code, and Codex links this machine.',
      },
      {
        id: 'api-key',
        label: 'Use an API key',
        description: 'Paste an OpenAI API key instead of signing in with ChatGPT.',
        pasteLabel: 'OpenAI API key',
        pastePlaceholder: 'sk-...',
      },
    ];
  },

  async startLogin(flowId: AuthFlowId, opts): Promise<AuthStartResult> {
    if (flowId === 'api-key') {
      const key = opts?.pasted?.trim();
      if (!key || key.length < 8) {
        throw new Error('Paste a valid OpenAI API key.');
      }
      updateAgentEnvKeys({ OPENAI_API_KEY: key });
      const result = await checkAuth();
      return { flow: flowId, instructions: 'API key saved.', done: Promise.resolve(result), cancel: () => {} };
    }

    if (flowId !== 'device-code') {
      throw new Error(`Codex does not support the "${flowId}" login flow.`);
    }

    return runLoginCommand({
      bin: resolver.resolve(),
      args: ['login', '--device-auth'],
      env: codexEnv(process.env),
      urlPattern: /https?:\/\/\S+/,
      codePattern: /\b([A-Z0-9]{4}-[A-Z0-9]{4}(?:-[A-Z0-9]{4})?)\b/,
      verify: checkAuth,
      instructions:
        'Open the link on any device signed in to ChatGPT, then enter the one-time code to link this machine. ' +
        'If it fails immediately, device-code login may be disabled in your ChatGPT security settings.',
      flowId,
    });
  },

  isAuthError(exitCode: number, stderr: string): boolean {
    if (exitCode === 0) return false;
    return /not logged in|not authenticated|please run.*login|401|unauthorized|sign in/i.test(stderr);
  },

  async listModels(): Promise<ModelEntry[]> {
    // Codex has no `codex models` listing command — model choice is config-driven
    // (~/.codex/config.toml [model_providers]). Surface the common presets so the
    // picker still has something real to show, and let advanced users set the
    // model in Codex's own config for anything not listed here.
    return [
      { id: 'gpt-5-codex', displayName: 'GPT-5 Codex (default)' },
      { id: 'o4-mini', displayName: 'o4-mini' },
    ];
  },

  // Codex resolves its model from its own config file, not a CLI flag.
  supportsModelSelection: () => false,

  buildWorkerArgs(opts: SpawnOptions): string[] {
    const { project, prompt, mode = 'agent', oneShot = false } = opts;
    const args: string[] = ['exec'];

    if (project.resumeId && !oneShot && mode !== 'ask') {
      args.push('resume', project.resumeId);
    }
    args.push('--json', '--sandbox', 'workspace-write', '--cd', project.path);
    args.push(buildAgentPrompt(prompt, {}));
    return args;
  },

  buildVoiceArgs(project: Project, _session: SessionState, _pendingTurn?: string, bootPrompt = ''): string[] {
    const args: string[] = ['exec'];
    if (project.resumeId) args.push('resume', project.resumeId);
    args.push('--json', '--sandbox', 'workspace-write', '--cd', project.path);
    args.push(bootPrompt);
    return args;
  },
};

log.debug({ bin: resolver.resolve() }, 'codex provider ready');
