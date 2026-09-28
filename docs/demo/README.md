# README demo video

`agentvoice-demo.mp4` (with sound) and `agentvoice-demo.gif` (silent preview
embedded in the README) show one voice session driven entirely from a terminal:

```bash
agentvoice pipe --mic --project agentvoice
```

The bridge is running in the background (`agentvoice run`, or the service) with
Claude Code as the agent CLI. The pipe streams the microphone to the bridge, the
bridge transcribes each pause-delimited segment, hands it to the voice agent,
and prints what the agent speaks back — no phone involved (docs/41).

## Transcript

What is said to the agent (spoken, transcribed by the bridge's speech-to-text
chain — the self-hosted Whisper container in this take) and what the agent
speaks back through `speak()`. Replies vary from take to take; these are the
lines in the published cut, verbatim.

| Who | Line |
| --- | --- |
| you | Hey, what does this project do? One sentence. |
| agent | AgentVoice lets you talk hands-free from your phone to coding agents like Claude Code, Cursor, Codex and Codewhale, so you can steer their work and hear what they're doing. |
| you | How do I install it? |
| agent | Let me check the README for the install steps. |
| agent | The quickest way is to install the npm package globally, at-ratitisrad slash agentvoice. |
| agent | Then run agentvoice setup, which walks you through picking your agent CLI and projects, then hosting such as Tailscale. |
| agent | On Debian, Ubuntu or Fedora you can also install it from the signed apt or dnf repositories, so updates come with the rest of your system. |

## How it was made

- Recorded with [Kooha](https://github.com/SeaDve/Kooha) (MP4, 30 fps) on a
  1920×1200 (16:10) display, cropped to the terminal's content area with ffmpeg
  and padded to 16:10 with the terminal's background colour; header bar, panels
  and pointer are not in the cut.
- The "microphone" is a PipeWire null sink whose monitor is the default source;
  the spoken questions are synthesized with Kokoro (via the bridge's speech
  server container) and played into that sink, so the pipe hears them exactly
  like a real mic and Kooha records them in sync.
- The agent's replies are synthesized the same way in post-production and
  aligned to the frame where each `agent ◂` line appears (on a phone the bridge
  speaks them through the configured TTS provider; the terminal pipe prints
  them).
- Waiting time (transcription, Claude Code start-up) is cut out; nothing else
  is altered.
