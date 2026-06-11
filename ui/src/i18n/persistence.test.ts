// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import { LOCALE_STORAGE_KEY, resolveInitialLocale, storeLocale } from "./persistence";

function stubBrowserLanguages(languages: string[]) {
  vi.spyOn(window.navigator, "languages", "get").mockReturnValue(languages);
}

describe("resolveInitialLocale", () => {
  afterEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it("prefers a stored locale over browser languages", () => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, "tr");
    stubBrowserLanguages(["de-DE", "de"]);

    expect(resolveInitialLocale()).toBe("tr");
  });

  it("matches a regional browser language to its base locale", () => {
    stubBrowserLanguages(["tr-TR"]);

    expect(resolveInitialLocale()).toBe("tr");
  });

  it("matches a base browser language to a regional locale", () => {
    stubBrowserLanguages(["pt"]);

    expect(resolveInitialLocale()).toBe("pt-BR");
  });

  it("falls back to the default locale when nothing matches", () => {
    stubBrowserLanguages(["xx-XX"]);

    expect(resolveInitialLocale()).toBe("en");
  });

  it("ignores stored values that are not supported locales", () => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, "klingon");
    stubBrowserLanguages(["tr"]);

    expect(resolveInitialLocale()).toBe("tr");
  });

  it("round-trips a locale stored via storeLocale", () => {
    stubBrowserLanguages([]);
    storeLocale("tr");

    expect(resolveInitialLocale()).toBe("tr");
  });
});
