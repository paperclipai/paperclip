import { ACTIVE_LOCALES, type ActiveLocale } from "./types";

export const DEFAULT_LOCALE: ActiveLocale = "en";
export const PAPERCLIP_LOCALE_STORAGE_KEY = "paperclip.locale";
export const MESSENGER_LOCALE_STORAGE_KEYS = [
  "hublit-ui-lang",
  "preferred_ui_language",
  "ui_language",
] as const;

export function normalizeLocale(input: string | null | undefined): ActiveLocale {
  const raw = input?.trim().toLowerCase();
  if (!raw) return DEFAULT_LOCALE;
  if (ACTIVE_LOCALES.includes(raw as ActiveLocale)) return raw as ActiveLocale;
  const base = raw.split("-")[0];
  if (ACTIVE_LOCALES.includes(base as ActiveLocale)) return base as ActiveLocale;
  return DEFAULT_LOCALE;
}

export function resolveInitialLocale(
  storedLocale: string | null | undefined,
  navigatorLanguages: string[] | readonly string[] | null | undefined,
): ActiveLocale {
  if (storedLocale) return normalizeLocale(storedLocale);
  for (const language of navigatorLanguages ?? []) {
    return normalizeLocale(language);
  }
  return DEFAULT_LOCALE;
}

export function readStoredLocalePreference(): string | null {
  if (typeof window === "undefined") return null;
  for (const key of MESSENGER_LOCALE_STORAGE_KEYS) {
    const value = window.localStorage.getItem(key);
    if (value) return value;
  }
  return window.localStorage.getItem(PAPERCLIP_LOCALE_STORAGE_KEY);
}

export function writeStoredLocalePreference(locale: ActiveLocale) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(PAPERCLIP_LOCALE_STORAGE_KEY, locale);
  for (const key of MESSENGER_LOCALE_STORAGE_KEYS) {
    window.localStorage.setItem(key, locale);
  }
}

export function getRuntimeLocale(): ActiveLocale {
  if (typeof window === "undefined") return DEFAULT_LOCALE;
  return resolveInitialLocale(readStoredLocalePreference(), window.navigator.languages);
}
