import { afterEach, describe, expect, it } from "vitest";

import { i18n, t } from ".";
import en from "./locales/en.json";
import { localeMessages } from "./locales";

function flattenKeys(value: unknown, prefix: string[] = []): string[] {
  if (typeof value === "string") return [prefix.join(".")];
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, child]) => flattenKeys(child, [...prefix, key]));
  }
  return [prefix.join(".")];
}

describe("locale sync", () => {
  afterEach(async () => {
    await i18n.changeLanguage("en");
  });

  it("keeps every locale in exact key parity with en.json", () => {
    const englishKeys = flattenKeys(en).sort();
    for (const [locale, messages] of Object.entries(localeMessages)) {
      if (locale === "en") continue;
      expect(flattenKeys(messages).sort(), locale).toEqual(englishKeys);
    }
  });

  it("keeps English plural suffixes so translated plural forms survive sync", () => {
    const englishKeys = flattenKeys(en);
    for (const pluralBase of englishKeys.filter((key) => key.endsWith("_one"))) {
      const otherKey = `${pluralBase.slice(0, -"_one".length)}_other`;
      expect(englishKeys, pluralBase).toContain(otherKey);
    }
  });

  it("renders Russian plural forms after switching locale", async () => {
    await i18n.changeLanguage("ru");
    expect(t("pages.timeline.runCount", { count: 1, defaultValue: "{{count}} runs" })).toBe("1 запуск");
    expect(t("pages.timeline.runCount", { count: 2, defaultValue: "{{count}} runs" })).toBe("2 запуска");
    expect(t("pages.timeline.runCount", { count: 5, defaultValue: "{{count}} runs" })).toBe("5 запусков");
  });
});
