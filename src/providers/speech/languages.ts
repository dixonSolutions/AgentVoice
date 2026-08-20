/**
 * Language catalog and capability matching, shared by speech-to-text and
 * text-to-speech.
 *
 * Two different questions get asked of this module:
 *   1. "What can the user pick?" — the catalog below.
 *   2. "Can provider X actually do `pl`?" — `supportsLanguage`, which is what
 *      lets the bridge skip a provider that would fail and delegate to the
 *      next one in the fallback chain instead of returning an error.
 *
 * Codes are ISO-639-1 throughout. Locale tags (`en-US`, `pt-BR`) are accepted
 * everywhere and narrowed to their base language for matching, because most
 * speech APIs key on the language, not the region.
 */

/** Every language a provider can do — used by Gemini-class multimodal models. */
export type LanguageSupportAll = 'all';
/** The fixed 99-language set the Whisper family was trained on. */
export type LanguageSupportWhisper = 'whisper';
export type LanguageSupport = LanguageSupportAll | LanguageSupportWhisper | readonly string[];

export interface LanguageInfo {
  /** ISO-639-1. */
  code: string;
  /** English name. */
  name: string;
  /** Endonym, shown alongside so speakers recognize their own language. */
  nativeName: string;
}

/**
 * Whisper's training languages (large-v3, including `yue`). This is a property
 * of the model weights, not of any one vendor, so Groq, OpenAI `whisper-1`, and
 * every self-hosted faster-whisper build share it.
 */
export const WHISPER_LANGUAGES: readonly string[] = [
  'af', 'am', 'ar', 'as', 'az', 'ba', 'be', 'bg', 'bn', 'bo', 'br', 'bs', 'ca', 'cs', 'cy',
  'da', 'de', 'el', 'en', 'es', 'et', 'eu', 'fa', 'fi', 'fo', 'fr', 'gl', 'gu', 'ha', 'haw',
  'he', 'hi', 'hr', 'ht', 'hu', 'hy', 'id', 'is', 'it', 'ja', 'jw', 'ka', 'kk', 'km', 'kn',
  'ko', 'la', 'lb', 'ln', 'lo', 'lt', 'lv', 'mg', 'mi', 'mk', 'ml', 'mn', 'mr', 'ms', 'mt',
  'my', 'ne', 'nl', 'nn', 'no', 'oc', 'pa', 'pl', 'ps', 'pt', 'ro', 'ru', 'sa', 'sd', 'si',
  'sk', 'sl', 'sn', 'so', 'sq', 'sr', 'su', 'sv', 'sw', 'ta', 'te', 'tg', 'th', 'tk', 'tl',
  'tr', 'tt', 'uk', 'ur', 'uz', 'vi', 'yi', 'yo', 'yue', 'zh',
];

const WHISPER_SET = new Set(WHISPER_LANGUAGES);

/**
 * Pickable languages. Deliberately broader than any single provider supports —
 * the UI marks which ones the *selected* provider can actually handle, so an
 * unsupported choice is visible before it fails rather than after.
 */
export const LANGUAGES: readonly LanguageInfo[] = [
  { code: 'ar', name: 'Arabic', nativeName: 'العربية' },
  { code: 'bg', name: 'Bulgarian', nativeName: 'Български' },
  { code: 'bn', name: 'Bengali', nativeName: 'বাংলা' },
  { code: 'ca', name: 'Catalan', nativeName: 'Català' },
  { code: 'cs', name: 'Czech', nativeName: 'Čeština' },
  { code: 'da', name: 'Danish', nativeName: 'Dansk' },
  { code: 'de', name: 'German', nativeName: 'Deutsch' },
  { code: 'el', name: 'Greek', nativeName: 'Ελληνικά' },
  { code: 'en', name: 'English', nativeName: 'English' },
  { code: 'es', name: 'Spanish', nativeName: 'Español' },
  { code: 'et', name: 'Estonian', nativeName: 'Eesti' },
  { code: 'fa', name: 'Persian', nativeName: 'فارسی' },
  { code: 'fi', name: 'Finnish', nativeName: 'Suomi' },
  { code: 'fr', name: 'French', nativeName: 'Français' },
  { code: 'he', name: 'Hebrew', nativeName: 'עברית' },
  { code: 'hi', name: 'Hindi', nativeName: 'हिन्दी' },
  { code: 'hr', name: 'Croatian', nativeName: 'Hrvatski' },
  { code: 'hu', name: 'Hungarian', nativeName: 'Magyar' },
  { code: 'id', name: 'Indonesian', nativeName: 'Bahasa Indonesia' },
  { code: 'it', name: 'Italian', nativeName: 'Italiano' },
  { code: 'ja', name: 'Japanese', nativeName: '日本語' },
  { code: 'kk', name: 'Kazakh', nativeName: 'Қазақ' },
  { code: 'ko', name: 'Korean', nativeName: '한국어' },
  { code: 'lt', name: 'Lithuanian', nativeName: 'Lietuvių' },
  { code: 'lv', name: 'Latvian', nativeName: 'Latviešu' },
  { code: 'ms', name: 'Malay', nativeName: 'Bahasa Melayu' },
  { code: 'nl', name: 'Dutch', nativeName: 'Nederlands' },
  { code: 'no', name: 'Norwegian', nativeName: 'Norsk' },
  { code: 'pl', name: 'Polish', nativeName: 'Polski' },
  { code: 'pt', name: 'Portuguese', nativeName: 'Português' },
  { code: 'ro', name: 'Romanian', nativeName: 'Română' },
  { code: 'ru', name: 'Russian', nativeName: 'Русский' },
  { code: 'sk', name: 'Slovak', nativeName: 'Slovenčina' },
  { code: 'sl', name: 'Slovenian', nativeName: 'Slovenščina' },
  { code: 'sr', name: 'Serbian', nativeName: 'Српски' },
  { code: 'sv', name: 'Swedish', nativeName: 'Svenska' },
  { code: 'sw', name: 'Swahili', nativeName: 'Kiswahili' },
  { code: 'ta', name: 'Tamil', nativeName: 'தமிழ்' },
  { code: 'te', name: 'Telugu', nativeName: 'తెలుగు' },
  { code: 'th', name: 'Thai', nativeName: 'ไทย' },
  { code: 'tl', name: 'Tagalog', nativeName: 'Tagalog' },
  { code: 'tr', name: 'Turkish', nativeName: 'Türkçe' },
  { code: 'uk', name: 'Ukrainian', nativeName: 'Українська' },
  { code: 'ur', name: 'Urdu', nativeName: 'اردو' },
  { code: 'vi', name: 'Vietnamese', nativeName: 'Tiếng Việt' },
  { code: 'zh', name: 'Chinese', nativeName: '中文' },
];

const LANGUAGE_BY_CODE = new Map(LANGUAGES.map((l) => [l.code, l]));

/** `auto`, or a language code the app knows how to talk about. */
export const AUTO_LANGUAGE = 'auto';

/** `en-US` → `en`; `auto`/empty → null. */
export function baseLanguage(code: string | undefined | null): string | null {
  const trimmed = code?.trim().toLowerCase();
  if (!trimmed || trimmed === AUTO_LANGUAGE) return null;
  const base = trimmed.split(/[-_]/)[0] ?? '';
  return base.length >= 2 ? base : null;
}

export function languageInfo(code: string): LanguageInfo | null {
  return LANGUAGE_BY_CODE.get(baseLanguage(code) ?? '') ?? null;
}

export function languageLabel(code: string): string {
  if (!baseLanguage(code)) return 'Auto-detect';
  const info = languageInfo(code);
  if (!info) return code;
  return info.name === info.nativeName ? info.name : `${info.name} (${info.nativeName})`;
}

/**
 * Can this provider handle the language?
 *
 * `auto` is always true — the caller has not committed to a language, so no
 * provider can be ruled out on that basis.
 */
export function supportsLanguage(support: LanguageSupport, code: string | undefined): boolean {
  const base = baseLanguage(code);
  if (!base) return true;
  if (support === 'all') return true;
  if (support === 'whisper') return WHISPER_SET.has(base);
  return support.some((c) => baseLanguage(c) === base);
}

/** Codes a provider supports, intersected with the pickable catalog. */
export function supportedCatalogCodes(support: LanguageSupport): string[] {
  return LANGUAGES.filter((l) => supportsLanguage(support, l.code)).map((l) => l.code);
}

/**
 * Best-effort BCP-47 tag for APIs that insist on a region (Polly, Amazon
 * Transcribe, browser speechSynthesis). Chosen as the most widely deployed
 * locale per language rather than anything culturally normative.
 */
const DEFAULT_LOCALE: Record<string, string> = {
  ar: 'ar-AE', bg: 'bg-BG', bn: 'bn-IN', ca: 'ca-ES', cs: 'cs-CZ', da: 'da-DK', de: 'de-DE',
  el: 'el-GR', en: 'en-US', es: 'es-ES', et: 'et-EE', fa: 'fa-IR', fi: 'fi-FI', fr: 'fr-FR',
  he: 'he-IL', hi: 'hi-IN', hr: 'hr-HR', hu: 'hu-HU', id: 'id-ID', it: 'it-IT', ja: 'ja-JP',
  kk: 'kk-KZ', ko: 'ko-KR', lt: 'lt-LT', lv: 'lv-LV', ms: 'ms-MY', nl: 'nl-NL', no: 'nb-NO',
  pl: 'pl-PL', pt: 'pt-PT', ro: 'ro-RO', ru: 'ru-RU', sk: 'sk-SK', sl: 'sl-SI', sr: 'sr-RS',
  sv: 'sv-SE', sw: 'sw-KE', ta: 'ta-IN', te: 'te-IN', th: 'th-TH', tl: 'fil-PH', tr: 'tr-TR',
  uk: 'uk-UA', ur: 'ur-PK', vi: 'vi-VN', zh: 'cmn-CN',
};

export function defaultLocale(code: string | undefined, fallback = 'en-US'): string {
  const base = baseLanguage(code);
  if (!base) return fallback;
  return DEFAULT_LOCALE[base] ?? `${base}-${base.toUpperCase()}`;
}
