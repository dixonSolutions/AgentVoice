/**
 * Per-device browser TTS preferences — stored in localStorage on the PWA.
 *
 * Server defaults live in config.json `settings.voice.tts.webkit`.
 * This module merges server defaults with the profile for the current browser.
 */

export interface WebkitTtsDefaults {
  rate: number;
  pitch: number;
  volume: number;
  lang: string;
}

export interface BrowserTtsOptions {
  voiceURI?: string;
  lang?: string;
  rate?: number;
  pitch?: number;
  volume?: number;
}

export interface BrowserTtsProfile {
  id: string;
  label: string;
  userAgent: string;
  options: BrowserTtsOptions;
  updatedAt: string;
}

export interface ResolvedBrowserTts {
  voiceURI?: string;
  lang: string;
  rate: number;
  pitch: number;
  volume: number;
}

const STORAGE_KEY = 'cv-browser-tts-profiles';

function readStore(): BrowserTtsProfile[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (p): p is BrowserTtsProfile =>
        typeof p === 'object' &&
        p !== null &&
        typeof (p as BrowserTtsProfile).id === 'string' &&
        typeof (p as BrowserTtsProfile).label === 'string',
    );
  } catch {
    return [];
  }
}

function writeStore(profiles: BrowserTtsProfile[]): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(profiles));
}

/** Stable id for the current browser + OS (not a fingerprint). */
export function currentBrowserProfileId(): string {
  if (typeof navigator === 'undefined') return 'unknown';
  const ua = navigator.userAgent;
  let browser = 'browser';
  if (/Edg\//.test(ua)) browser = 'edge';
  else if (/Chrome\//.test(ua) && !/Edg\//.test(ua)) browser = 'chrome';
  else if (/Firefox\//.test(ua)) browser = 'firefox';
  else if (/Safari\//.test(ua) && !/Chrome\//.test(ua)) browser = 'safari';

  let os = 'unknown';
  if (/iPhone|iPad|iPod/.test(ua)) os = 'ios';
  else if (/Android/.test(ua)) os = 'android';
  else if (/Mac OS X/.test(ua)) os = 'macos';
  else if (/Windows/.test(ua)) os = 'windows';
  else if (/Linux/.test(ua)) os = 'linux';

  return `${browser}-${os}`;
}

/** Human-readable label for the current browser. */
export function detectBrowserLabel(): string {
  if (typeof navigator === 'undefined') return 'Unknown browser';
  const ua = navigator.userAgent;
  let browser = 'Browser';
  if (/Edg\//.test(ua)) browser = 'Edge';
  else if (/Chrome\//.test(ua) && !/Edg\//.test(ua)) browser = 'Chrome';
  else if (/Firefox\//.test(ua)) browser = 'Firefox';
  else if (/Safari\//.test(ua) && !/Chrome\//.test(ua)) browser = 'Safari';

  let os = '';
  if (/iPhone/.test(ua)) os = 'iPhone';
  else if (/iPad/.test(ua)) os = 'iPad';
  else if (/Android/.test(ua)) os = 'Android';
  else if (/Mac OS X/.test(ua)) os = 'macOS';
  else if (/Windows/.test(ua)) os = 'Windows';
  else if (/Linux/.test(ua)) os = 'Linux';

  return os ? `${browser} on ${os}` : browser;
}

export function listBrowserTtsProfiles(): BrowserTtsProfile[] {
  return readStore().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function getBrowserTtsProfile(id: string): BrowserTtsProfile | undefined {
  return readStore().find((p) => p.id === id);
}

export function getCurrentBrowserTtsProfile(): BrowserTtsProfile | undefined {
  return getBrowserTtsProfile(currentBrowserProfileId());
}

export function saveBrowserTtsProfile(
  id: string,
  options: BrowserTtsOptions,
  label?: string,
): BrowserTtsProfile {
  const profiles = readStore();
  const idx = profiles.findIndex((p) => p.id === id);
  const profile: BrowserTtsProfile = {
    id,
    label: label?.trim() || (idx >= 0 ? profiles[idx]!.label : detectBrowserLabel()),
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
    options,
    updatedAt: new Date().toISOString(),
  };
  if (idx >= 0) {
    profiles[idx] = profile;
  } else {
    profiles.push(profile);
  }
  writeStore(profiles);
  return profile;
}

export function deleteBrowserTtsProfile(id: string): void {
  writeStore(readStore().filter((p) => p.id !== id));
}

export function resolveBrowserTtsOptions(
  serverDefaults: WebkitTtsDefaults,
  profileId = currentBrowserProfileId(),
): ResolvedBrowserTts {
  const profile = getBrowserTtsProfile(profileId);
  const opts = profile?.options ?? {};
  return {
    voiceURI: opts.voiceURI,
    lang: opts.lang ?? serverDefaults.lang,
    rate: opts.rate ?? serverDefaults.rate,
    pitch: opts.pitch ?? serverDefaults.pitch,
    volume: opts.volume ?? serverDefaults.volume,
  };
}

/** Voices exposed by speechSynthesis — call after user gesture on iOS. */
export function listBrowserTtsVoices(): SpeechSynthesisVoice[] {
  if (typeof window === 'undefined' || !window.speechSynthesis) return [];
  return window.speechSynthesis.getVoices();
}

export interface CurateBrowserVoicesOptions {
  /** Preferred BCP-47 language (e.g. en-US). */
  preferredLang?: string;
  /** Always keep this voiceURI even if it would be filtered out. */
  selectedVoiceURI?: string;
  /**
   * When false (default), drop remote/espeak-style bulk voices that Firefox
   * often dumps by the hundreds — those freeze PrimeNG/select overlays.
   */
  includeRemote?: boolean;
  /** Hard cap after curation (default 48). */
  maxVoices?: number;
}

function langPrefix(code: string | undefined): string {
  return (code ?? '').trim().toLowerCase().split('-')[0] ?? '';
}

function isLikelyEspeakBulk(voice: SpeechSynthesisVoice): boolean {
  const name = voice.name.toLowerCase();
  return (
    name.includes('klatt') ||
    name.includes('norbert') ||
    name.includes('shelby') ||
    name.includes('+male') ||
    name.includes('+female') ||
    (name.includes('whisper') && name.includes('+')) ||
    /^[a-z]+\+[a-z0-9]+$/i.test(voice.name)
  );
}

/**
 * Curate speechSynthesis voices for UI pickers.
 * Firefox/Linux can expose 200–1000+ remote espeak voices; rendering all of them
 * in a filtered overlay freezes the page.
 */
export function curateBrowserTtsVoices(
  voices: SpeechSynthesisVoice[],
  opts: CurateBrowserVoicesOptions = {},
): SpeechSynthesisVoice[] {
  const maxVoices = opts.maxVoices ?? 48;
  const includeRemote = opts.includeRemote === true;
  const preferred = langPrefix(opts.preferredLang);
  const navLang =
    typeof navigator !== 'undefined' ? langPrefix(navigator.language) : '';
  const preferredSet = new Set(
    [preferred, navLang, 'en'].filter((x) => x.length > 0),
  );

  const selected = opts.selectedVoiceURI
    ? voices.find((v) => v.voiceURI === opts.selectedVoiceURI)
    : undefined;

  let pool = voices.filter((v) => {
    if (selected && v.voiceURI === selected.voiceURI) return true;
    if (includeRemote) return true;
    // Default: local voices + preferred-language remotes (skip espeak bulk dumps).
    if (isLikelyEspeakBulk(v)) return false;
    if (v.localService) return true;
    return preferredSet.has(langPrefix(v.lang));
  });

  // Last resort when the platform exposes only remote bulk voices.
  if (pool.length === 0) {
    pool = voices.filter((v) => {
      if (selected && v.voiceURI === selected.voiceURI) return true;
      return preferredSet.has(langPrefix(v.lang));
    });
  }

  const scored = pool
    .map((v, index) => {
      const lp = langPrefix(v.lang);
      let score = 0;
      if (v.localService) score += 100;
      if (preferred && lp === preferred) score += 50;
      if (preferredSet.has(lp)) score += 25;
      if (v.default) score += 10;
      if (isLikelyEspeakBulk(v)) score -= 40;
      return { v, score, index };
    })
    .sort((a, b) => b.score - a.score || a.v.name.localeCompare(b.v.name));

  const out: SpeechSynthesisVoice[] = [];
  const seen = new Set<string>();
  for (const { v } of scored) {
    const key = `${v.name.toLowerCase()}|${v.lang.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
    if (out.length >= maxVoices) break;
  }

  if (selected && !out.some((v) => v.voiceURI === selected.voiceURI)) {
    out.unshift(selected);
    if (out.length > maxVoices) out.length = maxVoices;
  }

  return out;
}

/**
 * Wait for the browser to populate speechSynthesis voices (Chrome often loads async).
 * Resolves with whatever is available after voiceschanged or a short timeout.
 */
export function listBrowserTtsVoicesAsync(timeoutMs = 1500): Promise<SpeechSynthesisVoice[]> {
  if (typeof window === 'undefined' || !window.speechSynthesis) {
    return Promise.resolve([]);
  }
  const synth = window.speechSynthesis;
  const immediate = synth.getVoices();
  if (immediate.length > 0) return Promise.resolve(immediate);

  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      synth.removeEventListener('voiceschanged', onChange);
      resolve(synth.getVoices());
    };
    const onChange = () => finish();
    synth.addEventListener('voiceschanged', onChange);
    window.setTimeout(finish, timeoutMs);
  });
}

/** Subscribe to voice catalog changes; returns an unsubscribe function. */
export function onBrowserTtsVoicesChanged(
  cb: (voices: SpeechSynthesisVoice[]) => void,
  debounceMs = 250,
): () => void {
  if (typeof window === 'undefined' || !window.speechSynthesis) {
    return () => undefined;
  }
  const synth = window.speechSynthesis;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const handler = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      cb(synth.getVoices());
    }, debounceMs);
  };
  synth.addEventListener('voiceschanged', handler);
  return () => {
    if (timer) clearTimeout(timer);
    synth.removeEventListener('voiceschanged', handler);
  };
}
