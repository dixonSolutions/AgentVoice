/**
 * `agentvoice doctor` — the checks that actually stop a bridge from working.
 *
 * Every check answers with a remedy, not just a verdict: a doctor that says
 * "better-sqlite3: fail" and stops has moved the problem, not solved it. Order
 * runs outward from the runtime (Node, native binding) to the install (config,
 * data dir) to the world (agent CLI, port).
 *
 * Exit code is 1 if anything failed, 0 otherwise — warnings do not fail the
 * run, because "no APP_TOKEN yet" is a normal state five seconds after install.
 */

import { accessSync, constants, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createBinResolver, homeCandidate, type BinResolveSpec } from '../../providers/binResolve.js';
import { candidateEndpoints, probeHealth } from '../bridge.js';
import {
  checkNativeBinding,
  dbPath,
  envValue,
  errText,
  nativeBindingAdvice,
  readConfig,
  readEnvFile,
  resolveHome,
} from '../home.js';
import { bold, cyan, dim, mark, say, type Mark } from '../out.js';

/**
 * Where each agent CLI lives, mirroring src/providers/agents/*.ts.
 *
 * Duplicated rather than imported: importing the provider registry drags in the
 * whole executor stack — including @aws-sdk — and the management CLI must stay
 * a fast, dependency-light binary. The authoritative answer still comes from
 * the bridge (`/healthz` reports the resolved CLI and its version); this table
 * only exists so `doctor` can say something useful while the bridge is down.
 */
const AGENT_CLI_SPECS: Record<string, BinResolveSpec> = {
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
    candidates: [
      homeCandidate('.local/bin/codex'),
      homeCandidate('.codex/bin/codex'),
      '/usr/local/bin/codex',
    ],
    fallback: 'codex',
  },
  'claude-code': {
    envVar: 'CLAUDE_CODE_PATH',
    candidates: [
      homeCandidate('.local/bin/claude'),
      homeCandidate('.claude/bin/claude'),
      '/usr/local/bin/claude',
    ],
    fallback: 'claude',
  },
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
};

const MIN_NODE_MAJOR = 20;

export interface Check {
  name: string;
  status: Mark;
  detail: string;
  /** What to do about it. Only ever set on warn/fail. */
  fix?: string;
}

export async function doctorCommand(opts: { json: boolean }): Promise<number> {
  const home = resolveHome();
  const checks: Check[] = [];

  checks.push(checkNode());
  checks.push(await checkBinding());
  checks.push(checkConfig(home));
  checks.push(checkDataDir(home));
  checks.push(checkToken(home));
  checks.push(checkAgentCli(home));
  checks.push(await checkPort(home));

  const failed = checks.some((c) => c.status === 'fail');

  if (opts.json) {
    say(JSON.stringify({ home, ok: !failed, checks }, null, 2));
    return failed ? 1 : 0;
  }

  say('');
  say(`  ${bold(cyan('agentvoice doctor'))}  ${dim(home)}`);
  say('');
  for (const check of checks) {
    say(`  ${mark(check.status)}  ${bold(check.name.padEnd(16))} ${check.detail}`);
    if (check.fix) {
      for (const line of check.fix.split('\n')) say(`        ${dim(line)}`);
    }
  }
  say('');
  return failed ? 1 : 0;
}

function checkNode(): Check {
  const major = Number(process.versions.node.split('.')[0]);
  if (major >= MIN_NODE_MAJOR) {
    return { name: 'node', status: 'ok', detail: `${process.version} (${process.execPath})` };
  }
  return {
    name: 'node',
    status: 'fail',
    detail: `${process.version} — AgentVoice needs Node ${MIN_NODE_MAJOR}+`,
    fix: 'Install a newer Node and re-run. nvm: nvm install --lts && nvm use --lts',
  };
}

async function checkBinding(): Promise<Check> {
  const error = await checkNativeBinding();
  if (!error) return { name: 'sqlite', status: 'ok', detail: 'better-sqlite3 binding loads' };
  return {
    name: 'sqlite',
    status: 'fail',
    detail: `better-sqlite3 will not load — ${error.split('\n')[0]}`,
    fix: nativeBindingAdvice(error) ?? 'Reinstall the package: npm i -g agentvoice',
  };
}

function checkConfig(home: string): Check {
  const cfg = readConfig(home);
  if (!cfg.exists) {
    return {
      name: 'config.json',
      status: 'fail',
      detail: `missing at ${cfg.path}`,
      fix: 'Run `agentvoice` once — it seeds config.json from the packaged example.',
    };
  }
  if (cfg.error) {
    return {
      name: 'config.json',
      status: 'fail',
      detail: `unparseable — ${cfg.error}`,
      fix: `Fix the JSON in ${cfg.path}, or delete it and run \`agentvoice\` to re-seed.`,
    };
  }

  const projects = Array.isArray(cfg.config?.projects) ? cfg.config.projects : [];
  if (projects.length === 0) {
    return {
      name: 'config.json',
      status: 'warn',
      detail: 'parses, but registers no projects',
      fix: `Add your projects (absolute paths) to ${cfg.path}.`,
    };
  }
  return {
    name: 'config.json',
    status: 'ok',
    detail: `${projects.length} project${projects.length === 1 ? '' : 's'} · ${cfg.path}`,
  };
}

function checkDataDir(home: string): Check {
  const db = dbPath(home);
  const dir = dirname(db);
  try {
    mkdirSync(dir, { recursive: true });
    // accessSync(W_OK) lies on some mounts (and on every container running as
    // root); an actual write is the only answer worth reporting.
    const probe = join(dir, `.agentvoice-doctor-${process.pid}`);
    writeFileSync(probe, 'ok');
    rmSync(probe, { force: true });
  } catch (err) {
    return {
      name: 'data dir',
      status: 'fail',
      detail: `${dir} is not writable — ${errText(err)}`,
      fix: `Fix ownership:  chown -R "$USER" ${dir}\nOr point DB_PATH somewhere writable in ${join(home, '.env')}.`,
    };
  }

  const size = existsSync(db) ? statSync(db).size : 0;
  return {
    name: 'data dir',
    status: 'ok',
    detail: size ? `${dir} writable · state.db ${formatBytes(size)}` : `${dir} writable · no database yet`,
  };
}

function checkToken(home: string): Check {
  const fromFile = (readEnvFile(home).get('APP_TOKEN') ?? '').trim();
  const fromEnv = (process.env['APP_TOKEN'] ?? '').trim();
  const token = fromEnv || fromFile;

  if (!token) {
    return {
      name: 'APP_TOKEN',
      status: 'warn',
      detail: 'not configured — no client can pair',
      fix: 'Mint one:  agentvoice token --new',
    };
  }
  // The bridge's own EnvSchema rejects anything shorter; catching it here beats
  // catching it as a zod crash on the next boot. The value is never printed.
  if (token.length < 16) {
    return {
      name: 'APP_TOKEN',
      status: 'fail',
      detail: `too short (${token.length} chars) — the bridge requires at least 16`,
      fix: 'Replace it:  agentvoice token --new',
    };
  }
  return {
    name: 'APP_TOKEN',
    status: 'ok',
    detail: `configured (${fromEnv ? 'environment' : '.env'})`,
  };
}

function checkAgentCli(home: string): Check {
  const cfg = readConfig(home);
  const client = cfg.config?.settings?.agentClient ?? 'cursor';
  const spec = AGENT_CLI_SPECS[client];

  if (!spec) {
    return {
      name: 'agent CLI',
      status: 'fail',
      detail: `settings.agentClient is "${client}", which is not a known provider`,
      fix: 'Valid values: cursor, codex, claude-code, codewhale.',
    };
  }

  const pinned = spec.envVar ? envValue(home, spec.envVar)?.trim() : undefined;
  if (pinned) {
    return existsSync(pinned)
      ? { name: 'agent CLI', status: 'ok', detail: `${client} → ${pinned} (${spec.envVar})` }
      : {
          name: 'agent CLI',
          status: 'fail',
          detail: `${spec.envVar} points at ${pinned}, which does not exist`,
          fix: `Correct or remove ${spec.envVar} in ${join(home, '.env')}.`,
        };
  }

  const known = createBinResolver(spec).resolvedPath();
  if (known) return { name: 'agent CLI', status: 'ok', detail: `${client} → ${known}` };

  const onPath = whichSync(spec.fallback);
  if (onPath) return { name: 'agent CLI', status: 'ok', detail: `${client} → ${onPath} (PATH)` };

  return {
    name: 'agent CLI',
    status: 'fail',
    detail: `${client} is selected but \`${spec.fallback}\` is not installed`,
    fix: `Install it and make sure it is on PATH, pin it with ${spec.envVar} in ${join(home, '.env')},\nor switch settings.agentClient in config.json. See docs/23-multi-agent-client.md.`,
  };
}

async function checkPort(home: string): Promise<Check> {
  const endpoint = candidateEndpoints(home, readConfig(home))[0];
  if (!endpoint) {
    return {
      name: 'port',
      status: 'fail',
      detail: 'no backendPort in config.json for the active runMode',
      fix: 'Set settings.runModes.<runMode>.backendPort in config.json.',
    };
  }

  const probe = await probeHealth(endpoint, 2500);
  if (probe.ok) {
    return { name: 'port', status: 'ok', detail: `${endpoint.port} held by this AgentVoice (${endpoint.url})` };
  }
  if (probe.foreign) {
    return {
      name: 'port',
      status: 'fail',
      detail: `${endpoint.port} is in use by something that is not AgentVoice — ${probe.detail}`,
      fix: `Find it:  ss -ltnp 'sport = :${endpoint.port}'\nOr move the bridge: settings.runModes.<runMode>.backendPort in config.json.`,
    };
  }
  return { name: 'port', status: 'ok', detail: `${endpoint.port} is free (nothing listening)` };
}

/**
 * PATH lookup. binResolve's own fallback is a bare command name meant to be
 * handed to spawn(); `doctor` has to resolve it here or it could only ever
 * report "maybe".
 */
function whichSync(command: string): string | null {
  const path = process.env['PATH'];
  if (!path) return null;
  for (const dir of path.split(':')) {
    if (!dir) continue;
    const candidate = join(dir, command);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* next */
    }
  }
  return null;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
