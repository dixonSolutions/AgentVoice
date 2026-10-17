/**
 * The channel command line — what `@Squeaky …` (or a DM, `/av …`, `!av …`,
 * or a message in the channel's own message channel) means.
 *
 * A parser, not an implementation: a command is translated into `squeaky`
 * CLI arguments (with where it came from — `--channel --conversation --user`)
 * and the real CLI runs it (cliRunner.ts), so a chat and a terminal are the
 * same commands with the same answers. Only what is about the chat itself is
 * answered here: help, whoami, starting / ending a call, a live status message.
 *
 * Talking to the agent is `chat <message>` (attachments included), or a
 * stream: `stream on [--voice|--text] [--rep=voice|text]` makes every message
 * here a turn — voice notes transcribed, text as it is — until `stream break`
 * (hub.ts). Either way the agent gets a turn exactly like a spoken one.
 */

import { CONTROL_COMMANDS } from '../control/types.js';
import { CHAT_CLI, HOST_CLI } from './cliRunner.js';
import { splitCommand } from './text.js';
import type { ChannelCommandInput, ChannelVoiceAction } from './types.js';

export type StreamInput = 'voice' | 'text';
export type StreamRep = 'voice' | 'text';

export type ChatAction =
  /** Answered here. */
  | { kind: 'reply'; text: string }
  /** A turn for the agent: the text plus the message's attachments. */
  | { kind: 'chat'; text: string }
  | { kind: 'stream'; op: 'on'; input: StreamInput; rep: StreamRep }
  | { kind: 'stream'; op: 'status' | 'break' }
  /** Run `squeaky <argv>`. `say`: it hands text to the agent, so keep relaying replies here. */
  | { kind: 'cli'; argv: string[]; say?: boolean; host?: boolean; footer?: string }
  | { kind: 'voice'; action: ChannelVoiceAction }
  | { kind: 'watch' };

export interface ParseContext {
  input: ChannelCommandInput;
  /** Whether this channel can do calls, and why not. */
  voice: { supported: boolean; note: string };
  /** Platform-specific ways in, for `help` ("/av …" on Discord). */
  howToAddress?: string;
}

/** Chat words that are commands (first word of a message). Everything else is text for the agent. */
const CHAT_WORDS = new Set([
  'help', 'commands', '?', 'whoami', 'status', 's', 'stop', 'projects', 'project', 'sessions', 'ls', 'use', 'continue',
  'new', 'default', 'pin', 'say', 'ask', 'chat', 'stream', 'config', 'set', 'voice', 'calls', 'cli', 'squeaky', 'doctor', 'version',
  'logs', 'channel', 'call', 'join', 'leave', 'hangup', 'watch',
]);

/** Does this message start with a command word? (Otherwise it is text for the agent.) */
export function isCommand(text: string): boolean {
  const { cmd } = splitCommand(text);
  return cmd === '' || CHAT_WORDS.has(cmd);
}

const HELP_TOPICS: Record<string, string[]> = {
  sessions: [
    '**Sessions**',
    '`sessions [project]` — running and recent agent sessions, numbered',
    '`use <n|name>` — continue that session on the next turn',
    '`default [<n|name|project>|none]` — the session *this conversation* continues (text, `say`, calls started here)',
    '`new [project]` — start a fresh session',
    '`project [name]` · `projects` — show or switch the active project',
    '`stop` — stop the voice agent',
  ],
  chat: [
    '**Chat & streams**',
    '`chat <message>` — one turn for the agent, with any attachments (images, video, files; voice messages are transcribed); replies come back here',
    '`stream on [--voice|--text] [--rep=voice|text]` — from now on every message here goes to the agent; `--rep=voice` answers with voice notes, `--rep=text` with text',
    '`stream status` — the stream and any call here · `stream break` — end them',
    'Files the agent sends (recordings, screenshots, video) are posted here too. Turns continue this conversation\'s `default`, else your `voice default`.',
  ],
  voice: [
    '**Voice calls**',
    '`call` — a call: in the voice channel set for me, else your private room; `hangup` ends it',
    '`join` / `leave` — call in the voice channel you are in',
    '`voice` — the session your calls continue · `voice sessions` · `voice default <n|name|project|none>`',
    '`voice here` — make the voice channel you are in the one calls use',
    '`voice autojoin on|off` — walking into a voice channel is the call',
    'Calls listen the way the app does — `config wake|vad|silence|input` change it for both.',
  ],
  config: [
    '**Settings**',
    '`config` — every setting with its value and choices',
    '`config <key>` — one setting · `config <key> <value>` — change it',
    '`channel here` — this conversation becomes my message channel (untagged text, calls, logs)',
  ],
  cli: [
    '**Host CLI** — every command here runs `squeaky <command>` on the bridge host',
    ...Object.entries(HOST_CLI).map(([k, v]) => `\`cli ${k}\` — ${v}`),
    'Service control, updates, setup and tokens stay on the host.',
  ],
  other: [
    '**Other**',
    '`status` — agent, project, who is listening',
    '`watch` — keep a live status message here',
    '`whoami` — your id',
    '`help <chat|sessions|voice|config|cli>` — one group',
  ],
};

function helpText(ctx: ParseContext, topic?: string): string {
  if (topic) {
    const t = HELP_TOPICS[topic === 'call' || topic === 'calls' ? 'voice' : topic];
    if (t) return t.join('\n');
    return `No help topic "${topic}" — try ${Object.keys(HELP_TOPICS).filter((k) => k !== 'other').join(', ')}.`;
  }
  const groups = ['chat', 'sessions', ...(ctx.voice.supported ? ['voice'] : []), 'config', 'cli', 'other'];
  const how = ctx.howToAddress ?? 'Mention me or DM me with a command.';
  const noVoice = ctx.voice.supported ? [] : ['', `_Voice calls: ${ctx.voice.note}_`];
  return [`**Squeaky** — ${how}`, '', ...groups.flatMap((g) => [...HELP_TOPICS[g]!, '']), ...noVoice].join('\n').trim();
}

/** Words the CLI must take as they are — after `--`, so an id like -100 or text like "-1 is wrong" is not a flag. */
function text(...parts: string[]): string[] {
  const kept = parts.filter((p) => p !== '');
  return kept.length ? ['--', ...kept] : [];
}

const ON = ['on', 'true', 'yes', '1'];
const OFF = ['off', 'false', 'no', '0'];

/** Translate one command into what to do. Never throws. */
export function parseCommand(ctx: ParseContext): ChatAction {
  const { input } = ctx;
  const { cmd, args, rest } = splitCommand(input.text);
  const ch = input.channel;
  const here = ['--channel', ch, '--conversation', input.conversation.id];
  const me = ['--channel', ch, '--user', input.user.id];
  const noVoice: ChatAction = { kind: 'reply', text: `Voice calls are not available here: ${ctx.voice.note}` };

  switch (cmd) {
    case '':
    case 'help':
    case 'commands':
    case '?':
      return { kind: 'reply', text: helpText(ctx, args[0]?.toLowerCase()) };

    case 'whoami':
      return { kind: 'reply', text: `You are **${input.user.name}** — ${ch} id \`${input.user.id}\`.` };

    case 'status':
    case 's':
      return { kind: 'cli', argv: ['agent', ...here] };
    case 'stop':
      return { kind: 'cli', argv: ['agent', 'stop'] };
    case 'projects':
      return { kind: 'cli', argv: ['projects'] };
    case 'project':
      return { kind: 'cli', argv: ['project', ...text(rest)] };
    case 'sessions':
    case 'ls':
      return { kind: 'cli', argv: ['sessions', ...here, '--user', input.user.id, ...text(rest)] };
    case 'use':
    case 'continue':
      return { kind: 'cli', argv: ['use', ...text(rest)] };
    case 'new':
      return { kind: 'cli', argv: ['new', ...here, ...text(rest)] };
    case 'default':
    case 'pin':
      return { kind: 'cli', argv: ['default', ...here, ...text(rest)] };
    case 'chat':
    case 'say':
    case 'ask':
      return { kind: 'chat', text: rest };

    case 'stream':
      return parseStream(args);
    case 'config':
    case 'set': {
      const [key, ...value] = args;
      return { kind: 'cli', argv: ['config', ...text(key ?? '', value.join(' '))] };
    }

    case 'channel':
      // `channel here`: this conversation becomes the channel's message channel.
      if (args[0]?.toLowerCase() === 'here') return { kind: 'cli', argv: ['channel', ...text('set', ch, 'messageChannel', input.conversation.id)], host: true };
      return { kind: 'cli', argv: ['channel', ...args], host: true };

    case 'voice':
    case 'calls': {
      if (!ctx.voice.supported) return noVoice;
      const [sub = '', ...more] = args;
      const value = more.join(' ');
      switch (sub.toLowerCase()) {
        case '':
        case 'status':
        case 'default':
        case 'pin':
          return { kind: 'cli', argv: ['default', ...me, ...text(value)], ...(sub ? {} : { footer: HELP_TOPICS['voice']!.slice(1).join('\n') }) };
        case 'sessions':
        case 'ls':
          return { kind: 'cli', argv: ['sessions', ...here, '--user', input.user.id, ...text(value)] };
        case 'autojoin':
        case 'auto': {
          const v = value.toLowerCase();
          if (!ON.includes(v) && !OFF.includes(v)) return { kind: 'reply', text: '`voice autojoin on` or `voice autojoin off`' };
          return { kind: 'cli', argv: ['channel', ...text('set', ch, 'autoJoin', ON.includes(v) ? 'on' : 'off')], host: true };
        }
        case 'wake':
        case 'vad':
        case 'silence':
          return { kind: 'cli', argv: ['config', ...text(sub.toLowerCase(), value)] };
        case 'here':
          return { kind: 'voice', action: 'here' };
        case 'call':
          return { kind: 'voice', action: 'call' };
        case 'join':
        case 'start':
          return { kind: 'voice', action: input.conversation.isDirect ? 'call' : 'join' };
        case 'leave':
        case 'end':
        case 'hangup':
          return { kind: 'voice', action: 'leave' };
        default:
          return { kind: 'reply', text: HELP_TOPICS['voice']!.join('\n') };
      }
    }

    case 'call':
    case 'join':
    case 'leave':
    case 'hangup': {
      if (!ctx.voice.supported) return noVoice;
      // `join` from a DM has no voice channel to join — it means "call me".
      const action = cmd === 'call' || (cmd === 'join' && input.conversation.isDirect) ? 'call' : cmd === 'join' ? 'join' : 'leave';
      return { kind: 'voice', action };
    }

    case 'watch':
      return { kind: 'watch' };

    case 'cli':
    case 'squeaky':
    case 'doctor':
    case 'version':
    case 'logs': {
      const argv = cmd === 'cli' || cmd === 'squeaky' ? args : [cmd, ...args];
      if (!argv[0]) return { kind: 'reply', text: HELP_TOPICS['cli']!.join('\n') };
      if (!CHAT_CLI.has(argv[0])) {
        return { kind: 'reply', text: `\`squeaky ${argv[0]}\` is not available from chat — run it on the host. Allowed: ${[...CHAT_CLI].join(', ')}.` };
      }
      return { kind: 'cli', argv, host: !(CONTROL_COMMANDS as readonly string[]).includes(argv[0]) };
    }

    default:
      return { kind: 'reply', text: `Unknown command \`${cmd}\` — \`help\` lists them.` };
  }
}

/**
 * `stream on [--voice|--text] [--rep=voice|text]`, `stream status`, `stream break`.
 * Phones turn `--` into a dash (—voice); either spelling works.
 */
function parseStream(args: string[]): ChatAction {
  const words = args.map((a) => a.replace(/^[—–]+/, '--').toLowerCase());
  const [op = 'status', ...flags] = words;
  if (['break', 'off', 'end', 'stop'].includes(op)) return { kind: 'stream', op: 'break' };
  if (op === 'status' || op === '') return { kind: 'stream', op: 'status' };
  if (op !== 'on' && op !== 'start') return { kind: 'reply', text: HELP_TOPICS['chat']!.join('\n') };
  let input: StreamInput = 'text';
  let rep: StreamRep | null = null;
  for (let i = 0; i < flags.length; i++) {
    const f = flags[i]!.replace(/^-+/, '');
    if (f === 'voice' || f === 'text') input = f;
    else if (/^rep(ly)?=(voice|text)$/.test(f)) rep = f.split('=')[1] as StreamRep;
    else if ((f === 'rep' || f === 'reply') && (flags[i + 1] === 'voice' || flags[i + 1] === 'text')) rep = flags[++i] as StreamRep;
    else return { kind: 'reply', text: `Unknown stream option \`${flags[i]}\` — \`stream on [--voice|--text] [--rep=voice|text]\`` };
  }
  return { kind: 'stream', op: 'on', input, rep: rep ?? input };
}

/** How a CLI answer reads in a chat: control answers as they are, host output as a code block. */
export function renderCli(action: Extract<ChatAction, { kind: 'cli' }>, res: { ok: boolean; output: string }): string {
  const out = res.output.trim() || '(no output)';
  if (!action.host) {
    const text = res.ok ? out : `⚠️ ${out}`;
    return action.footer && res.ok ? `${text}\n${action.footer}` : text;
  }
  const clipped = out.length > 1800 ? `…${out.slice(-1800)}` : out;
  return `${res.ok ? '' : '⚠️ '}\`squeaky ${action.argv.join(' ')}\`\n\`\`\`\n${clipped}\n\`\`\``;
}
