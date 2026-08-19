import type { Resource } from "i18next";

import enMessages from "./locales/en.json";
import { assertValidLocaleMessages } from "./locale-validation";

export const DEFAULT_LOCALE = "en" as const;

// Per-locale lazy loaders. `en` (the default) is bundled synchronously below so
// the app renders immediately; every other locale's JSON is code-split and only
// fetched the first time that locale is activated. Previously all ~40 locales
// were `eager`-globbed into the entry chunk — pure dead weight for
// the common `en` path.
const localeLoaders = import.meta.glob("./locales/*.json", {
  import: "default",
}) as Record<string, () => Promise<unknown>>;

function localeFromPath(path: string): string {
  const locale = path.match(/\/([A-Za-z0-9_-]+)\.json$/)?.[1];
  if (!locale) {
    throw new Error(`Invalid locale file path: ${path}`);
  }
  return locale;
}

const loadersByLocale = new Map<string, () => Promise<unknown>>(
  Object.entries(localeLoaders).map(([path, loader]) => [localeFromPath(path), loader]),
);

if (!loadersByLocale.has(DEFAULT_LOCALE)) {
  throw new Error(`Missing default locale messages for ${DEFAULT_LOCALE}`);
}

// Validate the default locale eagerly; non-default locales are validated when
// they are loaded on demand (see `loadLocaleMessages`).
assertValidLocaleMessages(enMessages);

export const supportedLocales = Array.from(loadersByLocale.keys()).sort();

export type SupportedLocale = string;

// Only the default locale ships in the initial i18next resource bundle. Other
// locales are registered at runtime via `addResourceBundle` after their chunk
// loads (see `setLocale` in ./index.ts).
export const i18nextResources: Resource = {
  [DEFAULT_LOCALE]: { translation: enMessages as Record<string, unknown> },
};

/**
 * Load and validate a locale's messages on demand. The default locale resolves
 * synchronously from the already-bundled `en` messages; every other locale is
 * fetched via its code-split chunk. The bundler caches the underlying dynamic
 * import, so repeated calls do not re-fetch.
 */
export async function loadLocaleMessages(locale: string): Promise<Record<string, unknown>> {
  if (locale === DEFAULT_LOCALE) {
    return enMessages as Record<string, unknown>;
  }
  const loader = loadersByLocale.get(locale);
  if (!loader) {
    throw new Error(`Unsupported locale: ${locale}`);
  }
  const messages = (await loader()) as Record<string, unknown>;
  try {
    assertValidLocaleMessages(messages);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid ${locale} locale messages: ${message}`);
  }
  return messages;
}
