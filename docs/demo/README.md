# README demo video

`agentvoice-demo.mp4` (with sound) and `agentvoice-demo.gif` (silent preview
embedded in the README) show one real voice session in the AgentVoice web
client: pick the project and model, tap the orb, say the wake word and a
question, and hear Claude Code answer.

## Transcript

Both voices are in the MP4. The question is a pre-generated speech clip played
into a virtual microphone; the answer is the app's own playback of the
bridge's text-to-speech. These are the lines in the published cut, verbatim.

| Who | Line |
| --- | --- |
| you | Cursor listen. What does this project do? Answer in one sentence. |
| agent | AgentVoice is a self-hosted voice bridge that lets you control a coding agent like Claude Code, Cursor, Codex or Codewhale by speaking from your phone. |

The bridge's speech-to-text heard the question as "What does this project do
answer in one sentence?" (the wake phrase is stripped before the turn is sent).

## How it was made

- **Bridge:** `node dist/index.js` from a checkout of `main`, run with a
  throwaway config: Claude Code as the agent CLI (`manual` permission mode),
  one project, speech-to-text `local_whisper` and text-to-speech
  `local_speech` against a speaches container (faster-whisper small + Kokoro)
  on `127.0.0.1:8770`.
- **Client:** the built web app served by the bridge, opened by Playwright in
  Chromium at a 420×800 phone-sized viewport and recorded with Playwright's
  screen recording. The model list is what Claude Code reports through the
  bridge (`listModels()`); the take picks Sonnet 5.5.
- **The microphone:** a PipeWire virtual source (`Audio/Source/Virtual`) fed
  from a null sink. The question is a Kokoro clip (voice `am_michael`, so it
  sounds different from the agent's `af_heart`). It is played into that sink
  once the session is live. Vosk hears the wake word, Silero VAD ends the turn,
  and Whisper transcribes it, exactly as with a real mic.
- **Audio:** the virtual mic feed and Chromium's output (routed to a second null
  sink) are recorded with `parecord`, aligned to the screen recording by
  wall-clock timestamps, and mixed.
- **Edit (ffmpeg):** the footage sits in a phone frame next to step captions
  and the transcript, which are HTML rendered to PNG. A title card and an
  install card bracket it. The only cut is 9 s of waiting while Claude Code
  answers and the reply is synthesised, and the video marks it on screen.
  Nothing else is altered. GIF: steps only, 12 fps, 820 px wide.
