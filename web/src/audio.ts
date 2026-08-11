/**
 * Microphone capture and noise filtering for AgentVoice PWA.
 *
 * - getUserMedia with browser DSP (noise suppression, echo cancellation, AGC)
 * - Web Audio high-pass filter — cuts leaf-blower / HVAC low-frequency rumble
 * - Soft noise gate — attenuates steady background when you're not speaking
 *
 * Bedrock sends raw PCM (no WebRTC codec DSP), so the filter chain matters most
 * there. WebRTC sessions use the same constraints + optional processed stream.
 *
 * See docs/06-voice-audio-webrtc.md — Background noise filtering.
 */

let _audioCtx: AudioContext | null = null;

/** Browser-native mic processing — always on when supported. */
export const MIC_MEDIA_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  // Chromium extras (ignored safely on Safari/Firefox)
  ...({
    googEchoCancellation: true,
    googAutoGainControl: true,
    googNoiseSuppression: true,
    googHighpassFilter: true,
  } as MediaTrackConstraints),
};

export interface MicFilterOptions {
  /** High-pass cutoff (Hz). Leaf blowers sit mostly below ~200 Hz. */
  highPassHz?: number;
  /** Low-pass cutoff (Hz). Cuts high-frequency hiss/fan noise above the speech band. */
  lowPassHz?: number;
  /** Attenuate steady background when RMS stays below the adaptive threshold. */
  noiseGateEnabled?: boolean;
}

const DEFAULT_FILTER: Required<MicFilterOptions> = {
  highPassHz: 180,
  lowPassHz: 3500,
  noiseGateEnabled: true,
};

/**
 * Unlock the AudioContext inside a user-gesture handler.
 */
export async function unlockAudioContext(): Promise<void> {
  if (!_audioCtx) {
    _audioCtx = new AudioContext();
  }
  if (_audioCtx.state === 'suspended') {
    await _audioCtx.resume();
  }
}

let ttsPlaybackPrimed = false;

function isIosDevice(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  return (
    /iPad|iPhone|iPod/.test(ua) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
}

/**
 * Prime TTS for async playback — call synchronously inside a user gesture (orb tap)
 * before any `await`, or iOS Safari blocks later speak() / Audio.play() calls.
 *
 * - Web Audio: resume AudioContext (Polly decode path).
 * - speechSynthesis: silent dummy utterance unlocks programmatic speaks on iOS.
 */
export async function primeTtsPlaybackUnlock(): Promise<void> {
  await unlockAudioContext();

  if (typeof window === 'undefined' || !window.speechSynthesis) return;
  if (ttsPlaybackPrimed) {
    window.speechSynthesis.resume();
    return;
  }

  window.speechSynthesis.cancel();
  window.speechSynthesis.resume();
  window.speechSynthesis.getVoices();

  // iOS Safari requires an in-gesture utterance before async speak() works.
  if (!isIosDevice()) {
    ttsPlaybackPrimed = true;
    return;
  }

  await new Promise<void>((resolve) => {
    const utter = new SpeechSynthesisUtterance('\u00a0');
    utter.volume = 0.01;
    utter.rate = 10;
    const done = () => resolve();
    utter.onend = done;
    utter.onerror = done;
    window.speechSynthesis.speak(utter);
    window.setTimeout(done, 300);
  });

  ttsPlaybackPrimed = true;
}

/** Shared AudioContext for mic processing graphs. */
export function getSharedAudioContext(): AudioContext {
  if (!_audioCtx) {
    _audioCtx = new AudioContext();
  }
  return _audioCtx;
}

/** Request microphone with noise-suppression constraints enabled. */
export async function captureMicStream(): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: MIC_MEDIA_CONSTRAINTS,
    video: false,
  });
}

/**
 * Adaptive noise gate — reduces steady rumble (leaf blowers, fans) between words.
 * Mutates samples in place.
 *
 * Asymmetric adaptation: the noise floor rises very slowly so sustained background
 * noise (fans, HVAC, traffic) cannot lift the threshold above the user's voice.
 * The floor falls quickly when the environment becomes quiet.
 * A short hold period keeps the gate open for a few frames after speech ends to
 * prevent trailing word edges from being clipped.
 */
export class NoiseGate {
  private noiseFloor = 0.004;
  /** How many times above the noise floor the signal must be to open the gate. */
  private readonly openMultiplier = 3.2;
  /** Very slow rise — sustained background noise adapts floor up only slightly. */
  private readonly floorRiseAlpha = 0.003;
  /** Faster fall — quieter environments lower the threshold quickly. */
  private readonly floorFallAlpha = 0.04;
  private readonly closedGain = 0;
  /** Frames to keep the gate open after speech energy drops below threshold. */
  private readonly holdDuration = 4;
  private holdFrames = 0;

  process(samples: Float32Array): void {
    let sumSq = 0;
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i] ?? 0;
      sumSq += s * s;
    }
    const rms = Math.sqrt(sumSq / Math.max(samples.length, 1));
    const threshold = Math.max(this.noiseFloor * this.openMultiplier, 0.003);

    if (rms >= threshold) {
      // Speech detected — reset hold, pass audio through unmodified.
      this.holdFrames = this.holdDuration;
    } else if (this.holdFrames > 0) {
      // In hold period after speech — keep gate open to avoid clipping trailing words.
      this.holdFrames--;
    } else {
      // Silence/noise — adapt floor asymmetrically and zero samples.
      const alpha = rms > this.noiseFloor ? this.floorRiseAlpha : this.floorFallAlpha;
      this.noiseFloor += (rms - this.noiseFloor) * alpha;
      for (let i = 0; i < samples.length; i++) {
        samples[i] = (samples[i] ?? 0) * this.closedGain;
      }
    }
  }
}

type MicChainInternal = {
  output: AudioNode;
  dispose: () => void;
  applyGate?: (buf: Float32Array) => void;
};

export interface MicProcessingChain {
  output: AudioNode;
  dispose(): void;
}

/** Mic → high-pass → [low-pass] → output (apply gate in PCM callback for Bedrock). */
export function createMicProcessingChain(
  micStream: MediaStream,
  options: MicFilterOptions = {},
): MicProcessingChain {
  const opts = { ...DEFAULT_FILTER, ...options };
  const ctx = getSharedAudioContext();
  const source = ctx.createMediaStreamSource(micStream);
  const highPass = ctx.createBiquadFilter();
  highPass.type = 'highpass';
  highPass.frequency.value = opts.highPassHz;
  highPass.Q.value = 0.707;
  source.connect(highPass);

  let lastNode: AudioNode = highPass;

  if (opts.lowPassHz > 0) {
    const lowPass = ctx.createBiquadFilter();
    lowPass.type = 'lowpass';
    lowPass.frequency.value = opts.lowPassHz;
    lowPass.Q.value = 0.707;
    highPass.connect(lowPass);
    lastNode = lowPass;
  }

  const chain: MicChainInternal = {
    output: lastNode,
    dispose: () => {
      source.disconnect();
      highPass.disconnect();
      lastNode.disconnect();
    },
  };

  if (opts.noiseGateEnabled) {
    const gate = new NoiseGate();
    chain.applyGate = (buf: Float32Array) => gate.process(buf);
  }

  return chain;
}

/** Run noise gate on a float buffer when the chain was created with gating enabled. */
export function applyMicNoiseGate(chain: MicProcessingChain, samples: Float32Array): void {
  (chain as MicChainInternal).applyGate?.(samples);
}

/**
 * Build a filtered MediaStream for WebRTC (high-pass + gate → new track).
 */
export function createFilteredMicStream(
  micStream: MediaStream,
  options?: MicFilterOptions,
): { stream: MediaStream; dispose: () => void } {
  const ctx = getSharedAudioContext();
  const chain = createMicProcessingChain(micStream, options) as MicChainInternal;
  const dest = ctx.createMediaStreamDestination();

  if (chain.applyGate) {
    const processor = ctx.createScriptProcessor(4096, 1, 1);
    chain.output.connect(processor);
    processor.onaudioprocess = (ev) => {
      const output = ev.outputBuffer.getChannelData(0);
      output.set(ev.inputBuffer.getChannelData(0));
      chain.applyGate!(output);
    };
    processor.connect(dest);
    return {
      stream: dest.stream,
      dispose: () => {
        processor.disconnect();
        chain.dispose();
      },
    };
  }

  chain.output.connect(dest);
  return {
    stream: dest.stream,
    dispose: () => chain.dispose(),
  };
}

/** Create and attach an <audio> element for WebRTC remote-track playback. */
export function createAudioElement(): HTMLAudioElement {
  const el = document.createElement('audio');
  el.autoplay = true;
  el.setAttribute('playsinline', '');
  el.setAttribute('webkit-playsinline', '');
  document.body.appendChild(el);
  return el;
}

/**
 * ScriptProcessor nodes must be connected to the graph to run, but mic taps
 * must never play through speakers (causes echo and breaks wake-word detection).
 */
export function connectSilentSink(ctx: AudioContext, node: AudioNode): void {
  const silent = ctx.createGain();
  silent.gain.value = 0;
  node.connect(silent);
  silent.connect(ctx.destination);
}
