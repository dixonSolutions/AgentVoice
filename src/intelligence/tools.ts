/**
 * Tool definitions for the llm_intelligence workflow.
 *
 * Claude sees a simplified surface (speak, get_status, launch_agent, read_output)
 * plus the full cursor_* MCP tools. speak() is handled by the bridge — not dispatchTool.
 *
 * See docs/15-llm-intelligence-workflow.md.
 */

import type { ToolConfiguration } from '@aws-sdk/client-bedrock-runtime';
import { VOICE_FUNCTION_TOOLS } from '../mcp/functionTools.js';

export interface IntelligenceToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** Bridge-only — pipes text to WebKit TTS on the phone. */
export const SPEAK_TOOL_NAME = 'speak';

const INTELLIGENCE_ALIAS_TOOLS = [
  {
    type: 'function' as const,
    name: SPEAK_TOOL_NAME,
    description:
      'Speak to the user out loud. Call whenever you need to communicate — ' +
      'acknowledge, explain progress, ask clarifying questions, or deliver results. ' +
      'Keep utterances concise and conversational (the user cannot see the screen).',
    parameters: {
      type: 'object' as const,
      properties: {
        text: {
          type: 'string' as const,
          description: 'Exact words to speak to the user.',
        },
      },
      required: ['text'],
    },
  },
  {
    type: 'function' as const,
    name: 'get_status',
    description:
      'Check what Cursor is doing right now. Always query fresh — never assume prior state. ' +
      'Safe during running jobs; call at most once every 20 seconds while waiting.',
    parameters: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    type: 'function' as const,
    name: 'launch_agent',
    description:
      'Send a coding task to Cursor (build/fix/implement). Speak to confirm intent first, ' +
      "then call with the user's exact words — do not rewrite.",
    parameters: {
      type: 'object' as const,
      properties: {
        task: {
          type: 'string' as const,
          description: "The user's coding request, verbatim.",
        },
        mode: {
          type: 'string' as const,
          enum: ['agent', 'plan'],
          description: 'agent = apply changes; plan = propose only. Default agent.',
        },
      },
      required: ['task'],
    },
  },
  {
    type: 'function' as const,
    name: 'read_output',
    description:
      'Read trimmed Cursor stdout / job output for grounded context. ' +
      'Use after get_status or when you need the latest result text.',
    parameters: {
      type: 'object' as const,
      properties: {
        job_id: {
          type: 'string' as const,
          description: 'Optional job id — defaults to the active running job.',
        },
      },
      required: [],
    },
  },
];

/** Map intelligence alias names to cursor_* MCP tools. */
export const INTELLIGENCE_TOOL_ALIASES: Record<string, string> = {
  get_status: 'agent_job_status',
  launch_agent: 'agent_submit',
  read_output: 'agent_job_status',
};

/** All tools exposed to Claude in the intelligence workflow. */
export const INTELLIGENCE_FUNCTION_TOOLS = [
  ...INTELLIGENCE_ALIAS_TOOLS,
  ...VOICE_FUNCTION_TOOLS.filter(
    (t) => !INTELLIGENCE_ALIAS_TOOLS.some((a) => a.name === t.name),
  ),
];

function toBedrockTool(
  tool: (typeof INTELLIGENCE_FUNCTION_TOOLS)[number],
): NonNullable<ToolConfiguration['tools']>[number] {
  return {
    toolSpec: {
      name: tool.name,
      description: tool.description,
      inputSchema: {
        json: tool.parameters as unknown as NonNullable<
          NonNullable<ToolConfiguration['tools']>[number]['toolSpec']
        >['inputSchema'] extends { json?: infer J } ? J : never,
      },
    },
  };
}

export function buildBedrockToolConfig(): ToolConfiguration {
  return {
    tools: INTELLIGENCE_FUNCTION_TOOLS.map(toBedrockTool),
  };
}

export function isBridgeHandledTool(name: string): boolean {
  return name === SPEAK_TOOL_NAME;
}
