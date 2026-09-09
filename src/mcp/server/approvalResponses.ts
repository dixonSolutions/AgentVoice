/**
 * Apply a user's answer to a pending approval — shared by every client
 * surface: the phone's control WebSocket, the desk `/ws/events` socket, and
 * `POST /api/approvals/:id/respond`.
 *
 * Whoever answers first wins: the registry resolves once, and every other
 * surface is told to dismiss its card via `approval_cancelled`.
 *
 * Secrets (`secret_input`) pass straight through to the registry promise —
 * they are not logged here.
 */

import { resolveRequest, type ApprovalResponse } from './approvalRegistry.js';
import { pushToPhone } from '../../state/controlSocket.js';
import { publishEvent } from '../../state/eventBus.js';
import { childLogger } from '../../log.js';

const log = childLogger('approval-responses');

/** Parse the wire shape `{ kind, ... }` into a registry response, or null when malformed. */
export function parseApprovalResponse(raw: unknown): ApprovalResponse | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const kind = r['kind'];

  if (kind === 'user_input' && typeof r['answer'] === 'string') {
    return { kind: 'user_input', answer: r['answer'] };
  }
  if (kind === 'plan_approval' && typeof r['decision'] === 'string') {
    const decision = r['decision'];
    if (decision !== 'approved' && decision !== 'rejected' && decision !== 'modified') return null;
    return {
      kind: 'plan_approval',
      decision,
      notes: typeof r['notes'] === 'string' ? r['notes'] : undefined,
    };
  }
  if (kind === 'permission' && (r['decision'] === 'allow' || r['decision'] === 'deny')) {
    return {
      kind: 'permission',
      decision: r['decision'],
      message: typeof r['message'] === 'string' ? r['message'] : undefined,
    };
  }
  if (kind === 'secret_input') {
    return { kind: 'secret_input', secret: typeof r['secret'] === 'string' ? r['secret'] : null };
  }
  return null;
}

export interface ApplyApprovalResult {
  ok: boolean;
  /** `invalid` = malformed body; `not_pending` = already answered, timed out, or unknown id. */
  reason?: 'invalid' | 'not_pending';
}

/**
 * Resolve a pending request with the user's answer and tell every other UI to
 * drop its card. `source` is only used for logs ("phone", "desk", "rest").
 */
export function applyApprovalResponse(
  request_id: string,
  raw: unknown,
  source: string,
): ApplyApprovalResult {
  const response = parseApprovalResponse(raw);
  if (!response) return { ok: false, reason: 'invalid' };

  const resolved = resolveRequest(request_id, response);
  if (!resolved) return { ok: false, reason: 'not_pending' };

  log.info({ request_id, kind: response.kind, source }, 'approval answered');
  const cancel = { type: 'approval_cancelled', request_id, reason: 'answered', by: source };
  pushToPhone(cancel);
  publishEvent(cancel);
  return { ok: true };
}
