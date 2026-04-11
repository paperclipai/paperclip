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
    expect(translate("common.signOut", { locale: "zh-CN" })).toBe("退出登录");
    expect(translate("common.signOut", { locale: "en" })).toBe("Sign out");
  });

  it("falls back to English when the locale is unsupported", () => {
    expect(translate("common.signOut", { locale: "fr-FR" })).toBe("Sign out");
  });
});
