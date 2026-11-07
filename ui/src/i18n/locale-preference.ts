export const selectableLocales = ["en", "zh-CN"] as const;

export type SelectableLocale = (typeof selectableLocales)[number];

const STORAGE_KEY = "paperclip.locale";
let memoryLocale: SelectableLocale | undefined;

export function isSelectableLocale(value: unknown): value is SelectableLocale {
  return selectableLocales.some((locale) => locale === value);
}

export function readLocalePreference(): SelectableLocale {
  if (memoryLocale) return memoryLocale;
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return isSelectableLocale(stored) ? stored : "en";
  } catch {
    return "en";
  }
}

export function writeLocalePreference(locale: SelectableLocale): void {
  if (!isSelectableLocale(locale)) throw new RangeError(`Unsupported locale: ${locale}`);
  memoryLocale = locale;
  try {
    localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    return;
  }
}
