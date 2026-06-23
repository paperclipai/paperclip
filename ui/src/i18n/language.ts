import { DEFAULT_LOCALE, supportedLocales } from "./locales";

/**
 * Persisted-language storage key. Mirrors the `paperclip.theme` convention used
 * by {@link ../context/ThemeContext} so all user-chrome preferences share a
 * predictable namespace in `localStorage`.
 */
export const LANGUAGE_STORAGE_KEY = "paperclip.language";

export interface LanguageOption {
  /** i18next locale code, e.g. `"en"`, `"zh-CN"`. */
  code: string;
  /** Native name shown in the switcher (e.g. `简体中文`). */
  nativeLabel: string;
  /** English name, used for tooltips / `aria-label`. */
  englishLabel: string;
}

/**
 * Languages surfaced as first-class choices in the in-app switcher. Every code
 * here must exist in {@link supportedLocales} (i.e. have a `locales/<code>.json`
 * file). Other registered locales remain available through i18next's resource
 * map and fall back gracefully, but are not advertised until translated.
 */
export const LANGUAGE_OPTIONS: LanguageOption[] = [
  { code: "en", nativeLabel: "English", englishLabel: "English" },
  { code: "zh-CN", nativeLabel: "简体中文", englishLabel: "Chinese (Simplified)" },
  { code: "zh-TW", nativeLabel: "繁體中文", englishLabel: "Chinese (Traditional)" },
];

/** Right-to-left base languages (used to set `<html dir>`). */
const RTL_BASE_LANGUAGES = new Set(["ar", "he", "fa", "ur"]);

export function isRtlLocale(locale: string): boolean {
  const base = locale.split("-")[0] ?? locale;
  return RTL_BASE_LANGUAGES.has(base);
}

/**
 * Map an arbitrary BCP-47 tag to the closest supported locale, or `null` when
 * nothing matches. Tries the exact tag, then the base language, then the first
 * supported locale that shares the base (so `zh` resolves to `zh-CN`).
 */
function normalizeToSupported(locale: string | null | undefined): string | null {
  if (!locale) return null;
  if (supportedLocales.includes(locale)) return locale;
  const base = locale.split("-")[0] ?? "";
  if (base && supportedLocales.includes(base)) return base;
  return supportedLocales.find((candidate) => (candidate.split("-")[0] ?? "") === base) ?? null;
}

export function readStoredLanguage(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return normalizeToSupported(window.localStorage.getItem(LANGUAGE_STORAGE_KEY));
  } catch {
    return null;
  }
}

export function detectBrowserLanguage(): string | null {
  if (typeof navigator === "undefined") return null;
  const candidates = [navigator.language, ...(navigator.languages ?? [])];
  for (const candidate of candidates) {
    const match = normalizeToSupported(candidate);
    if (match) return match;
  }
  return null;
}

/**
 * Resolve the language to boot with: an explicit saved choice wins, then the
 * browser preference, then the default locale.
 */
export function resolveInitialLanguage(): string {
  return readStoredLanguage() ?? detectBrowserLanguage() ?? DEFAULT_LOCALE;
}

export function persistLanguage(locale: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, locale);
  } catch {
    /* storage may be unavailable (private mode, quota) — preference is best-effort */
  }
}

/** Reflect the active locale onto `<html lang>` / `<html dir>`. */
export function applyDocumentLanguage(locale: string): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.setAttribute("lang", locale);
  root.setAttribute("dir", isRtlLocale(locale) ? "rtl" : "ltr");
}
