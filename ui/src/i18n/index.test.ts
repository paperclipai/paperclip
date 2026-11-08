import type { i18n as I18n } from "i18next";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  vi.stubGlobal("document", { documentElement: { lang: "" } });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("i18n runtime", () => {
  it("exposes react-i18next hooks and Trans without a custom translation layer", async () => {
    const runtime = await import("./index");
    const reactI18next = await import("react-i18next");
    expectTypeOf(runtime.i18n).toEqualTypeOf<I18n>();
    expectTypeOf(runtime.useTranslation).toEqualTypeOf<typeof reactI18next.useTranslation>();
    expect(runtime.useTranslation).toBe(reactI18next.useTranslation);
    expect(runtime.Trans).toBe(reactI18next.Trans);
  });

  it("limits the runtime to the two offered locales and falls back to English", async () => {
    const { i18n, t } = await import("./index");
    expect(i18n.options.supportedLngs).toEqual(["en", "zh-CN", "cimode"]);
    i18n.addResource("en", "runtime-test", "fallback", "English fallback");
    await i18n.changeLanguage("zh-CN");
    expect(t("fallback", { ns: "runtime-test" })).toBe("English fallback");
    expect(t("missing", { ns: "runtime-test", defaultValue: "Default copy" })).toBe("Default copy");
  });
  it("updates document language and persisted preference through the standard i18next API", async () => {
    const { i18n, t } = await import("./index");
    expect(i18n.language).toBe("en");
    expect(document.documentElement.lang).toBe("en");
    expect(localStorage.getItem("paperclip.locale")).toBeNull();
    i18n.addResource("en", "runtime-test", "greeting", "Hello {{name}}");
    i18n.addResource("zh-CN", "runtime-test", "greeting", "你好，{{name}}");
    await i18n.changeLanguage("zh-CN");
    expect(t("greeting", { ns: "runtime-test", name: "Ada" })).toBe("你好，Ada");
    expect(document.documentElement.lang).toBe("zh-CN");
    expect(localStorage.getItem("paperclip.locale")).toBe("zh-CN");
    await i18n.changeLanguage("en");
    expect(t("greeting", { ns: "runtime-test", name: "Ada" })).toBe("Hello Ada");
    expect(document.documentElement.lang).toBe("en");
    expect(localStorage.getItem("paperclip.locale")).toBe("en");
  });
  it("initializes a persisted locale synchronously before consumers render", async () => {
    localStorage.setItem("paperclip.locale", "zh-CN");
    const { i18n } = await import("./index");
    expect(i18n.isInitialized).toBe(true);
    expect(i18n.language).toBe("zh-CN");
    expect(document.documentElement.lang).toBe("zh-CN");
  });
});
