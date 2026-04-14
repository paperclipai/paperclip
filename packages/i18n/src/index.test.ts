import { describe, expect, it } from "vitest";
import { SUPPORTED_LOCALES } from "@paperclipai/shared";
import { catalogs, pickSupportedLocaleFromAcceptLanguage, translateText, translateSystemMessage } from "./index.js";

describe("@paperclipai/i18n catalogs", () => {
  it("keeps every locale catalog aligned to the English key set", () => {
    const englishKeys = Object.keys(catalogs.en).sort();

    for (const locale of SUPPORTED_LOCALES) {
      expect(Object.keys(catalogs[locale]).sort()).toEqual(englishKeys);
    }
  });

  it("translates known English literals through translateText", () => {
    expect(translateText("zh-CN", "Page not found")).toBe("页面不存在");
    expect(translateSystemMessage("zh-CN", "Unauthorized")).toBe("未授权");
  });

  it("picks the first supported locale from Accept-Language", () => {
    expect(pickSupportedLocaleFromAcceptLanguage("fr-FR,fr;q=0.9,en;q=0.8")).toBe("fr-FR");
    expect(pickSupportedLocaleFromAcceptLanguage("pt-BR,zh;q=0.8")).toBe("zh-CN");
  });
});
