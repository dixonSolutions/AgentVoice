import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { isCommand, parseCommand, renderCli, type ChatAction } from './commands.js';
import type { ChannelCommandInput } from './types.js';

const input = (text: string, isDirect = false): ChannelCommandInput => ({
  channel: 'discord',
  user: { id: 'u1', name: 'Ana' },
  conversation: { id: isDirect ? 'dm-1' : 'chan-1', label: '#dev', isDirect },
  text,
});
const VOICE = { supported: true, note: '' };
const parse = (text: string, opts: { isDirect?: boolean; voice?: typeof VOICE } = {}): ChatAction =>
  parseCommand({ input: input(text, opts.isDirect), voice: opts.voice ?? VOICE });
const argv = (text: string, opts?: { isDirect?: boolean }) => {
  const a = parse(text, opts);
  assert.equal(a.kind, 'cli', `${text} → ${JSON.stringify(a)}`);
  return (a as Extract<ChatAction, { kind: 'cli' }>).argv;
};
const HERE = ['--channel', 'discord', '--conversation', 'chan-1'];

describe('chat → squeaky CLI', () => {
  it('translates the agent commands into the CLI, with where they came from', () => {
    assert.deepEqual(argv('status'), ['agent', ...HERE]);
    assert.deepEqual(argv('stop'), ['agent', 'stop']);
    assert.deepEqual(argv('sessions site'), ['sessions', ...HERE, '--user', 'u1', '--', 'site']);
    assert.deepEqual(argv('use 2'), ['use', '--', '2']);
    assert.deepEqual(argv('use auth worker'), ['use', '--', 'auth worker']);
    assert.deepEqual(argv('new'), ['new', ...HERE]);
    assert.deepEqual(argv('default 2'), ['default', ...HERE, '--', '2']);
    assert.deepEqual(argv('project docs'), ['project', '--', 'docs']);
    assert.deepEqual(argv('config tts openai voice'), ['config', '--', 'tts', 'openai voice']);
    assert.deepEqual(argv('config'), ['config']);
  });

  it('chat and say are turns for the agent; stream opens a conversation with it', () => {
    assert.deepEqual(parse('chat open the readme'), { kind: 'chat', text: 'open the readme' });
    assert.deepEqual(parse('say -1 is not a flag'), { kind: 'chat', text: '-1 is not a flag' });
    assert.deepEqual(parse('stream on --voice --rep=voice'), { kind: 'stream', op: 'on', input: 'voice', rep: 'voice' });
    assert.deepEqual(parse('stream on —voice —rep=text'), { kind: 'stream', op: 'on', input: 'voice', rep: 'text' }, 'a phone’s em dash works');
    assert.deepEqual(parse('stream on --text'), { kind: 'stream', op: 'on', input: 'text', rep: 'text' });
    assert.deepEqual(parse('stream on --rep voice'), { kind: 'stream', op: 'on', input: 'text', rep: 'voice' });
    assert.deepEqual(parse('stream status'), { kind: 'stream', op: 'status' });
    assert.deepEqual(parse('stream break'), { kind: 'stream', op: 'break' });
    assert.equal(parse('stream on --loud').kind, 'reply');
  });

  it('voice: defaults are per person, settings are the shared voice-session ones', () => {
    assert.deepEqual(argv('voice default 2'), ['default', '--channel', 'discord', '--user', 'u1', '--', '2']);
    assert.deepEqual(argv('voice'), ['default', '--channel', 'discord', '--user', 'u1']);
    assert.deepEqual(argv('voice wake off'), ['config', '--', 'wake', 'off']);
    assert.deepEqual(argv('voice autojoin on'), ['channel', '--', 'set', 'discord', 'autoJoin', 'on']);
    assert.deepEqual(argv('channel here'), ['channel', '--', 'set', 'discord', 'messageChannel', 'chan-1']);
  });

  it('calls are the adapter’s; join from a DM means call', () => {
    assert.deepEqual(parse('call'), { kind: 'voice', action: 'call' });
    assert.deepEqual(parse('join', { isDirect: true }), { kind: 'voice', action: 'call' });
    assert.deepEqual(parse('join'), { kind: 'voice', action: 'join' });
    assert.deepEqual(parse('hangup'), { kind: 'voice', action: 'leave' });
    assert.deepEqual(parse('voice here'), { kind: 'voice', action: 'here' });
    const tg = parse('call', { voice: { supported: false, note: 'bots cannot call' } });
    assert.equal(tg.kind, 'reply');
    assert.match((tg as { text: string }).text, /not available here: bots cannot call/);
  });

  it('host commands run in every spelling; the rest stay on the host', () => {
    assert.deepEqual(argv('cli version'), ['version']);
    assert.deepEqual(argv('squeaky logs -n 5'), ['logs', '-n', '5']);
    assert.deepEqual(argv('doctor'), ['doctor']);
    for (const text of ['cli update', 'cli token', 'squeaky restart']) {
      const a = parse(text);
      assert.equal(a.kind, 'reply', text);
      assert.match((a as { text: string }).text, /not available from chat/);
    }
  });

  it('help, whoami and watch are answered here', () => {
    const help = parse('help') as { kind: string; text: string };
    assert.match(help.text, /\*\*Sessions\*\*/);
    assert.match(help.text, /\*\*Voice calls\*\*/);
    const noVoice = parseCommand({ input: input('help'), voice: { supported: false, note: 'no calls' } }) as { text: string };
    assert.doesNotMatch(noVoice.text, /\*\*Voice calls\*\*/);
    assert.match((parse('whoami') as { text: string }).text, /discord id `u1`/);
    assert.deepEqual(parse('watch'), { kind: 'watch' });
  });

  it('only messages that start with a command word are commands', () => {
    for (const t of ['help', 'sessions', 'use 2', 'Status', '', 'voice default 1', 'chat hi', 'stream on']) assert.equal(isCommand(t), true, t);
    for (const t of ['what does the login page do?', 'run the tests please', 'hello']) assert.equal(isCommand(t), false, t);
  });

  it('renders CLI answers: control as text, host output as a block, failures flagged', () => {
    const control = { kind: 'cli' as const, argv: ['use', '9'] };
    assert.equal(renderCli(control, { ok: false, output: 'No session matches "9".' }), '⚠️ No session matches "9".');
    const host = { kind: 'cli' as const, argv: ['version'], host: true };
    assert.equal(renderCli(host, { ok: true, output: 'squeaky 0.1.5' }), '`squeaky version`\n```\nsqueaky 0.1.5\n```');
  });
});
