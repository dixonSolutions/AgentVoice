# 41 — Direct Audio Stream Pipe

> Added: September 2026

Until now every word reached the agent as a **turn**: wake phrase → speech →
VAD (or the end phrase) decides you are done → one transcript → one
`next_voice_turn()`. That is still the default, and still the recommendation.

This adds a second input mode, the **direct audio stream**. The mic is piped to
the bridge continuously; the bridge cuts it at your natural pauses, transcribes
each piece, and hands every transcript to the agent the moment it lands. It is
also the first way to talk to the agent from something that is not the phone:

```bash
arecord -f S16_LE -r 16000 -c 1 -t raw | agentvoice pipe   # anything that emits PCM
agentvoice pipe --mic                                    # the default microphone
agentvoice pipe --file question.wav                      # a recording
```

## Turns or stream?

| | **Turns** (recommended) | **Direct stream** |
| --- | --- | --- |
| Starts listening | wake phrase / Speak button | as soon as the session opens |
| Ends an utterance | Silero VAD, end phrase, or silence timer | any pause ≥ `segmentSilenceMs` |
| What the agent receives | one whole request | pieces, as you speak them |
| Latency to first word | after you stop talking | after your first pause |
| Where STT runs | phone (browser) or bridge | bridge only |
| Works from a terminal | no | yes — `agentvoice pipe` |

Turns are recommended because the agent always acts on a complete request. In
stream mode a thought spoken with a pause in the middle arrives as two turns,
and the agent has to decide whether it has heard all of it — it usually does
the right thing (see *How the agent copes*), but "open the config… and delete
the cache" can get the first half acted on before the second half lands.
Use the stream when hands-free, lower latency, or a non-phone source matters
more than that.

## Using it

**Phone / PWA:** Config → Listening & controls → **Input mode** → *Direct stream*,
save, and restart the session. Speech-to-text must be a **server** provider
(Config → Speech) — the browser's recogniser cannot transcribe a raw stream. If
none is configured, the session says so and falls back to turns. While the
agent is speaking, sending pauses (so it never hears itself), and the segment in
progress is cut at that moment. Mute stops the stream; Speak just unmutes.
Hanging up sends `end` and waits for `drained`, so a phrase spoken right before
the orb is tapped is still transcribed and delivered rather than dropped.

**Terminal:** `agentvoice pipe` reads stdin, `--mic`, or `--file`
(`npm run cli -- pipe` in a clone). It finds the bridge the same way
`agentvoice status` does — the home from `$AGENTVOICE_HOME`, the current
directory or `~/.agentvoice`, then whichever configured port answers — and
authenticates with the `APP_TOKEN` in that home's `.env`. `--url` / `--token`
point it at a remote bridge:

```bash
agentvoice pipe --mic --url https://box.tailnet.ts.net --token "$APP_TOKEN"
```

WAV input of any rate/channel count is converted on the client (16-bit PCM or
32-bit float); raw stdin is taken as 16 kHz mono PCM16 unless `--rate` /
`--channels` say otherwise; other formats go through `ffmpeg`. `--mic` uses the
first recorder it finds: `pw-record`, `parec`, `arecord`, `sox`, `ffmpeg`.

The conversation goes to stdout (`you ▸ …` / `agent ◂ …`), diagnostics to
stderr, so `agentvoice pipe --mic > session.txt` keeps just the dialogue.
`--json` prints every bridge event as NDJSON instead. The pipe registers as a
voice client **and as a listener** (presence kind `audio_pipe`, docs/36), so the
agent's `speak()` / `next_voice_turn()` work with no phone connected and the
away policies see someone there; `--no-listen` sends audio only. After input
ends it waits up to `--linger` seconds (default 30) for the agent to finish
replying. Exit codes: 0 done, 1 bridge unreachable / no token, 2 usage,
3 stream refused, 4 wrong token, 5 connection lost.

## How it works

```
mic / stdin / file
   │ PCM16LE 16 kHz mono, any chunk size
   ▼
/ws/audio-stream ── PcmSegmenter (20 ms RMS frames) ── AudioStreamPipe
                        │ segment at each pause           │ transcribe in order,
                        ▼                                 ▼ merge backlog
                    speech-to-text chain (docs/29) → submitAgentNativeTurn(…, 'stream')
                                                          │
                          no agent running → spawn with this text as the prompt
                          agent running   → voiceTurnQueue (source: "stream")
```

- **Segmentation** (`src/voice/audioStream/segmenter.ts`) is an energy gate over
  20 ms frames: a segment opens on the first frame above `speechThreshold`,
  keeps `preRollMs` of audio before it so first syllables survive, and closes
  after `segmentSilenceMs` of quiet or at `maxSegmentMs`. Segments with less
  than `minSpeechMs` of speech (coughs, clicks) are dropped. It is driven by
  sample counts, never wall-clock time, so a file pushed at full speed
  segments exactly like the same audio spoken live.
- **Transcription** (`src/voice/audioStream/pipe.ts`) runs one request at a time
  so transcripts reach the agent in speaking order whatever each call's
  latency. If the engine falls behind, the waiting segments are merged into one
  request rather than queueing without bound.
- **Delivery** goes through the same `submitAgentNativeTurn()` as a phone, desk
  or REST turn (`src/executor/agentTurns.ts`) with `source: "stream"`: the
  first segment spawns the agent, later ones are queued, and each is recorded
  in the turn history and the session transcript. Consecutive streamed segments the agent has not
  collected yet are handed over **merged** by the next `next_voice_turn()`, so a
  busy agent gets everything said since it last listened in one go.

### How the agent copes

Streamed turns come back from `next_voice_turn()` with `source: "stream"`,
`segments` (how many were merged) and a `stream_hint`. The MCP instructions tell
the agent that such a turn may be half a thought: if it reads as unfinished,
call `next_voice_turn(timeout_ms=2500)` to collect the rest before acting;
otherwise handle it normally. Turn-based input never carries these fields.

A segment that arrives while the agent is inside another AgentVoice tool is
delivered through that tool's result instead (docs/16 § 8.4) — with the same
three fields, so a pause-cut fragment never reads as a finished request.

## Settings

`settings.voice` in `config.json` (also Config → Listening & controls):

| Key | Default | Meaning |
| --- | --- | --- |
| `inputMode` | `"turns"` | `"turns"` or `"stream"` — what the phone does |
| `stream.segmentSilenceMs` | `700` | pause that ends a segment |
| `stream.maxSegmentMs` | `15000` | longest segment before a forced cut |
| `stream.minSpeechMs` | `300` | shorter bursts of sound are dropped |
| `stream.speechThreshold` | `0.012` | RMS (0–1 of full scale) that counts as speech |
| `stream.preRollMs` | `300` | audio kept from before the first loud frame |

`agentvoice pipe --silence / --max-segment / --threshold` override these for
one pipe. Raise the threshold if background noise keeps segments open; lower it
if quiet speech is missed.

API: `PATCH /api/voice/input { inputMode?, stream? }`.

## Protocol — `/ws/audio-stream`

Text frames are JSON; audio frames are binary PCM16LE mono at 16 kHz.

| Direction | Message |
| --- | --- |
| client → | `{ type: "auth", token }` — first frame, always |
| client → | `{ type: "start", sampleRate: 16000, encoding: "pcm_s16le", channels: 1, client?: "cli" \| "pwa", name?, listen?, segment? }` |
| client → | binary audio, any chunk size (≤ 256 KB per frame) |
| client → | `{ type: "flush" }` — cut the current segment now |
| client → | `{ type: "end" }` — no more audio; finish transcribing |
| bridge → | `{ type: "auth_ok" }`, then `{ type: "ready", segment, stt, listening }` |
| bridge → | `{ type: "segment", index, text, audio_ms, latency_ms, delivered, delivery }` — `delivery` is `spawn`, `waiter`, `queued` or `tool_interrupt`; undelivered segments carry `reason` + `message` |
| bridge → | `{ type: "segment_empty", index, audio_ms }` |
| bridge → | `{ type: "drained", stats }` — after `end`, once every segment is done |
| bridge → | `{ type: "error", message, fatal? }` |
| bridge → | with `listen`: the voice-session events the phone's `/ws` socket gets (`speak`, `thinking`, `turn_complete`, `voice_agent_status`) |

The stream is refused (fatal error, socket closed) unless the workflow is
`agent_native` and a server speech-to-text provider is configured.

## Limits

- `agent_native` only. `llm_intelligence` keeps turns.
- Energy-based segmentation: a noisy room needs a higher threshold, and there is
  no barge-in while the agent speaks on the phone — sending simply pauses.
- Every segment is a separate transcription request, which costs more on
  per-request-priced providers than one request per turn.

## Testing

- Unit: `src/voice/audioStream/*.test.ts`, `src/mcp/server/turnQueue.test.ts`,
  `src/cli/audioInput.test.ts` (`npm test`).
- Unit: `src/state/presence.test.ts` covers the `audio_pipe` listener.
- End to end: `node scripts/live-pipe-test.mjs` drives `agentvoice run / pipe /
  logs` against a stand-in Whisper server and the stub agent, and checks
  delivery, replies, transcripts and log files. `scripts/live-pwa-stream-test.mjs`
  does the same through the real PWA in headless Chromium with a fake
  microphone, switching the input mode through the Config screen first.
  `.github/workflows/test.yml` runs both on every PR.
