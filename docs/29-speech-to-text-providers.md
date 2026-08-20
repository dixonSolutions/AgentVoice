# 29 — Speech-to-Text Providers: Beyond Amazon Transcribe

> Added: August 2026

Until now the only way to transcribe a voice turn on the bridge was **Amazon
Transcribe**, which meant an AWS account and IAM keys before the app could hear
you at all. `src/providers/speech/input/` generalizes that: a self-hosted
Whisper container and six hosted APIs are equally supported, configured from
**Config → Speech** without touching `.env` by hand.

Each vendor is one file — a converter plus a metadata block — wired up by the
shared orchestration core
([docs/31](./31-service-orchestrator-converter.md)). Text-to-speech has the
same layer ([docs/30](./30-speech-output-providers.md)) and shares the keys,
the self-hosted container, and the fallback semantics.

See [`src/providers/speech/input/types.ts`](../src/providers/speech/input/types.ts).

## What this does *not* change

- **Vosk still does wake words.** `agent listen` / `send` / `cancel` are spotted
  on-device by Vosk and never leave the phone. No provider here sees them.
- **Bedrock still orchestrates** in the `llm_intelligence` workflow, and Polly
  still does server-side TTS. This is speech *in*, not speech out or reasoning.
- **Browser STT is still tried first** by default — it is simply the first
  entry in the chain (`stt.provider: "browser"`). The providers below are what
  run when it is off, unavailable, or the device is an iOS standalone PWA.

## Providers

| Provider | id | Key | Approx. $/audio hour | Notes |
| --- | --- | --- | --- | --- |
| Self-hosted Whisper | `local_whisper` | — | free | Docker/Podman container on your machine; audio never leaves the host |
| Groq | `groq` | `GROQ_API_KEY` | ~$0.04 | Whisper large-v3 on LPUs — the fastest hosted option by a wide margin |
| OpenAI | `openai` | `OPENAI_API_KEY` | ~$0.18 | `gpt-4o-mini-transcribe` default; key shared with the Codex agent client |
| Deepgram | `deepgram` | `DEEPGRAM_API_KEY` | ~$0.26 | Nova-3, smart formatting; the usual choice for production voice agents |
| Google Gemini | `gemini` | `GEMINI_API_KEY` | ~$0.06 | `generateContent` with inline audio; generous free tier |
| ElevenLabs | `elevenlabs` | `ELEVENLABS_API_KEY` | ~$0.40 | Scribe v1 — best raw accuracy, slowest of the hosted set |
| OpenRouter | `openrouter` | `OPENROUTER_API_KEY` | ~$0.10 | Audio-capable **chat** models (see caveat below) |
| Amazon Transcribe (default) | `amazon_transcribe` | AWS IAM keys | ~$1.44 | Streaming SFM; keeps its own language/stabilization settings |

Prices are list rates at the time of writing and are shown in the picker to make
the trade-off visible, not as a billing guarantee.

### Two provider-specific caveats

**Ollama cannot do this.** It has no transcription endpoint — text and vision
only — so "run STT locally" goes through a Whisper server image instead. If you
already run Ollama, it stays exactly where it is; the Whisper container is a
separate, smaller thing.

**OpenRouter has no `/audio/transcriptions` route.** It reaches audio-capable
*chat* models with an `input_audio` content part, so only the models listed in
[`openrouter.ts`](../src/providers/speech/input/vendors/openrouter.ts) work; pointing it at a
text-only model returns an upstream error. It is here because one key many
people already have unlocks several models without opening another account —
but Groq or Gemini will be faster and cheaper for the same job.

## Self-hosted Whisper

Any server exposing OpenAI-compatible `POST {root}{apiPath}/audio/transcriptions`
works. Two modes:

- **`container`** — the bridge pulls the image and runs it. Defaults to
  [speaches](https://speaches.ai/) (`faster-whisper` under the hood), published
  as `ghcr.io/speaches-ai/speaches:latest-cpu` / `:latest-cuda`.
- **`external`** — you already run a server (another host, an existing compose
  stack, `whisper.cpp`); the bridge just points at its URL.

The container is published on **`127.0.0.1:<port>` only**, so it stays
unreachable from the network even when the bridge itself is tunnelled.

**Model ladder.** Weights download on first use into a named volume, so
re-pulling the image does not re-download them. The default is
`Systran/faster-whisper-small` — deliberately not the biggest one, because
`large-v3` on a CPU takes *minutes* per turn and reads as a broken app. With a
GPU, switch to the CUDA image, enable GPU passthrough, and move up to
`large-v3-turbo`.

**One-click setup** (Config → Speech → Pull & start) runs: resolve
runtime → pull image → start container → wait for health → install the model →
warm it up with a probe clip. The last two steps are the slow ones and are
reported honestly in the progress log rather than hidden behind a spinner.

Note that speaches does **not** download weights lazily on first transcription —
it answers `Model 'X' is not installed locally. You can download the model
using POST /v1/models`. Setup therefore asks explicitly
(`POST {apiPath}/models/{model_id}`, checking `GET` first so a re-run is cheap)
and falls back gracefully for servers with no model-management API, where the
weights ship inside the image. Model ids contain a slash and are routed as a
path segment, so they are deliberately **not** percent-encoded.

Docker and Podman are peers, not fallbacks — Podman is the default on
Fedora/RHEL and needs no daemon or root, which matters for a bridge running as a
user service. The only difference in the generated command is GPU passthrough
(`--gpus all` vs `--device nvidia.com/gpu=all`).

## Keys

Keys go into `.env` on the bridge, are never returned to the web app (only
*configured / complete*), and every write is audited. `OPENAI_API_KEY` is shared
with the Codex agent client and the UI warns before replacing it.

## Testing a provider

**Test provider** transcribes a bundled 600 ms probe clip through the real API.
That is deliberately a full round trip rather than an auth-only ping: it proves
the key, the model id, and the network path in one shot. The clip contains no
speech, so an **empty transcript is the success case** — what is being checked
is the HTTP status.

## Config

Everything lives under `settings.workflow.llmIntelligence.audio.stt`:

```jsonc
"stt": {
  "provider": "browser",                            // first choice
  "fallbacks": ["groq", "amazon_transcribe"],       // tried in order
  "language": "en",                                 // ISO-639-1, or "auto"
  "models": { "groq": "whisper-large-v3-turbo" },   // per-provider model
  "scopes": { "groq": { "prompt": "Fastify, Zod" } }// per-provider options
}
```

The old flat fields — `preferWebkit` and the seven `transcribe*` keys — migrate
automatically on first load. `preferWebkit: true` becomes
`provider: "browser"` with the previous server engine as the fallback, and
Transcribe's language mode, identify candidates and stabilization settings move
into `scopes.amazon_transcribe`, where they belong to the one vendor that uses
them. See `migrateAudioSettings` in [`src/config.ts`](../src/config.ts).

## API (`src/routes/speechProviders.ts`)

| Route | Method | Purpose |
| --- | --- | --- |
| `/api/speech` | GET | Both catalogs, chains, scopes, languages and settings in one round trip |
| `/api/speech/stt` | PATCH | `{ provider?, fallbacks?, language?, model?, scopes?, scopeProvider?, server? }` |
| `/api/speech/keys` | PATCH | `{ GROQ_API_KEY: "…" }` → `.env`; empty string clears |
| `/api/speech/stt/:id/test` | POST | Probe-clip round trip → `{ ok, latencyMs, transcript?, error? }` |
| `/api/speech/server/status` | GET | Runtime detection, image present, container state, server health |
| `/api/speech/server/setup` | POST | `{ runId }` immediately; progress pushed as `{ type: 'speech_setup_progress', runId, message, done, error? }` over `/ws/control` |
| `/api/speech/server/setup/:runId` | GET | Poll a run — the WS-disconnect-safe fallback |
| `/api/speech/server/stop` | POST | `{ remove?: boolean }` — stop, or remove the container (the model volume is kept) |
| `/api/speech/server/logs` | GET | Container log tail |

All require the same Bearer `APP_TOKEN` as the rest of `/api/*`.

## Transcription path

`POST /api/intelligence/transcribe` is unchanged from the phone's point of view
— still raw PCM16LE at 16 kHz — but now goes through the speech-input service
instead of calling Amazon directly. The PWA class was renamed
`AmazonSttSession` → `ServerSttSession` (`web/src/server-stt.ts`) to match.

Amazon streams the raw PCM; every other provider gets it wrapped in a WAV
container ([`wav.ts`](../src/providers/speech/wav.ts)) since none of the HTTP
APIs accept headerless PCM. That is a 44-byte header, not a transcode.

Errors name the engine that actually failed
([`errors.ts`](../src/providers/speech/errors.ts)) — "check AWS credentials" is
worse than useless when the active provider is Groq.

## Adding a provider

One file in `src/providers/speech/input/vendors/` exporting a
`SpeechInputVendor` — metadata plus a converter — and one entry in the
orchestrator's `VENDORS` map and `SPEECH_INPUT_PICKER_ORDER`. Add the id to
`SPEECH_INPUT_PROVIDERS` ([`src/config.ts`](../src/config.ts)), and the key to
`EnvSchema` and `SPEECH_ENV_KEYS`
([`src/state/envFile.ts`](../src/state/envFile.ts)) if it needs one.

Nothing else changes: the config screen renders providers, models and scopes
from what the vendor declares, and transport, auth and retry come from the
shared HTTP specializer. If the API is OpenAI-shaped, `openAiTranscriptionCall`
([`http.ts`](../src/providers/speech/http.ts)) is most of the work — see
[`groq.ts`](../src/providers/speech/input/vendors/groq.ts).
