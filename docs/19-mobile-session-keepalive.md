# 19 — Mobile session keepalive

Keeps an active voice session alive on phones when the display would otherwise auto-lock.

## Problem

Mobile browsers suspend foreground tabs when:

- The screen auto-locks (display timeout)
- The user switches to another app

That closes WebSockets, stops the microphone, and tears down the voice session. A web PWA
**cannot** register as a real phone call (CallKit / VoIP) — that requires a native app.

## Solution (web stack)

While `VoiceSessionService` has a live session, `web/src/session-keepalive.ts` runs three
complementary mechanisms:

| Mechanism | Purpose | Platform notes |
| --- | --- | --- |
| **Screen Wake Lock** | Prevents auto-lock while session is active | Android Chrome, iOS Safari 16.4+ |
| **Silent looping audio** | Signals an active media session to the OS | Helps when display dims on iOS |
| **Media Session API** | Lock-screen / Control Center metadata | Shows “AgentVoice — listening” |

On `visibilitychange` (user returns to the app):

- Wake lock and silent audio are re-acquired
- If the intelligence WebSocket dropped while backgrounded, the session **auto-reconnects**
  (orb tap not required)

## What this fixes vs. what it does not

| Scenario | Fixed? |
| --- | --- |
| Screen auto-off while app stays foreground | **Usually yes** (Wake Lock + media keepalive) |
| User switches to another app | **No** — iOS freezes JS after ~5 s; mic stops |
| True background voice like a phone call | **No** — needs native app + CallKit |

## User guidance

The Voice tab shows while connected:

> Keep this app open — voice pauses if you switch apps. Screen stays on while connected.

Recommend **Settings → Display → Auto-Lock → 5 minutes** (or Never during voice use) as a
backup if Wake Lock is denied.

## Implementation map

| File | Role |
| --- | --- |
| `web/src/session-keepalive.ts` | Wake Lock, silent audio, Media Session |
| `web/src/app/services/voice-session.service.ts` | Start/stop keepalive; auto-resume on visibility |
| `web/src/app/components/voice-tab/*` | Live-session hint in UI |

## Related

- [`06-voice-audio-webrtc.md`](./06-voice-audio-webrtc.md) — voice pipeline overview
- [`08-decisions-and-risks.md`](./08-decisions-and-risks.md) — R-8 iOS background limits
