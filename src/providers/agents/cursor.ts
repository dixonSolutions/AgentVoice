/**
 * Cursor CLI (`cursor-agent`) provider.
 *
 * Auth: `NO_OPEN_BROWSER=1 cursor-agent login` prints a plain login URL instead
 * of trying to open a local browser (there is none on a headless bridge host);
 * the phone opens that URL and the CLI process exits once the account links.
 * Fallback: CURSOR_API_KEY env var (no browser round-trip at all).
 *
 * See https://cursor.com/docs/cli/reference/authentication
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import stripAnsi from 'strip-ansi';
import { getConfig } from '../../config.js';
import { childLogger } from '../../log.js';
import { updateAgentEnvKeys } from '../../state/envFile.js';
import type { Project, SessionState } from '../../state/registry.js';
import { buildAgentPrompt, buildAskPrompt } from '../../executor/agentPrompt.js';
import { createBinResolver, homeCandidate } from '../binResolve.js';
import { runLoginCommand } from './authFlowRunner.js';
import type {
  AgentAbout,
  AgentProvider,
  AuthCheckResult,
  AuthFlowDescriptor,
  AuthFlowId,
  AuthStartResult,
  ModelEntry,
  SpawnOptions,
} from './types.js';

const execFileAsync = promisify(execFile);
const log = childLogger('provider:cursor');

const resolver = createBinResolver({
  envVar: 'CURSOR_AGENT_PATH',
  candidates: [
    homeCandidate('.local/bin/cursor-agent'),
    homeCandidate('.cursor/bin/cursor-agent'),
    '/usr/local/bin/cursor-agent',
  ],
  fallback: 'cursor-agent',
});

function parseModelsOutput(raw: string): ModelEntry[] {
  return stripAnsi(raw)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.includes(' - ') && !l.startsWith('Tip:') && !l.startsWith('Available models') && l.length > 0)
    .map((l) => {
      const dashIdx = l.indexOf(' - ');
      return { id: l.slice(0, dashIdx).trim(), displayName: l.slice(dashIdx + 3).trim() };
    })
    .filter((m) => m.id.length > 0);
}

async function checkAuth(): Promise<AuthCheckResult> {
  try {
    const { stdout } = await execFileAsync(resolver.resolve(), ['status', '--format', 'json'], {
      timeout: 10_000,
      env: cursorEnv(process.env),
    });
    const parsed = JSON.parse(stripAnsi(stdout).trim()) as Record<string, unknown>;
    const userInfo = (parsed['userInfo'] ?? {}) as Record<string, unknown>;
    return {
      authenticated: parsed['isAuthenticated'] === true,
      email: typeof userInfo['email'] === 'string' ? userInfo['email'] : null,
    };
  } catch (err) {
    return { authenticated: false, email: null, detail: err instanceof Error ? err.message : String(err) };
  }
}

function cursorEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...base,
    HOME: base.HOME ?? homedir(),
    // Cursor's own auth owns the session — never leak other providers' keys into it.
    OPENAI_API_KEY: undefined,
    GEMINI_API_KEY: undefined,
  };
}

function buildWorkerArgs(opts: SpawnOptions): string[] {
  const { project, session, prompt, mode = 'agent', oneShot = false, worktree, browser } = opts;
  const { settings } = getConfig();

  const args: string[] = [
    '-p',
    '--output-format',
    oneShot ? 'json' : 'stream-json',
    '--workspace',
    project.path,
  ];

  if (worktree) args.push('-w', worktree);
  if (session.activeModel && session.activeModel !== 'auto') {
    args.push('--model', session.activeModel);
  }
  if (project.resumeId && !oneShot && mode !== 'ask' && !worktree) {
    args.push('--resume', project.resumeId);
  }
  if (mode === 'plan') args.push('--mode', 'plan');
  else if (mode === 'ask') args.push('--mode', 'ask');

  for (const flag of settings.preRunFlags) args.push(flag);

  args.push(mode === 'ask' ? buildAskPrompt(prompt) : buildAgentPrompt(prompt, { browser }));
  return args;
}

function buildVoiceArgs(project: Project, session: SessionState, pendingTurn?: string, bootPrompt = ''): string[] {
  const { settings } = getConfig();
  const args: string[] = ['-p', '--output-format', 'stream-json', '--workspace', project.path, '--approve-mcps'];

  if (session.activeModel && session.activeModel !== 'auto') {
    args.push('--model', session.activeModel);
  }
  if (project.resumeId) args.push('--resume', project.resumeId);
  for (const flag of settings.preRunFlags) {
    if (!args.includes(flag)) args.push(flag);
  }
  args.push(bootPrompt);
  void pendingTurn;
  return args;
}

export const cursorProvider: AgentProvider = {
  id: 'cursor',
  displayName: 'Cursor',

  resolveBin: () => resolver.resolve(),
  isInstalled: () => resolver.isInstalled(),
  env: cursorEnv,
  checkAuth,

  authFlows(): AuthFlowDescriptor[] {
    return [
      {
        id: 'browser-url',
        label: 'Sign in with browser',
        description: 'Cursor opens a login link — tap it on your phone to link this device.',
      },
      {
        id: 'api-key',
        label: 'Use an API key',
        description: 'Paste a Cursor Dashboard API key instead of signing in interactively.',
        pasteLabel: 'Cursor API key',
        pastePlaceholder: 'key_...',
      },
    ];
  },

  async startLogin(flowId: AuthFlowId, opts): Promise<AuthStartResult> {
    if (flowId === 'api-key') {
      const key = opts?.pasted?.trim();
      if (!key || key.length < 8) {
        throw new Error('Paste a valid Cursor API key (from cursor.com/dashboard/api).');
      }
      updateAgentEnvKeys({ CURSOR_API_KEY: key });
      const result = await checkAuth();
      return {
        flow: flowId,
        instructions: 'API key saved.',
        done: Promise.resolve(result),
        cancel: () => {},
      };
    }

    if (flowId !== 'browser-url') {
      throw new Error(`Cursor does not support the "${flowId}" login flow.`);
    }

    return runLoginCommand({
      bin: resolver.resolve(),
      args: ['login'],
      env: { ...cursorEnv(process.env), NO_OPEN_BROWSER: '1' },
      urlPattern: /https?:\/\/\S+/,
      verify: checkAuth,
      instructions: 'Open the link on your phone and sign in to Cursor — this device links automatically.',
      flowId,
    });
  },

  isAuthError(exitCode: number, stderr: string): boolean {
    if (exitCode === 0) return false;
    return /authentication required|not authenticated|not logged in|please (run|log ?in)|cursor-agent login|401|unauthorized/i.test(
      stderr,
    );
  },

  async listModels(): Promise<ModelEntry[]> {
    const { stdout } = await execFileAsync(resolver.resolve(), ['models'], {
      timeout: 15_000,
      env: cursorEnv(process.env),
    });
    return parseModelsOutput(stdout);
  },

  supportsModelSelection: () => true,
  buildWorkerArgs,
  buildVoiceArgs,

  async getAbout(): Promise<AgentAbout | null> {
    try {
      const { stdout } = await execFileAsync(resolver.resolve(), ['about', '--format', 'json'], {
        timeout: 10_000,
        env: cursorEnv(process.env),
      });
      const parsed = JSON.parse(stripAnsi(stdout).trim()) as Partial<AgentAbout>;
      if (!parsed.cliVersion) return null;
      return {
        cliVersion: parsed.cliVersion ?? '',
        model: parsed.model ?? '',
        osPlatform: parsed.osPlatform ?? '',
        osArch: parsed.osArch ?? '',
      };
    } catch {
      return null;
    }
  },
};

log.debug({ bin: resolver.resolve() }, 'cursor provider ready');
