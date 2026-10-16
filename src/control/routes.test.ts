import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import Fastify from 'fastify';
import { memoryBindingStore } from '../channels/bindings.js';
import { registerControlRoutes } from './routes.js';
import { pickSession } from './sessions.js';
import type { BridgeOps, SessionRow } from './types.js';

const ROWS: SessionRow[] = [
  { handle: 'run-1', name: 'auth worker', kind: 'voice', project: 'site', providerName: 'Claude Code', sessionId: 'aaaa1111', status: 'thinking', lastActivityAt: new Date().toISOString(), summary: 'fix the login redirect' },
  { handle: 'claude:bbbb', name: 'readme pass', kind: 'recent', project: 'docs', providerName: 'Claude Code', sessionId: 'bbbb2222', status: 'idle', lastActivityAt: null, summary: null },
  { handle: 'job-3', name: 'new worker', kind: 'worker', project: 'site', providerName: 'Claude Code', sessionId: null, status: 'waiting', lastActivityAt: null, summary: null },
];

function setup() {
  const calls: string[] = [];
  let active: string | null = 'site';
  const config: Record<string, string> = { agent: 'claude-code', wake: 'on' };
  const ops: BridgeOps = {
    status: () => ({ workflow: 'agent_native', agentName: 'Claude Code', activeProject: active, agentRunning: false, agentSessionId: null, listener: 'away', stt: 'Groq', tts: 'OpenAI' }),
    projects: () => ['site', 'docs'].map((name) => ({ name, active: name === active })),
    setProject: (name) => {
      if (!['site', 'docs'].includes(name)) throw new Error(`No project "${name}"`);
      calls.push(`project ${name}`);
      active = name;
      return name;
    },
    sessions: (project) => ROWS.filter((r) => !project || r.project === project),
    selectSession: (project, id) => {
      calls.push(`select ${project} ${id}`);
      return `continues ${id}`;
    },
    newSession: async (project) => {
      calls.push(`new ${project ?? ''}`);
      return 'fresh';
    },
    stopAgent: () => true,
    configKeys: () => [
      { key: 'agent', help: 'agent CLI', choices: ['cursor', 'claude-code'] },
      { key: 'wake', help: 'wake words', choices: ['on', 'off'] },
    ],
    getConfig: (k) => config[k] ?? '',
    setConfig: async (k, v) => {
      config[k] = v;
      return `${k} → ${v}`;
    },
  };
  const app = Fastify();
  const bindings = memoryBindingStore();
  const submitted: string[] = [];
  registerControlRoutes(app, {
    ops,
    bindings,
    submit: async (text, source) => {
      submitted.push(`${source}|${text}`);
      return { ok: true, delivery: 'spawn' };
    },
  });
  const post = async (url: string, body: unknown) => {
    const r = await app.inject({ method: 'POST', url, payload: body as object });
    return { status: r.statusCode, body: r.json() as Record<string, unknown> };
  };
  const get = async (url: string) => {
    const r = await app.inject({ method: 'GET', url });
    return { status: r.statusCode, body: r.json() as Record<string, unknown> };
  };
  return { app, calls, submitted, post, get, bindings };
}

describe('/api/control', () => {
  it('lists sessions and continues one by number, name or id prefix', async () => {
    const h = setup();
    const list = await h.get('/api/control/sessions');
    assert.equal((list.body['rows'] as SessionRow[]).length, 3);
    assert.equal((await h.post('/api/control/use', { query: '2' })).body['message'], 'continues bbbb2222');
    assert.deepEqual(h.calls, ['project docs', 'select docs bbbb2222']);
    const none = await h.post('/api/control/use', { query: 'new worker' });
    assert.equal(none.status, 400);
    assert.match(String(none.body['error']), /no conversation id yet/);
  });

  it('pins a default per conversation and per person, and say applies it before the turn', async () => {
    const h = setup();
    const pin = await h.post('/api/control/default', { channel: 'discord', conversation: 'chan-1', target: '1' });
    assert.match(String(pin.body['message']), /auth worker.*is now the session this conversation continues/);
    const mine = await h.post('/api/control/default', { channel: 'discord', user: 'u1', target: 'docs' });
    assert.match(String(mine.body['message']), /Your voice calls now continue the latest session on \*\*docs\*\*/);
    const s = await h.get('/api/control/sessions?channel=discord&conversation=chan-1&user=u1');
    assert.equal((s.body['binding'] as { sessionId: string }).sessionId, 'aaaa1111');
    assert.equal((s.body['voiceBinding'] as { project: string }).project, 'docs');
    const said = await h.post('/api/control/say', { channel: 'discord', conversation: 'chan-1', text: 'open the readme' });
    assert.equal(said.body['pinned'], 'auth worker');
    assert.deepEqual(h.submitted, ['discord|open the readme']);
    assert.ok(h.calls.includes('select site aaaa1111'), 'the pinned session is resumed before the turn');
    assert.match(String((await h.post('/api/control/default', { channel: 'discord', conversation: 'chan-1', target: 'none' })).body['message']), /cleared/);
  });

  it('reads and changes settings through the allowlisted keys only', async () => {
    const h = setup();
    const cfg = await h.get('/api/control/config');
    assert.deepEqual((cfg.body['keys'] as Array<{ key: string; value: string }>).map((k) => `${k.key}=${k.value}`), ['agent=claude-code', 'wake=on']);
    assert.equal((await h.post('/api/control/config', { key: 'wake', value: 'off' })).body['message'], 'wake → off');
    const bad = await h.post('/api/control/config', { key: 'permissions', value: 'yolo' });
    assert.equal(bad.status, 400);
    assert.match(String(bad.body['error']), /Unknown setting/);
  });

  it('new starts fresh and unpins the conversation’s session for that project', async () => {
    const h = setup();
    await h.post('/api/control/default', { channel: 'discord', conversation: 'chan-1', target: '1' });
    assert.equal((await h.post('/api/control/new', { channel: 'discord', conversation: 'chan-1' })).body['message'], 'fresh');
    assert.deepEqual(h.calls.at(-1), 'new site');
    assert.equal(h.bindings.get('discord', 'chan-1')?.sessionId, null);
  });

  it('picks by list number, spoken name or id prefix, and reports ambiguity', () => {
    assert.equal(pickSession(ROWS, '1').row?.sessionId, 'aaaa1111');
    assert.equal(pickSession(ROWS, 'readme pass').row?.sessionId, 'bbbb2222');
    assert.equal(pickSession(ROWS, 'bbbb').row?.sessionId, 'bbbb2222');
    assert.equal(pickSession(ROWS, 'worker').row, null);
    assert.equal(pickSession(ROWS, 'worker').matches.length, 2);
  });
});
