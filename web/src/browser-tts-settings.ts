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
export function onBrowserTtsVoicesChanged(cb: (voices: SpeechSynthesisVoice[]) => void): () => void {
  if (typeof window === 'undefined' || !window.speechSynthesis) {
    return () => undefined;
  }
  const synth = window.speechSynthesis;
  const handler = () => cb(synth.getVoices());
  synth.addEventListener('voiceschanged', handler);
  return () => synth.removeEventListener('voiceschanged', handler);
}
