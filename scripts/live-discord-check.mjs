#!/usr/bin/env node
/**
 * A live Discord check (docs/44) — the part CI cannot do: a real bot, a real
 * server, a real person talking in a voice channel.
 *
 * Boots a throwaway bridge (scripts/e2e-harness.mjs: the stub agent echoes
 * every turn, the stand-in Whisper and streaming voice answer speech) with
 * Discord enabled, prints the invite link for the bot, waits for it to come
 * online, then stays up while you try it:
 *
 *   @Squeaky help · sessions · voice default 1 · voice autojoin on · join
 *   …talk in the voice channel: each pause becomes a turn ("ECHO …" is spoken back)
 *
 * The token comes from the environment and is never printed:
 *   DISCORD_BOT_TOKEN=… [DISCORD_ALLOW=<your user id>] [DISCORD_AUTOJOIN=1]
 *     [DISCORD_MESSAGE_CHANNEL=<text channel id>] [DISCORD_VOICE_CHANNEL=<voice channel id>]
 *     [VOICE_WAKE=0|1] [VOICE_VAD=0|1] node scripts/live-discord-check.mjs
 * Calls listen by the voice-session settings the app uses (wake words, VAD) —
 * VOICE_WAKE / VOICE_VAD set them for this throwaway bridge.
 * Without DISCORD_ALLOW nobody is allowed yet — message the bot, it replies
 * with your id, and the script adds whoever it reports (watch the output).
 *
 * A stand-in app holds the control socket and prints every `channel_call`
 * frame the call mirrors to it ("app ◂ …") — what the phone would show and
 * which sound effects it would play.
 *
 * Ctrl-C stops it. Build first: npm run build:backend.
 */

import { join } from 'node:path';
import { WebSocket } from 'ws';
import { createInstance, makeReporter, ROOT } from './e2e-harness.mjs';

const token = (process.env.DISCORD_BOT_TOKEN ?? '').trim();
if (!token) {
  console.error('Set DISCORD_BOT_TOKEN (e.g. through ClaudeKeys).');
  process.exit(2);
}

// The token's first segment is the application id, base64-encoded.
const appId = Buffer.from(token.split('.')[0] ?? '', 'base64').toString('utf8');
// View Channels, Send Messages, Read Message History, Connect, Speak, plus
// Manage Channels and Manage Roles for the private voice room (`call`).
const PERMISSIONS = 1024 + 2048 + 65536 + 1048576 + 2097152 + 16 + 268435456;
const invite = `https://discord.com/oauth2/authorize?client_id=${appId}&scope=bot%20applications.commands&permissions=${PERMISSIONS}`;

const { say, check } = makeReporter();
const allow = (process.env.DISCORD_ALLOW ?? '').split(',').map((s) => s.trim()).filter(Boolean);

const av = await createInstance({
  bin: [process.execPath, join(ROOT, 'dist', 'cli.js')],
  canned: Array.from({ length: 20 }, (_, i) => `test phrase ${i + 1}`),
  ttsChunkDelayMs: 40,
  extraEnv: { DISCORD_BOT_TOKEN: token },
  configure(config) {
    const audio = config.settings.workflow.llmIntelligence.audio;
    audio.tts = { provider: 'local_speech', fallbacks: [], language: 'auto', models: {}, voices: {}, scopes: {} };
    if (process.env.VOICE_WAKE) config.settings.voice.wakeWordsEnabled = process.env.VOICE_WAKE === '1';
    if (process.env.VOICE_VAD) config.settings.voice.turnSubmit = { ...config.settings.voice.turnSubmit, vadEnabled: process.env.VOICE_VAD === '1' };
    config.settings.channels = {
      discord: {
        enabled: true,
        allowUsers: allow,
        voice: true,
        autoJoin: process.env.DISCORD_AUTOJOIN === '1',
        messageChannel: process.env.DISCORD_MESSAGE_CHANNEL || null,
        voiceChannel: process.env.DISCORD_VOICE_CHANNEL || null,
      },
    };
  },
});

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  say('stopping…');
  try {
    app.close(); // not open yet when the login itself failed
  } catch {}
  await av.cleanup(false);
  process.exit(0);
}
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());

await av.startBridge();
await av.api('/api/active-project', { project: 'e2e' });
await av.api('/api/voice-session/prepare', { project: 'e2e' });
// One turn up front, so there is a session to list, pin and continue.
await av.api('/api/turns', { text: 'start the Squeaky live check' });
say(`bridge up at ${av.base} (scratch home ${av.instance})`);
say(`invite the bot: ${invite}`);

let connected = false;
for (let i = 0; i < 60 && !connected; i++) {
  const discord = JSON.parse((await av.api('/api/channels')).text).channels.find((c) => c.id === 'discord');
  if (discord.state === 'connected') {
    connected = true;
    check(true, `Discord connected as ${discord.detail}`);
  } else if (discord.state === 'error') {
    check(false, 'Discord login', discord.detail);
    await stop();
  }
  await new Promise((r) => setTimeout(r, 1000));
}
if (!connected) {
  check(false, 'Discord did not connect within a minute');
  await stop();
}

say(allow.length ? `allowed: ${allow.join(', ')}` : 'nobody allowed yet — DM the bot "whoami"; ids it reports are allowed automatically');
say('try: help · sessions · voice here (from a voice channel) · channel here · call · type anything to talk to the agent · hangup');

// The app's side: everything the call mirrors to the phone.
const app = new WebSocket(`${av.base.replace(/^http/, 'ws')}/ws/control`);
app.on('open', () => app.send(JSON.stringify({ type: 'auth', token: av.token })));
app.on('message', (raw) => {
  const m = JSON.parse(String(raw));
  if (m.type === 'ping') app.send(JSON.stringify({ type: 'pong' }));
  if (m.type !== 'channel_call') return;
  const { type: _t, call: _c, source: _s, at: _a, event, ...rest } = m;
  say(`app ◂ ${event} ${Object.entries(rest).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ')}`);
});

// Follow the bridge log: who the bot refused (to allow them), calls, turns, replies.
const seen = new Set();
setInterval(async () => {
  const log = av.readNewest('bridge');
  for (const line of log.split('\n')) {
    if (seen.has(line)) continue;
    seen.add(line);
    const stranger = /channel message from a user not on the allowlist channel=discord userId=(\d+)/.exec(line);
    if (stranger && allow.length === 0) {
      allow.push(stranger[1]);
      await av.run(['channel', 'allow', 'discord', stranger[1]]);
      say(`allowed ${stranger[1]} — send your command again`);
    }
    if (/discord call joined|voice call (started|ended)|stream segment|agent_native turn delivered|speak called|tts streamed|call segment transcription failed|discord receive stream failed/.test(line)) {
      say(line.replace(/^\S+ (\S+) +\w+ +/, '$1 '));
    }
  }
}, 1000);
