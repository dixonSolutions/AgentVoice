# README demo video

`squeaky-demo.mp4` (with sound) and `squeaky-demo.gif` (silent preview
embedded in the README) show one real voice session in the Squeaky web
client: pick the project and model, tap the orb, say the wake word and a
question, and hear Claude Code answer.

## Transcript

Both voices are in the MP4. The question is a pre-generated speech clip fed
to the browser as its microphone. The answer is the audio the app played for
the bridge's text-to-speech, captured inside the page. These are the lines in
the published cut, verbatim.

| Who | Line |
| --- | --- |
| you | Cursor listen. What does this project do? Answer in one sentence. |
| agent | Squeaky is a voice bridge that lets you control coding agents like Claude Code hands-free from your phone, by carrying my speech to you and your words back to me. |

The bridge's speech-to-text heard the question word for word as "What does
this project do? Answer in one sentence." The wake phrase is stripped before
the turn is sent.

## How it was made

- **Bridge:** `node dist/index.js` from a source checkout, run
  with a throwaway config and home: Claude Code as the agent CLI (`manual`
  permission mode), one project (the Squeaky repository itself, so the agent
  describes Squeaky), speech-to-text `local_whisper` and text-to-speech
  `local_speech` against a speaches server (faster-whisper small + Kokoro) on
  `127.0.0.1:8770`.
- **Client:** the built web app served by the bridge, opened by Playwright in
  Chromium at a 420×800 phone-sized viewport and recorded with Playwright's
  screen recording. The model list is what Claude Code reports through the
  bridge (`listModels()`); the take picks Sonnet (Sonnet 5.5). The app's
  appearance is left on System, and the browser reports a dark system theme
  (`prefers-color-scheme: dark`), so the app renders dark.
- **The microphone:** Chromium's fake capture device
  (`--use-fake-device-for-media-stream --use-file-for-fake-audio-capture`)
  reads a WAV file as the mic. The file is a Kokoro clip (voice `am_michael`,
  so it sounds different from the agent's `af_heart`): 3.5 s of silence, "Cursor
  listen.", a 1.1 s pause, then the question. Vosk hears the wake word, Silero
  VAD ends the turn, and Whisper transcribes it, exactly as with a real mic.
- **Audio:** the browser had no sound device to record from, so the soundtrack
  is rebuilt from what the page did, with wall-clock times. A script in the
  page logged when Chromium opened the mic (the question clip goes in at that
  moment), and copied every buffer the app scheduled through Web Audio. The
  reply is those copied buffers, so it is the bridge's own Kokoro `af_heart`
  speech, sample for sample, placed where the app started playing it. The
  app's UI sounds (start beep, connect ding, "listening" and "sent" cues) are
  added at the logged times. A white flash before the app loads ties the
  wall clock to the screen recording.
- **Edit (ffmpeg):** the footage sits in a phone frame next to step captions
  and the transcript, which are HTML rendered to PNG. A title card and an
  install card bracket it. The only cut is 7 s of waiting while Claude Code
  answers and the reply is synthesised, and the video marks it on screen.
  Nothing else is altered. GIF: steps only, 12 fps, 820 px wide.
