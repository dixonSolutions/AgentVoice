/**
 * Listener envelope — the presence signal that rides on every agent-voice tool
 * result (docs/36 §3.1).
 *
 * MCP is pull-only. There is no way for the bridge to push "the user just put
 * their phone down" into a running Cursor, Codex, Claude Code or Codewhale
 * process. The only channel that reaches all four is the result of a tool they
 * already call, which is why the pending-user-turn notice was hung off
 * `speak()` in the first place.
 *
 * This wrapper generalises that: every AgentVoice tool result gains a
 * `listener` block with the presence state, how long the user has been away,
 * the policy in force and one line of instruction. An agent that never calls
 * `speak()` — one grinding through its own Read/Bash tools — still learns the
 * user has gone the next time it touches any AgentVoice tool.
 *
 * It is also the natural place to charge the unattended tool-call budget:
 * every agent-voice call while away is one tick, and the budget verdict comes
 * back in the same envelope.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { listenerBlock, chargeAwayBudget, isListening } from '../../state/awayPolicy.js';
import { childLogger } from '../../log.js';

const log = childLogger('mcp:listener-envelope');

type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

interface TextContent {
  type: string;
  text?: string;
}

interface ToolResult {
  content?: TextContent[];
  isError?: boolean;
}

/**
 * Tools whose result is not a JSON object the agent reads as state — leaving
 * them alone keeps binary / display payloads untouched.
 */
const SKIP = new Set(['show_images']);

/**
 * Merge the listener block into a tool result, in place where the result is
 * the usual single JSON text block. Anything else is returned untouched: a
 * malformed or non-JSON payload must never be corrupted by this.
 */
export function attachListenerToResult(name: string, result: unknown): unknown {
  if (SKIP.has(name)) return result;
  const res = result as ToolResult | null;
  const first = res?.content?.[0];
  if (!first || first.type !== 'text' || typeof first.text !== 'string') return result;

  let parsed: unknown;
  try {
    parsed = JSON.parse(first.text);
  } catch {
    return result; // plain-text result — nothing to merge into
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return result;

  const payload = parsed as Record<string, unknown>;
  // A handler that already built its own listener block (the voice tools do)
  // keeps it — theirs is the one that matches what it just decided.
  if (payload['listener'] === undefined) payload['listener'] = listenerBlock();

  if (!isListening()) {
    const verdict = chargeAwayBudget();
    if (verdict.exceeded) {
      payload['budget_exceeded'] = verdict.reason;
      payload['budget_message'] = verdict.message;
      log.warn({ tool: name, reason: verdict.reason }, 'unattended budget exceeded');
    }
  }

  first.text = JSON.stringify(payload);
  return result;
}

/**
 * Wrap `server.tool` so every registered tool's result carries the envelope.
 * Call once in buildMcpServer, before the tools are registered.
 */
export function instrumentListenerEnvelope(server: McpServer): void {
  const target = server as McpServer & {
    tool: (name: string, description: string, schema: unknown, handler: ToolHandler) => unknown;
  };
  const original = target.tool.bind(target);

  // The SDK's tool() overloads confuse TS when reassigned — the runtime shape
  // is the four-argument form every call site here uses.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (target as any).tool = (name: string, description: string, schema: unknown, handler: ToolHandler) =>
    original(name, description, schema, async (args: Record<string, unknown>) => {
      const result = await handler(args);
      try {
        return attachListenerToResult(name, result);
      } catch (err) {
        log.warn({ err, tool: name }, 'could not attach the listener block');
        return result;
      }
    });
}
