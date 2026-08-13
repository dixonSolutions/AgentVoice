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
| **Screen Wake Lock** | Prevents auto-lock while session is active | **PWA only.** Native CallKit skips this so the display can sleep. |
| **Silent looping audio** | Signals an active media session to the OS | **PWA only.** Helps when display dims on iOS Safari. Native CallKit already holds an audio session. |
| **Media Session API** | Lock-screen / Control Center metadata | Shows “AgentVoice — listening” |

On `visibilitychange` (user returns to the app):

- Wake lock and silent audio are re-acquired **on PWA**
- Orb FFT / canvas animation pause while hidden (native and PWA)
- If the intelligence WebSocket dropped while backgrounded, the session **auto-reconnects**
  (orb tap not required)

## Battery: why this is not a cellular voice call

A carrier phone call is handled by the baseband + dedicated audio DSP. The screen
turns off; the CPU mostly sleeps.

AgentVoice is a **WebView + always-on microphone + on-device wake-word model
(Vosk WASM)**. That keeps the CPU, GPU (orb), radio (WebSocket), and — on Safari
PWA — the **display** awake. Display is typically the largest iPhone battery
cost.

| Path | Screen | What stays running |
| --- | --- | --- |
| **Safari / home-screen PWA** | Held on (Wake Lock) | Required — iOS kills the tab if the screen locks |
| **Native TestFlight app (CallKit)** | **May lock** | Mic + Vosk wake word + CallKit audio session |

**Dad should use the native app and lock the phone** (or let Auto-Lock fire)
after tapping the orb. Hang up when finished. Mute if you are not speaking and
do not need wake words.

## What this fixes vs. what it does not

| Scenario | Fixed? |
| --- | --- |
| Screen auto-off while **PWA** stays foreground | **Usually yes** (Wake Lock + media keepalive) — battery cost is the screen |
| Screen auto-off while **native CallKit** session is up | **Yes** — lock the phone; the green call bar stays |
| User switches to another app (PWA) | **No** — iOS freezes JS after ~5 s; mic stops |
| True background voice like a phone call | **Native app only** (CallKit) — still more CPU than a cellular call because of Vosk |

## User guidance

The Voice tab shows while connected:

- **PWA:** “Keep this app open — voice pauses if you switch apps. Screen stays on while connected.”
- **Native app:** “You can lock the screen — the call stays active and uses less battery.”

Recommend **Settings → Display → Auto-Lock → 5 minutes** (or Never during PWA
voice use) as a backup if Wake Lock is denied. On the native app, a short
Auto-Lock is better for battery.

## Implementation map

| File | Role |
| --- | --- |
| `web/src/session-keepalive.ts` | Wake Lock, silent audio, Media Session |
| `web/src/app/services/voice-session.service.ts` | Start/stop keepalive; auto-resume on visibility |
| `web/src/app/components/voice-tab/*` | Live-session hint in UI |

## Related

- [`06-voice-audio-webrtc.md`](./06-voice-audio-webrtc.md) — voice pipeline overview
- [`08-decisions-and-risks.md`](./08-decisions-and-risks.md) — R-8 iOS background limits
