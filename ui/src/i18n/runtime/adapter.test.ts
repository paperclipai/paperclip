import { beforeEach, describe, expect, it } from "vitest";
import { normalizeLocale, setCurrentLocale, translate } from "./adapter";

describe("i18n adapter", () => {
  beforeEach(() => {
    setCurrentLocale("en");
  });

  it("normalizes supported locales", () => {
    expect(normalizeLocale("zh")).toBe("zh-CN");
    expect(normalizeLocale("zh-CN")).toBe("zh-CN");
    expect(normalizeLocale("en-US")).toBe("en");
    expect(normalizeLocale("fr-FR")).toBe("en");
  });

  it("returns translated messages for the requested locale", () => {
    expect(translate("instanceGeneral.title", { locale: "zh-CN" })).toBe("通用");
    expect(translate("instanceGeneral.title", { locale: "en" })).toBe("General");
    expect(translate("instanceHeartbeats.title", { locale: "zh-CN" })).toBe("调度器心跳");
    expect(translate("instanceExperimental.title", { locale: "zh-CN" })).toBe("实验功能");
  });

  it("falls back to English when the locale is unsupported", () => {
    expect(translate("instanceGeneral.title", { locale: "fr-FR" })).toBe("General");
  });
});
