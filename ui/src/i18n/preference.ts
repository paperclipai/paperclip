export const LOCALE_STORAGE_KEY = "paperclip.locale";

export const SELECTABLE_LOCALES = ["en", "ru"] as const;

export type SelectableLocale = (typeof SELECTABLE_LOCALES)[number];

export function isSelectableLocale(value: string | null | undefined): value is SelectableLocale {
  return value === "en" || value === "ru";
}

export function readStoredLocale(): SelectableLocale {
  try {
    if (typeof localStorage === "undefined") return "en";
    const stored = localStorage.getItem(LOCALE_STORAGE_KEY);
    if (isSelectableLocale(stored)) return stored;
  } catch {
    // Private mode and the node test runner have no usable storage.
  }
  return "en";
}

export function writeStoredLocale(locale: SelectableLocale) {
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // The in-memory i18next language still changes for this page load.
  }
}

export function applyDocumentLang(locale: string) {
  if (typeof document === "undefined") return;
  document.documentElement.lang = locale;
}
