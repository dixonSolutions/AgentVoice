/**
 * Conversational voice agent — the auto-spawned agent loop for `agent_native`.
 *
 * When a voice turn is enqueued and no agent is running, the bridge spawns the
 * active coding CLI in headless mode with the AgentVoice system prompt, wired
 * to the agent-voice MCP server so it can call next_voice_turn / speak / done.
 * Every CLI-specific flag lives in providers/agents/<client>.ts.
 *
 * See docs/16-mcp-server-agent-as-brain.md § Phase 3.
 */

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import stripAnsi from 'strip-ansi';
import { attachCursorAgentSpawnGuard } from './agentProcess.js';
import { guardResumeId, handleStaleSessionExit } from './resumeGuard.js';
import { getActiveProvider } from '../providers/agents/registry.js';
import { notifyAuthRequired } from '../providers/agents/authNotify.js';
import { childLogger } from '../log.js';
import { agentVoiceRuleBody } from '../mcp/agentVoicePrompt.js';
import { MCP_SERVER_NAME } from '../providers/agents/mcpRegistration.js';
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
import type { AgentStreamEvent } from '../providers/agents/events.js';

const log = childLogger('voice-agent');

const VOICE_BOOT_SUFFIX =
  `\n\n---\nThe ${MCP_SERVER_NAME} MCP server (AgentVoice) is connected. ` +
  'Speak one sentence to greet or acknowledge the user first, then call next_voice_turn() to receive their request. ' +
  'Never start a session in silent tool mode.';

const VOICE_RESUME_SUFFIX =
  `\n\n---\nThe ${MCP_SERVER_NAME} MCP server (AgentVoice) is connected. ` +
  'Speak one sentence to acknowledge the user first, then call next_voice_turn() immediately. ' +
  'If a worker is running, narrate its live progress via get_agent_status() — do not go silent.';

/**
 * Trimmed reminder of the voice contract for resumed threads.
 *
 * Only Cursor persists our rules via a `.mdc` file, so a resumed Codex or
 * Claude Code thread would otherwise carry NO AgentVoice instructions at all —
 * the agent replies as text and the user hears silence. Cursor keeps the short
 * form (its rule file already holds the full prompt); everyone else gets the
 * full system prompt again.
 */
function resumeSystemBlock(): string {
  return getActiveProvider().id === 'cursor' ? '' : `\n\n${agentVoiceRuleBody()}`;
}

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
    `\n\nUser just spoke (delivered here directly; it is not queued):\n"${text}"\n\n` +
    'Address this request now and do not call next_voice_turn() before acting. ' +
    'You MUST answer via speak() — text-only replies are inaudible. Call speak() then done().'
  );
}

function buildVoiceBootPrompt(project: Project, pendingTurn?: string): string {
  const turnBlock = buildPendingTurnBlock(pendingTurn);
  const isResume = Boolean(project.resumeId);
  // Do NOT trim these suffixes — they start with "---" after trimming, which
  // cursor-agent parses as an unknown option flag (exit code 1). The leading
  // "\n\n" keeps the prompt from being treated as a CLI flag.
  return isResume
    ? `${resumeSystemBlock()}${VOICE_RESUME_SUFFIX}${turnBlock}`
    : `${agentVoiceRuleBody()}${VOICE_BOOT_SUFFIX}${turnBlock}`;
}

/**
 * First sentence(s) of assistant text for TTS when speak() was never called.
 * Skips internal planning / narration-of-intent (stream text that was never
 * meant to be spoken aloud).
 */
function summarizeForSpeechFallback(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  // Model thinking-out-loud often looks like this; speaking it is a hallucination.
  if (
    /^(i'?ll |i will |let me |i'?m going to |i need to |first[, ]|okay[, ]?i )/i.test(clean) &&
    /\b(then |and then |acknowledge|dig into|take a (?:quick )?look|wrap up|confirm that)\b/i.test(
      clean,
    )
  ) {
    return '';
  }
  const sentences = clean.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? [clean];
  const lead = sentences.slice(0, 2).join(' ').trim();
  const max = 320;
  if (lead.length <= max) return lead;
  const cut = lead.slice(0, max);
  const lastBreak = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  return (lastBreak > max * 0.4 ? cut.slice(0, lastBreak + 1) : cut).trimEnd() + '…';
}

/**
 * Build the conversational voice-agent argv for the active provider.
 * Every CLI-specific flag lives in the provider (providers/agents/*.ts) —
 * this just supplies the boot prompt that's common across all three CLIs.
 */
function buildVoiceAgentArgs(
  project: Project,
  session: SessionState,
  pendingTurn?: string,
): string[] {
  const provider = getActiveProvider();
  const bootPrompt = buildVoiceBootPrompt(project, pendingTurn);
  return provider.buildVoiceArgs(project, session, pendingTurn, bootPrompt);
}

/**
 * Spawn the conversational agent loop. At most one voice agent runs at a time.
 */
export function spawnVoiceAgent(
  incomingProject: Project,
  session: SessionState,
  pendingTurn?: string,
): VoiceAgentHandle {
  if (activeVoiceAgent) {
    throw new Error(
      `Voice agent already running (pid ${activeVoiceAgent.pid}, run ${activeVoiceAgent.runId})`,
    );
  }

  // A resume id the active CLI does not have is fatal *and* mute: it exits 1
  // before the agent can speak. Better a fresh thread than a silent turn.
  const project = guardResumeId(incomingProject);
  const provider = getActiveProvider();
  const client = provider.id;
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

  const agentBin = provider.resolveBin();
  const child = spawn(agentBin, args, {
    cwd: project.path,
    shell: false,
    env: provider.env(process.env),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  attachCursorAgentSpawnGuard(child, { runId, project: project.name, client });

  const pid = child.pid;
  if (!pid) {
    throw new Error(`${provider.displayName} voice agent failed to spawn (no pid) — check the binary is installed and on PATH`);
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

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(clean) as Record<string, unknown>;
    } catch {
      return;
    }

    let events: AgentStreamEvent[];
    try {
      events = provider.parseStreamEvent(parsed);
    } catch (err) {
      log.warn({ err, client }, 'provider failed to parse voice stream event');
      return;
    }

    for (const event of events) {
      if (event.kind === 'session') {
        const sid = event.sessionId;
        if (sid === capturedSessionId) continue;
        capturedSessionId = sid;
        setProjectResumeId(project.name, sid);
        updateVoiceAgentRun(runId, { sessionId: sid });
        if (activeVoiceAgent) activeVoiceAgent.sessionId = sid;
        log.info({ runId, pid, sessionId: sid }, 'voice agent session_id captured');
        broadcastVoiceAgentStatus({
          runId,
          pid,
          sessionId: sid,
          state: 'running',
          project: project.name,
        });
        for (const cb of eventListeners) cb({ type: 'session_id', value: sid });
      } else if (event.kind === 'assistant_text') {
        lastAssistantText = event.text;
      } else if (event.kind === 'result' && event.text) {
        lastAssistantText = event.text;
      }
    }
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

    const authRequired = exitCode !== 0 && provider.isAuthError(exitCode, stderr);
    // Last resort when the pre-spawn check could not tell (provider store
    // unreadable): forget the thread so the next turn is not a silent repeat.
    const staleSession = handleStaleSessionExit(project, exitCode, stderr);

    if (exitCode !== 0) {
      log.warn({ pid, runId, exitCode, authRequired, stderr: stderr.slice(0, 500) }, 'voice agent exited with error');
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

    if (authRequired) {
      void notifyAuthRequired(`voice agent run ${runId} on ${project.name}`);
    }

    // Safety net only when the agent never called speak() this user turn.
    // spokeThisTurn must survive done() — clearing it there made normal turns
    // look silent and TTS’d the agent’s final process/summary text after exit.
    if (!hadSpeakThisTurn()) {
      const fallback = authRequired
        ? `${provider.displayName} needs you to sign in — I sent a sign-in link to your phone.`
        : staleSession
          ? `That ${provider.displayName} conversation is no longer available, so I cleared it. Say that again and I will start a fresh thread.`
          : summarizeForSpeechFallback(lastAssistantText);
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
