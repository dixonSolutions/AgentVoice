import { Injectable, signal } from '@angular/core';
import { palette, updatePrimaryPalette } from '@openng/optimus-ui-themes';
import type { PaletteDesignToken } from '@openng/optimus-ui-themes/types';

export type AppearanceScheme = 'light' | 'dark' | 'system';

export interface AppearanceSettings {
  scheme: AppearanceScheme;
  tone: string;
}

export const APPEARANCE_TONES = [
  'emerald',
  'green',
  'lime',
  'red',
  'orange',
  'amber',
  'yellow',
  'teal',
  'cyan',
  'sky',
  'blue',
  'indigo',
  'violet',
  'purple',
  'fuchsia',
  'pink',
  'rose',
  'slate',
  'zinc',
  'neutral',
] as const;

export type AppearanceTone = (typeof APPEARANCE_TONES)[number];

const STORAGE_KEY = 'cv-appearance';
const DARK_CLASS = 'app-dark';

/**
 * Fired on `document` after the theme has been applied.
 *
 * Optimus writes the primary palette into an injected <style> element rather
 * than onto <html>, so a MutationObserver cannot see a tone change. Anything
 * caching resolved theme tokens (the voice orb reads `--p-primary-*` into a
 * canvas palette) listens for this instead.
 */
export const APPEARANCE_CHANGED_EVENT = 'cv-appearance-changed';

const DEFAULTS: AppearanceSettings = {
  scheme: 'system',
  tone: 'violet',
};

function isTone(value: string): value is AppearanceTone {
  return (APPEARANCE_TONES as readonly string[]).includes(value);
}

function isScheme(value: unknown): value is AppearanceScheme {
  return value === 'light' || value === 'dark' || value === 'system';
}

function readStored(): AppearanceSettings {
  if (typeof localStorage === 'undefined') return { ...DEFAULTS };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<AppearanceSettings>;
    return {
      scheme: isScheme(parsed.scheme) ? parsed.scheme : DEFAULTS.scheme,
      tone: typeof parsed.tone === 'string' && isTone(parsed.tone) ? parsed.tone : DEFAULTS.tone,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

function prefersDark(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function resolveDark(scheme: AppearanceScheme): boolean {
  if (scheme === 'dark') return true;
  if (scheme === 'light') return false;
  return prefersDark();
}

@Injectable({ providedIn: 'root' })
export class AppearanceService {
  private readonly settingsSignal = signal<AppearanceSettings>(readStored());
  private mediaQuery: MediaQueryList | null = null;
  private mediaListener: ((event: MediaQueryListEvent) => void) | null = null;

  readonly settings = this.settingsSignal.asReadonly();

  /** Apply stored appearance and listen for system scheme changes. Call once at app start. */
  init(): void {
    this.apply(this.settingsSignal());
    this.bindSystemListener();
  }

  setScheme(scheme: AppearanceScheme): void {
    this.persist({ ...this.settingsSignal(), scheme });
  }

  setTone(tone: string): void {
    const nextTone = isTone(tone) ? tone : DEFAULTS.tone;
    this.persist({ ...this.settingsSignal(), tone: nextTone });
  }

  setAppearance(partial: Partial<AppearanceSettings>): void {
    const current = this.settingsSignal();
    this.persist({
      scheme: isScheme(partial.scheme) ? partial.scheme : current.scheme,
      tone:
        typeof partial.tone === 'string' && isTone(partial.tone)
          ? partial.tone
          : current.tone,
    });
  }

  private persist(next: AppearanceSettings): void {
    this.settingsSignal.set(next);
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    }
    this.apply(next);
    this.bindSystemListener();
  }

  private apply(settings: AppearanceSettings): void {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    const dark = resolveDark(settings.scheme);
    root.classList.toggle(DARK_CLASS, dark);
    root.classList.remove('p-dark');

    updatePrimaryPalette(palette(`{${settings.tone}}`) as PaletteDesignToken);
    this.updateThemeColorMeta(dark);
    document.dispatchEvent(new CustomEvent(APPEARANCE_CHANGED_EVENT));
  }

  private updateThemeColorMeta(dark: boolean): void {
    if (typeof document === 'undefined') return;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) return;
    const styles = getComputedStyle(document.documentElement);
    const surface =
      styles.getPropertyValue('--p-surface-ground').trim() ||
      styles.getPropertyValue('--p-content-background').trim();
    const primary = styles.getPropertyValue('--p-primary-color').trim();
    const fallback = dark ? '#0f172a' : '#f8fafc';
    meta.setAttribute('content', surface || primary || fallback);
  }

  private bindSystemListener(): void {
    if (typeof window === 'undefined' || !window.matchMedia) return;

    if (this.mediaQuery && this.mediaListener) {
      this.mediaQuery.removeEventListener('change', this.mediaListener);
      this.mediaQuery = null;
      this.mediaListener = null;
    }

    if (this.settingsSignal().scheme !== 'system') return;

    this.mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    this.mediaListener = () => this.apply(this.settingsSignal());
    this.mediaQuery.addEventListener('change', this.mediaListener);
  }
}
