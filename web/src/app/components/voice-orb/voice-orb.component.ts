import {
  Component,
  ElementRef,
  OnDestroy,
  afterNextRender,
  effect,
  input,
  viewChild,
} from '@angular/core';
import type { AudioSpectrum } from '../../../voice-audio-meter.js';

const TAU = Math.PI * 2;
const SILENT = 0.028;
const VIZ_BINS = 32;

/** Semantic orb states — colors come from Optimus `--p-primary-*` tokens. */
export type OrbColorMode = 'idle' | 'ready' | 'listening';

/** @deprecated Prefer OrbColorMode; kept for any stray imports. */
export type OrbColorModeLegacy = 'blue' | 'red' | 'green' | OrbColorMode;

interface Rgb {
  r: number;
  g: number;
  b: number;
}

@Component({
  selector: 'cv-voice-orb',
  standalone: true,
  template: `
    <div
      class="cv-voice-orb"
      [class.cv-voice-orb--dim]="dimmed()"
      [class.cv-voice-orb--live]="live()"
      [class.cv-voice-orb--expanded]="expanded()"
      [class.cv-voice-orb--idle]="resolvedMode() === 'idle'"
      [class.cv-voice-orb--ready]="resolvedMode() === 'ready'"
      [class.cv-voice-orb--listening]="resolvedMode() === 'listening'">
      <canvas #canvas aria-hidden="true"></canvas>
      <div class="cv-voice-orb-glow" [style.opacity]="glowOpacity()" aria-hidden="true"></div>
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
      }

      .cv-voice-orb {
        position: relative;
        width: 11.5rem;
        height: 11.5rem;
        margin: 0 auto;
        transition: width 0.35s ease, height 0.35s ease;
      }

      .cv-voice-orb--expanded {
        width: min(58vw, 58vh, 20rem);
        height: min(58vw, 58vh, 20rem);
      }

      @media (max-width: 640px) {
        .cv-voice-orb {
          width: 10.5rem;
          height: 10.5rem;
        }

        .cv-voice-orb--expanded {
          width: min(52vw, 42vh, 18rem);
          height: min(52vw, 42vh, 18rem);
        }
      }

      .cv-voice-orb canvas {
        position: relative;
        z-index: 1;
        width: 100%;
        height: 100%;
        display: block;
        border-radius: 50%;
        background: transparent;
      }

      .cv-voice-orb-glow {
        position: absolute;
        inset: -12%;
        border-radius: 50%;
        background: radial-gradient(
          circle,
          color-mix(in srgb, var(--p-primary-color) 45%, transparent) 0%,
          color-mix(in srgb, var(--p-primary-color) 14%, transparent) 45%,
          transparent 70%
        );
        filter: blur(18px);
        z-index: 0;
        pointer-events: none;
        opacity: 0.2;
        transition: opacity 0.12s ease, background 0.25s ease;
      }

      .cv-voice-orb--live .cv-voice-orb-glow {
        opacity: 0.35;
      }

      .cv-voice-orb--idle .cv-voice-orb-glow {
        background: radial-gradient(
          circle,
          color-mix(in srgb, var(--p-primary-color) 28%, transparent) 0%,
          color-mix(in srgb, var(--p-primary-color) 8%, transparent) 45%,
          transparent 70%
        );
      }

      .cv-voice-orb--ready .cv-voice-orb-glow {
        background: radial-gradient(
          circle,
          color-mix(in srgb, var(--p-primary-color) 55%, transparent) 0%,
          color-mix(in srgb, var(--p-primary-color) 18%, transparent) 45%,
          transparent 70%
        );
        animation: cv-orb-pulse-ready 1.8s ease-in-out infinite;
      }

      .cv-voice-orb--listening .cv-voice-orb-glow {
        background: radial-gradient(
          circle,
          color-mix(in srgb, var(--p-primary-color) 70%, transparent) 0%,
          color-mix(in srgb, var(--p-primary-color) 22%, transparent) 45%,
          transparent 70%
        );
      }

      .cv-voice-orb--dim .cv-voice-orb-glow {
        opacity: 0.12;
      }

      .cv-voice-orb--dim canvas {
        opacity: 0.55;
      }

      @keyframes cv-orb-pulse-ready {
        0%,
        100% {
          opacity: 0.32;
        }
        50% {
          opacity: 0.55;
        }
      }
    `,
  ],
})
export class VoiceOrbComponent implements OnDestroy {
  /** Live frequency spectrum from VoiceAudioMeter (mic + AI playback). */
  readonly spectrum = input<AudioSpectrum>({
    bins: new Array(VIZ_BINS).fill(0),
    mic: 0,
    out: 0,
    active: 0,
  });
  readonly live = input(false);
  readonly dimmed = input(false);
  readonly expanded = input(false);
  /** idle = preparing/offline · ready = session live waiting · listening = mic open */
  readonly colorMode = input<OrbColorModeLegacy>('idle');
  /** When true, draw mic-reactive waves (post–wake-word user speech only). */
  readonly visualizeUserSpeech = input(false);

  protected resolvedMode = (): OrbColorMode => normalizeOrbMode(this.colorMode());

  protected glowOpacity = (): number => {
    if (!this.visualizeUserSpeech()) return this.live() ? 0.22 : 0.12;
    const lv = this.spectrum().mic;
    if (lv < SILENT) return this.live() ? 0.28 : 0.15;
    return Math.min(1, 0.35 + lv * 0.65);
  };

  private readonly canvasRef = viewChild<ElementRef<HTMLCanvasElement>>('canvas');
  private rafId = 0;
  private displayLevel = 0;
  private displayMic = 0;
  private displayOut = 0;
  private displayBins = new Float32Array(VIZ_BINS);
  private readonly parseCtx: CanvasRenderingContext2D | null =
    typeof document !== 'undefined'
      ? document.createElement('canvas').getContext('2d')
      : null;

  constructor() {
    afterNextRender(() => {
      this.resizeCanvas();
      this.loop();
    });

    effect(() => {
      if (this.canvasRef()) this.resizeCanvas();
    });

    effect(() => {
      this.expanded();
      queueMicrotask(() => this.resizeCanvas());
    });
  }

  private resizeCanvas(): void {
    const el = this.canvasRef()?.nativeElement;
    if (!el) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const size = el.clientWidth || 208;
    el.width = Math.round(size * dpr);
    el.height = Math.round(size * dpr);
  }

  private loop = (): void => {
    const el = this.canvasRef()?.nativeElement;
    if (el) {
      const viz = this.visualizeUserSpeech();
      const { mic, out, bins } = this.spectrum();
      const targetMic = viz ? mic : 0;
      const targetOut = viz ? out : 0;
      const targetLevel = viz ? mic : 0;
      const rise = targetLevel > this.displayLevel ? 0.55 : 0.22;
      this.displayLevel += (targetLevel - this.displayLevel) * rise;
      this.displayMic += (targetMic - this.displayMic) * 0.35;
      this.displayOut += (targetOut - this.displayOut) * 0.35;
      for (let i = 0; i < VIZ_BINS; i++) {
        const v = viz ? (bins[i] ?? 0) : 0;
        this.displayBins[i] += (v - this.displayBins[i]!) * (viz ? 0.4 : 0.28);
      }
      this.draw(el);
    }
    this.rafId = requestAnimationFrame(this.loop);
  };

  private themePalette(mode: OrbColorMode): {
    highlight: Rgb;
    mid: Rgb;
    deep: Rgb;
    accent: Rgb;
  } {
    const root = getComputedStyle(document.documentElement);
    const primary = this.cssToRgb(root.getPropertyValue('--p-primary-color')) ?? { r: 139, g: 92, b: 246 };
    const light =
      this.cssToRgb(root.getPropertyValue('--p-primary-300')) ??
      this.cssToRgb(root.getPropertyValue('--p-primary-400')) ??
      lighten(primary, 0.45);
    const midToken =
      this.cssToRgb(root.getPropertyValue('--p-primary-500')) ??
      this.cssToRgb(root.getPropertyValue('--p-primary-color')) ??
      primary;
    const deepToken =
      this.cssToRgb(root.getPropertyValue('--p-primary-800')) ??
      this.cssToRgb(root.getPropertyValue('--p-primary-700')) ??
      darken(primary, 0.45);

    if (mode === 'listening') {
      return {
        highlight: lighten(light, 0.15),
        mid: midToken,
        deep: darken(midToken, 0.25),
        accent: light,
      };
    }
    if (mode === 'ready') {
      return {
        highlight: light,
        mid: darken(midToken, 0.08),
        deep: deepToken,
        accent: midToken,
      };
    }
    // idle / preparing — darkest, muted
    return {
      highlight: darken(midToken, 0.05),
      mid: deepToken,
      deep: darken(deepToken, 0.2),
      accent: midToken,
    };
  }

  private cssToRgb(raw: string): Rgb | null {
    const value = raw.trim();
    if (!value || !this.parseCtx) return null;
    this.parseCtx.fillStyle = '#000000';
    this.parseCtx.fillStyle = value;
    const normalized = String(this.parseCtx.fillStyle);
    const hex = normalized.match(/^#([0-9a-f]{6})$/i);
    if (hex) {
      const n = parseInt(hex[1]!, 16);
      return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
    }
    const rgb = normalized.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
    if (rgb) {
      return { r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]) };
    }
    return null;
  }

  private draw(canvas: HTMLCanvasElement): void {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    const cx = w / 2;
    const cy = h / 2;
    const baseR = Math.min(w, h) * 0.38;
    const level = this.displayMic;
    const mic = this.displayMic;
    const out = this.displayOut;
    const speaking = this.visualizeUserSpeech() && (level >= SILENT || this.maxBin() >= 0.06);
    const userTalk = mic > out && mic >= SILENT;

    const mode = this.resolvedMode();
    const palette = this.themePalette(mode);
    const highlight = userTalk ? lighten(palette.highlight, 0.12) : palette.highlight;
    const mid = userTalk ? lighten(palette.mid, 0.08) : palette.mid;
    const deep = palette.deep;
    const accent = palette.accent;

    ctx.clearRect(0, 0, w, h);

    const glow = speaking ? 0.35 + level * 0.65 : this.live() ? 0.22 : 0.12;
    const bloom = ctx.createRadialGradient(cx, cy, baseR * 0.2, cx, cy, baseR * 1.35);
    bloom.addColorStop(0, rgba(accent, 0.18 * glow));
    bloom.addColorStop(0.55, rgba(mid, 0.06 * glow));
    bloom.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = bloom;
    ctx.fillRect(0, 0, w, h);

    const coreR = baseR * (speaking ? 1 + level * 0.03 : 1);

    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, coreR, 0, TAU);
    ctx.clip();

    const sphere = ctx.createRadialGradient(
      cx - coreR * 0.28,
      cy - coreR * 0.32,
      coreR * 0.08,
      cx + coreR * 0.1,
      cy + coreR * 0.12,
      coreR * 1.05,
    );
    sphere.addColorStop(0, rgb(highlight));
    sphere.addColorStop(0.45, rgb(mid));
    sphere.addColorStop(1, rgb(deep));
    ctx.fillStyle = sphere;
    ctx.fillRect(cx - coreR, cy - coreR, coreR * 2, coreR * 2);

    if (speaking) {
      const minR = coreR * 0.12;
      const maxR = coreR * 0.92;
      const fill = lighten(accent, 0.35);

      ctx.beginPath();
      for (let i = 0; i <= VIZ_BINS; i++) {
        const bin = this.displayBins[i % VIZ_BINS] ?? 0;
        const radius = minR + (maxR - minR) * (0.35 + bin * 0.65);
        const angle = (i / VIZ_BINS) * TAU - Math.PI / 2;
        const x = cx + Math.cos(angle) * radius;
        const y = cy + Math.sin(angle) * radius;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fillStyle = rgba(fill, 0.1 + level * 0.18);
      ctx.fill();

      for (let ring = 1; ring <= 3; ring++) {
        const ringBin = this.avgBinSlice(ring - 1, 3);
        const ringR = coreR * (0.28 + (ring / 4) * 0.55) + ringBin * coreR * 0.12;
        ctx.beginPath();
        ctx.arc(cx, cy, ringR, 0, TAU);
        ctx.strokeStyle = rgba(accent, 0.08 + ringBin * 0.22 + level * 0.12);
        ctx.lineWidth = Math.max(1, w * 0.006);
        ctx.stroke();
      }

      ctx.beginPath();
      for (let i = 0; i <= VIZ_BINS; i++) {
        const bin = this.displayBins[i % VIZ_BINS] ?? 0;
        const radius = minR + (maxR - minR) * (0.35 + bin * 0.65);
        const angle = (i / VIZ_BINS) * TAU - Math.PI / 2;
        const x = cx + Math.cos(angle) * radius;
        const y = cy + Math.sin(angle) * radius;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.strokeStyle = rgba(lighten(accent, userTalk ? 0.25 : 0.1), 0.2 + level * 0.35);
      ctx.lineWidth = Math.max(1.5, w * 0.005);
      ctx.stroke();
    }

    const sheen = ctx.createRadialGradient(
      cx - coreR * 0.35,
      cy - coreR * 0.4,
      0,
      cx - coreR * 0.1,
      cy - coreR * 0.15,
      coreR * 0.75,
    );
    sheen.addColorStop(0, `rgba(255, 255, 255, ${speaking ? 0.22 + level * 0.15 : 0.14})`);
    sheen.addColorStop(1, 'rgba(255, 255, 255, 0)');
    ctx.fillStyle = sheen;
    ctx.fillRect(cx - coreR, cy - coreR, coreR * 2, coreR * 2);

    ctx.restore();

    ctx.beginPath();
    ctx.arc(cx, cy, coreR, 0, TAU);
    ctx.strokeStyle = rgba(lighten(accent, 0.2), speaking ? 0.22 + level * 0.3 : 0.16);
    ctx.lineWidth = Math.max(1, w * 0.004);
    ctx.stroke();
  }

  private avgBinSlice(slice: number, slices: number): number {
    const start = Math.floor((slice / slices) * VIZ_BINS);
    const end = Math.floor(((slice + 1) / slices) * VIZ_BINS);
    let sum = 0;
    let count = 0;
    for (let i = start; i < end; i++) {
      sum += this.displayBins[i] ?? 0;
      count++;
    }
    return count > 0 ? sum / count : 0;
  }

  private maxBin(): number {
    let m = 0;
    for (let i = 0; i < VIZ_BINS; i++) {
      m = Math.max(m, this.displayBins[i] ?? 0);
    }
    return m;
  }

  ngOnDestroy(): void {
    cancelAnimationFrame(this.rafId);
  }
}

function normalizeOrbMode(mode: OrbColorModeLegacy): OrbColorMode {
  if (mode === 'green' || mode === 'listening') return 'listening';
  if (mode === 'red' || mode === 'ready') return 'ready';
  return 'idle';
}

function rgb(c: Rgb): string {
  return `rgb(${c.r}, ${c.g}, ${c.b})`;
}

function rgba(c: Rgb, a: number): string {
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${a})`;
}

function lighten(c: Rgb, amount: number): Rgb {
  return {
    r: Math.round(c.r + (255 - c.r) * amount),
    g: Math.round(c.g + (255 - c.g) * amount),
    b: Math.round(c.b + (255 - c.b) * amount),
  };
}

function darken(c: Rgb, amount: number): Rgb {
  return {
    r: Math.round(c.r * (1 - amount)),
    g: Math.round(c.g * (1 - amount)),
    b: Math.round(c.b * (1 - amount)),
  };
}
