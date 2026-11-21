import { DEFAULT_LOCALE, localeMessages } from "./locales";

export const LOCALE_STORAGE_KEY = "paperclip.locale";
export const MIN_SELECTABLE_COVERAGE = 0.8;

function collectLeaves(node: unknown, prefix: string, out: Map<string, string>) {
  if (typeof node === "string") {
    out.set(prefix, node);
    return;
  }
  if (!node || typeof node !== "object") return;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    collectLeaves(value, prefix ? `${prefix}.${key}` : key, out);
  }
}

export function localeCoverage(messages: unknown, englishMessages: unknown): number {
  const english = new Map<string, string>();
  const candidate = new Map<string, string>();
  collectLeaves(englishMessages, "", english);
  collectLeaves(messages, "", candidate);
  if (english.size === 0) return 0;
  let translated = 0;
  for (const [key, value] of english) {
    const localized = candidate.get(key);
    if (localized !== undefined && localized !== value) translated += 1;
  }
  return translated / english.size;
}

export function selectableLocales(
  messagesByLocale: Record<string, unknown> = localeMessages,
  minCoverage = MIN_SELECTABLE_COVERAGE,
): string[] {
  const english = messagesByLocale[DEFAULT_LOCALE];
  return Object.keys(messagesByLocale)
    .filter((locale) => locale === DEFAULT_LOCALE || localeCoverage(messagesByLocale[locale], english) >= minCoverage)
    .sort((a, b) => (a === DEFAULT_LOCALE ? -1 : b === DEFAULT_LOCALE ? 1 : a.localeCompare(b)));
}

export function matchLocale(tag: string | null | undefined, available: readonly string[]): string | null {
  if (!tag) return null;
  const normalized = tag.trim().replace(/_/g, "-").toLowerCase();
  if (!normalized) return null;
  const exact = available.find((locale) => locale.toLowerCase() === normalized);
  if (exact) return exact;
  const base = normalized.split("-")[0];
  return available.find((locale) => locale.toLowerCase().split("-")[0] === base) ?? null;
}

export function resolveInitialLocale({
  stored,
  languages,
  available,
}: {
  stored: string | null | undefined;
  languages: readonly string[];
  available: readonly string[];
}): string {
  if (stored && available.includes(stored)) return stored;
  for (const language of languages) {
    const match = matchLocale(language, available);
    if (match) return match;
  }
  return DEFAULT_LOCALE;
}

export function readStoredLocale(): string | null {
  try {
    return globalThis.localStorage?.getItem(LOCALE_STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

export function writeStoredLocale(locale: string) {
  try {
    globalThis.localStorage?.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    return;
  }
}

export function browserLanguages(): readonly string[] {
  if (typeof navigator === "undefined") return [];
  if (Array.isArray(navigator.languages) && navigator.languages.length > 0) return navigator.languages;
  return navigator.language ? [navigator.language] : [];
}

export function localeDisplayName(locale: string): string {
  try {
    const name = new Intl.DisplayNames([locale], { type: "language" }).of(locale);
    if (name) return name.charAt(0).toLocaleUpperCase(locale) + name.slice(1);
  } catch {
    return locale;
  }
  return locale;
}
