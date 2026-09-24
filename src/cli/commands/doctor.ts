/**
 * `agentvoice doctor` — the checks that actually stop a bridge from working.
 *
 * Every check answers with a remedy, not just a verdict: a doctor that says
 * "better-sqlite3: fail" and stops has moved the problem, not solved it. Order
 * runs outward from the runtime (Node, native binding) to the install (config,
 * data dir) to the world (agent CLI, port, service), and last to what only the
 * running bridge can answer (agent sign-in, hosting).
 *
 * Exit code is 1 if anything failed, 0 otherwise — warnings do not fail the
 * run, because "no APP_TOKEN yet" is a normal state five seconds after install.
 */

import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createBinResolver, whichSync, type BinResolveSpec } from '../../providers/binResolve.js';
import { AGENT_BIN_SPECS } from '../../providers/binSpecs.js';
import { PACKAGE_NAME } from '../../serve/installMode.js';
import { bridgeApi, candidateEndpoints, findBridge, probeHealth } from '../bridge.js';
import { describeUnit, detectUnit, readUnitState } from '../service.js';
import { capture, ran } from '../exec.js';
import {
  checkNativeBinding,
  dbPath,
  envValue,
  errText,
  nativeBindingAdvice,
  packageRoot,
  projectSummary,
  readConfig,
  readConfigFile,
  readEnvFile,
  resolveHome,
} from '../home.js';
import { bold, cyan, dim, mark, say, type Mark } from '../out.js';

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
  checks.push(...(await checkService()));
  checks.push(...(await checkThroughBridge(home)));

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
    detail: error.includes('NODE_MODULE_VERSION')
      ? 'better-sqlite3 was built for a different Node version'
      : `better-sqlite3 will not load — ${error.split('\n')[0]}`,
    fix: nativeBindingAdvice(error) ?? `Reinstall the package: npm i -g ${PACKAGE_NAME}`,
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

  // Projects are discovered under settings.projectDiscovery.hotPaths; a
  // hand-written list is optional. Only warn when nothing can be found at all.
  const p = projectSummary(cfg);
  const count = `${p.projects} project${p.projects === 1 ? '' : 's'}`;
  if (p.discovery && p.hotPaths.length > 0 && p.missingHotPaths.length === p.hotPaths.length) {
    return {
      name: 'config.json',
      status: 'warn',
      detail: `project discovery looks in ${p.hotPaths.join(', ')}, which does not exist`,
      fix: 'Point settings.projectDiscovery.hotPaths at the folder(s) holding your git repos.',
    };
  }
  if (!p.discovery && p.projects === 0) {
    return {
      name: 'config.json',
      status: 'warn',
      detail: 'project discovery is off and no projects are listed',
      fix: `Turn settings.projectDiscovery.enabled back on, or list projects in ${cfg.path}.`,
    };
  }
  return {
    name: 'config.json',
    status: 'ok',
    detail: p.discovery
      ? `discovery in ${p.hotPaths.join(', ')} · ${count} · ${cfg.path}`
      : `${count} · ${cfg.path}`,
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
  // No config yet means the first run will seed one from the packaged example,
  // so check the CLI that example selects — not the schema's fallback.
  const client = cfg.exists
    ? (cfg.config?.settings?.agentClient ?? 'cursor')
    : (readConfigFile(join(packageRoot(), 'config.example.json')).config?.settings?.agentClient ?? 'cursor');
  const spec = (AGENT_BIN_SPECS as Record<string, BinResolveSpec | undefined>)[client];

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
 * Is a background service installed and running? Not installed is only a
 * warning — `agentvoice run` in a terminal is a perfectly good way to use it.
 */
async function checkService(): Promise<Check[]> {
  const unit = await detectUnit();
  if (unit.scope === 'none') {
    return [
      {
        name: 'service',
        status: 'warn',
        detail: unit.noSystemd ? 'no service manager on this host' : 'none installed — the bridge only runs while a terminal does',
        ...(unit.noSystemd ? {} : { fix: 'Install one:  agentvoice service install --now' }),
      },
    ];
  }

  const state = await readUnitState(unit);
  const checks: Check[] = [
    state?.activeState === 'active'
      ? { name: 'service', status: 'ok', detail: `${describeUnit(unit)} · ${state.subState}` }
      : {
          name: 'service',
          status: 'warn',
          detail: `${describeUnit(unit)} is ${state ? `${state.activeState} (${state.subState})` : 'in an unknown state'}`,
          fix: 'Start it:  agentvoice start   ·   Why it stopped:  agentvoice logs -n 50',
        },
  ];

  // A systemd user unit dies at logout unless linger is on — exactly when you
  // want to reach the bridge from your phone.
  if (unit.scope === 'user') {
    const user = process.env['USER'] ?? '';
    const linger = await capture('loginctl', ['show-user', user, '--property=Linger']);
    if (ran(linger) && linger.code === 0 && !linger.stdout.includes('Linger=yes')) {
      checks.push({
        name: 'linger',
        status: 'warn',
        detail: 'off — the service stops when you log out',
        fix: `loginctl enable-linger ${user || '$USER'}`,
      });
    } else if (ran(linger) && linger.code === 0) {
      checks.push({ name: 'linger', status: 'ok', detail: 'on — the service keeps running after logout' });
    }
  }
  return checks;
}

interface ProviderAuth {
  authenticated: boolean;
  email: string | null;
  detail?: string;
}

interface HostingDoctor {
  ok: boolean;
  checks: Array<{ label: string; ok: boolean; detail?: string }>;
}

/**
 * Checks only the running bridge can answer: whether the agent CLI is signed
 * in and whether the hosting provider is healthy. The management CLI stays
 * dependency-light by asking, rather than loading every provider itself.
 */
async function checkThroughBridge(home: string): Promise<Check[]> {
  const cfg = readConfig(home);
  const bridge = await findBridge(home, cfg);
  const endpoint = bridge.answering?.endpoint;
  if (!endpoint) {
    return [
      {
        name: 'bridge',
        status: 'warn',
        detail: 'not running — agent sign-in and hosting checks skipped',
        fix: 'Start it (agentvoice start, or agentvoice run) and re-run doctor.',
      },
    ];
  }

  const checks: Check[] = [];
  const client = bridge.answering?.health?.agentClient ?? cfg.config?.settings?.agentClient ?? 'cursor';
  if (bridge.answering?.health?.cliFound !== false) {
    const auth = await bridgeApi<ProviderAuth>(home, endpoint, `/api/providers/${encodeURIComponent(client)}/status`);
    if (!auth.ok) {
      checks.push({ name: 'agent sign-in', status: 'warn', detail: `could not ask the bridge — ${auth.error}` });
    } else if (auth.body.authenticated) {
      checks.push({
        name: 'agent sign-in',
        status: 'ok',
        detail: `${client} signed in${auth.body.email ? ` as ${auth.body.email}` : ''}`,
      });
    } else {
      checks.push({
        name: 'agent sign-in',
        status: 'fail',
        detail: `${client} is not signed in${auth.body.detail ? ` — ${auth.body.detail}` : ''}`,
        fix: 'Sign in from the app (it prompts on the first voice turn), or in a terminal with the CLI itself.',
      });
    }
  }

  const providers = await bridgeApi<{ active: string }>(home, endpoint, '/api/admin/hosting-providers');
  const hosting = providers.ok ? providers.body.active : null;
  if (hosting) {
    const result = await bridgeApi<HostingDoctor>(
      home,
      endpoint,
      `/api/admin/hosting-providers/doctor?provider=${encodeURIComponent(hosting)}`,
      30_000,
    );
    if (!result.ok) {
      checks.push({ name: 'hosting', status: 'warn', detail: `${hosting}: could not ask the bridge — ${result.error}` });
    } else {
      const failed = result.body.checks.filter((c) => !c.ok);
      checks.push(
        failed.length === 0
          ? { name: 'hosting', status: 'ok', detail: `${hosting} · ${result.body.checks.length}/${result.body.checks.length} provider checks pass` }
          : {
              name: 'hosting',
              status: 'fail',
              detail: `${hosting} · ${failed.map((c) => c.label).join(', ')}`,
              fix: failed
                .map((c) => `${c.label}${c.detail ? `: ${c.detail}` : ''}`)
                .concat('Fix it from Config → Serve → Network in the app.')
                .join('\n'),
            },
      );
    }
  }
  return checks;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
