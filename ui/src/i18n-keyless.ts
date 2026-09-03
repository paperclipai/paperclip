import {
  getTranslation,
  init,
  resolveLang,
  useCurrentLanguage,
  useI18nKeyless,
  type Lang,
  type TranslationOptions,
} from "i18n-keyless-react";

/**
 * Keyless UI translation.
 *
 * The English string in the JSX is the key. There is no locale file and no key
 * name to invent: the first render of a string in a new language asks the
 * translation server for it, the server translates it once with an LLM and
 * stores it, and every later client gets it from the cache. Reviewers fix a
 * translation on the server dashboard instead of in a 40-file JSON diff.
 *
 * Only `English` ships in the bundle, so an offline or air-gapped instance
 * still renders every string in the primary language.
 */

export const PRIMARY_LANGUAGE: Lang = "en";

/** Every language the translation server can answer for. */
export const SUPPORTED_LANGUAGES: readonly Lang[] = [
  "en",
  "ar",
  "bn",
  "ca",
  "zh-Hans",
  "zh-Hant",
  "hr",
  "cs",
  "da",
  "nl",
  "en-GB",
  "fi",
  "fr",
  "fr-CA",
  "de",
  "el",
  "gu",
  "he",
  "hi",
  "hu",
  "id",
  "it",
  "ja",
  "kn",
  "ko",
  "ms",
  "ml",
  "mr",
  "no",
  "or",
  "pl",
  "pt",
  "pt-BR",
  "pa",
  "ro",
  "ru",
  "sk",
  "sl",
  "es",
  "es-MX",
  "sv",
  "ta",
  "te",
  "th",
  "tr",
  "uk",
  "ur",
  "vi",
];

/**
 * Picks the first browser language Paperclip supports, most preferred first.
 * `zh-CN` resolves to `zh-Hans`, `de-AT` to `de`, an unknown tag to English.
 */
export function detectBrowserLanguage(preferred: readonly string[]): Lang {
  for (const tag of preferred) {
    const lang = resolveLang(tag, { supported: SUPPORTED_LANGUAGES });
    if (lang) return lang;
  }
  return PRIMARY_LANGUAGE;
}

/** Native display name of a language, in that language ("Deutsch", "ไทย"). */
export function languageDisplayName(lang: Lang): string {
  try {
    return new Intl.DisplayNames([lang], { type: "language" }).of(lang) ?? lang;
  } catch {
    return lang;
  }
}

export function initI18nKeyless() {
  void init({
    API_KEY: "TXgf8PpHp3zxLJcc",
    API_URL: "https://i18n-keyless.ambroselli.io",
    storage: window.localStorage,
    languages: {
      primary: PRIMARY_LANGUAGE,
      supported: [...SUPPORTED_LANGUAGES],
      fallback: PRIMARY_LANGUAGE,
      initWithDefault: detectBrowserLanguage(navigator.languages ?? [navigator.language]),
    },
  });
}

/** Disambiguates one-word labels for the translator ("Audit" is a log, not an exam). */
export const NAVIGATION_CONTEXT: TranslationOptions = {
  context: "Navigation menu item in an app that manages AI agents, tasks and projects",
};

/**
 * Reactive translator for string props (`label`, `aria-label`, `placeholder`).
 * Re-renders the caller when the language changes or a translation arrives.
 * `options` applies to every call (`context`, `namespace`, ...).
 * For JSX text prefer `<I18nKeylessText>` from `i18n-keyless-react`.
 *
 * Storybook and unit tests render components without the app entry, so the
 * SDK is not initialized there; the identity function keeps English in that
 * case instead of throwing.
 */
export function useT(options?: TranslationOptions): (text: string) => string {
  useCurrentLanguage();
  useI18nKeyless((state) => state.translations);
  const initialized = useI18nKeyless((state) => Boolean(state.config.API_KEY));
  return initialized ? (text) => getTranslation(text, options) : (text) => text;
}
