/**
 * The agent CLI is launched with a generated MCP config that the phone writes
 * through /api/voice-session/prepare before its first turn. A channel has no
 * prepare step — someone may talk to the bot on Discord with no phone ever
 * connected — so it is written here before the first turn a channel sends,
 * as the audio pipe does (routes/audioStream.ts). Once per agent CLI.
 */

import { getConfig } from '../config.js';
import { ensureClientMcpSetup } from '../mcp/agentMcpSetup.js';

let ready: Promise<void> | null = null;
let readyFor = '';

export function prepareAgentForChannels(): Promise<void> {
  const client = getConfig().settings.agentClient;
  if (!ready || readyFor !== client) {
    readyFor = client;
    ready = ensureClientMcpSetup(client).then((result) => {
      if (!result.ok) {
        ready = null;
        throw new Error(`Agent MCP registration failed: ${result.message}`);
      }
    });
    ready.catch(() => undefined);
  }
  return ready;
}
