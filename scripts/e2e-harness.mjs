/**
 * Shared scaffolding for the end-to-end scripts (live-pipe-test.mjs,
 * live-pwa-stream-test.mjs): a throwaway bridge home run by the real
 * `agentvoice` CLI, a stand-in Whisper server, and the stub agent as
 * "Claude Code".
 *
 * AGENTVOICE_HOME is the scratch home and HOME a scratch directory, so neither
 * ~/.agentvoice nor the MCP registration the bridge writes for the agent
 * (~/.claude.json) is touched.
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

export const ROOT = resolve(import.meta.dirname, '..');
const STUB = join(ROOT, 'scripts', 'stub-agent-cli.mjs');

export function makeReporter() {
  const t0 = Date.now();
  let failures = 0;
  const say = (...a) => console.log(`[${String(Date.now() - t0).padStart(6)}ms]`, ...a);
  return {
    say,
    check(ok, label, detail = '') {
      if (ok) say(`  ✔ ${label}`);
      else {
        failures += 1;
        say(`  ✘ ${label}${detail ? ` — ${detail}` : ''}`);
      }
    },
    fail(err) {
      failures += 1;
      say('ERROR', err instanceof Error ? err.stack : String(err));
    },
    get failures() {
      return failures;
    },
  };
}

async function freePort() {
  const srv = createServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  await new Promise((r) => srv.close(r));
  return port;
}

/**
 * @param {object} opts
 * @param {string[]} opts.bin       command for the CLI, e.g. [node, dist/cli.js]
 * @param {string[]} opts.canned    transcripts the fake Whisper returns, in order
 * @param {(config: any) => void} [opts.configure]  last-minute config.json edits
 */
export async function createInstance({ bin, canned, configure }) {
  const tmp = mkdtempSync(join(tmpdir(), 'agentvoice-e2e-'));
  const instance = join(tmp, 'instance');
  const project = join(tmp, 'project');
  const home = join(tmp, 'home');
  for (const d of [instance, project, home]) mkdirSync(d, { recursive: true });
  writeFileSync(join(project, 'README.md'), '# e2e project\n');
  chmodSync(STUB, 0o755);

  // ── Stand-in Whisper: OpenAI-compatible, answers from `canned` ──────────
  const sttRequests = [];
  const stt = createServer((req, res) => {
    if (req.method === 'GET' && (req.url === '/health' || req.url === '/v1/models')) {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"data":[]}');
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/audio/transcriptions') {
      let bytes = 0;
      req.on('data', (c) => (bytes += c.length));
      req.on('end', () => {
        const text = canned[sttRequests.length] ?? `extra ${sttRequests.length + 1}`;
        sttRequests.push({ bytes, text, at: Date.now() });
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ text }));
      });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((r) => stt.listen(0, '127.0.0.1', r));
  const sttPort = stt.address().port;
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;

  const env = {
    ...process.env,
    AGENTVOICE_HOME: instance,
    HOME: home,
    NODE_ENV: 'production',
    STUB_VOICE_SCRIPT: 'echo',
    STUB_ECHO_TURNS: '6',
  };
  for (const key of ['APP_TOKEN', 'CONFIG_PATH', 'DB_PATH', 'PORT', 'AGENTVOICE_LOG_DIR', 'LOG_LEVEL']) delete env[key];

  function run(cmdArgs, { input, timeoutMs = 60_000 } = {}) {
    return new Promise((resolveRun) => {
      const child = spawn(bin[0], [...bin.slice(1), ...cmdArgs], { cwd: instance, env });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stderr += d));
      if (input !== undefined) child.stdin.end(input);
      const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
      child.on('close', (code) => {
        clearTimeout(timer);
        resolveRun({ code, stdout, stderr });
      });
    });
  }

  // ── A bridge home pointed at the stand-ins ──────────────────────────────
  // What `agentvoice run` would seed on first start, but with the settings
  // the test needs already in place.
  const token = randomBytes(32).toString('base64url');
  const config = JSON.parse(readFileSync(join(ROOT, 'config.example.json'), 'utf-8'));
  config.settings.runMode = 'serve';
  config.settings.runModes = { test: { backendPort: 5089, webPort: 4200 }, serve: { backendPort: port } };
  config.settings.agentClient = 'claude-code';
  config.settings.workflow.default = 'agent_native';
  const audio = config.settings.workflow.llmIntelligence.audio;
  audio.stt = { provider: 'local_whisper', fallbacks: [], language: 'en', models: {}, scopes: {} };
  audio.speechServer = { ...audio.speechServer, manage: 'external', baseUrl: `http://127.0.0.1:${sttPort}`, apiPath: '/v1' };
  config.settings.voice.stream = { segmentSilenceMs: 500, maxSegmentMs: 15_000, minSpeechMs: 300, speechThreshold: 0.012, preRollMs: 200 };
  config.settings.logging = { keepPlain: 1 };
  delete config.settings.userName;
  config.projects = [{ name: 'e2e', path: project, aliases: [], enabled: true }];
  configure?.(config);
  writeFileSync(join(instance, 'config.json'), JSON.stringify(config, null, 2));
  writeFileSync(join(instance, '.env'), `APP_TOKEN=${token}\nCLAUDE_CODE_PATH=${STUB}\n`, { mode: 0o600 });

  // The bridge fetches the 41 MB wake-word model on first boot of a home.
  // Nothing here uses wake words, so give it a stand-in that passes its
  // plausibility check (gzip, ≥ 10 MB) instead of a download per test run.
  mkdirSync(join(instance, 'vosk'), { recursive: true });
  writeFileSync(join(instance, 'vosk', 'model.tar.gz'), gzipSync(randomBytes(10.5 * 1024 * 1024), { level: 0 }));

  let bridge = null;
  let bridgeOut = '';

  async function api(path, body) {
    const res = await fetch(`${base}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, text: await res.text() };
  }

  async function startBridge() {
    bridgeOut = '';
    bridge = spawn(bin[0], [...bin.slice(1), 'run'], { cwd: instance, env });
    bridge.stdout.on('data', (d) => (bridgeOut += d));
    bridge.stderr.on('data', (d) => (bridgeOut += d));
    for (let i = 0; i < 80; i++) {
      await new Promise((r) => setTimeout(r, 250));
      try {
        if ((await fetch(`${base}/healthz`)).ok) return;
      } catch {
        // not up yet
      }
      if (bridge.exitCode !== null) break;
    }
    throw new Error(`bridge did not come up on ${base}\n${bridgeOut.slice(-3000)}`);
  }

  async function stopBridge() {
    if (!bridge || bridge.exitCode !== null) return;
    const exited = new Promise((r) => bridge.on('close', r));
    bridge.kill('SIGTERM');
    await Promise.race([exited, new Promise((r) => setTimeout(r, 10_000))]);
  }

  const logDir = (folder) => join(instance, 'logs', 'serve', folder);
  const readFolder = (folder) => (existsSync(logDir(folder)) ? readdirSync(logDir(folder)).sort() : []);
  const readNewest = (folder) => {
    const plain = readFolder(folder).filter((n) => n.endsWith('.log'));
    const last = plain[plain.length - 1];
    return last ? readFileSync(join(logDir(folder), last), 'utf-8') : '';
  };

  return {
    tmp,
    instance,
    project,
    home,
    base,
    port,
    token,
    sttRequests,
    run,
    api,
    startBridge,
    stopBridge,
    bridgeOutput: () => bridgeOut,
    logDir,
    readFolder,
    readNewest,
    async cleanup(keep) {
      await stopBridge();
      stt.close();
      if (!keep) rmSync(tmp, { recursive: true, force: true });
    },
  };
}

/** 16-bit PCM WAV from a plan of [kind, ms] steps. "speech" is a voiced, syllabic signal. */
export function speechWav(plan, { rate = 44_100, channels = 2 } = {}) {
  const samples = [];
  for (const [kind, ms] of plan) {
    const n = Math.round((rate * ms) / 1000);
    for (let i = 0; i < n; i++) {
      let v = 0;
      if (kind === 'tone') {
        v = Math.sin((2 * Math.PI * 220 * i) / rate) * 0.3;
      } else if (kind === 'speech') {
        // Harmonics of a 140 Hz voice, amplitude-modulated at a syllable rate —
        // enough like speech that browser noise suppression lets it through.
        const t = i / rate;
        const env = 0.55 + 0.45 * Math.sin(2 * Math.PI * 4 * t);
        for (let h = 1; h <= 8; h++) v += Math.sin(2 * Math.PI * 140 * h * t) / h;
        v *= 0.18 * env;
      }
      const s = Math.round(Math.max(-1, Math.min(1, v)) * 32767);
      for (let c = 0; c < channels; c++) samples.push(s);
    }
  }
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((v, i) => data.writeInt16LE(v, i * 2));
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii');
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * channels * 2, 28);
  h.writeUInt16LE(channels * 2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36, 'ascii');
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}
