// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";

import { i18n, LOCALE_STORAGE_KEY, setLocale, t } from ".";
import en from "./locales/en.json";
import { localeMessages, supportedLocales } from "./locales";

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
    window.localStorage.clear();
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

  it("keeps locale text when a catalog omits a CLDR plural category", async () => {
    await i18n.changeLanguage("ru");
    for (const count of [0, 1, 2, 5, 11, 21, 22, 25, 1.5]) {
      expect(t("pages.projects.projectCount", { count }), String(count)).toBe(`Проектов: ${count}`);
    }
  });

  it("exposes only locales with a completed native review", () => {
    expect(supportedLocales).toEqual(["en", "ru"]);
    expect(localeMessages).toHaveProperty("ar");
  });

  it("keeps the document language and direction in sync", async () => {
    await i18n.changeLanguage("ru");
    expect(document.documentElement.lang).toBe("ru");
    expect(document.documentElement.dir).toBe("ltr");

    await i18n.changeLanguage("en");
    expect(document.documentElement.lang).toBe("en");
    expect(document.documentElement.dir).toBe("ltr");
  });

  it("persists supported locale changes and ignores unsupported locales", () => {
    setLocale("ru");
    expect(i18n.language).toBe("ru");
    expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("ru");

    setLocale("ar");
    expect(i18n.language).toBe("ru");
    expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("ru");
  });
});
