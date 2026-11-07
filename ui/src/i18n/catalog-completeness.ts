import { validateLocaleMessages } from "./locale-validation";

export function checkCatalogCompleteness(modules: Record<string, unknown>): string[] {
  const catalogs = new Map<string, Map<string, unknown>>();
  const errors: string[] = [];
  for (const [path, messages] of Object.entries(modules)) {
    const match = /^\.\/catalogs\/(en|zh-CN)\/([a-z][a-z0-9-]*)\.json$/.exec(path);
    if (!match) continue;
    const [, locale, namespace] = match;
    let languages = catalogs.get(namespace);
    if (!languages) {
      languages = new Map();
      catalogs.set(namespace, languages);
    }
    languages.set(locale, messages);
  }
  for (const [namespace, languages] of [...catalogs].sort(([a], [b]) => a.localeCompare(b))) {
    if (!languages.has("en")) {
      errors.push(`Missing en catalog for ${namespace}`);
      continue;
    }
    if (!languages.has("zh-CN")) {
      errors.push(`Missing zh-CN catalog for ${namespace}`);
      continue;
    }
    errors.push(...validateLocaleMessages(languages.get("zh-CN"), languages.get("en"))
      .map((message) => `${namespace}: ${message}`));
  }
  return errors;
}
