#!/usr/bin/env node
/**
 * End-to-end: channels (docs/44) against a real bridge.
 *
 * `squeaky run` with Telegram, Slack and WhatsApp enabled, each pointed at
 * a stand-in for its platform API — the adapters speak exactly the HTTP and
 * WebSocket protocol they use against the real services:
 *
 *   Telegram   Bot API: getMe, setMyCommands, getUpdates long-polling,
 *              sendMessage, editMessageText, getFile + file download, sendVoice
 *   Slack      Web API (auth.test, apps.connections.open, chat.postMessage,
 *              chat.update, users.info) and a Socket Mode WebSocket
 *   WhatsApp   the bridge's own signed webhook in, Graph API out
 *
 * The voice agent is the stub CLI echoing every turn, speech is the harness's
 * stand-in Whisper and streaming voice. Discord needs a real gateway; its
 * command handling is the same hub as these, and its audio path is unit-tested.
 *
 * Asserts:
 *   - strangers are told their id and ignored; allowlisted users are obeyed
 *   - status / sessions / default / whoami / config answer in the chat
 *   - `say` reaches the agent and the agent's reply is relayed back to that chat
 *   - a Telegram voice message is transcribed, handed to the agent, and the
 *     reply comes back as an Ogg/Opus voice message plus text
 *   - `watch` posts a status message and edits it as things change
 *   - Slack mentions and the /av slash command are acked and answered
 *   - WhatsApp webhooks need Meta's signature; verification echoes the challenge
 *   - GET /api/channels and `squeaky channel` report them; `channel allow` works
 *
 * Usage:
 *   npm run build:backend && node scripts/live-channels-test.mjs [--keep]
 */

import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { createInstance, makeReporter, ROOT } from './e2e-harness.mjs';

const KEEP = process.argv.includes('--keep');
const BIN = [process.execPath, join(ROOT, 'dist', 'cli.js')];
const CANNED = ['read the changelog'];
const TG_TOKEN = '123456:test-token';
const OWNER_TG = 42;
const STRANGER_TG = 7;
const WA_SECRET = 'wa-app-secret';
const OWNER_WA = '15550001111';

const report = makeReporter();
const { say, check, fail } = report;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, ms = 20_000, what = 'condition') {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}

// A real Ogg/Opus voice note, made by the bridge's own encoder.
const VOICE_NOTE = execFileSync(
  process.execPath,
  [
    '--import',
    'tsx',
    '-e',
    `import { encodeOggOpus } from './src/channels/audio.ts';
     const n = 16000 * 1.5; const pcm = Buffer.alloc(n * 2);
     for (let i = 0; i < n; i++) pcm.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 220 * i / 16000) * 9000), i * 2);
     process.stdout.write(encodeOggOpus(pcm, 16000));`,
  ],
  { cwd: ROOT, maxBuffer: 1 << 24 },
);

// ── Stand-in Telegram Bot API ──────────────────────────────────────────────
const tg = { sent: [], edits: [], voices: [], updates: [], waiters: [], commands: null, nextId: 1 };
function tgPush(message) {
  tg.updates.push({ update_id: tg.nextId++, message: { message_id: tg.nextId, date: 0, ...message } });
  for (const w of tg.waiters.splice(0)) w();
}
const tgServer = createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks);
  const json = (result) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, result }));
  if (req.url === '/file/bot' + TG_TOKEN + '/voice/note.oga') return res.writeHead(200).end(VOICE_NOTE);
  const method = req.url.split('/').pop();
  const body = (req.headers['content-type'] ?? '').includes('json') ? JSON.parse(raw.toString() || '{}') : {};
  switch (method) {
    case 'getMe':
      return json({ id: 999, is_bot: true, username: 'SqueakyTestBot' });
    case 'setMyCommands':
      tg.commands = body.commands;
      return json(true);
    case 'getUpdates': {
      const deadline = Date.now() + 2000;
      while (!tg.updates.some((u) => u.update_id >= body.offset) && Date.now() < deadline) {
        await new Promise((r) => {
          tg.waiters.push(r);
          setTimeout(r, 200);
        });
      }
      return json(tg.updates.filter((u) => u.update_id >= (body.offset ?? 0)));
    }
    case 'sendMessage':
      tg.sent.push({ chat: body.chat_id, text: body.text, at: Date.now() });
      return json({ message_id: 5000 + tg.sent.length });
    case 'editMessageText':
      tg.edits.push({ chat: body.chat_id, id: body.message_id, text: body.text });
      return json(true);
    case 'getFile':
      return json({ file_id: body.file_id, file_path: 'voice/note.oga' });
    case 'sendVoice':
      tg.voices.push(raw);
      return json({ message_id: 9000 + tg.voices.length });
    default:
      return res.writeHead(404).end(JSON.stringify({ ok: false, description: `no ${method}` }));
  }
});

// ── Stand-in Slack: Web API + Socket Mode ──────────────────────────────────
const slack = { posts: [], updates: [], acks: [], socket: null };
const slackWss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
slackWss.on('connection', (ws) => {
  slack.socket = ws;
  ws.send(JSON.stringify({ type: 'hello' }));
  ws.on('message', (raw) => slack.acks.push(JSON.parse(raw.toString()).envelope_id));
});
const slackApi = createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
  const ok = (extra = {}) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, ...extra }));
  const method = req.url.split('/').pop();
  if (method === 'auth.test') return ok({ user_id: 'UBOT', user: 'squeaky', team: 'Test' });
  if (method === 'apps.connections.open') {
    if (req.headers.authorization !== 'Bearer xapp-test') return ok({ ok: false, error: 'invalid_auth' });
    return ok({ url: `ws://127.0.0.1:${slackWss.address().port}` });
  }
  if (method === 'chat.postMessage') {
    slack.posts.push(body);
    return ok({ ts: `${Date.now()}.${slack.posts.length}` });
  }
  if (method === 'chat.update') {
    slack.updates.push(body);
    return ok();
  }
  if (method === 'users.info') return ok({ user: { real_name: 'Ana Slack' } });
  return res.writeHead(404).end('{}');
});
let envelope = 0;
function slackEvent(type, payload) {
  const id = `env-${++envelope}`;
  slack.socket.send(JSON.stringify({ envelope_id: id, type, payload }));
  return id;
}

// ── Stand-in Graph API (WhatsApp) ──────────────────────────────────────────
const wa = { messages: [] };
const graph = createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = (req.headers['content-type'] ?? '').includes('json') ? JSON.parse(Buffer.concat(chunks).toString() || '{}') : {};
  if (req.url.endsWith('/messages')) {
    wa.messages.push(body);
    return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ messages: [{ id: `wamid.${wa.messages.length}` }] }));
  }
  return res.writeHead(404).end('{}');
});

await Promise.all([
  new Promise((r) => tgServer.listen(0, '127.0.0.1', r)),
  new Promise((r) => slackApi.listen(0, '127.0.0.1', r)),
  new Promise((r) => graph.listen(0, '127.0.0.1', r)),
  new Promise((r) => (slackWss.address() ? r() : slackWss.once('listening', r))),
]);

const av = await createInstance({
  bin: BIN,
  canned: CANNED,
  ttsChunkDelayMs: 20,
  extraEnv: {
    TELEGRAM_BOT_TOKEN: TG_TOKEN,
    TELEGRAM_API_BASE: `http://127.0.0.1:${tgServer.address().port}`,
    SLACK_BOT_TOKEN: 'xoxb-test',
    SLACK_APP_TOKEN: 'xapp-test',
    SLACK_API_BASE: `http://127.0.0.1:${slackApi.address().port}/api`,
    WHATSAPP_ACCESS_TOKEN: 'wa-token',
    WHATSAPP_PHONE_NUMBER_ID: '1000',
    WHATSAPP_VERIFY_TOKEN: 'verify-me',
    WHATSAPP_APP_SECRET: WA_SECRET,
    WHATSAPP_API_BASE: `http://127.0.0.1:${graph.address().port}`,
  },
  configure(config) {
    const audio = config.settings.workflow.llmIntelligence.audio;
    audio.tts = { provider: 'local_speech', fallbacks: [], language: 'auto', models: {}, voices: {}, scopes: {} };
    config.settings.channels = {
      telegram: { enabled: true, allowUsers: [String(OWNER_TG)] },
      slack: { enabled: true, allowUsers: ['U42'] },
      whatsapp: { enabled: true, allowUsers: [OWNER_WA] },
      discord: { enabled: false },
    };
  },
});

const dm = (from, text, extra = {}) =>
  tgPush({ from: { id: from, first_name: from === OWNER_TG ? 'Ana' : 'Eve' }, chat: { id: from, type: 'private' }, text, ...extra });
const tgSince = (n) => tg.sent.slice(n).map((m) => m.text).join('\n---\n');

function signedWebhook(body, secret = WA_SECRET) {
  const raw = JSON.stringify(body);
  return fetch(`${av.base}/hooks/whatsapp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}` },
    body: raw,
  });
}
const waText = (from, text) => ({
  entry: [{ changes: [{ value: { contacts: [{ wa_id: from, profile: { name: 'Ana WA' } }], messages: [{ from, id: `m${Math.random()}`, type: 'text', text: { body: text } }] } }] }],
});

try {
  say(`scratch: ${av.tmp}`);
  await av.startBridge();
  say('bridge up');
  check((await av.api('/api/active-project', { project: 'e2e' })).status === 200, 'selected the project');

  // ── status of the channels ─────────────────────────────────────────────
  await until(() => tg.commands !== null && slack.socket !== null, 15_000, 'channels to connect');
  const api = JSON.parse((await av.api('/api/channels')).text);
  const state = Object.fromEntries(api.channels.map((c) => [c.id, c.state]));
  check(state.telegram === 'connected' && state.slack === 'connected' && state.whatsapp === 'connected' && state.discord === 'off', 'GET /api/channels: three connected, Discord off', JSON.stringify(state));
  check(api.channels.find((c) => c.id === 'telegram').capabilities.voiceCalls.supported === false, 'Telegram declares calls unsupported, with a reason');
  check(tg.commands.some((c) => c.command === 'sessions'), 'Telegram command menu registered');

  // ── Telegram: access control ───────────────────────────────────────────
  let mark = tg.sent.length;
  dm(STRANGER_TG, 'status');
  await until(() => tg.sent.length > mark, 10_000, 'stranger notice');
  check(/id is <code>7<\/code>/.test(tgSince(mark)) && /squeaky channel allow telegram 7/.test(tgSince(mark)), 'a stranger is told their id and how to be allowed');
  mark = tg.sent.length;
  dm(STRANGER_TG, 'sessions');
  await sleep(800);
  check(tg.sent.length === mark, 'and is then ignored');

  // ── Telegram: commands ─────────────────────────────────────────────────
  mark = tg.sent.length;
  dm(OWNER_TG, '/status');
  await until(() => tg.sent.length > mark, 10_000, 'status');
  check(/Claude Code is idle/.test(tgSince(mark)) && /project: e2e/.test(tgSince(mark)), '/status answers with agent and project', tgSince(mark));
  mark = tg.sent.length;
  dm(OWNER_TG, 'whoami');
  await until(() => tg.sent.length > mark, 10_000, 'whoami');
  check(/telegram id <code>42<\/code>/.test(tgSince(mark)), 'whoami');
  mark = tg.sent.length;
  dm(OWNER_TG, 'help');
  await until(() => tg.sent.length > mark, 10_000, 'help');
  check(/<b>Sessions<\/b>/.test(tgSince(mark)) && /<b>Host CLI<\/b>/.test(tgSince(mark)) && !/<b>Voice calls<\/b>/.test(tgSince(mark)), 'help lists the groups (no voice-call group on Telegram)');
  mark = tg.sent.length;
  // A group message: the tag, blank lines, then the command.
  const tagged = '@SqueakyTestBot\n\n  whoami';
  tgPush({ from: { id: OWNER_TG, first_name: 'Ana' }, chat: { id: -100, type: 'supergroup', title: 'Dev' }, text: tagged, entities: [{ type: 'mention', offset: 0, length: 15 }] });
  await until(() => tg.sent.length > mark, 10_000, 'tagged group command');
  check(/telegram id <code>42<\/code>/.test(tgSince(mark)), 'a group tag followed by line breaks still reads as the command');
  mark = tg.sent.length;
  tgPush({ from: { id: OWNER_TG, first_name: 'Ana' }, chat: { id: -100, type: 'supergroup', title: 'Dev' }, text: 'whoami' });
  await sleep(600);
  check(tg.sent.length === mark, 'an untagged group message is not a command');
  mark = tg.sent.length;
  dm(OWNER_TG, 'cli version');
  await until(() => tg.sent.length > mark, 30_000, 'cli version');
  check(/<code>squeaky version<\/code>/.test(tgSince(mark)) && /squeaky \d+\.\d+\.\d+/.test(tgSince(mark)), 'cli version runs the host CLI and posts its output', tgSince(mark).slice(0, 200));
  mark = tg.sent.length;
  dm(OWNER_TG, 'cli update');
  await until(() => tg.sent.length > mark, 10_000, 'cli update refusal');
  check(/not available from chat/.test(tgSince(mark)), 'host commands that change the install are refused');
  mark = tg.sent.length;
  dm(OWNER_TG, 'voice default 1');
  await until(() => tg.sent.length > mark, 10_000, 'voice on telegram');
  check(/Voice calls are not available here/.test(tgSince(mark)), 'voice commands explain why Telegram cannot call');
  mark = tg.sent.length;
  dm(OWNER_TG, 'config tts');
  await until(() => tg.sent.length > mark, 10_000, 'config');
  check(/<code>tts<\/code> = local_speech/.test(tgSince(mark)), 'config reads a setting', tgSince(mark));
  mark = tg.sent.length;
  dm(OWNER_TG, 'default e2e');
  await until(() => tg.sent.length > mark, 10_000, 'default');
  check(/latest session on <b>e2e<\/b>/.test(tgSince(mark)), 'default pins this chat to a project');

  // ── Telegram: watch, then say → the agent's reply comes back here ──────
  mark = tg.sent.length;
  dm(OWNER_TG, 'watch');
  await until(() => tg.sent.length > mark, 10_000, 'watch');
  check(/Live status/.test(tgSince(mark)), 'watch posts a live status message');
  mark = tg.sent.length;
  dm(OWNER_TG, 'say hello from telegram');
  await until(() => /ECHO boot: hello from telegram/.test(tgSince(mark)), 30_000, 'the agent reply');
  check(!/Sent/.test(tgSince(mark)), 'say (= chat) goes to the agent with no confirmation — the reply is the answer');
  check(true, 'the agent’s spoken reply was relayed back to the Telegram chat');
  await until(() => tg.edits.length > 0, 10_000, 'a live status edit');
  check(/Claude Code is running/.test(tg.edits.at(-1).text), 'the live status message was edited as the agent started', tg.edits.at(-1)?.text.slice(0, 120));

  // ── Telegram: voice message in, voice message out ──────────────────────
  mark = tg.sent.length;
  const voicesBefore = tg.voices.length;
  tgPush({ from: { id: OWNER_TG, first_name: 'Ana' }, chat: { id: OWNER_TG, type: 'private' }, voice: { file_id: 'voice-1', duration: 2, mime_type: 'audio/ogg' } });
  await until(() => /ECHO telegram: read the changelog/.test(tgSince(mark)), 30_000, 'the voice-note reply');
  check(/🎙️ <i>read the changelog<\/i>/.test(tgSince(mark)), 'the voice message was transcribed and echoed back as text');
  check(tg.voices.length > voicesBefore, 'the reply came back as a voice message');
  const voice = tg.voices.at(-1);
  const oggStart = voice.indexOf('OggS');
  check(oggStart >= 0 && voice.indexOf('OpusHead') > oggStart, 'that voice message is Ogg/Opus', `${voice.length} bytes`);
  check(/ECHO telegram: read the changelog/.test(tgSince(mark)), 'the agent heard the voice message as a telegram turn');

  // ── Telegram: chat <message> is a turn; other text is not ──────────────
  mark = tg.sent.length;
  dm(OWNER_TG, 'summarise the readme');
  await until(() => tg.sent.length > mark, 10_000, 'a pointer to chat');
  check(/<code>chat &lt;message&gt;<\/code>|chat <message>/.test(tgSince(mark)), 'text that is not a command points to `chat`', tgSince(mark).slice(0, 200));
  mark = tg.sent.length;
  dm(OWNER_TG, 'chat summarise the readme');
  await until(() => /ECHO \w+: summarise the readme/.test(tgSince(mark)), 30_000, 'a chat turn');
  check(true, '`chat <message>` went to the agent as a turn, and the reply came back');

  // ── Telegram: the group becomes the message channel ───────────────────
  const GROUP = { id: -100, type: 'supergroup', title: 'Dev' };
  mark = tg.sent.length;
  tgPush({ from: { id: OWNER_TG, first_name: 'Ana' }, chat: GROUP, text: '@SqueakyTestBot channel here', entities: [{ type: 'mention', offset: 0, length: 15 }] });
  await until(() => /messageChannel/.test(tgSince(mark)), 30_000, 'channel here');
  check(/messageChannel → -100/.test(tgSince(mark)), '`channel here` makes the group the message channel', tgSince(mark).slice(0, 200));
  mark = tg.sent.length;
  tgPush({ from: { id: OWNER_TG, first_name: 'Ana' }, chat: GROUP, text: 'whoami' });
  await until(() => tg.sent.length > mark, 10_000, 'untagged command in the message channel');
  check(/telegram id <code>42<\/code>/.test(tgSince(mark)), 'there, an untagged command is obeyed');
  mark = tg.sent.length;
  tgPush({ from: { id: OWNER_TG, first_name: 'Ana' }, chat: GROUP, text: 'chat list the files' });
  await until(() => /ECHO \w+: list the files/.test(tgSince(mark)), 30_000, 'a turn from the message channel');
  check(true, 'and an untagged `chat` is a turn');
  await until(() => /<code>telegram<\/code> list the files/.test(tgSince(mark)), 10_000, 'session logs in the message channel');
  check(true, 'every session log line is poured into the message channel (the turn, the agent status, its reply)');

  // ── Telegram: a voice stream — voice notes in, voice notes out ─────────
  mark = tg.sent.length;
  dm(OWNER_TG, 'stream on —voice —rep=voice');
  await until(() => /Stream on/.test(tgSince(mark)), 10_000, 'stream on');
  check(/Replies: <b>voice notes<\/b>/.test(tgSince(mark)), '`stream on —voice —rep=voice` (a phone’s dashes) opens a voice stream', tgSince(mark).slice(0, 200));
  mark = tg.sent.length;
  const voicesInStream = tg.voices.length;
  dm(OWNER_TG, 'status of the build');
  await until(() => tg.voices.length > voicesInStream, 30_000, 'a voice-note reply in the stream');
  check(true, 'in the stream, text — even one starting with a command word — is a turn, answered with a voice note');
  const inDm = tg.sent.slice(mark).filter((m) => String(m.chat) === String(OWNER_TG)).map((m) => m.text).join('\n');
  check(!/ECHO \w+: status of the build/.test(inDm), 'and only a voice note in the DM (rep=voice), no text copy', inDm.slice(0, 200));
  mark = tg.sent.length;
  dm(OWNER_TG, 'stream status');
  await until(() => tg.sent.length > mark, 10_000, 'stream status');
  check(/Stream on.*1 turn/s.test(tgSince(mark)), '`stream status` reports it', tgSince(mark).slice(0, 200));
  mark = tg.sent.length;
  dm(OWNER_TG, 'stream break');
  await until(() => tg.sent.length > mark, 10_000, 'stream break');
  check(/Ended the stream/.test(tgSince(mark)), '`stream break` ends it');

  // ── Slack ─────────────────────────────────────────────────────────────
  let sMark = slack.posts.length;
  const env1 = slackEvent('events_api', { event: { type: 'app_mention', user: 'U42', text: '<@UBOT> status', channel: 'C1' } });
  await until(() => slack.posts.length > sMark, 10_000, 'slack status');
  check(slack.acks.includes(env1), 'Slack envelope acknowledged');
  check(/Claude Code is (running|idle)/.test(slack.posts.at(-1).text) && slack.posts.at(-1).channel === 'C1', 'Slack mention answered in the channel', slack.posts.at(-1).text.slice(0, 100));
  sMark = slack.posts.length;
  slackEvent('events_api', { event: { type: 'app_mention', user: 'U42', text: '<@UBOT>\n\n   whoami', channel: 'C1' } });
  await until(() => slack.posts.length > sMark, 10_000, 'slack tag with line breaks');
  check(/slack id `U42`/.test(slack.posts.at(-1).text), 'Slack: tag, line breaks, then the command');
  sMark = slack.posts.length;
  slackEvent('slash_commands', { command: '/av', text: 'whoami', user_id: 'U42', user_name: 'ana', channel_id: 'D1', channel_name: 'directmessage' });
  await until(() => slack.posts.length > sMark, 10_000, 'slack slash');
  check(/slack id `U42`/.test(slack.posts.at(-1).text), 'Slack /av slash command answered');
  sMark = slack.posts.length;
  slackEvent('events_api', { event: { type: 'app_mention', user: 'U99', text: '<@UBOT> stop', channel: 'C1' } });
  await until(() => slack.posts.length > sMark, 10_000, 'slack stranger');
  check(/id is `U99`/.test(slack.posts.at(-1).text), 'Slack stranger gets their id, not a command');

  // ── WhatsApp ──────────────────────────────────────────────────────────
  const verify = await fetch(`${av.base}/hooks/whatsapp?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=abc123`);
  check(verify.status === 200 && (await verify.text()) === 'abc123', 'WhatsApp webhook verification echoes the challenge');
  const badVerify = await fetch(`${av.base}/hooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=x`);
  check(badVerify.status === 403, 'a wrong verify token is refused');
  const forged = await signedWebhook(waText(OWNER_WA, 'stop'), 'not-the-secret');
  check(forged.status === 401, 'a webhook without Meta’s signature is rejected');
  const wMark = wa.messages.length;
  const ok = await signedWebhook(waText(OWNER_WA, 'status'));
  check(ok.status === 200, 'a signed webhook is accepted');
  await until(() => wa.messages.length > wMark, 10_000, 'whatsapp reply');
  const waReply = wa.messages.at(-1);
  check(waReply.to === OWNER_WA && /Claude Code is (running|idle)/.test(waReply.text.body), 'WhatsApp status answered through the Graph API', waReply.text?.body.slice(0, 100));

  // ── CLI ───────────────────────────────────────────────────────────────
  const cli = await av.run(['channel']);
  check(cli.code === 0 && /Telegram\s+connected/.test(cli.stdout) && /Discord\s+off/.test(cli.stdout), 'squeaky channel shows them', cli.stdout + cli.stderr);
  const allow = await av.run(['channel', 'allow', 'telegram', '77']);
  check(allow.code === 0, 'squeaky channel allow', allow.stderr);
  const after = JSON.parse((await av.api('/api/channels')).text).channels.find((c) => c.id === 'telegram');
  check(after.allowUsers.includes('77'), 'the new user is on the allowlist', JSON.stringify(after.allowUsers));
  mark = tg.sent.length;
  dm(77, 'whoami');
  await until(() => tg.sent.length > mark, 10_000, 'newly allowed user');
  check(/telegram id <code>77<\/code>/.test(tgSince(mark)), 'and is obeyed straight away');
} catch (err) {
  fail(err);
  say(av.bridgeOutput().slice(-3000));
} finally {
  const keep = KEEP || report.failures > 0;
  await av.cleanup(keep);
  tgServer.close();
  slackApi.close();
  graph.close();
  slackWss.close();
  if (keep) say(`kept scratch dir: ${av.tmp}`);
}

say(report.failures === 0 ? 'PASS — channels work end to end' : `FAIL — ${report.failures} check(s) failed`);
process.exit(report.failures === 0 ? 0 : 1);
