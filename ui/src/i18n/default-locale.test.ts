import { describe, expect, it } from "vitest";

import { normalizeSupportedLocale, resolveDefaultLocale } from "./default-locale";

describe("default locale resolution", () => {
  it("defaults new Paperclip sessions to Simplified Chinese", () => {
    expect(resolveDefaultLocale()).toBe("zh-CN");
  });

  it("lets configured and stored locales override the built-in default", () => {
    expect(
      resolveDefaultLocale({
        envLocale: "fr",
        storedLocale: "ja",
        navigatorLanguages: ["de"],
      }),
    ).toBe("fr");

    expect(
      resolveDefaultLocale({
        storedLocale: "ja",
        navigatorLanguages: ["de"],
      }),
    ).toBe("ja");

    expect(resolveDefaultLocale({ navigatorLanguages: ["de-DE"] })).toBe("zh-CN");
    expect(resolveDefaultLocale({ navigatorLanguages: ["de-DE"], defaultLocale: "unknown" })).toBe("de");
  });

  it("normalizes locale casing and separators", () => {
    expect(normalizeSupportedLocale("ZH_cn")).toBe("zh-CN");
    expect(normalizeSupportedLocale("pt-pt")).toBe("pt-PT");
    expect(normalizeSupportedLocale("zh")).toBe("zh-CN");
  });

  it("falls back to English only when no default candidate is supported", () => {
    expect(resolveDefaultLocale({ envLocale: "unknown", defaultLocale: "unknown" })).toBe("en");
  });
});
