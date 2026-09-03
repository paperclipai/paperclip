import { describe, expect, it } from "vitest";

import { detectBrowserLanguage, languageDisplayName, SUPPORTED_LANGUAGES } from "./i18n-keyless";

describe("detectBrowserLanguage", () => {
  it("returns the first supported language, most preferred first", () => {
    expect(detectBrowserLanguage(["th-TH", "en-US"])).toBe("th");
    expect(detectBrowserLanguage(["de-AT", "en"])).toBe("de");
  });

  it("maps regional Chinese tags to the script the server supports", () => {
    expect(detectBrowserLanguage(["zh-CN"])).toBe("zh-Hans");
    expect(detectBrowserLanguage(["zh-TW"])).toBe("zh-Hant");
  });

  it("keeps the regional variant when it is supported", () => {
    expect(detectBrowserLanguage(["pt-BR"])).toBe("pt-BR");
    expect(detectBrowserLanguage(["en-GB"])).toBe("en-GB");
  });

  it("falls back to English for unknown or empty preferences", () => {
    expect(detectBrowserLanguage(["tlh"])).toBe("en");
    expect(detectBrowserLanguage([])).toBe("en");
  });
});

describe("languageDisplayName", () => {
  it("names every supported language in that language", () => {
    for (const lang of SUPPORTED_LANGUAGES) {
      expect(languageDisplayName(lang)).not.toBe("");
    }
    expect(languageDisplayName("de")).toBe("Deutsch");
    expect(languageDisplayName("th")).toBe("ไทย");
  });
});
