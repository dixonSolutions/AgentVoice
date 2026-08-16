#!/usr/bin/env node
/**
 * Live end-to-end test of the AgentVoice interrupt hook.
 *
 * Unit tests prove the hook's mechanics in isolation. This drives the real
 * thing: a real bridge, a real coding CLI, a real MCP connection, a real task,
 * and a real user turn fired while the agent is mid-work.
 *
 * It impersonates the PWA on /ws/intelligence, because the hook only arms when
 * a voice session is actually connected (`hasActiveVoiceSession()`).
 *
 * Usage:
 *   node scripts/live-hook-test.mjs --project <name> [--url ws://127.0.0.1:5089]
 *                                   [--task "..."] [--interrupt "..."]
 *                                   [--delay 12000] [--timeout 180000]
 *
 * Reads APP_TOKEN from the environment or .env.
 *
 * Exit code 0 only if the interrupt was demonstrably delivered to the agent
 * while it was working — i.e. the agent acknowledged the second request
 * without the first one having already finished.
 */

import { readFileSync, existsSync } from 'node:fs';
import { WebSocket } from 'ws';

// ── Args ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
}

const PROJECT = arg('project', null);
const BASE = arg('url', 'ws://127.0.0.1:5089');
const TASK = arg(
  'task',
  'Search this repository for every file that mentions the word "narrator" and tell me what each one does.',
);
const INTERRUPT = arg('interrupt', 'Actually stop describing that — just tell me what year it is.');
const DELAY_MS = Number(arg('delay', 12000));
const TIMEOUT_MS = Number(arg('timeout', 180000));

function loadToken() {
  if (process.env.APP_TOKEN) return process.env.APP_TOKEN;
  if (existsSync('.env')) {
    const line = readFileSync('.env', 'utf-8')
      .split('\n')
      .find((l) => l.startsWith('APP_TOKEN='));
    if (line) return line.slice('APP_TOKEN='.length).trim().replace(/^["']|["']$/g, '');
  }
  throw new Error('APP_TOKEN not found in env or .env');
}

// ── Transcript ────────────────────────────────────────────────────────────

const t0 = Date.now();
const events = [];
const ms = () => String(Date.now() - t0).padStart(6, ' ');

function record(kind, detail) {
  events.push({ at: Date.now() - t0, kind, detail });
  const tag = kind.padEnd(20);
  console.log(`[${ms()}ms] ${tag} ${detail ?? ''}`);
}

// ── State the assertions depend on ────────────────────────────────────────

const state = {
  agentName: null,
  agentPid: null,
  spokeBeforeInterrupt: [],
  spokeAfterInterrupt: [],
  interruptSentAt: null,
  firstTurnCompleteAt: null,
  toolActivity: [],
  agentStates: [],
  /** Set when the bridge reports next_voice_turn actually handing over our interrupt. */
  interruptCollectedAt: null,
};

const token = loadToken();
const ws = new WebSocket(`${BASE}/ws/intelligence`);

const done = (code, reason) => {
  record('RESULT', reason);
  try {
    ws.close();
  } catch {
    /* already closing */
  }
  setTimeout(() => process.exit(code), 150);
};

const timer = setTimeout(() => {
  summarize();
  done(1, `timed out after ${TIMEOUT_MS}ms`);
}, TIMEOUT_MS);

ws.on('open', () => {
  record('ws.open', BASE);
  ws.send(JSON.stringify({ type: 'auth', token }));
});

ws.on('error', (err) => {
  record('ws.error', String(err));
  clearTimeout(timer);
  done(1, 'websocket error');
});

ws.on('close', (code, reason) => {
  record('ws.close', `${code} ${reason}`);
});

ws.on('message', (raw) => {
  let msg;
  try {
    msg = JSON.parse(raw.toString('utf-8'));
  } catch {
    return;
  }

  switch (msg.type) {
    case 'auth_ok': {
      record('auth_ok', `workflow=${msg.workflow} model=${msg.model}`);
      if (msg.workflow !== 'agent_native') {
        clearTimeout(timer);
        return done(1, `workflow is ${msg.workflow}; this test needs agent_native`);
      }
      // Kick off the real task.
      record('SEND user_turn #1', TASK);
      ws.send(JSON.stringify({ type: 'user_turn', text: TASK }));

      // Fire the interrupt while the agent should still be working.
      setTimeout(() => {
        if (state.firstTurnCompleteAt) {
          record('SKIP interrupt', 'first turn already completed — task was too short');
          return;
        }
        state.interruptSentAt = Date.now() - t0;
        record('SEND user_turn #2', `${INTERRUPT}   <-- INTERCEPT, agent is mid-work`);
        ws.send(JSON.stringify({ type: 'user_turn', text: INTERRUPT }));
      }, DELAY_MS);
      return;
    }

    case 'voice_agent_status': {
      state.agentName = msg.provider_name ?? state.agentName;
      state.agentPid = msg.pid ?? state.agentPid;
      state.agentStates.push(msg.state);
      record('agent_status', `${msg.provider_name ?? '?'} ${msg.state} pid=${msg.pid} session=${(msg.session_id ?? '').slice(0, 8)}`);
      return;
    }

    case 'speak': {
      const bucket = state.interruptSentAt === null ? state.spokeBeforeInterrupt : state.spokeAfterInterrupt;
      bucket.push(msg.text);
      record(state.interruptSentAt === null ? 'speak (pre)' : 'speak (POST)', `"${msg.text}"`);
      return;
    }

    case 'tool_activity': {
      state.toolActivity.push({ at: Date.now() - t0, ...msg });
      // The one unambiguous proof the agent COLLECTED the turn: the bridge
      // broadcasts next_voice_turn/done with the dequeued text as detail.
      // "the agent kept talking" is not proof — it may just be finishing its
      // previous answer, which is exactly the false pass this test had before.
      if (
        msg.tool === 'next_voice_turn' &&
        typeof msg.detail === 'string' &&
        msg.detail.slice(0, 40) === INTERRUPT.slice(0, 40)
      ) {
        state.interruptCollectedAt = Date.now() - t0;
        record('INTERRUPT COLLECTED', 'agent dequeued the turn via next_voice_turn');
        if (state.interruptSentAt !== null) scheduleJudgement();
      }
      record(`tool.${msg.phase}`, `${msg.tool} — ${msg.label}${msg.detail ? ` :: ${String(msg.detail).slice(0, 90)}` : ''}`);
      return;
    }

    case 'turn_complete': {
      if (state.firstTurnCompleteAt === null) state.firstTurnCompleteAt = Date.now() - t0;
      record('turn_complete', '');
      // The agent may collect and answer the interrupt in a FOLLOWING turn, so
      // do not judge on the first turn_complete. Settle once it has collected
      // the turn; otherwise give it a grace period before calling it a miss.
      if (state.interruptSentAt !== null) scheduleJudgement();
      return;
    }

    case 'thinking':
      record('thinking', String(msg.value));
      return;

    case 'error':
      record('bridge.error', msg.message);
      return;

    default:
      return;
  }
});

// ── Verdict ───────────────────────────────────────────────────────────────

let judgeTimer = null;
function scheduleJudgement() {
  if (judgeTimer) clearTimeout(judgeTimer);
  // Short settle once we have our proof; long grace while still hoping for it.
  const wait = state.interruptCollectedAt !== null ? 6000 : 25000;
  judgeTimer = setTimeout(() => {
    clearTimeout(timer);
    judge();
  }, wait);
}

function summarize() {
  console.log('\n──────── summary ────────');
  console.log('agent               :', state.agentName ?? '(none reported)');
  console.log('agent pid           :', state.agentPid ?? '-');
  console.log('agent states        :', state.agentStates.join(' → ') || '-');
  console.log('interrupt sent at   :', state.interruptSentAt === null ? 'never' : `${state.interruptSentAt}ms`);
  console.log('first turn complete :', state.firstTurnCompleteAt === null ? 'never' : `${state.firstTurnCompleteAt}ms`);
  console.log('speak before        :', state.spokeBeforeInterrupt.length);
  console.log('speak after         :', state.spokeAfterInterrupt.length);
  console.log('interrupt collected :', state.interruptCollectedAt === null ? 'NEVER' : `${state.interruptCollectedAt}ms`);
  for (const line of state.spokeAfterInterrupt) console.log('   POST:', line);
  console.log('tool calls          :', state.toolActivity.map((t) => `${t.tool}/${t.phase}`).join(', ') || '-');
}

function judge() {
  summarize();

  const failures = [];
  if (state.interruptSentAt === null) {
    failures.push('interrupt was never sent (task finished too fast — raise --delay or use a longer --task)');
  }
  if (state.agentStates.length === 0) {
    failures.push('no voice_agent_status ever arrived — the CLI never spawned');
  }
  if (state.agentName === null) {
    failures.push('bridge did not report provider_name on voice_agent_status');
  }
  if (state.spokeBeforeInterrupt.length === 0) {
    failures.push('agent never spoke before the interrupt — MCP speak() is not reaching the bridge');
  }
  if (state.spokeAfterInterrupt.length === 0) {
    failures.push('agent said nothing after the interrupt — the turn was not delivered to it');
  }
  if (state.interruptCollectedAt === null) {
    failures.push(
      'agent never COLLECTED the interrupt (no next_voice_turn carrying it). It kept talking about ' +
        'the original request, so the user was ignored — speaking after an interrupt is not the same ' +
        'as handling it',
    );
  }
  if (
    state.firstTurnCompleteAt !== null &&
    state.interruptSentAt !== null &&
    state.firstTurnCompleteAt < state.interruptSentAt
  ) {
    failures.push('the agent had already finished before the interrupt — this did not test mid-work delivery');
  }

  if (failures.length > 0) {
    console.log('\nFAIL:');
    for (const f of failures) console.log('  ✗', f);
    return done(1, 'interrupt hook did NOT behave correctly');
  }

  console.log('\nPASS:');
  console.log('  ✓ agent spawned and spoke via MCP');
  console.log('  ✓ interrupt was sent while the agent was still working');
  console.log('  ✓ agent collected the interrupt via next_voice_turn while mid-work');
  console.log('  ✓ agent responded after collecting it');
  return done(0, 'interrupt hook verified live');
}
