# 13 — Voice Settings & AWS Audio

How AgentVoice configures wake words, turn submit timing, and AWS services for
STT/TTS fallback and the `llm_intelligence` orchestrator.

## config.json — voice settings

```json
{
  "settings": {
    "voice": {
      "wakeWords": {
        "start": "cursor listen",
        "end": "cursor send",
        "cancel": "cancel",
        "wakeConfidenceThreshold": 0.45
      },
      "turnSubmit": {
        "silenceMs": 1500,
        "vadEnabled": true
      },
      "tts": {
        "agentVoiceEnabled": true,
        "errorSoundEnabled": true,
        "errorSpeakEnabled": true,
        "webkit": {
          "rate": 1.02,
          "pitch": 1,
          "volume": 1,
          "lang": "en-US"
        }
      },
      "touchControls": "when_muted",
      "wakeWordsEnabled": true,
      "defaultMicMuted": false,
      "workerPollTimeoutMs": 25000
    }
  }
}
```

| Field | Purpose |
| --- | --- |
| `wakeWords.start` | Activation phrase (Vosk offline detection) |
| `wakeWords.end` | Submit phrase when VAD is disabled |
| `wakeWords.cancel` | Abort phrase during capture (no turn sent) |
| `wakeWords.wakeConfidenceThreshold` | Minimum mean Vosk word confidence (0–1) to accept the wake phrase; below 0.55 also enables partial recognition |
| `turnSubmit.silenceMs` | Silence before auto-submit (500–30000 ms) |
| `turnSubmit.vadEnabled` | Use Silero VAD for speech-end detection |
| `tts.agentVoiceEnabled` | Play MCP `speak()` lines aloud |
| `tts.errorSoundEnabled` | Play error earcon on voice pipeline failures |
| `tts.errorSpeakEnabled` | Speak error messages aloud |
| `tts.webkit.*` | Default browser TTS rate/pitch/volume/lang |
| `touchControls` | On-screen Speak / Cancel visibility: `off` \| `when_muted` (default) \| `always` |
| `wakeWordsEnabled` | When false, skip Vosk start/end/cancel — use on-screen Speak |
| `defaultMicMuted` | Start each voice session muted |
| `workerPollTimeoutMs` | Worker narration poll interval |

Managed via Config tab or API:

- `GET /api/voice/providers` — returns `{ wakeWords, turnSubmit, tts, touchControls, wakeWordsEnabled, defaultMicMuted, userName? }`
- `PATCH /api/voice/wake-words` — update wake words and turn submit
- `PATCH /api/voice/tts` — update cursor voice on/off, error feedback, WebKit defaults
- `PATCH /api/voice/ui` — update `touchControls` / `wakeWordsEnabled` / `defaultMicMuted` / `touchOnlyPreset`
- `PATCH /api/voice/user-name` — optional name the agent uses for the user

On-screen controls and cancel-while-processing: [`27-touch-controls-and-cancel.md`](./27-touch-controls-and-cancel.md).

Per-browser TTS voice selection is stored in PWA localStorage (not `config.json`).
See [`06-voice-audio-webrtc.md`](./06-voice-audio-webrtc.md#browser-tts-options).

Implementation: `src/voice/voiceSettingsRegistry.ts`.

## AWS IAM keys (`.env`)

Used for **Amazon Polly** (TTS), **Amazon Transcribe** (STT), and **Bedrock Converse**
(Claude for `llm_intelligence`). **Not** used for speech-to-speech models (removed).

| Env var | Required | Purpose |
| --- | --- | --- |
| `AWS_ACCESS_KEY_ID` | Yes (for AWS features) | IAM access key (AKIA…) |
| `AWS_SECRET_ACCESS_KEY` | Yes | IAM secret |
| `AWS_REGION` | Optional | Defaults to `us-east-1` / llm region |
| `AWS_BEARER_TOKEN_BEDROCK` | Optional | Text-only Bedrock API key — **not** valid for Polly/Transcribe |

Validation: `src/intelligence/aws/credentials.ts` — rejects Bedrock API key IDs for
audio services.

## Audio API routes

| Route | Service |
| --- | --- |
| `POST /api/intelligence/tts` | Amazon Polly → MP3 |
| `POST /api/intelligence/transcribe` | Amazon Transcribe streaming |

Client modules: `web/src/amazon-tts.ts`, `web/src/amazon-stt.ts`.

## Workflow selection

Set in `config.json`:

```json
"workflow": {
  "default": "agent_native",
  "llmIntelligence": { ... }
}
```

| Workflow | AWS usage |
| --- | --- |
| `agent_native` | Polly/Transcribe per `ttsProvider` / STT preference |
| `llm_intelligence` | Bedrock Converse + Polly/Transcribe per audio settings |

### Speech output (`settings.workflow.llmIntelligence.audio`)

| Field | Values | Meaning |
| --- | --- | --- |
| `ttsProvider` | `browser` \| `amazon_polly` | Default TTS backend (Config → Voice → Speech output) |
| `pollyVoiceId` / `pollyEngine` | e.g. `Joanna` / `neural` | Used when provider is Polly |
| `preferWebkit` | boolean | Prefer browser **STT** when available |

Browser voices are listed from the device `speechSynthesis.getVoices()` API (not a hard-coded browser list). Polly voices come from `GET /api/intelligence/polly-voices` (`DescribeVoices`).

### Speech input — Amazon Transcribe SFM

Amazon **Transcribe** (not Bedrock) provides real-time STT. The Speech Foundation Model
powers `StartStreamTranscription` with no separate ModelId.

| Field | Default | Notes |
| --- | --- | --- |
| `transcribeModel` | `speech_foundation_model` | Only premier option exposed |
| `transcribeLanguageMode` | `fixed` | `identify` is ~3× slower in voice tests |
| `transcribeLanguageCode` | `en-US` | Used in fixed mode |
| `transcribePartialResultsStabilization` | `true` | Lower streaming latency |
| `transcribePartialResultsStability` | `high` | Best latency for voice turns |

Catalog: `GET /api/intelligence/transcribe-models`. Medical / Call Analytics / Bedrock Whisper
Marketplace are intentionally not offered for interactive voice.

## Security

- `.env` is chmod 600, never committed, never returned by API.
- Wake word updates require app token (`/api/voice/wake-words`).
- Polly/Transcribe routes require app token.

## Related docs

- [`06-voice-audio-webrtc.md`](./06-voice-audio-webrtc.md) — STT/TTS pipeline
- [`15-llm-intelligence-workflow.md`](./15-llm-intelligence-workflow.md) — Bedrock orchestrator config
