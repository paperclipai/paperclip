export const LOCALE_STORAGE_KEY = "paperclip.locale";

export const SELECTABLE_LOCALES = ["en", "ru"] as const;

export type SelectableLocale = (typeof SELECTABLE_LOCALES)[number];

export function isSelectableLocale(value: string | null | undefined): value is SelectableLocale {
  return typeof value === "string" && (SELECTABLE_LOCALES as readonly string[]).includes(value);
}

/** The open menu choice, then an exact selectable code, then its language subtag. */
export function selectedSelectableLocale(resolved: string | null | undefined): SelectableLocale {
  const chosen = readChosenLocale();
  if (chosen) return chosen;
  if (isSelectableLocale(resolved)) return resolved;
  const base = resolved?.toLowerCase().split("-")[0];
  if (isSelectableLocale(base)) return base;
  return "en";
}

let chosenLocale: SelectableLocale | null = null;

export function noteUiLanguageChoice(locale: SelectableLocale) {
  chosenLocale = locale;
}

export function readChosenLocale(): SelectableLocale | null {
  return chosenLocale;
}

export function clearUiLanguageChoice() {
  chosenLocale = null;
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
