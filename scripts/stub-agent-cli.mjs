#!/usr/bin/env node
/**
 * A stand-in coding-agent CLI, for integration-testing the bridge end to end.
 *
 * Point `CURSOR_AGENT_PATH` / `CLAUDE_CODE_PATH` / `CODEX_PATH` at this file and
 * the bridge spawns it exactly as it would the real CLI. Everything downstream
 * is production code: the real spawn, the real argv the provider built, the
 * real MCP Streamable HTTP transport, the real tool handlers, the real
 * interrupt hook. Only the model's judgement is replaced by a fixed script.
 *
 * That makes it able to prove things a unit test cannot:
 *   - the argv each provider builds is actually parseable by a CLI
 *   - the MCP registration each provider writes is actually usable to connect
 *   - a user turn fired mid-tool really does reach the agent process
 *   - each provider's stream parser really does capture the session id it needs
 *     for `--resume`
 *
 * It cannot prove the real CLIs accept these flags or authenticate — that needs
 * a signed-in machine.
 *
 * Behaviour is chosen from argv, the same way a real CLI would read it:
 *   voice mode  — the prompt mentions next_voice_turn
 *   worker mode — anything else (this is what agent_ask spawns)
 */

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const argv = process.argv.slice(2);
const prompt = argv[argv.length - 1] ?? '';
const isVoice = /next_voice_turn/.test(prompt);

// ── Which CLI are we imitating? Inferred from the argv the provider built. ──

const dialect = argv[0] === 'exec' ? 'codex' : argv.includes('--workspace') ? 'cursor' : 'claude';

const log = (...a) => process.stderr.write(`[stub:${dialect}] ${a.join(' ')}\n`);
log('argv:', JSON.stringify(argv.slice(0, -1)));

// ── Emit NDJSON in that CLI's own dialect, so the bridge's provider parser
//    is genuinely exercised (session id capture especially). ────────────────

const sessionId = `stub-${dialect}-${Date.now().toString(36)}`;

function emit(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function emitInit() {
  if (dialect === 'codex') {
    emit({ id: '0', msg: { type: 'session_configured', session_id: sessionId, model: 'stub' } });
  } else {
    emit({ type: 'system', subtype: 'init', session_id: sessionId, model: 'stub' });
  }
}

function emitToolStart(name, path) {
  if (dialect === 'cursor') {
    emit({ type: 'tool_call', subtype: 'started', tool_call: { [`${name}ToolCall`]: { args: { path } } } });
  } else if (dialect === 'codex') {
    emit({ id: '1', msg: { type: 'patch_apply_begin', changes: { [path]: {} } } });
  } else {
    emit({
      type: 'assistant',
      session_id: sessionId,
      message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: path } }] },
    });
  }
}

function emitResult(text) {
  if (dialect === 'codex') {
    emit({ id: '9', msg: { type: 'task_complete', last_agent_message: text } });
  } else {
    emit({ type: 'result', subtype: 'success', session_id: sessionId, result: text, is_error: false });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Worker mode: what agent_ask spawns. Must take real wall-clock time so a
//    mid-work interrupt has something to interrupt. ─────────────────────────

async function runWorker() {
  log('worker mode');
  emitInit();
  for (const [i, file] of ['src/one.ts', 'src/two.ts', 'src/three.ts'].entries()) {
    await sleep(2500);
    emitToolStart('read', file);
    log(`worker step ${i + 1}`);
  }
  await sleep(1500);
  emitResult('The narrator module turns watcher events into spoken milestones.');
  log('worker done');
}

// ── Voice mode: connect to the bridge's MCP server the way a real agent does.

function resolveMcpEndpoint() {
  // Claude Code is handed an explicit --mcp-config file by its provider.
  const idx = argv.indexOf('--mcp-config');
  if (idx !== -1 && argv[idx + 1] && existsSync(argv[idx + 1])) {
    const cfg = JSON.parse(readFileSync(argv[idx + 1], 'utf-8'));
    const entry = cfg.mcpServers?.['agent-voice'];
    if (entry?.url) return { url: entry.url, token: entry.headers?.Authorization ?? '', from: argv[idx + 1] };
  }
  // Codex reads its own TOML, and takes the token from the env var the
  // provider named in `bearer_token_env_var`.
  const codexCfg = join(homedir(), '.codex', 'config.toml');
  if (dialect === 'codex' && existsSync(codexCfg)) {
    const toml = readFileSync(codexCfg, 'utf-8');
    const block = toml.split('[mcp_servers."agent-voice"]')[1] ?? '';
    const url = block.match(/url\s*=\s*"([^"]+)"/)?.[1];
    const envVar = block.match(/bearer_token_env_var\s*=\s*"([^"]+)"/)?.[1];
    const tok = envVar ? process.env[envVar] : undefined;
    if (url && tok) return { url, token: `Bearer ${tok}`, from: `${codexCfg} (token via $${envVar})` };
    if (url) throw new Error(`config.toml points at ${url} but $${envVar} is not set in the spawn env`);
  }

  // Cursor reads its own global config.
  const cursorCfg = join(homedir(), '.cursor', 'mcp.json');
  if (existsSync(cursorCfg)) {
    const cfg = JSON.parse(readFileSync(cursorCfg, 'utf-8'));
    const entry = cfg.mcpServers?.['agent-voice'];
    if (entry?.url) return { url: entry.url, token: entry.headers?.Authorization ?? '', from: cursorCfg };
  }
  throw new Error('no agent-voice MCP registration found — provider did not write one');
}

async function callTool(client, name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content?.find((c) => c.type === 'text')?.text ?? '{}';
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function runVoice() {
  log('voice mode');
  emitInit();

  const { url, token, from } = resolveMcpEndpoint();
  log(`MCP endpoint ${url} (registration read from ${from})`);

  const client = new Client({ name: 'stub-agent', version: '1.0.0' }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: token } },
  });
  await client.connect(transport);
  const tools = (await client.listTools()).tools.map((t) => t.name);
  log(`connected — ${tools.length} tools; agent_ask present: ${tools.includes('agent_ask')}`);

  // The bridge delivered the user's first request inside the boot prompt.
  const quoted = prompt.match(/User just spoke[^"]*"([^"]+)"/);
  log(`boot prompt carried user turn: ${quoted ? JSON.stringify(quoted[1]) : 'none'}`);

  await callTool(client, 'speak', { text: 'On it — let me look through the repository.' });

  // ── The thing under test ────────────────────────────────────────────────
  // agent_ask blocks for as long as the worker runs. The harness fires a new
  // user turn while we are inside this call. It must come back on THIS result
  // without the research being cancelled.
  log('calling agent_ask (long) — interrupt should land during this');
  const started = Date.now();
  const ask = await callTool(client, 'agent_ask', {
    question: 'What does the narrator module do?',
  });
  const elapsed = Date.now() - started;

  log(`agent_ask returned after ${elapsed}ms`);
  log(`  answer present : ${Boolean(ask.answer)}`);
  log(`  interrupted    : ${ask.interrupted === true}`);
  log(`  user_turn      : ${ask.user_turn ? JSON.stringify(ask.user_turn) : 'none'}`);

  emitToolStart('read', 'src/executor/narrator.ts');

  if (ask.interrupted === true && ask.user_turn) {
    // Exactly what the system prompt tells the agent to do.
    await callTool(client, 'speak', {
      text: `INTERRUPT-OK: research finished and you also asked: ${ask.user_turn}`,
    });
  } else {
    await callTool(client, 'speak', { text: 'INTERRUPT-MISSED: no user turn arrived on the tool result.' });
  }

  await callTool(client, 'done', {});
  emitResult('stub voice turn complete');
  await client.close();
}

try {
  if (isVoice) await runVoice();
  else await runWorker();
  process.exit(0);
} catch (err) {
  log('ERROR', err?.stack ?? String(err));
  emit({ type: 'error', message: String(err?.message ?? err) });
  process.exit(1);
}
