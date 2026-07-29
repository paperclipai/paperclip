// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_LOCALE,
  LOCALE_STORAGE_KEY,
  detectPreferredLocale,
  i18n,
  matchSupportedLocale,
  setLocale,
  t,
} from ".";

describe("locale preference", () => {
  beforeEach(async () => {
    window.localStorage.clear();
    await setLocale(DEFAULT_LOCALE);
  });

  afterEach(async () => {
    window.localStorage.clear();
    await setLocale(DEFAULT_LOCALE);
  });

  it("matches exact, regional, underscore, and Chinese script locales", () => {
    expect(matchSupportedLocale("ru-RU")).toBe("ru");
    expect(matchSupportedLocale("pt_BR")).toBe("pt-BR");
    expect(matchSupportedLocale("zh-Hans-CN")).toBe("zh-CN");
    expect(matchSupportedLocale("zh-Hant-HK")).toBe("zh-TW");
    expect(matchSupportedLocale("xx-YY")).toBeNull();
  });

  it("prefers a supported stored choice before browser languages", () => {
    expect(
      detectPreferredLocale({
        storedLocale: "ru",
        browserLocales: ["de-DE", "en-US"],
      }),
    ).toBe("ru");

    expect(
      detectPreferredLocale({
        storedLocale: "unsupported",
        browserLocales: ["de-DE", "en-US"],
      }),
    ).toBe("de");
  });

  it("persists runtime changes and synchronizes the document language", async () => {
    await setLocale("ru-RU");

    expect(i18n.resolvedLanguage).toBe("ru");
    expect(t("app.noCompanies.newCompany")).toBe("Новая компания");
    expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("ru");
    expect(document.documentElement.lang).toBe("ru");
  });

  it("falls back safely when an unsupported locale is requested", async () => {
    expect(await setLocale("xx-YY")).toBe(DEFAULT_LOCALE);
    expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe(DEFAULT_LOCALE);
  });
});
