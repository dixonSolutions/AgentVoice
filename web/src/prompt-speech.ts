/**
 * Reading question, plan and permission cards aloud (docs/40 §1, #63).
 *
 * `readAloud` only ever covered *tool activity*. A `user_input_request`,
 * `plan_approval_request` or `secret_input_request` went straight from the
 * bridge to the approval panel and nothing spoke it — while the
 * `request_user_input` tool description told the agent its question would be
 * "displayed and read aloud" and, in the same breath, *not* to call `speak()`
 * first because "the PWA card is the notification". A hands-free user with no
 * screen was therefore asked a question in complete silence and then blamed
 * for not answering. That is a bug, not a missing feature.
 *
 * Speaking happens here, on the phone, from the card itself. That is
 * deliberate: it makes the behaviour identical for every workflow and every
 * CLI, and it lets the bridge's hardcoded permission and askpass narration
 * lines go away, since the card now speaks for itself.
 *
 * It uses the normal TTS queue, so barge-in and `tts_interrupt` work, and a
 * spoken answer resolves the card through the paths that already exist.
 */

// Relative rather than the `@agentvoice/client` alias: this module is also
// exercised by the node:test suite, which has no Angular path mapping.
import type { ApprovalRequest } from '../../packages/client/src/protocol.js';

export type ReadPromptsMode = 'off' | 'announce' | 'question' | 'full';

/** How many plan steps `full` will read before summarising the rest. */
const MAX_SPOKEN_STEPS = 8;

/**
 * The lines to speak for a card, in order. Empty when nothing should be said.
 *
 * Returned as separate sentences rather than one blob because the TTS queue is
 * per sentence — that is what keeps first-audio latency low and lets the user
 * barge in between options instead of after the whole thing.
 */
export function promptSpeechLines(
  request: ApprovalRequest,
  mode: ReadPromptsMode,
): string[] {
  if (mode === 'off') return [];

  switch (request.kind) {
    case 'secret_input':
      // Never read a secret prompt's text, at any level: it routinely names
      // the host and account, and the answer is a password.
      return [
        request.source === 'sudo'
          ? 'A password is needed on your phone.'
          : 'A password prompt is waiting on your phone.',
      ];

    case 'user_input': {
      if (mode === 'announce') return ["There's a question on your phone."];
      const lines = [request.question.trim()];
      const options = request.options?.filter((o) => o.trim()) ?? [];
      if (request.input_type === 'yesno') {
        lines.push('Yes or no?');
      } else if (options.length > 0) {
        lines.push(`Pick one: ${joinForSpeech(options)}.`);
      }
      return lines;
    }

    case 'plan_approval': {
      const stepCount = request.steps.length;
      if (mode === 'announce') return ["There's a plan waiting on your phone."];
      const lines = [
        `${request.title.trim()} — ${stepCount} step${stepCount === 1 ? '' : 's'}.`,
      ];
      if (mode === 'full') {
        for (const step of request.steps.slice(0, MAX_SPOKEN_STEPS)) {
          const text = step.trim();
          if (text) lines.push(text);
        }
        if (stepCount > MAX_SPOKEN_STEPS) {
          lines.push(`And ${stepCount - MAX_SPOKEN_STEPS} more on screen.`);
        }
        if (request.estimated_impact?.trim()) {
          lines.push(request.estimated_impact.trim());
        }
      }
      lines.push('Approve, reject, or ask for changes?');
      return lines;
    }

    case 'permission': {
      if (mode === 'announce') return [`${request.provider} is asking for permission.`];
      return [
        `${request.provider} wants to run ${request.summary.trim()}.`,
        'Say yes or no, or answer on your phone.',
      ];
    }
  }
}

/** "a, b, or c" — the shape a person actually says. */
function joinForSpeech(items: string[]): string {
  if (items.length === 1) return items[0]!;
  if (items.length === 2) return `${items[0]} or ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, or ${items[items.length - 1]}`;
}

/**
 * Remember which cards have been read, so re-sending an open card on reconnect
 * (docs/36 §3.5) does not read it a second time in the same breath — but a
 * genuinely new card with the same text still gets read, because the key is
 * the request id.
 */
const spoken = new Set<string>();

export function markPromptSpoken(requestId: string): void {
  spoken.add(requestId);
  // Bounded: a long session must not accumulate ids forever.
  if (spoken.size > 200) {
    const first = spoken.values().next().value;
    if (first !== undefined) spoken.delete(first);
  }
}

export function hasSpokenPrompt(requestId: string): boolean {
  return spoken.has(requestId);
}

export function forgetSpokenPrompts(): void {
  spoken.clear();
}
