# 20 — Native shell (CallKit) and push notifications

AgentVoice on iPhone needs a **native Capacitor app** for iOS to treat an active
voice session as a **phone call** (CallKit). The PWA alone cannot do this.

Push notifications reach your dad when the app is closed or backgrounded — for
agent approvals, job completion, and image carousels.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Native app (Capacitor)                                      │
│  ├─ CallKit outbound call on orb tap → screen lock OK        │
│  ├─ PushKit VoIP → incoming call when agent needs approval  │
│  └─ WebView loads same Angular app from web/dist            │
└───────────────────────────┬─────────────────────────────────┘
                            │ HTTPS (Tailscale)
                            ▼
┌─────────────────────────────────────────────────────────────┐
│  Bridge (Node)                                               │
│  ├─ notifyPhone() → WebSocket + Web Push + APNs             │
│  ├─ GET /api/pending-approvals (reconnect)                  │
│  └─ Cursor agent keeps running when phone disconnects       │
└─────────────────────────────────────────────────────────────┘
```

## CallKit (iOS)

| Event | Native behaviour |
| --- | --- |
| Orb tap / start session | `CXStartCallAction` — outbound call to "AgentVoice" |
| Hang up | `CXEndCallAction` |
| Screen lock / switch apps | Call stays active (green bar) while call is up |
| Force-quit app | Call ends — session stops |

Implementation: `mobile/plugins/call-session/ios/Sources/CallSessionPlugin/`

JS bridge: `web/src/native/call-session.ts` → `CallSession.startCall()` / `endCall()`

### Android

Foreground notification with `CATEGORY_CALL` while session is active
(`CallSessionPlugin.java`).

## Push notifications

| Channel | When | Setup |
| --- | --- | --- |
| **Web Push (VAPID)** | PWA in Safari / installed PWA | `WEB_PUSH_VAPID_*` in `.env` |
| **APNs alert** | Native app background | `APNS_*` in `.env` |
| **APNs VoIP (PushKit)** | Incoming CallKit ring for approvals | Same `.p8` key; `ios_voip` token |

### Events that push

| Payload type | Notification |
| --- | --- |
| `user_input_request` | Always (blocks agent until answered) |
| `plan_approval_request` | Always |
| `narration` (`job_done`, `job_error`) | When WebSocket not connected |
| `show_images` | When WebSocket not connected |

Service worker: `web/public/sw.js` (push + notificationclick).

## Setup — Web Push (PWA, quick win)

1. On the bridge host:
   ```bash
   bash scripts/gen-vapid-keys.sh
   ```
2. Add keys to `.env`:
   ```
   WEB_PUSH_VAPID_PUBLIC_KEY=...
   WEB_PUSH_VAPID_PRIVATE_KEY=...
   WEB_PUSH_VAPID_SUBJECT=mailto:you@example.com
   ```
3. Restart bridge: `bash scripts/restart.sh`
4. On iPhone: install PWA to home screen → open app → allow notifications when prompted.

## Setup — Native iOS app (CallKit)

Requires **macOS + Xcode** and Apple Developer account ($99/yr).

1. Build web assets:
   ```bash
   npm run build:web
   ```
2. Install mobile deps and sync:
   ```bash
   cd mobile && npm install --legacy-peer-deps && npx cap sync ios
   ```
3. Open Xcode: `npx cap open ios`
4. In Xcode → Signing & Capabilities, add:
   - **Background Modes**: Audio, Voice over IP
   - **Push Notifications**
5. Set bundle ID `com.cursorvoice.app` (unchanged by the rename — kept for APNs device-token continuity; match `APNS_BUNDLE_ID`).
6. Create APNs Auth Key (.p8) in Apple Developer → Keys; add to `.env`:
   ```
   APNS_KEY_ID=...
   APNS_TEAM_ID=...
   APNS_KEY_PATH=./AuthKey_XXXX.p8
   APNS_BUNDLE_ID=com.cursorvoice.app
   APNS_PRODUCTION=false
   ```
7. Archive → TestFlight → install on dad's iPhone.

**Dad uses the TestFlight/native app icon**, not the Safari PWA, for voice.

## Dad's workflow (native app)

1. Open **AgentVoice** (native app).
2. Tap orb → iOS shows active call → speak command.
3. **Lock the phone** (or let Auto-Lock fire) — the green call bar stays; the screen
   sleeping is what keeps battery reasonable. Using other apps is OK while the call is up.
4. Agent needs approval while app closed → **incoming call** or notification → tap → approve.
5. Job finishes → notification if he's away.
6. **Hang up** (tap the orb) when you are done — leaving a live session runs the mic and
   wake-word model continuously.

A carrier voice call is cheap because the phone's radio/DSP do the work. AgentVoice is
still a live WebView listening for a wake phrase, so it will never match Phone.app
battery life — but holding the **display on** was the avoidable part.

## File map

| Path | Role |
| --- | --- |
| `mobile/` | Capacitor project |
| `mobile/plugins/call-session/` | CallKit + Android foreground plugin |
| `src/push/notifyPhone.ts` | WS + push fan-out |
| `src/routes/push.ts` | Subscribe / config API |
| `web/src/native/push-registration.ts` | Client registration |
| `web/src/app/services/push.service.ts` | Angular integration |

## Related

- [`19-mobile-session-keepalive.md`](./19-mobile-session-keepalive.md) — PWA Wake Lock (supplement, not replacement)
- [`07-data-and-deployment.md`](./07-data-and-deployment.md) — Tailscale hosting
