/**
 * agent_recall_answer — return the last agent_ask result without re-querying Cursor.
 */

import { getLastAsk, truncateForVoice } from '../../state/lastAsk.js';

export interface RecallArgs {
  format?: 'brief' | 'full';
}

export interface RecallResult {
  question: string;
  answer: string;
  project: string;
  completed_at: string;
  has_more?: boolean;
  message?: string;
}

export function handleCursorRecallAnswer(
  args: RecallArgs,
  sessionKey: string,
): RecallResult {
  const last = getLastAsk(sessionKey);
  if (!last) {
    throw new Error(
      'No previous Cursor answer to recall. Ask a question with agent_ask first.',
    );
  }

  const format = args.format ?? 'brief';
  if (format === 'full') {
    return {
      question: last.question,
      answer: last.answer,
      project: last.project,
      completed_at: last.completedAt,
    };
  }

  const brief = truncateForVoice(last.answer);
  return {
    question: last.question,
    answer: brief,
    project: last.project,
    completed_at: last.completedAt,
    has_more: brief.length < last.answer.length,
    message:
      'Recalled the last Cursor answer. Read the answer field aloud now — summarize in your own words. Do not stay silent.',
  };
}
