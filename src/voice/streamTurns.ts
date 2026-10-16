/**
 * Hand one streamed transcript to the voice agent — spawn it or queue for it —
 * through the same path as a phone turn, and tell every voice client what
 * happened the way the phone socket does.
 *
 * Shared by everything that streams audio at the agent rather than taking
 * turns: the /ws/audio-stream pipe (docs/41) and channel voice calls (docs/44).
 */

import { submitAgentNativeTurn, TurnError, type TurnDelivery } from '../executor/agentTurns.js';
import { childLogger } from '../log.js';
import { broadcastToVoiceSessions } from '../mcp/server/voiceToolHandlers.js';

const log = childLogger('voice:stream-turns');

export type StreamTurnOutcome =
  | { ok: true; delivery: TurnDelivery['delivery'] }
  | { ok: false; reason: TurnError['code'] | 'ERROR'; message: string };

export function deliverStreamTurn(text: string, source = 'stream'): StreamTurnOutcome {
  broadcastToVoiceSessions({ type: 'thinking', value: true });
  try {
    return { ok: true, delivery: submitAgentNativeTurn(text, { source }).delivery };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const reason = err instanceof TurnError ? err.code : 'ERROR';
    broadcastToVoiceSessions({
      type: 'speak',
      text: reason === 'NO_PROJECT' ? 'No project is selected. Choose a project in the voice tab first.' : message,
    });
    if (reason !== 'NO_PROJECT') broadcastToVoiceSessions({ type: 'error', message });
    broadcastToVoiceSessions({ type: 'thinking', value: false });
    broadcastToVoiceSessions({ type: 'turn_complete' });
    log.warn({ reason, message, source }, 'streamed segment not delivered');
    return { ok: false, reason, message };
  }
}
