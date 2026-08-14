import { describe, expect, it } from "vitest";

import { DEFAULT_LOCALE } from "./locales";
import { normalizeBrowserLocale, resolveInitialLocale } from "./resolve-locale";

describe("normalizeBrowserLocale", () => {
  it("maps Simplified Chinese tags to zh-CN", () => {
    expect(normalizeBrowserLocale("zh-CN")).toBe("zh-CN");
    expect(normalizeBrowserLocale("zh")).toBe("zh-CN");
    expect(normalizeBrowserLocale("zh-Hans")).toBe("zh-CN");
    expect(normalizeBrowserLocale("zh_CN")).toBe("zh-CN");
  });

  it("maps Traditional Chinese tags to zh-TW", () => {
    expect(normalizeBrowserLocale("zh-TW")).toBe("zh-TW");
    expect(normalizeBrowserLocale("zh-HK")).toBe("zh-TW");
    expect(normalizeBrowserLocale("zh-Hant")).toBe("zh-TW");
  });

  it("falls back to English for unknown tags", () => {
    expect(normalizeBrowserLocale(null)).toBe(DEFAULT_LOCALE);
    expect(normalizeBrowserLocale("")).toBe(DEFAULT_LOCALE);
    expect(normalizeBrowserLocale("xx-YY")).toBe(DEFAULT_LOCALE);
  });
});

describe("resolveInitialLocale", () => {
  it("stays on English during tests", () => {
    expect(
      resolveInitialLocale({
        stored: "zh-CN",
        navigatorLanguage: "zh-CN",
        mode: "test",
      }),
    ).toBe(DEFAULT_LOCALE);
  });

  it("prefers a stored locale over the browser language", () => {
    expect(
      resolveInitialLocale({
        stored: "zh-TW",
        navigatorLanguage: "en-US",
        mode: "development",
      }),
    ).toBe("zh-TW");
  });

  it("uses the browser language when nothing is stored", () => {
    expect(
      resolveInitialLocale({
        stored: null,
        navigatorLanguage: "zh-CN",
        mode: "development",
      }),
    ).toBe("zh-CN");
  });
});
