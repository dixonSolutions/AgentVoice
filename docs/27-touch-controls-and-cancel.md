# 27 — On-screen touch controls & cancel-while-processing

Hands-free wake words remain the primary path. On-screen **Speak** / **Cancel**
and a mid-bottom red **Cancel** during processing cover mute, silent rooms, and
the window where spoken cancel cannot work.

See also: [`13-voice-providers.md`](./13-voice-providers.md),
[`06-voice-audio-webrtc.md`](./06-voice-audio-webrtc.md),
[`17-tts-barge-in-and-wake-echo.md`](./17-tts-barge-in-and-wake-echo.md).

## Why default is `when_muted`

AgentVoice is designed for eyes-free use. Showing Speak / Cancel **always**
clutters the live orb stage and pulls attention to the screen. **Touch-only**
as a default would disable wake words for everyone.

**When muted** matches phone-call UX (Jakob’s Law):

| Mic | Behavior |
| --- | --- |
| Unmuted | Wake words (if enabled) |
| Muted | On-screen Speak / Cancel appear |

Users who want always-on buttons or no wake words opt in under
**Config → Voice & Controls → On-screen controls**.

## Visibility matrix

| Control | When shown |
| --- | --- |
| **Speak** | `touchControls` is `always`, or `when_muted` while mic muted; session live; not capturing / not submitting |
| **Cancel** (capture) | Same touch-controls rule, while capturing (`voiceActivated`) |
| **Cancel** (processing, red mid-bottom) | **Always** while `submittingTurn` (VAD/end-phrase → Transcribe) — **not** gated by `touchControls` |

```
  [idle / ready]
       │ wake phrase OR Speak
       ▼
  [capturing] ── Cancel (spoken or button) ──► discard, back to idle
       │ VAD / end phrase
       ▼
  [submitting / Transcribing…] ── red Cancel ──► abort flush, discard
       │ success
       ▼
  [agent turn]
```

## Spoken cancel limits

| Phase | Say cancel? | UI Cancel? |
| --- | --- | --- |
| Preparing / connecting | — | Tap orb hangs up |
| Capturing | Yes (Vosk cancel phrase) | Yes (if touch bar visible) |
| Submitting / Transcribing | **No** — `voiceActivated` is already false | **Yes** — red button always |
| Live idle | — | Hang up via orb |

## Settings (`settings.voice`)

| Field | Values | Default |
| --- | --- | --- |
| `touchControls` | `off` \| `when_muted` \| `always` | `when_muted` |
| `wakeWordsEnabled` | boolean | `true` |
| `defaultMicMuted` | boolean | `false` |

**Touch-only preset** (Config button): sets `touchControls=always` and
`wakeWordsEnabled=false`.

API:

- `GET /api/voice/providers` — includes the three fields
- `PATCH /api/voice/ui` — `{ touchControls?, wakeWordsEnabled?, defaultMicMuted?, touchOnlyPreset? }`

Auth WebSocket `auth_ok` includes `wakeWordsEnabled` so the PWA session skips
Vosk start/end/cancel spotters when false.

## Placement (Cancel processing)

```
┌─────────────────────────┐
│         Orb             │
│       Mute button       │
│   Speak / Cancel bar    │
│                         │
│      (  Cancel  )       │  ← small rounded red, center bottom
└─────────────────────────┘
```

## Mute defaults

- `defaultMicMuted` applies when a session **starts** (if no device preference)
- Mute / unmute taps persist in PWA `localStorage` (`cv_mic_muted_pref`) and win on the next start
- Session hang-up clears the live mute signal; the next start reloads pref / config default
- **Speak** while muted unmutes, then enters capture (and updates the stored pref)

## Testing checklist

- [ ] During “Transcribing…”, red Cancel discards the turn (no agent kickoff)
- [ ] Mute → Speak / Cancel appear (`when_muted`); unmute → hide
- [ ] Touch-only preset: wake off, Speak works without phrase
- [ ] Spoken cancel still works during capture when wake words on
- [ ] Config → Connection shows `vX.Y.Z · <sha>` matching `/healthz`

## Code

| Area | Path |
| --- | --- |
| Schema | `src/config.ts` (`VoiceSettingsSchema`) |
| Registry / PATCH | `src/voice/voiceSettingsRegistry.ts`, `src/routes/voiceProviders.ts` |
| Session cancel / Speak | `web/src/llm-intelligence-session.ts` |
| Transcribe abort | `web/src/amazon-stt.ts` (`cancelPendingFlush`) |
| UI | `web/src/app/components/voice-tab/*` |
| Config fieldset | `web/src/app/components/config-tab/*` |
