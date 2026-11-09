import type { Resource } from "i18next";

import en from "./locales/en.json";
import { assertValidLocaleMessages } from "./locale-validation";

export const DEFAULT_LOCALE = "en" as const;

// Only English ships in the startup bundle; every other catalog is fetched on demand.
const localeLoaders = import.meta.glob(["./locales/*.json", "!./locales/en.json"], {
  import: "default",
}) as Record<string, () => Promise<unknown>>;

function localeOf(path: string) {
  const locale = path.match(/\/([A-Za-z0-9_-]+)\.json$/)?.[1];
  if (!locale) {
    throw new Error(`Invalid locale file path: ${path}`);
  }
  return locale;
}

assertValidLocaleMessages(en);

const loaders = new Map(Object.entries(localeLoaders).map(([path, load]) => [localeOf(path), load]));

export const supportedLocales: string[] = [DEFAULT_LOCALE, ...loaders.keys()];

export const i18nextResources: Resource = { [DEFAULT_LOCALE]: { translation: en } } as Resource;

export async function loadLocaleMessages(locale: string): Promise<unknown> {
  if (locale === DEFAULT_LOCALE) return en;
  const load = loaders.get(locale);
  if (!load) throw new Error(`Unsupported locale: ${locale}`);
  const messages = await load();
  try {
    assertValidLocaleMessages(messages);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid ${locale} locale messages: ${message}`);
  }
  return messages;
}
