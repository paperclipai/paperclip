import { i18n } from "./index";
import { createDomTranslator, installDisplayDateLocale, startDomTranslation, type DisplayCatalog } from "./display-dom";

export type { DisplayCatalog };

export const DISPLAY_LOCALE_STORAGE_KEY = "paperclip:locale";
export const DISPLAY_LOCALES = ["en", "fr"] as const;
export type DisplayLocale = (typeof DISPLAY_LOCALES)[number];
export type DisplayValues = Record<string, unknown>;
export type DisplayTranslator = (text: string, values?: DisplayValues) => string;

const catalogLoaders = import.meta.glob<DisplayCatalog>("./display/*.json", { import: "default" });

let activeLocale: DisplayLocale = "en";
let activeTranslator: DisplayTranslator | null = null;

function placeholderSignature(text: string): string {
  return Array.from(text.matchAll(/\{\{[^{}]+\}\}/g), (match) => match[0]).sort().join("\u0000");
}

const MAX_TRANSLATED_VALUE_LENGTH = 60;

function interpolate(text: string, values: DisplayValues, catalog?: DisplayCatalog): string {
  return text.replace(/\{\{(v\d+)\}\}/g, (token, key: string) => {
    if (!Object.prototype.hasOwnProperty.call(values, key)) return token;
    const value = values[key];
    if (catalog && typeof value === "string") {
      const label = normalizeDisplayText(value);
      if (
        label.length <= MAX_TRANSLATED_VALUE_LENGTH &&
        Object.prototype.hasOwnProperty.call(catalog, label) &&
        !catalog[label].includes("{{")
      ) {
        return catalog[label];
      }
    }
    return String(value);
  });
}

export function normalizeDisplayText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function createDisplayTranslator(catalog: DisplayCatalog): DisplayTranslator {
  return (text, values) => {
    let result = text;
    const key = normalizeDisplayText(text);
    if (Object.prototype.hasOwnProperty.call(catalog, key)) {
      const translated = catalog[key];
      if (placeholderSignature(translated) === placeholderSignature(key)) {
        result = (text.match(/^\s*/)?.[0] ?? "") + translated + (text.match(/\s*$/)?.[0] ?? "");
      }
    }
    return values ? interpolate(result, values, catalog) : result;
  };
}

export function displayText(text: string, values?: DisplayValues): string {
  if (activeTranslator) return activeTranslator(text, values);
  return values ? interpolate(text, values) : text;
}

function matchDisplayLocale(value: string): DisplayLocale | null {
  const normalized = value.trim().toLowerCase();
  return DISPLAY_LOCALES.find((locale) => normalized === locale || normalized.startsWith(`${locale}-`)) ?? null;
}

export function resolveDisplayLocale(stored: string | null | undefined, preferred: readonly string[]): DisplayLocale {
  const storedLocale = stored ? matchDisplayLocale(stored) : null;
  if (storedLocale) return storedLocale;
  for (const language of preferred) {
    const locale = matchDisplayLocale(language);
    if (locale) return locale;
  }
  return "en";
}

export function getDisplayLocale(): DisplayLocale {
  return activeLocale;
}

export function readStoredDisplayLocale(): string | null {
  try {
    return globalThis.localStorage?.getItem(DISPLAY_LOCALE_STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

export function setDisplayLocale(locale: DisplayLocale): void {
  try {
    globalThis.localStorage?.setItem(DISPLAY_LOCALE_STORAGE_KEY, locale);
  } catch {
    return;
  }
}

function preferredLanguages(): readonly string[] {
  if (typeof navigator === "undefined") return [];
  if (navigator.languages?.length) return navigator.languages;
  return navigator.language ? [navigator.language] : [];
}

export async function initDisplayLanguage(): Promise<DisplayLocale> {
  const locale = resolveDisplayLocale(readStoredDisplayLocale(), preferredLanguages());
  if (locale === "en") return "en";
  const load = catalogLoaders[`./display/${locale}.json`];
  if (!load) return "en";
  let catalog: DisplayCatalog;
  try {
    catalog = await load();
  } catch {
    return "en";
  }
  activeLocale = locale;
  activeTranslator = createDisplayTranslator(catalog);
  await i18n.changeLanguage(locale);
  if (typeof document !== "undefined") {
    document.documentElement.lang = locale;
    installDisplayDateLocale(globalThis, locale);
    startDomTranslation(document.body, createDomTranslator(catalog));
  }
  return locale;
}
