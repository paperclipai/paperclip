import type { Resource } from "i18next";
import { assertValidLocaleMessages } from "./locale-validation";

export function buildCatalogResources(
  localeMessages: Record<string, unknown>,
  catalogModules: Record<string, unknown>,
): Resource {
  const resources: Resource = Object.fromEntries(
    Object.entries(localeMessages).map(([locale, messages]) => [
      locale,
      { translation: messages },
    ]),
  ) as Resource;
  const catalogs = Object.entries(catalogModules).map(([path, messages]) => {
    const match = /^\.\/catalogs\/([A-Za-z0-9-]+)\/([a-z][a-z0-9-]*)\.json$/.exec(path);
    if (!match) throw new Error(`Invalid product catalog path: ${path}`);
    const [, locale, namespace] = match;
    if (namespace === "translation") {
      throw new Error(`Reserved product catalog namespace: ${namespace}`);
    }
    if (!Object.hasOwn(localeMessages, locale)) {
      throw new Error(`Unknown product catalog locale: ${locale}`);
    }
    return { path, locale, namespace, messages };
  });
  const english = new Map(
    catalogs
      .filter(({ locale }) => locale === "en")
      .map(({ namespace, messages }) => [namespace, messages]),
  );
  for (const { path, locale, namespace, messages } of catalogs) {
    if (!english.has(namespace)) {
      throw new Error(`Missing English product catalog for ${path}`);
    }
    try {
      assertValidLocaleMessages(messages, english.get(namespace));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid product catalog ${path}: ${message}`);
    }
    resources[locale][namespace] = messages as Resource[string][string];
  }
  return resources;
}
