/**
 * MCP inspect tools — agent_mcp_list, agent_mcp_tools
 *
 * Informational tools for debugging what MCP servers the *coding CLI* has
 * configured. These are NOT about AgentVoice's own MCP server.
 *
 * Cursor is the only supported CLI with an `mcp list` command, so these tools
 * refuse loudly when another client is active rather than shelling out to
 * `cursor-agent` behind the user's back (which is what they used to do — the
 * output described a CLI that was not even running the work).
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
import { getActiveProvider, getProvider } from '../../providers/agents/registry.js';

const execFileAsync = promisify(execFile);

/**
 * Resolve the Cursor CLI, or explain why this diagnostic does not apply.
 * Returns the binary path + env for `cursor-agent`.
 */
function requireCursorCli(tool: string): { bin: string; env: NodeJS.ProcessEnv } {
  const active = getActiveProvider();
  if (active.id !== 'cursor') {
    throw new Error(
      `${tool} inspects Cursor's own MCP config, but the active agent client is ${active.displayName}. ` +
        `Switch the agent client to Cursor in Config, or check ${active.displayName}'s MCP setup with its own CLI.`,
    );
  }
  const cursor = getProvider('cursor');
  return { bin: cursor.resolveBin(), env: cursor.env(process.env) };
}

// ── agent_mcp_list ────────────────────────────────────────────────────────

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
  const { bin, env } = requireCursorCli('agent_mcp_list');
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(bin, ['mcp', 'list'], { timeout: 10_000, env }));
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

// ── agent_mcp_tools ───────────────────────────────────────────────────────

export interface McpTool {
  name: string;
  description: string | null;
}

export interface McpToolsResult {
  server: string;
  tools: McpTool[];
}

/**
 * List tools for a specific MCP server registered with the Cursor CLI.
 * Used for debugging executor MCP configuration.
 */
export async function handleMcpTools(args: { server: string }): Promise<McpToolsResult> {
  const { bin, env } = requireCursorCli('agent_mcp_tools');
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(bin, ['mcp', 'list-tools', args.server], {
      timeout: 10_000,
      env,
    }));
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
