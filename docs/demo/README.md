# README demo video

`agentvoice-demo.mp4` (with sound) and `agentvoice-demo.gif` (silent preview
embedded in the README) show one voice session in the AgentVoice web client:
pick a project, pick the Claude Code model, tap the orb, ask two questions and
hear Claude Code answer.

## Transcript

What is said to the agent (spoken into the app, transcribed by the bridge's
speech-to-text chain — the self-hosted Whisper container in this take) and what
the agent speaks back through `speak()`, played by the app through the
self-hosted Kokoro voice. Replies vary from take to take; these are the lines
in the published cut, verbatim.

| Who | Line |
| --- | --- |
| you | Hey, what does this project do? One sentence. |
| agent | AgentVoice is a bridge that lets you talk hands-free from your phone to coding agents like me — Claude Code, Cursor, Codex or Codewhale — so you can give instructions, hear progress and approve work by voice. |
| you | How do I install it? |
| agent | Let me check the README for the install steps. |
| agent | The easiest way is to run npm install dash g at ratitisrad slash agentvoice, which also starts it as a background service. |
| agent | _(the cut fades out here; the full answer went on to describe `agentvoice setup`, pairing, and the apt/dnf repositories)_ |

## How it was made

- Bridge: `agentvoice run` on this machine, Claude Code as the agent CLI, three
  registered projects, speech-to-text `local_whisper` and text-to-speech
  `local_speech` (the speaches container: faster-whisper small + Kokoro).
- Client: the built web app served by the bridge, opened in a chromeless
  Chromium app-mode window at 150 % zoom, paired beforehand. The model list is
  what Claude Code reports through the bridge (`listModels()`).
- Recorded with [Kooha](https://github.com/SeaDve/Kooha) (MP4, 30 fps, desktop
  audio + microphone) on a 1920×1200 (16:10) display. The window's title bar
  and Chromium's "for testing" infobar are cropped off and the frame is padded
  back to 16:10 with the page background; panels and dock are never in frame.
- The "microphone" is a PipeWire virtual source fed from a null sink; the two
  questions are Kokoro TTS clips played into that sink at the moment they are
  asked, so the app hears them exactly like a real mic, Whisper transcribes
  them live, and Kooha records them in sync. The agent's replies are the app's
  own playback of the bridge's TTS, recorded as desktop audio.
- Waiting time (transcription, Claude Code start-up, TTS synthesis) is cut out
  and the second answer is faded out after its second sentence; nothing else
  is altered.
