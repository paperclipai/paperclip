// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import { applyDocumentLocale, i18n, LOCALE_STORAGE_KEY, setLocale } from ".";

describe("locale runtime", () => {
  afterEach(async () => {
    window.localStorage.removeItem(LOCALE_STORAGE_KEY);
    await i18n.changeLanguage("en");
  });

  it("persists a supported locale and updates the document language", async () => {
    setLocale("zh-CN");
    await vi.waitFor(() => expect(i18n.resolvedLanguage).toBe("zh-CN"));

    expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("zh-CN");
    expect(document.documentElement.lang).toBe("zh-CN");
    expect(document.documentElement.dir).toBe("ltr");
  });

  it("sets text direction from the resolved language", () => {
    applyDocumentLocale("ar");
    expect(document.documentElement.lang).toBe("ar");
    expect(document.documentElement.dir).toBe("rtl");

    applyDocumentLocale("zh-HK");
    expect(document.documentElement.lang).toBe("zh-TW");
    expect(document.documentElement.dir).toBe("ltr");
  });

  it("ignores unsupported locale changes", () => {
    setLocale("not-a-locale");
    expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBeNull();
  });
});
