/**
 * MCP inspect tools — cursor_mcp_list, cursor_mcp_tools
 *
 * Informational tools for debugging the cursor-agent executor's MCP config.
 * These are NOT about AgentVoice's own MCP server — they inspect what MCPs
 * cursor-agent itself has configured in .cursor/mcp.json.
 *
 * Backed by:
 *   cursor-agent mcp list
 *   cursor-agent mcp list-tools <identifier>
 *
 * Output is plain text — parsed by the bridge.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import stripAnsi from 'strip-ansi';
import { buildCursorAgentEnv } from '../../executor/cursorAgent.js';

const execFileAsync = promisify(execFile);

// ── cursor_mcp_list ───────────────────────────────────────────────────────

export interface McpServer {
  name: string;
  status: string;
}

export interface McpListResult {
  servers: McpServer[];
}

/**
 * List MCP servers configured in cursor-agent's .cursor/mcp.json.
 * Plain text output: one line per server, format varies.
 */
export async function handleMcpList(): Promise<McpListResult> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync('cursor-agent', ['mcp', 'list'], {
      timeout: 10_000,
      env: buildCursorAgentEnv(),
    }));
  } catch {
    return { servers: [] };
  }

  const servers = stripAnsi(stdout)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => {
      // Best-effort parse — CLI format is not documented as machine-readable
      const colonIdx = l.indexOf(':');
      if (colonIdx === -1) return { name: l, status: 'unknown' };
      return { name: l.slice(0, colonIdx).trim(), status: l.slice(colonIdx + 1).trim() };
    });

  return { servers };
}

// ── cursor_mcp_tools ──────────────────────────────────────────────────────

export interface McpTool {
  name: string;
  description: string | null;
}

export interface McpToolsResult {
  server: string;
  tools: McpTool[];
}

/**
 * List tools for a specific cursor-agent MCP server.
 * Used for debugging executor MCP configuration.
 */
export async function handleMcpTools(args: { server: string }): Promise<McpToolsResult> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      'cursor-agent',
      ['mcp', 'list-tools', args.server],
      { timeout: 10_000, env: buildCursorAgentEnv() },
    ));
  } catch (err) {
    throw new Error(`cursor-agent mcp list-tools "${args.server}" failed: ${String(err)}`);
  }

  const tools = stripAnsi(stdout)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => ({ name: l, description: null }));

  return { server: args.server, tools };
}
