# 30 — Speech Output Providers and Capability-Aware Fallback

> Added: August 2026

Text-to-speech used to be a two-value choice: the device's `speechSynthesis`,
or Amazon Polly. That is fine until the agent has to answer in a language the
device has no voice for — Safari ships `en-*` and little else, so a Polish reply
comes out as Polish words in English phonemes, or as silence.

Speech output now has the same provider layer as speech input
([docs/29](./29-speech-to-text-providers.md)), built on the shared orchestration
core ([docs/31](./31-service-orchestrator-converter.md)).

## Providers

| Provider | id | Key | Approx. $/M chars | Notes |
| --- | --- | --- | --- | --- |
| Browser | `browser` | — | free | The device's own voices. Instant and free; coverage depends entirely on the device |
| Self-hosted | `local_speech` | — | free | Kokoro or Piper, in the same container as self-hosted Whisper. Nothing leaves the host |
| ElevenLabs | `elevenlabs` | `ELEVENLABS_API_KEY` | ~$150 | The most natural voices, one identity across 32 languages |
| OpenAI | `openai` | `OPENAI_API_KEY` | ~$12 | Steerable — `gpt-4o-mini-tts` takes a plain-English delivery instruction |
| Gemini | `gemini` | `GEMINI_API_KEY` | ~$10 | Prompt-steered, 24 languages, returns raw PCM that the decoder wraps in WAV |
| Deepgram | `deepgram` | `DEEPGRAM_API_KEY` | ~$30 | Aura-2 — the fastest first syllable. English-first |
| Groq | `groq` | `GROQ_API_KEY` | ~$50 | PlayAI on LPUs. Very fast, but English or Arabic only |
| Amazon Polly | `amazon_polly` | AWS IAM keys | ~$16 | The previous default; voices are language-bound |

Prices are list rates at the time of writing, shown in the picker to make the
trade-off visible rather than as a billing guarantee.

## The fallback chain

Both directions are `provider` plus an ordered `fallbacks` list. The
orchestrator tries each in turn, skipping any that is unconfigured, unreachable,
or cannot handle the language. `browser` is an ordinary chain entry with no
bridge-side implementation, so "device first, ElevenLabs when it cannot cope"
is just:

```jsonc
"tts": { "provider": "browser", "fallbacks": ["elevenlabs", "amazon_polly"] }
```

The phone receives the resolved chain over `/ws/intelligence` and walks it
itself, because only the device can answer "do *I* have a voice for this?".
Everything below `browser` is decided on the bridge.

## Language capability, at three levels

This is the part that needed real care, because getting it wrong produces
confident mispronunciation rather than an error.

- **Provider** — Deepgram Aura is English and Spanish; Gemini does 24 languages.
- **Model** — Groq's `playai-tts` is English, `playai-tts-arabic` is Arabic.
- **Voice** — a Kokoro `ff_` voice is French no matter what the model supports.

`accepts()` checks all three, but with one deliberate exception: when the
provider *can* speak the language and some other voice of its own would do, it
is still accepted, because Polly and Groq swap the voice themselves. Skipping
them would be wrong. The config screen says so explicitly rather than letting
the swap happen invisibly:

> "Joanna" does not speak pl — Amazon Polly will use one of its other voices for those replies.

Whether the device can speak a language is answered at runtime from
`speechSynthesis.getVoices()` (`hasBrowserVoiceForLanguage`), not from a static
table, since it differs per browser and per OS install.

`tts.language: "auto"` follows the speech-input language, so talking to it in
one language gets a reply in the same one without configuring it twice.

## Which engine actually spoke

`/api/intelligence/tts` returns `X-Speech-Provider` and `X-Speech-Voice`
headers, and the voice log names the engine per line. A silent fallback is
still a fallback — if the primary is being skipped every turn, that should be
visible without reading the bridge log.

## Self-hosted, both directions

One container serves both: `local_whisper` posts to `/audio/transcriptions`,
`local_speech` to `/audio/speech`. Setup installs only the models the configured
chains actually need. Kokoro is 82M parameters and runs in real time on a plain
CPU, which is what makes an entirely local voice loop practical rather than a
demo — the Whisper side is the part that wants a GPU, not this one.

## API

| Route | Method | Purpose |
| --- | --- | --- |
| `/api/speech` | GET | Both catalogs, chains, scopes, languages and settings in one round trip |
| `/api/speech/tts` | PATCH | provider / fallbacks / language / model / voice / scopes |
| `/api/speech/tts/:id/voices` | GET | Live voice catalog (Polly DescribeVoices, ElevenLabs `/voices`) |
| `/api/speech/tts/:id/test` | POST | Synthesize a sample line and return the audio |
| `/api/intelligence/tts` | POST | The runtime path — `{ text, language? }` → audio through the chain |

Speech-input routes and the shared self-hosted server lifecycle are in
[docs/29](./29-speech-to-text-providers.md).

## Config

```jsonc
"tts": {
  "provider": "browser",
  "fallbacks": ["elevenlabs", "amazon_polly"],
  "language": "auto",                              // follows speech-in
  "models":  { "elevenlabs": "eleven_turbo_v2_5" },
  "voices":  { "elevenlabs": "21m00Tcm4TlvDq8ikWAM" },
  "scopes":  { "elevenlabs": { "stability": 0.5 } }
}
```

The old `audio.ttsProvider` / `pollyVoiceId` / `pollyEngine` fields migrate
automatically on first load: `ttsProvider: "browser"` becomes
`provider: "browser"` with `amazon_polly` as the fallback, and the Polly voice
and engine move into `voices` and `models`. Nothing to edit by hand — see
`migrateAudioSettings` in [`src/config.ts`](../src/config.ts).
