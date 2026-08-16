/**
 * Execute tools — agent_submit, agent_ask
 *
 * agent_submit: async job submission (returns job_id immediately).
 * agent_ask:    synchronous read-only Q&A (read-only mode, provider-enforced).
 *
 * Both resolve the project from the registry. The model controls the
 * prompt/question text only — workspace path comes from the registry.
 *
 * `agent_ask` can block for minutes, so it runs under AgentVoice's interrupt
 * hook: if the user speaks mid-research the work is NOT cancelled — the
 * utterance rides back on this tool's own result.
 */

import { submitJob, askQuestion } from '../../executor/jobManager.js';
import { getActiveProvider } from '../../providers/agents/registry.js';
import { withVoiceInterrupt } from '../server/pendingWaits.js';
import { childLogger } from '../../log.js';
import { resolveProjectOrThrow } from './project.js';
import {
  looksLikeReadOnlyQuestion,
  looksLikeMutationRequest,
  isMetaVoiceBridgeQuestion,
  normalizeAskQuestion,
  isReadOnlyResearchIntent,
} from './questionDetect.js';
import { isAgentBusy, getActiveAgentRun } from '../../executor/agentSingleton.js';
import { getLastAsk, setLastAsk, truncateForVoice } from '../../state/lastAsk.js';

const log = childLogger('tool:execute');

// ── agent_submit ─────────────────────────────────────────────────────────

export interface SubmitArgs {
  prompt: string;
  project?: string;
  mode?: 'agent' | 'plan';
  browser?: boolean;
}

export interface SubmitResult {
  job_id?: string;
  status?: 'running';
  project: string;
  model?: string;
  message: string;
  /** Present when a question was misrouted to submit — answered via agent_ask instead. */
  routed?: 'ask';
  answer?: string;
  has_more?: boolean;
}

/**
 * Submit work to the active agent CLI (async).
 * Returns immediately with a job_id. Track progress with agent_job_status.
 */
export async function handleCursorSubmit(
  args: SubmitArgs,
  sessionKey: string,
  activeProject: string | null,
): Promise<SubmitResult> {
  const project = resolveProjectOrThrow(args.project, activeProject);

  if (looksLikeReadOnlyQuestion(args.prompt) || isReadOnlyResearchIntent(args.prompt)) {
    log.info(
      { project: project.name, prompt: args.prompt.slice(0, 100) },
      'agent_submit redirected to agent_ask (read-only question)',
    );
    const ask = await handleCursorAsk(
      { question: normalizeAskQuestion(args.prompt), project: args.project },
      sessionKey,
      activeProject,
    );
    return {
      routed: 'ask',
      answer: ask.answer,
      has_more: ask.has_more,
      project: ask.project,
      message:
        'Read-only question answered. Summarize the answer field for the user in a few sentences.',
    };
  }

  const mode = args.mode ?? 'agent';
  const result = await submitJob(project, sessionKey, args.prompt, mode, undefined, args.browser);

  return {
    job_id: result.jobId,
    status: 'running',
    project: result.project,
    model: result.model,
    message: `Job started (${result.jobId}). The user can ask what's happening anytime — use agent_job_status without job_id.`,
  };
}

// ── agent_ask ─────────────────────────────────────────────────────────────

export interface AskArgs {
  question: string;
  project?: string;
}

export interface AskResult {
  answer: string;
  project: string;
  has_more: boolean;
  message?: string;
}

/**
 * Read-only repo Q&A. Always runs in ask mode (cannot write or mutate) — the
 * active provider enforces that with its own flags, and refuses outright if it
 * cannot. One-shot: does not resume or persist a session.
 * This is the voice model's ONLY route to repo facts.
 */
export async function handleCursorAsk(
  args: AskArgs,
  sessionKey: string,
  activeProject: string | null,
): Promise<AskResult> {
  const project = resolveProjectOrThrow(args.project, activeProject);
  const question = normalizeAskQuestion(args.question.trim());
  const qKey = question.toLowerCase();

  if (looksLikeMutationRequest(question)) {
    throw new Error(
      'This request changes the repo (commit, PR, merge, implement, etc.) — use agent_submit, not agent_ask.',
    );
  }

  if (isMetaVoiceBridgeQuestion(question)) {
    const last = getLastAsk(sessionKey);
    if (last) {
      const voiceAnswer = truncateForVoice(last.answer);
      return {
        answer: voiceAnswer,
        project: last.project,
        has_more: voiceAnswer.length < last.answer.length,
        message:
          'The user likely heard TTS echo — do not ask the coding agent about setting up agents. ' +
          'Summarize the previous answer about implementation steps instead.',
      };
    }
    throw new Error(
      'That question is about the voice bridge, not this codebase. Ask about the project implementation instead.',
    );
  }

  if (isAgentBusy()) {
    const active = getActiveAgentRun();
    if (active?.kind === 'ask') {
      throw new Error(
        `${getActiveProvider().displayName} is still researching your question. ` +
          'Use agent_job_status for live progress — do not call agent_ask again yet.',
      );
    }
  }

  const last = getLastAsk(sessionKey);
  if (last && last.question.trim().toLowerCase() === qKey) {
    const ageMs = Date.now() - new Date(last.completedAt).getTime();
    if (ageMs < 5 * 60_000) {
      log.info({ sessionKey, question: question.slice(0, 80) }, 'agent_ask cache hit');
      const voiceAnswer = truncateForVoice(last.answer);
      return {
        answer: voiceAnswer,
        project: last.project,
        has_more: voiceAnswer.length < last.answer.length,
        message:
          'This question was just answered — read the answer field aloud for the user in 2–4 sentences.',
      };
    }
  }

  // Research can run for minutes. Registering the call with the interrupt hook
  // means a mid-research utterance comes back attached to THIS result instead
  // of waiting for the next poll — and the research still completes.
  return withVoiceInterrupt('agent_ask', async () => {
    const fullAnswer = await askQuestion(project, sessionKey, question);

    setLastAsk(sessionKey, {
      question,
      answer: fullAnswer,
      project: project.name,
    });

    const voiceAnswer = truncateForVoice(fullAnswer);
    return {
      answer: voiceAnswer,
      project: project.name,
      has_more: voiceAnswer.length < fullAnswer.length,
      message:
        `${getActiveProvider().displayName} finished. You MUST speak now: summarize the answer field in ` +
        '3–5 short sentences for the user. Do not stay silent. If they later ask to summarize or repeat, ' +
        'use agent_recall_answer.',
    };
  });
}
