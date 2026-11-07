import { afterEach, describe, expect, it, vi } from "vitest";

async function loadPreference() {
  vi.resetModules();
  return import("./locale-preference");
}

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("locale preference", () => {
  it.each(["en", "zh-CN"] as const)("persists explicit %s choices across module initialization", async (locale) => {
    const preference = await loadPreference();
    preference.writeLocalePreference(locale);
    expect(localStorage.getItem("paperclip.locale")).toBe(locale);
    expect((await loadPreference()).readLocalePreference()).toBe(locale);
  });

  it("keeps the latest explicit choice in memory when storage writes fail", async () => {
    localStorage.setItem("paperclip.locale", "en");
    const preference = await loadPreference();
    vi.spyOn(localStorage, "setItem").mockImplementation(() => { throw new Error("Quota exceeded"); });
    try {
      expect(() => preference.writeLocalePreference("zh-CN")).not.toThrow();
      expect(preference.readLocalePreference()).toBe("zh-CN");
      vi.stubGlobal("localStorage", undefined);
      expect(preference.readLocalePreference()).toBe("zh-CN");
      preference.writeLocalePreference("en");
      expect(preference.readLocalePreference()).toBe("en");
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("rejects unsupported choices without changing the preference", async () => {
    const preference = await loadPreference();
    expect(preference.isSelectableLocale("zh-CN")).toBe(true);
    expect(preference.isSelectableLocale("fr")).toBe(false);
    expect(preference.isSelectableLocale(null)).toBe(false);
    expect(() => preference.writeLocalePreference("fr" as never)).toThrow(RangeError);
    expect(preference.readLocalePreference()).toBe("en");
    expect(localStorage.getItem("paperclip.locale")).toBeNull();
  });
  it.each(["", "fr", "zh-TW", "zh", "ZH-cn", "null"])("ignores unsupported stored value %s", async (value) => {
    localStorage.setItem("paperclip.locale", value);
    const preference = await loadPreference();
    expect(preference.readLocalePreference()).toBe("en");
  });

  it.each(["missing", "getter", "read"])("defaults to English when storage is unavailable: %s", async (failure) => {
    const storage = localStorage;
    if (failure === "missing") vi.stubGlobal("localStorage", undefined);
    if (failure === "getter") {
      Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        get: () => { throw new Error("Blocked storage"); },
      });
    }
    if (failure === "read") vi.spyOn(storage, "getItem").mockImplementation(() => { throw new Error("Blocked read"); });
    try {
      const preference = await loadPreference();
      expect(preference.readLocalePreference()).toBe("en");
    } finally {
      Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
      vi.restoreAllMocks();
    }
  });
  it("defaults to English without detecting the browser language", async () => {
    vi.stubGlobal("navigator", { language: "zh-CN", languages: ["zh-CN"] });
    const preference = await loadPreference();
    expect(preference.readLocalePreference()).toBe("en");
    expect(preference.selectableLocales).toEqual(["en", "zh-CN"]);
  });

  it("reads an explicit stored Simplified Chinese preference", async () => {
    localStorage.setItem("paperclip.locale", "zh-CN");
    const preference = await loadPreference();
    expect(preference.readLocalePreference()).toBe("zh-CN");
  });
});
