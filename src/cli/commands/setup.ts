/**
 * `agentvoice setup` — the guided first-time setup, the same for every install
 * (npm, .deb/.rpm, or a clone, where scripts/setup.sh builds first and then
 * hands over to this).
 *
 *   1. Ask once: install a background service?
 *   2. Project config — always: agent CLI, where your repos live, and
 *      optionally the directory you ran it from.
 *   3. Only if you said yes to 1: install and start the service, then set up
 *      hosting (Tailscale, Cloudflare, …) through the running bridge.
 *
 * The question comes first but the service starts last, so the bridge boots
 * once, with the finished config — no restart in the middle of a wizard.
 * Say no, and setup is config only: nothing is installed, nothing exposed.
 *
 * Every question has a default; `--yes` (or no terminal) takes them all, and
 * flags answer individual questions for scripted installs.
 */

import { existsSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createBinResolver, whichSync } from '../../providers/binResolve.js';
import { AGENT_BIN_SPECS, type AgentBinId } from '../../providers/binSpecs.js';
import { detectInstallMode } from '../../serve/installMode.js';
import { bridgeApi, findBridge, type Endpoint } from '../bridge.js';
import { capture, passthrough, ran } from '../exec.js';
import { envPath, readConfig, resolveHome, seedConfig, seedEnv } from '../home.js';
import { bold, cyan, dim, fail, green, say, yellow } from '../out.js';
import { Prompter } from '../prompt.js';
import { addCommand } from './add.js';
import { serviceInstallCommand } from './serviceInstall.js';
import { serviceCommand } from './service.js';
import { describeUnit, detectUnit, readUnitState } from '../service.js';

export interface SetupOptions {
  /** Take every default without asking. */
  yes?: boolean;
  /** Answer "install a service?" up front: true / false. */
  service?: boolean;
  /** Hosting provider id, or "none". */
  hosting?: string;
  /** Agent CLI id (cursor, codex, claude-code, codewhale). */
  agent?: string;
  /** Folder holding your git repos, for project discovery. */
  projectsDir?: string;
}

const AGENT_LABELS: Record<AgentBinId, string> = {
  cursor: 'Cursor (cursor-agent)',
  codex: 'Codex (codex)',
  'claude-code': 'Claude Code (claude)',
  codewhale: 'Codewhale (codewhale)',
};

const HOSTING_CHOICES = [
  { id: 'tailscale', label: 'Tailscale', note: 'private HTTPS on your tailnet — recommended' },
  { id: 'cloudflare', label: 'Cloudflare Tunnel' },
  { id: 'ngrok', label: 'ngrok' },
  { id: 'devtunnel', label: 'Azure Dev Tunnels' },
  { id: 'lan', label: 'Local network (LAN)' },
  { id: 'none', label: 'Not now', note: 'this machine only; set it up later in Config → Serve → Network' },
];

function installedAgent(id: AgentBinId): string | null {
  const spec = AGENT_BIN_SPECS[id];
  return createBinResolver(spec).resolvedPath() ?? whichSync(spec.fallback);
}

/**
 * "Set to run" across systemd, launchd and Windows. For launchd, readUnitState
 * reports `installed` when the plist exists but is not bootstrapped — it still
 * starts at login (RunAtLoad), e.g. after `agentvoice stop`.
 */
const ENABLED_STATES = new Set(['enabled', 'enabled-runtime', 'linked', 'linked-runtime', 'static', 'loaded', 'installed', 'auto']);

/** Is a service installed *and* set to run (enabled) or running right now? */
async function serviceIsLive(): Promise<boolean> {
  const unit = await detectUnit();
  if (unit.scope === 'none') return false;
  const state = await readUnitState(unit);
  return state?.activeState === 'active' || ENABLED_STATES.has(state?.enabled ?? '');
}

function step(n: number, total: number, title: string): void {
  say('');
  say(`  ${cyan(bold(`${n}/${total}`))}  ${bold(title)}`);
}

async function waitForBridge(home: string, seconds: number): Promise<Endpoint | null> {
  for (let i = 0; i < seconds; i++) {
    const found = await findBridge(home, readConfig(home));
    if (found.answering) return found.answering.endpoint;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return null;
}

interface SetupRun {
  events: Array<{ message: string; error?: string }>;
  done: boolean;
  result?: { ok: boolean; publicUrl: string | null; detail: string };
}

/** Kick off hosting setup in the bridge and relay its progress until it ends. */
async function runHostingSetup(home: string, endpoint: Endpoint, provider: string): Promise<string | null> {
  const start = await bridgeApi<{ runId: string }>(home, endpoint, '/api/admin/hosting-providers/setup', 15_000, {
    method: 'POST',
    body: { provider },
  });
  if (!start.ok) {
    fail(`hosting setup could not start — ${start.error}`);
    return null;
  }
  let shown = 0;
  // Setup may wait on a sign-in (tailscale up prints a login URL): allow 10 min.
  for (let i = 0; i < 600; i++) {
    const run = await bridgeApi<SetupRun>(home, endpoint, `/api/admin/hosting-providers/setup/${start.body.runId}`);
    if (run.ok) {
      for (const event of run.body.events.slice(shown)) {
        say(`     ${event.error ? yellow('!') : dim('·')} ${event.message}`);
      }
      shown = run.body.events.length;
      if (run.body.done) {
        const result = run.body.result;
        if (result?.ok) {
          say(`  ${green('ok')}  ${provider} is set up${result.publicUrl ? ` — ${bold(result.publicUrl)}` : ''}`);
          return result.publicUrl;
        }
        fail(`${provider} setup did not finish — ${result?.detail ?? 'no detail'}`);
        say(dim('     Retry from the app: Config → Serve → Network.'));
        return null;
      }
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  fail('hosting setup is still running after 10 minutes — check Config → Serve → Network in the app.');
  return null;
}

export async function setupCommand(opts: SetupOptions): Promise<number> {
  const interactive = !opts.yes && Boolean(process.stdin.isTTY);
  const ask = new Prompter(interactive);
  const install = detectInstallMode();
  const home = resolveHome();

  try {
    say('');
    say(`  ${bold(cyan('AgentVoice setup'))}  ${dim(`${install.mode} install · home ${home}`)}`);
    if (!interactive) say(dim('  Non-interactive: taking the defaults (flags answer individual questions).'));

    // The base: config.json + APP_TOKEN, exactly as a first `agentvoice run` would.
    const seeded = seedConfig(home);
    const token = seedEnv(home);
    if (seeded) say(`  ${green('created')} ${join(home, 'config.json')}`);
    if (token) say(`  ${green('created')} ${envPath(home)} ${dim('(a new APP_TOKEN — `agentvoice token` prints it)')}`);

    // ── 1. The one up-front question ──────────────────────────────────────
    const serviceSupported = process.platform !== 'linux' || ran(await capture('systemctl', ['--user', '--version']));
    // A global npm install or a .deb/.rpm has usually installed the service
    // already; then the question is whether to keep it (and set up hosting).
    // "Has a service" means one that runs — enabled or active. A packaged unit
    // file alone (every .deb/.rpm ships one) that nobody enabled does not count.
    const hasService = serviceSupported && (await serviceIsLive());
    const wantService =
      opts.service ??
      (serviceSupported
        ? await ask.confirm(
            hasService
              ? 'Keep AgentVoice running as a background service, and set up hosting for your phone?'
              : 'Install AgentVoice as a background service (starts at login, reachable from your phone)?',
            hasService,
          )
        : false);
    if (wantService && !serviceSupported) {
      fail('no service manager on this host — continuing with project config only.');
    }
    const doService = wantService && serviceSupported;
    const total = doService ? 3 : 1;

    // ── 2. Project config ─────────────────────────────────────────────────
    step(1, total, 'Projects and agent');
    const cfgRead = readConfig(home);
    if (!cfgRead.config) {
      fail(`cannot read ${cfgRead.path}${cfgRead.error ? ` — ${cfgRead.error}` : ''}`);
      return 1;
    }
    const cfg = cfgRead.config as Record<string, unknown> & {
      settings?: Record<string, unknown> & {
        agentClient?: string;
        runMode?: string;
        projectDiscovery?: { enabled?: boolean; hotPaths?: string[] };
        runModes?: { serve?: { backendPort?: number } };
      };
    };
    cfg.settings ??= {};

    const agents = (Object.keys(AGENT_BIN_SPECS) as AgentBinId[]).map((id) => ({ id, path: installedAgent(id) }));
    const current = cfg.settings.agentClient;
    const defaultAgent =
      opts.agent ??
      (current && agents.find((a) => a.id === current)?.path ? current : undefined) ??
      agents.find((a) => a.path)?.id ??
      current ??
      'codex';
    const agent = opts.agent
      ? opts.agent
      : await ask.choose(
          'Which agent CLI should do the work?',
          agents.map((a) => ({
            id: a.id,
            label: AGENT_LABELS[a.id],
            note: a.path ? `installed · ${a.path}` : 'not installed',
          })),
          defaultAgent,
        );
    if (!(agent in AGENT_BIN_SPECS)) {
      fail(`unknown agent "${agent}" — one of: ${Object.keys(AGENT_BIN_SPECS).join(', ')}`);
      return 1;
    }
    cfg.settings.agentClient = agent;
    if (!agents.find((a) => a.id === agent)?.path) {
      say(`  ${yellow('note')}  ${agent} is not installed yet — install it before your first voice turn.`);
    }

    const discovery = (cfg.settings.projectDiscovery ??= {});
    const currentHotPaths = discovery.hotPaths?.length ? discovery.hotPaths : ['~/Projects'];
    const projectsDir = opts.projectsDir ?? (await ask.text('Folder holding your git repos (each repo in it becomes a project)', currentHotPaths.join(', ')));
    discovery.enabled = true;
    discovery.hotPaths = projectsDir
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
    const missing = discovery.hotPaths.filter((p) => !existsSync(p.replace(/^~(?=$|\/)/, homedir())));
    if (missing.length) say(`  ${yellow('note')}  ${missing.join(', ')} does not exist yet — projects appear once it does.`);

    // A service needs the serve profile: it serves the built web client itself.
    if (doService && cfg.settings.runMode !== 'serve') {
      cfg.settings.runMode = 'serve';
      say(`  ${dim('runMode → serve, for the background service')}`);
    }
    writeFileSync(cfgRead.path, `${JSON.stringify(cfg, null, 2)}\n`);
    say(`  ${green('saved')}  agent ${agent} · projects from ${discovery.hotPaths.join(', ')}`);

    // The directory setup was started from, when it is a project of its own.
    const cwd = realpathSync(process.cwd());
    const isRepoRoot = existsSync(join(cwd, '.git'));
    // Discovery already picks up every repo directly inside a hot path.
    const expand = (p: string): string => p.replace(/^~(?=$|\/)/, homedir());
    const covered = discovery.hotPaths.some((p) => {
      try {
        return realpathSync(expand(p)) === realpathSync(join(cwd, '..'));
      } catch {
        return false;
      }
    });
    if (isRepoRoot && cwd !== realpathSync(home) && cwd !== homedir() && !covered && install.root !== cwd) {
      if (await ask.confirm(`Also register ${cwd} as a project?`, false)) {
        await addCommand({ dir: cwd });
      }
    }

    if (!doService) {
      if ((await findBridge(home, readConfig(home))).answering) {
        say(`  ${yellow('note')}  a bridge is already running — restart it to load this config (agentvoice restart).`);
      }
      return finish(home, null, false);
    }

    // ── 3. Service ────────────────────────────────────────────────────────
    step(2, total, 'Background service');
    const existing = await detectUnit();
    if (existing.scope !== 'none' && (await serviceIsLive())) {
      // Re-running setup: keep the service you have (it may be hand-tuned) and
      // restart it so it boots with the config just written.
      say(`  ${dim(`${describeUnit(existing)} is already installed — restarting it with the new config`)}`);
      const restarted = await serviceCommand('restart');
      if (restarted !== 0) return restarted;
    } else {
      const code = await serviceInstallCommand({ now: true, force: false });
      if (code !== 0) {
        fail('the service did not install — fix the above, then re-run `agentvoice setup` (it is safe to repeat).');
        return code;
      }
    }
    if (process.platform === 'linux') {
      const user = process.env['USER'] ?? '';
      const linger = await capture('loginctl', ['show-user', user, '--property=Linger']);
      if (ran(linger) && !linger.stdout.includes('Linger=yes')) {
        if (await ask.confirm('Keep it running after you log out (loginctl enable-linger)?', true)) {
          await passthrough('loginctl', ['enable-linger', user]);
        }
      }
    }

    // ── 4. Hosting ────────────────────────────────────────────────────────
    step(3, total, 'Hosting — reaching it from your phone');
    const endpoint = await waitForBridge(home, 30);
    if (!endpoint) {
      fail('the service started but the bridge is not answering yet — see `agentvoice logs -n 50`, then set up hosting in the app.');
      return finish(home, null, true);
    }
    const providers = await bridgeApi<{
      active: string;
      providers: Array<{ id: string; detected: { installed: boolean; active: boolean } }>;
    }>(home, endpoint, '/api/admin/hosting-providers');
    const detected = new Map(providers.ok ? providers.body.providers.map((p) => [p.id, p.detected]) : []);
    const suggested =
      opts.hosting ?? (detected.get('tailscale')?.installed ? 'tailscale' : interactive ? 'tailscale' : 'none');
    const hosting = opts.hosting
      ? opts.hosting
      : await ask.choose(
          'How should your phone reach it?',
          HOSTING_CHOICES.map((c) => {
            const d = detected.get(c.id);
            const state = d ? (d.active ? 'active' : d.installed ? 'installed' : 'not installed') : '';
            return { ...c, note: [c.note, state].filter(Boolean).join(' · ') };
          }),
          suggested,
        );
    const publicUrl = hosting === 'none' ? null : await runHostingSetup(home, endpoint, hosting);
    return finish(home, publicUrl ?? endpoint.url, true);
  } catch (err) {
    // Ctrl-C / Ctrl-D at a prompt: stop cleanly. Everything saved so far stays
    // saved, and re-running setup picks up from it.
    if (err instanceof Error && err.name === 'AbortError') {
      say('');
      say(dim('  Setup cancelled — anything already saved stays; run `agentvoice setup` again any time.'));
      return 130;
    }
    throw err;
  } finally {
    ask.close();
  }
}

function finish(home: string, url: string | null, service: boolean): number {
  const cfg = readConfig(home).config;
  const port = cfg?.settings?.runModes?.serve?.backendPort;
  say('');
  say(`  ${green(bold('Setup complete'))}`);
  if (url) say(`  ${dim('open  ')} ${bold(url)}`);
  else if (port) say(`  ${dim('start ')} ${bold('agentvoice run')} ${dim(`→ http://127.0.0.1:${port}`)}`);
  say(`  ${dim('token ')} agentvoice token ${dim('— paste it when the app asks to pair')}`);
  say(`  ${dim('check ')} agentvoice doctor${service ? ' · agentvoice status' : ''}`);
  if (!service) say(`  ${dim('later ')} agentvoice setup ${dim('again to add the background service and hosting')}`);
  say('');
  return 0;
}
