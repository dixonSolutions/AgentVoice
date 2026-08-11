# AgentVoice — Native mobile shell

Capacitor wrapper for **CallKit** (iOS) and foreground call notification (Android).

The Angular PWA in `web/dist` is loaded inside the native WebView. Voice session
start/end is bridged to CallKit so iOS keeps the session alive when the screen locks.

## Prerequisites

- macOS + Xcode 15+ (iOS builds)
- Apple Developer account (TestFlight)
- Bridge hosted on Tailscale (see root README)

## Quick start

```bash
# From repo root
npm run build:web
cd mobile
npm install --legacy-peer-deps
npx cap sync ios    # or android
npx cap open ios
```

In Xcode: configure signing, enable Background Modes (Audio, VoIP), run on device.

## Push

Configure bridge `.env` with VAPID (PWA) and/or APNS keys (native). See
[`docs/20-native-callkit-shell.md`](../docs/20-native-callkit-shell.md).

## Plugin

`plugins/call-session` — Capacitor plugin registered as `CallSession`:

- `startCall()` / `endCall()` — wired from `VoiceSessionService`
- `voipToken` event — PushKit token sent to bridge for incoming approval calls
