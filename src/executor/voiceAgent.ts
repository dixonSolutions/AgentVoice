/**
 * Conversational voice agent — auto-spawned cursor-agent loop for cursor_native.
 *
 * When a voice turn is enqueued and no agent is running, the bridge spawns
 * cursor-agent -p with the voice system prompt and --approve-mcps so the
 * agent can call cursor-voice MCP tools (next_voice_turn, speak, done).
 *
 * See docs/16-mcp-server-cursor-as-brain.md § Phase 3.
 */

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import stripAnsi from 'strip-ansi';
import { getConfig } from '../config.js';
import {
  attachCursorAgentSpawnGuard,
  buildCursorAgentEnv,
  resolveAgentBin,
} from './cursorAgent.js';
import { childLogger } from '../log.js';
import { cursorVoiceRuleBody } from '../mcp/loadCursorVoicePrompt.js';
import {
  broadcastVoiceAgentStatus,
  broadcastVoiceTurnIdle,
  hadSpeakThisTurn,
  handleSpeak,
} from '../mcp/server/voiceToolHandlers.js';
import {
  createVoiceAgentRun,
  updateVoiceAgentRun,
} from '../state/jobs.js';
import {
  cloneSessionState,
  setProjectResumeId,
  getProjectByName,
  type Project,
  type SessionState,
} from '../state/registry.js';
import type { StreamJsonEvent } from './watcher.js';

const log = childLogger('voice-agent');

const VOICE_BOOT_SUFFIX =
  '\n\n---\nThe cursor-voice MCP server is connected. ' +
  'Speak one sentence to greet or acknowledge the user first, then call next_voice_turn() to receive their request. ' +
  'Never start a session in silent tool mode.';

const VOICE_RESUME_SUFFIX =
  '\n\n---\n@cursor-voice\n\nThe cursor-voice MCP server is connected. ' +
  'Speak one sentence to acknowledge the user first, then call next_voice_turn() immediately. ' +
  'If a worker is running, narrate its live progress via get_agent_status() — do not go silent.';

export interface VoiceAgentEvent {
  type: 'spawned' | 'session_id' | 'exit';
  value?: string;
  exitCode?: number;
}

export interface VoiceAgentHandle {
  runId: string;
  pid: number;
  kill(): void;
  onEvent(cb: (event: VoiceAgentEvent) => void): void;
}

export interface ActiveVoiceAgent {
  runId: string;
  project: string;
  pid: number;
  sessionId: string | null;
  mcpSessionId: string | null;
  handle: VoiceAgentHandle;
}

let activeVoiceAgent: ActiveVoiceAgent | null = null;

export function isVoiceAgentRunning(): boolean {
  return activeVoiceAgent !== null;
}

export function getActiveVoiceAgent(): Readonly<ActiveVoiceAgent> | null {
  return activeVoiceAgent;
}

function buildPendingTurnBlock(pendingTurn?: string): string {
  const text = pendingTurn?.trim();
  if (!text) return '';
  return (
    `\n\nUser just spoke (also queued for next_voice_turn()):\n"${text}"\n\n` +
    'You MUST answer via speak() — text-only replies are inaudible. Call speak() then done().'
  );
}

function buildVoiceBootPrompt(project: Project, pendingTurn?: string): string {
  const turnBlock = buildPendingTurnBlock(pendingTurn);
  const isResume = Boolean(project.resumeId);
  // Do NOT trim VOICE_RESUME_SUFFIX — it starts with "---" after trimming,
  // which cursor-agent CLI parses as an unknown option flag (exit code 1).
  // The leading "\n\n" keeps it from being treated as a CLI flag.
  return isResume
    ? `${VOICE_RESUME_SUFFIX}${turnBlock}`
    : `${cursorVoiceRuleBody()}${VOICE_BOOT_SUFFIX}${turnBlock}`;
}

/** First sentence(s) of assistant text for TTS when speak() was never called. */
function summarizeForSpeechFallback(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  const sentences = clean.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? [clean];
  const lead = sentences.slice(0, 2).join(' ').trim();
  const max = 320;
  if (lead.length <= max) return lead;
  const cut = lead.slice(0, max);
  const lastBreak = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  return (lastBreak > max * 0.4 ? cut.slice(0, lastBreak + 1) : cut).trimEnd() + '…';
}

function extractAssistantText(event: Record<string, unknown>): string | null {
  if (event['type'] === 'result') {
    if (typeof event['result'] === 'string' && event['result'].trim()) {
      return event['result'].trim();
    }
    const msg = event['message'];
    if (typeof msg === 'string' && msg.trim()) return msg.trim();
  }

  if (event['type'] === 'assistant') {
    const msg = event['message'];
    if (
      typeof msg === 'object' &&
      msg !== null &&
      'content' in msg &&
      Array.isArray((msg as { content: unknown[] }).content)
    ) {
      const textPart = (msg as { content: Array<{ text?: string }> }).content.find(
        (c) => typeof c.text === 'string' && c.text.trim(),
      );
      if (textPart?.text) return textPart.text.trim();
    }
  }

  return null;
}

function buildCursorVoiceArgs(
  project: Project,
  session: SessionState,
  pendingTurn?: string,
): string[] {
  const { settings } = getConfig();

  const args: string[] = [
    '-p',
    '--output-format',
    'stream-json',
    '--workspace',
    project.path,
    '--approve-mcps',
  ];

  if (session.activeModel && session.activeModel !== 'auto') {
    args.push('--model', session.activeModel);
  }

  if (project.resumeId) {
    args.push('--resume', project.resumeId);
  }

  for (const flag of settings.preRunFlags) {
    if (!args.includes(flag)) {
      args.push(flag);
    }
  }

  args.push(buildVoiceBootPrompt(project, pendingTurn));
  return args;
}

function buildCodexVoiceArgs(
  project: Project,
  _session: SessionState,
  pendingTurn?: string,
): string[] {
  const args: string[] = ['exec'];

  if (project.resumeId) {
    args.push('resume', project.resumeId);
  }

  args.push('--json');
  args.push('--sandbox', 'workspace-write');
  args.push('--cd', project.path);
  args.push(buildVoiceBootPrompt(project, pendingTurn));
  return args;
}

function buildClaudeCodeVoiceArgs(
  project: Project,
  _session: SessionState,
  pendingTurn?: string,
): string[] {
  const args: string[] = ['-p', '--output-format', 'stream-json'];

  if (project.resumeId) {
    args.push('--resume', project.resumeId);
  }

  args.push(buildVoiceBootPrompt(project, pendingTurn));
  return args;
}

function buildVoiceAgentArgs(
  project: Project,
  session: SessionState,
  pendingTurn?: string,
): string[] {
  const { settings } = getConfig();
  switch (settings.agentClient) {
    case 'codex':
      return buildCodexVoiceArgs(project, session, pendingTurn);
    case 'claude-code':
      return buildClaudeCodeVoiceArgs(project, session, pendingTurn);
    case 'cursor':
    default:
      return buildCursorVoiceArgs(project, session, pendingTurn);
  }
}

/**
 * Spawn the conversational cursor-agent loop. At most one voice agent runs at a time.
 */
export function spawnVoiceAgent(
  project: Project,
  session: SessionState,
  pendingTurn?: string,
): VoiceAgentHandle {
  if (activeVoiceAgent) {
    throw new Error(
      `Voice agent already running (pid ${activeVoiceAgent.pid}, run ${activeVoiceAgent.runId})`,
    );
  }

  const { settings } = getConfig();
  const client = settings.agentClient;
  const args = buildVoiceAgentArgs(project, session, pendingTurn);
  const runId = createVoiceAgentRun({ project: project.name });

  log.info(
    {
      runId,
      project: project.name,
      resume: project.resumeId ?? 'none',
      model: session.activeModel,
      client,
    },
    'spawning conversational voice agent',
  );
  log.debug({ client, args: args.slice(0, -1) }, 'voice agent args');

  const agentBin = resolveAgentBin(client);
  const child = spawn(agentBin, args, {
    cwd: project.path,
    shell: false,
    env: buildCursorAgentEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  attachCursorAgentSpawnGuard(child, { runId, project: project.name, client });

  const pid = child.pid;
  if (!pid) {
    throw new Error(`${client} voice agent failed to spawn (no pid) — check the binary is installed and on PATH`);
  }

  updateVoiceAgentRun(runId, { pid });

  const eventListeners: Array<(event: VoiceAgentEvent) => void> = [];
  let capturedSessionId: string | null = project.resumeId;
  let lastAssistantText = '';

  broadcastVoiceAgentStatus({
    runId,
    pid,
    sessionId: capturedSessionId,
    state: 'starting',
    project: project.name,
  });

  // Console mirror for dev terminal monitoring (see npm run dev [server] output).
  console.log(
    `\n[voice] ▶ conversational agent spawned — run ${runId}, pid ${pid}` +
      (project.resumeId ? `, resume ${project.resumeId.slice(0, 8)}…` : ', new session') +
      '\n        Watch this terminal for [voice] speak/done lines\n',
  );

  const rl = createInterface({ input: child.stdout!, crlfDelay: Infinity });

  rl.on('line', (raw: string) => {
    const clean = stripAnsi(raw).trim();
    if (!clean) return;

    let event: Record<string, unknown>;
    try {
      event = JSON.parse(clean) as Record<string, unknown>;
    } catch {
      return;
    }

    if (typeof event['session_id'] === 'string') {
      const sid = event['session_id'];
      if (sid !== capturedSessionId) {
        capturedSessionId = sid;
        setProjectResumeId(project.name, sid);
        updateVoiceAgentRun(runId, { sessionId: sid });
        if (activeVoiceAgent) {
          activeVoiceAgent.sessionId = sid;
        }
        log.info({ runId, pid, sessionId: sid }, 'voice agent session_id captured');
        broadcastVoiceAgentStatus({
          runId,
          pid,
          sessionId: sid,
          state: 'running',
          project: project.name,
        });
        for (const cb of eventListeners) {
          cb({ type: 'session_id', value: sid });
        }
      }
    }

    const assistantText = extractAssistantText(event);
    if (assistantText) {
      lastAssistantText = assistantText;
    }

    const typed = event as StreamJsonEvent;
    void typed;
  });

  const stderrChunks: Buffer[] = [];
  child.stderr!.on('data', (chunk: Buffer) => {
    stderrChunks.push(chunk);
  });

  let killTimer: ReturnType<typeof setTimeout> | null = null;

  function kill(): void {
    log.info({ pid, runId }, 'killing voice agent');
    child.kill('SIGTERM');
    killTimer = setTimeout(() => {
      log.warn({ pid, runId }, 'voice agent did not exit after SIGTERM — SIGKILL');
      child.kill('SIGKILL');
    }, 5000);
  }

  const handle: VoiceAgentHandle = {
    runId,
    pid,
    kill,
    onEvent: (cb) => eventListeners.push(cb),
  };

  activeVoiceAgent = {
    runId,
    project: project.name,
    pid,
    sessionId: capturedSessionId,
    mcpSessionId: null,
    handle,
  };

  for (const cb of eventListeners) {
    cb({ type: 'spawned' });
  }

  child.on('close', (code) => {
    if (killTimer) clearTimeout(killTimer);
    rl.close();

    const exitCode = code ?? -1;
    const stderr = stripAnsi(Buffer.concat(stderrChunks).toString('utf-8')).trim();

    updateVoiceAgentRun(runId, {
      status: exitCode === 0 ? 'done' : 'error',
      endedAt: new Date().toISOString(),
      sessionId: capturedSessionId,
    });

    if (exitCode !== 0) {
      log.warn({ pid, runId, exitCode, stderr: stderr.slice(0, 500) }, 'voice agent exited with error');
    } else {
      log.info({ pid, runId, sessionId: capturedSessionId }, 'voice agent completed');
    }

    broadcastVoiceAgentStatus({
      runId,
      pid,
      sessionId: capturedSessionId,
      state: exitCode === 0 ? 'done' : 'error',
      project: project.name,
    });

    // Safety net only when the agent never called speak() this user turn.
    // spokeThisTurn must survive done() — clearing it there made normal turns
    // look silent and TTS’d Cursor’s final process/summary text after exit.
    if (!hadSpeakThisTurn()) {
      const fallback = summarizeForSpeechFallback(lastAssistantText);
      if (fallback) {
        log.warn(
          { runId, pid, textLen: fallback.length },
          'voice agent exited without speak() — streaming TTS fallback',
        );
        handleSpeak({ text: fallback });
      } else {
        log.warn(
          { runId, pid },
          'voice agent exited without speak() and no assistant text — user heard nothing',
        );
        handleSpeak({
          text: 'I finished but did not speak aloud — please try again.',
        });
      }
    }

    console.log(`[voice] ✗ conversational agent exited — run ${runId}, code ${exitCode}`);

    if (activeVoiceAgent?.handle === handle) {
      activeVoiceAgent = null;
    }

    broadcastVoiceTurnIdle();

    for (const cb of eventListeners) {
      cb({ type: 'exit', exitCode });
    }
  });

  return handle;
}

/**
 * Bind MCP HTTP session to the running voice agent (first connection wins).
 * Copies bridge session_state from 'default' to the MCP session key.
 */
export function bindVoiceAgentMcpSession(mcpSessionId: string): void {
  if (!activeVoiceAgent || activeVoiceAgent.mcpSessionId) return;

  activeVoiceAgent.mcpSessionId = mcpSessionId;
  cloneSessionState('default', mcpSessionId);
  updateVoiceAgentRun(activeVoiceAgent.runId, { mcpSession: mcpSessionId });

  log.info(
    {
      runId: activeVoiceAgent.runId,
      pid: activeVoiceAgent.pid,
      mcpSessionId,
      project: activeVoiceAgent.project,
    },
    'voice agent MCP session bound',
  );

  broadcastVoiceAgentStatus({
    runId: activeVoiceAgent.runId,
    pid: activeVoiceAgent.pid,
    sessionId: activeVoiceAgent.sessionId,
    mcpSessionId,
    state: 'running',
    project: activeVoiceAgent.project,
  });
}

/** Kill the active voice agent, if any. */
export function killVoiceAgent(reason = 'voice session ended'): boolean {
  if (!activeVoiceAgent) return false;

  const { runId, pid, handle } = activeVoiceAgent;
  log.warn({ runId, pid, reason }, 'stopping voice agent');

  updateVoiceAgentRun(runId, {
    status: 'stopped',
    endedAt: new Date().toISOString(),
  });

  handle.kill();
  activeVoiceAgent = null;
  return true;
}

/** Refresh project resume_id from DB before spawn (user may have selected a session). */
export function refreshProjectForVoice(project: Project): Project {
  const row = getProjectByName(project.name);
  if (!row) return project;
  return { ...project, resumeId: row.resumeId };
}
