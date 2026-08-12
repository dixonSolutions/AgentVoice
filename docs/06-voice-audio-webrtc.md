# 06 — Voice, Audio, STT & TTS

> Filename kept for link stability. WebRTC / speech-to-speech was removed; this doc
> covers the current cascade audio path.

## Overview

Both workflows (`cursor_native` and `llm_intelligence`) share the same PWA audio
pipeline. The phone handles capture and playback; the bridge handles turn routing
and (for `llm_intelligence`) Claude orchestration.

```
Mic → Vosk (wake/end) → STT (WebKit or Transcribe) → /ws/intelligence
                                                              │
Assistant audio ← WebKit TTS or Polly ← speak events ←────────┘
```

## Session class

`web/src/llm-intelligence-session.ts` — used for **both** workflows. Connects to
`/ws/intelligence`, manages wake word gating, VAD, STT buffering, and TTS playback.

Callback types: `web/src/voice-session-types.ts`.

## Wake words (Vosk)

- **Start phrase** (`settings.voice.wakeWords.start`) — activates utterance capture.
- **End phrase** (`settings.voice.wakeWords.end`) — optional submit when VAD is off.
- **Cancel phrase** — aborts capture only; after VAD/end-phrase (while Transcribe runs), use the red **Cancel** button — see [`27-touch-controls-and-cancel.md`](./27-touch-controls-and-cancel.md).
- Offline WASM grammar spotter — requires COOP/COEP headers (see `webDispatch.ts`).
- Configure in Config tab or `PATCH /api/voice/wake-words`. Set `wakeWordsEnabled: false` for touch-only.

## Turn submit

| Mode | Config | Behavior |
| --- | --- | --- |
| **Silero VAD** (default) | `turnSubmit.vadEnabled: true` | Detect speech end → submit |
| **End phrase** | `vadEnabled: false` | Vosk listens for end phrase |
| **Silence fallback** | `turnSubmit.silenceMs` | Auto-submit after N ms quiet |

## STT backends

| Backend | When used |
| --- | --- |
| **WebKit SpeechRecognition** | iPhone Safari / PWA (preferred) |
| **Amazon Transcribe** | Desktop fallback when WebKit unavailable |
| **Typed input** | Voice tab text field (dev / no mic) |

Transcribe: `POST /api/intelligence/transcribe` (bridge proxies with IAM keys).

## TTS backends

| Backend | When used |
| --- | --- |
| **WebKit speechSynthesis** | iPhone Safari tab (preferred) |
| **Amazon Polly** | iOS home-screen PWA, desktop fallback; also `llm_intelligence` transcript fallback |

Polly: `POST /api/intelligence/tts` (bridge proxies with IAM keys).

**iOS audio unlock:** Tap the orb runs `primeTtsPlaybackUnlock()` before any network
prep — resumes `AudioContext` and (on iOS) speaks a silent dummy utterance so later
`speak()` events from the WebSocket are not blocked by Safari autoplay policy.
Home-screen PWAs prefer Polly over WebKit TTS when AWS keys are configured.

## UI sound cues

`web/public/sounds/` — MP3 from [Kenney UI Audio](https://kenney.nl/assets/ui-audio) (CC0).
Regenerate: `bash scripts/prepare-voice-cues.sh`.

| Cue | File | Kenney source | When | Character |
| --- | --- | --- | --- | --- |
| **listening** | `listening.mp3` | `rollover4.wav` | Wake phrase (`onActivated`) | Short beep — mic open |
| **sent** | `sent.mp3` | `click3.wav` | Turn submitted (`onTurnSubmitted`) | Soft boop — message sent |
| **cancel** | `cancel.mp3` | `switch2.wav` | Cancel phrase (`onTurnCancelled`) | Toggle-off — turn discarded |
| **error** | `error.mp3` | Universfield (Pixabay) | TTS failure, disconnect, STT/turn errors | Error tone — pipeline failure |

Playback: `web/src/sound-effects.ts` via `playVoiceCueNow()` — fired in `llm-intelligence-session.ts` at Vosk/VAD recognition, **before** STT flush. Preload on orb tap. Error cue uses `LlmIntelligenceSession.notifyError()` / `VoiceSessionService.notifyVoiceError()`.

Configure error feedback under **Config → Voice → Cursor voice (TTS)**:
- `errorSoundEnabled` — play the error earcon (default on)
- `errorSpeakEnabled` — also speak the error message via TTS, independent of `cursorVoiceEnabled` (default on; turn off for sound-only alerts)

For **`cursor_native`**, primary TTS comes from MCP `speak()` events pushed over
`/ws/intelligence`. For **`llm_intelligence`**, orchestrator `speak` tool + optional
browser TTS fallback (`web/src/tts-fallback.ts`).

## TTS barge-in

User can say the wake phrase during assistant playback. The client **pauses TTS at full
volume** (never ducks), keeps the queue for cancel-resume, and on submit snapshots
`heard_complete` / `heard_partial` / `not_spoken` so Cursor knows what was heard.

Legacy `interruptMode` / `interruptDeafenFactor` config keys are stripped on load — volume
ducking is gone.

Set `settings.voice.tts.cursorVoiceEnabled: false` to disable MCP `speak()` playback entirely
(transcripts still appear in the UI).

Configure in Config tab → Voice & Wake Words, or `PATCH /api/voice/tts`.

### Wake-word echo
from the speaker. The client ignores that detection when the **current TTS line**
contains the wake phrase — barge-in stays enabled for real user interrupts.

Full flow, data shapes, and file map: [`17-tts-barge-in-and-wake-echo.md`](./17-tts-barge-in-and-wake-echo.md).

Types: `src/voice/ttsInterrupt.ts`, `web/src/tts-interrupt.ts`.

## Browser TTS options

When the WebKit `speechSynthesis` backend is active, each `SpeechSynthesisUtterance` supports:

| Property | Range | Default | Purpose |
| --- | --- | --- | --- |
| `voice` | system voices | — | Timbre / accent (selected by `voiceURI`) |
| `rate` | 0.1–10 (UI: 0.5–2) | `1.02` | Speaking speed |
| `pitch` | 0–2 | `1` | Tone |
| `volume` | 0–1 | `1` | Loudness |
| `lang` | BCP-47 | `en-US` | Language when no voice is set |

**Server defaults** live in `config.json` → `settings.voice.tts.webkit`.

**Per-device overrides** are stored in PWA `localStorage` (`web/src/browser-tts-settings.ts`)
keyed by browser + OS (e.g. `safari-ios`, `chrome-macos`). The Config tab lists all saved
profiles and lets you edit voice/rate/pitch/volume for the current browser.

Preview uses `speechSynthesis.speak()` directly from the Config tab (no bridge round-trip).

## WebSocket endpoints

| Path | Purpose |
| --- | --- |
| `/ws/intelligence` | Voice turns, speak events, tool activity, agent status |
| `/ws/control` | Legacy tool relay + narrator (worker jobs) |

## Mobile session keepalive

While a voice session is active on a phone, `web/src/session-keepalive.ts` keeps the app
in a foreground media session (Screen Wake Lock + silent looping audio + Media Session API).
If the OS suspends the intelligence WebSocket while backgrounded, the session auto-reconnects
when the user returns.

Limits and user guidance: [`19-mobile-session-keepalive.md`](./19-mobile-session-keepalive.md).

## Audio processing

`web/src/audio.ts` — mic capture, echo cancellation, noise gate.
`web/src/silero-vad.ts` — speech-end detection.
`web/src/voice-audio-meter.ts` — orb visualization levels.

## Related docs

- [`17-tts-barge-in-and-wake-echo.md`](./17-tts-barge-in-and-wake-echo.md) — barge-in snapshot + wake echo filter
- [`16-mcp-server-cursor-as-brain.md`](./16-mcp-server-cursor-as-brain.md) — Cursor voice loop
- [`15-llm-intelligence-workflow.md`](./15-llm-intelligence-workflow.md) — Bedrock orchestrator
- [`13-voice-providers.md`](./13-voice-providers.md) — wake word config
- [`27-touch-controls-and-cancel.md`](./27-touch-controls-and-cancel.md) — on-screen Speak / Cancel and cancel during Transcribe
- [`19-mobile-session-keepalive.md`](./19-mobile-session-keepalive.md) — mobile screen-off / reconnect
