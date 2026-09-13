/**
 * `agentvoice status` — one screen that answers "is it running, and is it the
 * version I think it is".
 *
 * Everything here is read-only and best-effort: a missing config, a dead
 * service and an unreachable registry each degrade to one honest line rather
 * than aborting the report. Someone runs `status` precisely when something is
 * broken, so it has to survive being run on a broken install.
 *
 * The APP_TOKEN is reported as configured/absent and never printed — `token`
 * is the one command allowed to show it.
 */

import { detectInstallMode } from '../../serve/installMode.js';
import { findBridge } from '../bridge.js';
import { readConfig, readEnvFile, resolveHome } from '../home.js';
import { bold, cyan, dim, green, red, renderRows, say, yellow, type Row } from '../out.js';
import { detectUnit, noUnitAdvice, readUnitState } from '../service.js';
import { gitVersion, isNewer, latestOnRegistry, packageVersion } from '../versions.js';

export interface StatusReport {
  install: ReturnType<typeof detectInstallMode>;
  home: string;
  version: {
    installed: string;
    latest?: string | null;
    updateAvailable?: boolean;
    registryError?: string | null;
    git?: Awaited<ReturnType<typeof gitVersion>>;
  };
  config: { path: string; exists: boolean; error: string | null; projects: number | null };
  service: {
    unit: string;
    scope: string;
    installed: boolean;
    active: boolean;
    state: string | null;
    since: string | null;
    mainPid: number | null;
    enabled: string | null;
    /** Why there is nothing to manage, and what to do about it. */
    advice: string | null;
  };
  bridge: {
    url: string | null;
    port: number | null;
    portFrom: string | null;
    reachable: boolean;
    detail: string | null;
    health: Record<string, unknown> | null;
  };
  token: { configured: boolean; source: 'env-file' | 'environment' | null };
}

export async function collectStatus(): Promise<StatusReport> {
  const install = detectInstallMode();
  const home = resolveHome();
  const cfg = readConfig(home);

  const installed = packageVersion(install.root);
  const version: StatusReport['version'] = { installed };
  if (install.mode === 'git') {
    version.git = await gitVersion(install.root);
  } else if (install.mode === 'npm') {
    const latest = await latestOnRegistry('agentvoice');
    version.latest = latest.version;
    version.registryError = latest.error;
    version.updateAvailable = latest.version ? isNewer(latest.version, installed) : false;
  }

  const unit = await detectUnit();
  const unitState = await readUnitState(unit);
  const noUnit = unit.scope === 'none' ? noUnitAdvice(unit, install.root) : null;

  const bridge = await findBridge(home, cfg);
  const answering = bridge.answering;
  const firstProbe = bridge.probes[0] ?? null;

  const envFile = readEnvFile(home);
  const tokenInFile = (envFile.get('APP_TOKEN') ?? '').trim().length > 0;
  const tokenInEnv = (process.env['APP_TOKEN'] ?? '').trim().length > 0;

  const projects = Array.isArray(cfg.config?.projects) ? cfg.config.projects.length : null;

  return {
    install,
    home,
    version,
    config: { path: cfg.path, exists: cfg.exists, error: cfg.error, projects },
    service: {
      unit: unit.unit,
      scope: unit.scope,
      installed: unit.scope !== 'none',
      active: unitState?.activeState === 'active',
      state: unitState ? `${unitState.activeState} (${unitState.subState})` : null,
      since: unitState?.since ?? null,
      mainPid: unitState?.mainPid ?? null,
      enabled: unitState?.enabled ?? null,
      advice: noUnit,
    },
    bridge: {
      url: answering?.endpoint.url ?? bridge.configured?.url ?? null,
      port: answering?.endpoint.port ?? bridge.configured?.port ?? null,
      portFrom: answering?.endpoint.from ?? bridge.configured?.from ?? null,
      reachable: Boolean(answering),
      detail: answering ? null : (firstProbe?.detail ?? 'no port configured'),
      health: (answering?.health ?? null) as Record<string, unknown> | null,
    },
    token: {
      configured: tokenInFile || tokenInEnv,
      source: tokenInFile ? 'env-file' : tokenInEnv ? 'environment' : null,
    },
  };
}

export async function statusCommand(opts: { json: boolean }): Promise<number> {
  const report = await collectStatus();

  if (opts.json) {
    say(JSON.stringify(report, null, 2));
    return report.bridge.reachable ? 0 : 1;
  }

  const rows: Row[] = [];

  rows.push({
    label: 'install',
    value: `${bold(report.install.mode)}  ${report.install.root}`,
    notes: [report.install.reason],
  });

  rows.push({ label: 'home', value: report.home });

  rows.push(versionRow(report));

  rows.push({
    label: 'config',
    value: configValue(report),
    notes: [report.config.path],
  });

  rows.push(serviceRow(report));
  rows.push(...bridgeRows(report));

  rows.push({
    label: 'token',
    value: report.token.configured
      ? `${green('configured')} ${dim(`(${report.token.source === 'env-file' ? '.env' : 'APP_TOKEN in environment'})`)}`
      : `${red('not set')} ${dim('— run `agentvoice token --new`')}`,
  });

  rows.push({
    label: 'update',
    value: report.install.updateCommand
      ? `agentvoice update ${dim(`→ ${report.install.updateCommand}`)}`
      : `${yellow('not available')} ${dim('— install mode is unknown')}`,
  });

  say('');
  say(`  ${bold(cyan('AgentVoice'))}`);
  say('');
  say(renderRows(rows));
  say('');

  return report.bridge.reachable ? 0 : 1;
}

function versionRow(report: StatusReport): Row {
  const { version, install } = report;

  if (install.mode === 'git') {
    const git = version.git;
    if (!git) {
      return { label: 'version', value: `${version.installed} ${dim('(git metadata unreadable)')}` };
    }
    const drift: string[] = [];
    if (git.ahead) drift.push(`${git.ahead} ahead`);
    if (git.behind) drift.push(yellow(`${git.behind} behind`));
    const tail = [
      git.upstream ? `vs ${git.upstream}` : 'no upstream',
      drift.length ? drift.join(', ') : git.upstream ? 'in sync' : null,
      git.dirty ? yellow('dirty tree') : null,
    ]
      .filter(Boolean)
      .join(' · ');

    return {
      label: 'version',
      value: `${version.installed}  ${dim(`${git.branch ?? '?'} @ ${git.commit ?? '?'}`)}`,
      notes: [
        `${tail}${git.upstream ? ' (as of the last fetch)' : ''}`,
        git.subject ? `HEAD: ${git.subject}` : '',
      ].filter(Boolean),
    };
  }

  if (install.mode === 'npm') {
    if (version.registryError) {
      return {
        label: 'version',
        value: `${version.installed} ${dim(`(latest unknown — ${version.registryError})`)}`,
      };
    }
    if (version.updateAvailable) {
      return {
        label: 'version',
        value: `${version.installed} → ${yellow(`${version.latest} available`)}`,
        notes: ['agentvoice update'],
      };
    }
    return { label: 'version', value: `${version.installed} ${green('(latest)')}` };
  }

  return { label: 'version', value: version.installed };
}

function configValue(report: StatusReport): string {
  if (!report.config.exists) {
    return `${red('missing')} ${dim('— run `agentvoice` once to seed it')}`;
  }
  if (report.config.error) {
    return `${red('unparseable')} ${dim(`— ${report.config.error}`)}`;
  }
  const projects = report.config.projects;
  return `${green('ok')} ${dim(`${projects ?? 0} project${projects === 1 ? '' : 's'}`)}`;
}

function serviceRow(report: StatusReport): Row {
  const svc = report.service;
  if (!svc.installed) {
    return {
      label: 'service',
      value: dim('none installed'),
      notes: (svc.advice ?? '').split('\n').slice(1).map((line) => line.trim()),
    };
  }
  const scope = `${svc.unit} (${svc.scope} unit${svc.enabled ? `, ${svc.enabled}` : ''})`;
  const state = svc.active ? green(svc.state ?? 'active') : red(svc.state ?? 'inactive');
  const notes = [scope];
  if (svc.since) notes.push(`since ${svc.since}${svc.mainPid ? ` · pid ${svc.mainPid}` : ''}`);
  return { label: 'service', value: state, notes };
}

function bridgeRows(report: StatusReport): Row[] {
  const b = report.bridge;
  const rows: Row[] = [];

  if (!b.url) {
    rows.push({ label: 'bridge', value: `${red('no port configured')}` });
    return rows;
  }

  rows.push({
    label: 'bridge',
    value: b.reachable ? `${green('healthy')}  ${b.url}` : `${red('not answering')}  ${b.url}`,
    notes: [b.portFrom ? `port ${b.port} from ${b.portFrom}` : '', b.detail ?? ''].filter(Boolean),
  });

  const health = b.health;
  if (health) {
    const db = String(health['db'] ?? '?');
    const projects = Number(health['projects'] ?? 0);
    const client = String(health['agentClient'] ?? '?');
    const cliVersion = health['cliVersion'];
    const agent =
      cliVersion === null || cliVersion === undefined
        ? `${client} ${yellow('(not resolved yet)')}`
        : `${client} ${String(cliVersion)}`;
    rows.push({
      label: 'healthz',
      value: `db ${db === 'ok' ? green('ok') : red(db)} · ${projects} project${projects === 1 ? '' : 's'} · agent CLI ${agent}`,
      notes: [`runMode ${String(health['runMode'] ?? '?')} · open ${String(health['webUrl'] ?? b.url)}`],
    });
  }

  return rows;
}
