/**
 * MCP inspect tools — agent_mcp_list, agent_mcp_tools
 *
 * Informational tools for debugging what MCP servers the *coding CLI* has
 * configured. These are NOT about AgentVoice's own MCP server.
 *
 * These used to shell out to `cursor-agent` whatever client was active, so the
 * answer described a CLI that was not running the work; the fix at the time
 * was to refuse for everyone except Cursor, which left three of four providers
 * with a permanently broken diagnostic (docs/40 §2).
 *
 * Now every provider declares its own commands through `mcpInspectCommands()`,
 * or declares that it has none. Declaring none is a real answer and comes back
 * as `supported: false` with the reason, rather than an error that reads like
 * a bug.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import stripAnsi from 'strip-ansi';
import { getActiveProvider } from '../../providers/agents/registry.js';
import type { AgentProvider, McpInspectCommands } from '../../providers/agents/types.js';

const execFileAsync = promisify(execFile);

interface InspectTarget {
  provider: AgentProvider;
  commands: McpInspectCommands;
  bin: string;
  env: NodeJS.ProcessEnv;
}

interface Unsupported {
  supported: false;
  provider: string;
  message: string;
}

/** Resolve the active CLI's inspect commands, or explain why there are none. */
function resolveTarget(): InspectTarget | Unsupported {
  const provider = getActiveProvider();
  const commands = provider.mcpInspectCommands?.() ?? null;
  if (!commands) {
    return {
      supported: false,
      provider: provider.id,
      message:
        `${provider.displayName} has no command for listing its own MCP servers, ` +
        'so this diagnostic does not apply to it.',
    };
  }
  return { provider, commands, bin: provider.resolveBin(), env: provider.env(process.env) };
}

function isUnsupported(t: InspectTarget | Unsupported): t is Unsupported {
  return (t as Unsupported).supported === false;
}

/** Non-empty, ANSI-free lines of a CLI's plain-text output. */
function lines(stdout: string): string[] {
  return stripAnsi(stdout)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

// ── agent_mcp_list ────────────────────────────────────────────────────────

export interface McpServer {
  name: string;
  status: string;
}

export interface McpListResult {
  supported: boolean;
  provider: string;
  servers: McpServer[];
  message?: string;
}

export async function handleMcpList(): Promise<McpListResult> {
  const target = resolveTarget();
  if (isUnsupported(target)) {
    return { supported: false, provider: target.provider, servers: [], message: target.message };
  }

  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(target.bin, target.commands.list, {
      timeout: 15_000,
      env: target.env,
    }));
  } catch (err) {
    // An installed CLI whose build predates the command is a real answer too.
    return {
      supported: false,
      provider: target.provider.id,
      servers: [],
      message:
        `${target.provider.displayName} did not answer \`${target.commands.list.join(' ')}\`: ` +
        `${err instanceof Error ? err.message.split('\n')[0] : String(err)}`,
    };
  }

  const servers = lines(stdout)
    // Health-check banners and "no servers configured" notes are not servers.
    .filter((l) => !/^(checking|no mcp servers)/i.test(l))
    .map((l) => {
      // Every CLI prints its own shape; `name: detail` is the common core.
      const colonIdx = l.indexOf(':');
      if (colonIdx === -1) return { name: l, status: 'unknown' };
      return { name: l.slice(0, colonIdx).trim(), status: l.slice(colonIdx + 1).trim() };
    });

  return { supported: true, provider: target.provider.id, servers };
}

// ── agent_mcp_tools ───────────────────────────────────────────────────────

export interface McpTool {
  name: string;
  description: string | null;
}

export interface McpToolsResult {
  supported: boolean;
  provider: string;
  server: string;
  tools: McpTool[];
  /** True when the CLI listed every server's tools, not just the one asked for. */
  all_servers?: boolean;
  message?: string;
}

export async function handleMcpTools(args: { server: string }): Promise<McpToolsResult> {
  const target = resolveTarget();
  if (isUnsupported(target)) {
    return {
      supported: false,
      provider: target.provider,
      server: args.server,
      tools: [],
      message: target.message,
    };
  }

  const toolsArgs = target.commands.tools?.(args.server) ?? null;
  if (!toolsArgs) {
    return {
      supported: false,
      provider: target.provider.id,
      server: args.server,
      tools: [],
      message:
        `${target.provider.displayName} can list its MCP servers but has no command for ` +
        'listing one server\'s tools.',
    };
  }

  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(target.bin, toolsArgs, { timeout: 15_000, env: target.env }));
  } catch (err) {
    return {
      supported: false,
      provider: target.provider.id,
      server: args.server,
      tools: [],
      message:
        `${target.provider.displayName} did not answer \`${toolsArgs.join(' ')}\`: ` +
        `${err instanceof Error ? err.message.split('\n')[0] : String(err)}`,
    };
  }

  return {
    supported: true,
    provider: target.provider.id,
    server: args.server,
    tools: lines(stdout).map((l) => ({ name: l, description: null })),
    ...(target.commands.toolsListsEverything ? { all_servers: true } : {}),
  };
}
