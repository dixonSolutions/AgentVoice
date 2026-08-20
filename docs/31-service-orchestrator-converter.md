# 31 — Service / Orchestrator / Converter / Specializer

> Added: August 2026

Three subsystems in this codebase are "pick one of several interchangeable
back-ends and use it": the coding-agent CLIs, speech-to-text, and
text-to-speech. Each had grown its own version of the same logic, and the two
speech ones had already started to drift — one probed availability before
attempting, the other did not.

`src/orchestration/` is the shared core. Four roles, each with exactly one
reason to change:

| Role | Knows | Does not know |
| --- | --- | --- |
| **Service** | the app's vocabulary — "transcribe this", "speak this" | that vendors exist |
| **Orchestrator** | chain order, capabilities, what to retry | any wire format |
| **Converter** | one vendor's field names, in both directions | when it is chosen |
| **Specializer** | one vendor's transport and credentials | the chain it sits in |

```
  route / voice session
          │
          ▼
      Service ─────────── neutral request, e.g. { pcm, language }
          │
          ▼
   Orchestrator ───────── chain → skip unusable → try in order → fall through
          │
          ▼
   Specializer ────────── transport + credentials
          │
          ▼
    Converter ─────────── neutral ⇄ native
          │
          ▼
        vendor
```

## Why the converter is its own role

It is the anti-corruption layer. Deepgram calls it `smart_format`, ElevenLabs
calls it `voice_settings.stability`, Gemini wants the audio base64'd inside a
`generateContent` part. Without a converter those names leak upward and the
orchestrator ends up with a special case per vendor. With one, vendor
vocabulary stops at a single file:

```ts
converter: {
  id: 'deepgram',
  encode(req) { /* neutral request → one HTTP call */ },
  decode(res, req) { /* vendor response → neutral result */ },
}
```

`encode`/`decode` are pure enough to test without a network, which is the other
reason to keep them separate from transport.

## Transport is a vendor detail

Most vendors are REST, so `createHttpSpecializer`
([`orchestration/http.ts`](../src/orchestration/http.ts)) turns a converter plus
a metadata block into a full `Specializer` — auth, timeouts, error
classification and the contract all come for free.

Two do not: Amazon Transcribe streams over the AWS SDK, and Polly uses
`SynthesizeSpeech`. They declare `transport: 'custom'` and own their transport,
and *nothing above them changes*. That is the load-bearing test of the
abstraction — it survived a vendor that is not HTTP at all.

## What the orchestrator decides

[`orchestration/orchestrator.ts`](../src/orchestration/orchestrator.ts) is the
only implementation of fallback semantics in the codebase.

1. Walk `chain(req)`, deduped.
2. `resolve(id)` returning null means "not handled here" — that is how
   `browser` sits in a chain with no bridge-side implementation.
3. Skip anything not `isConfigured()`, recording the reason.
4. Ask `accepts(specializer, req)` — the request-shaped check, such as "cannot
   speak Ukrainian". A string answer becomes the skip reason.
5. Optionally `checkAvailability()`, gated by `probeAvailability` so a network
   probe costs nothing for vendors where a key is the whole answer.
6. Try each survivor. On failure consult `retriable(err)` — credentials, quota
   and reachability move on; malformed input does not, because it would fail
   identically everywhere and retrying only multiplies the wait.

Every pass-over is recorded as a `SkipRecord` with a `phase`: `skipped` (never
attempted) or `failed` (attempted and errored). That distinction is kept
because "why didn't it use the one I picked?" is the question a fallback chain
provokes most, and "no key" and "the key was rejected" need different fixes.

Real output from the speech-in chain with a bad Groq key:

```jsonc
{ "handledBy": "amazon_transcribe",
  "skipped": [{ "id": "groq", "reason": "Access denied…", "phase": "failed" }] }
```

## Adding things

- **A vendor** — one file exporting a converter plus metadata, one entry in the
  orchestrator's map. No service, schema, route or UI change: the config screen
  renders providers, models, voices and scopes from what the vendor declares.
- **A policy** — "prefer cheapest", "round-robin", "prefer local when the
  network is down" — is an `OrchestrationPolicy` change that touches no vendor.
- **A caller** — talks to the service and learns neither.

## Where it is used

| Subsystem | Service | Orchestrator | Vendors |
| --- | --- | --- | --- |
| Speech in | [`input/service.ts`](../src/providers/speech/input/service.ts) | [`input/orchestrator.ts`](../src/providers/speech/input/orchestrator.ts) | `input/vendors/` (8) |
| Speech out | [`output/service.ts`](../src/providers/speech/output/service.ts) | [`output/orchestrator.ts`](../src/providers/speech/output/orchestrator.ts) | `output/vendors/` (7) |
| Agent CLIs | *not yet migrated* — see below | | `providers/agents/` |

The agent-CLI layer already has the shape without the names: `AgentProvider`
mixes specializer and converter, and `parseStreamEvent` is a decode step in all
but name. Migrating it means splitting each CLI into a converter (neutral
`SpawnRequest` → argv + env; NDJSON line → normalized `AgentStreamEvent`) and a
specializer (the process), then an orchestrator that can fall back when a CLI
is not installed or not signed in. That is outstanding.

## Scopes

Per-vendor options are declared, not hard-coded:
[`providers/scopes.ts`](../src/providers/scopes.ts). A `ProviderScope` has a
kind (`select`/`toggle`/`number`/`text`), a default, optional bounds and
choices, and an optional `showWhen` guard. The config screen renders them
generically, so a new option is one entry in one vendor file.

Scopes attach at two levels. Provider-level ones apply to everything;
model-level ones live on the model entry and are merged over the top, which is
how OpenAI's `instructions` exists for `gpt-4o-mini-tts` and not for `tts-1`
without a parallel list or a hidden conditional.
