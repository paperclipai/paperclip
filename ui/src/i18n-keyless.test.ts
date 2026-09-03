import { describe, expect, it } from "vitest";

import {
  detectBrowserLanguage,
  languageDisplayName,
  resolveStorage,
  SUPPORTED_LANGUAGES,
} from "./i18n-keyless";

describe("resolveStorage", () => {
  it("keeps a working storage", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
      clear: () => store.clear(),
    };
    expect(resolveStorage(() => storage)).toBe(storage);
  });

  it("falls back to memory when reading the storage property throws", () => {
    const storage = resolveStorage(() => {
      throw new DOMException("The operation is insecure.", "SecurityError");
    });
    storage.setItem("k", "v");
    expect(storage.getItem("k")).toBe("v");
  });

  it("falls back to memory when the storage throws on first use", () => {
    const storage = resolveStorage(() => ({
      getItem: () => {
        throw new DOMException("QuotaExceededError");
      },
      setItem: () => {},
      removeItem: () => {},
      clear: () => {},
    }));
    expect(storage.getItem("k")).toBeNull();
  });

  it("falls back to memory when no storage is available", () => {
    expect(resolveStorage(() => undefined).getItem("k")).toBeNull();
  });
});

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
