// @vitest-environment node

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider, normalizeLocale, resolvePreferredLocale, translate, useI18n } from "./index";

function Probe({ messageKey }: { messageKey: string }) {
  const { t } = useI18n();
  return <span>{t(messageKey)}</span>;
}

describe("i18n", () => {
  it("normalizes supported browser locales into app locales", () => {
    expect(normalizeLocale("en-US")).toBe("en");
    expect(normalizeLocale("zh")).toBe("zh-CN");
    expect(normalizeLocale("zh-CN")).toBe("zh-CN");
  });

  it("prefers stored locale over browser locale", () => {
    expect(resolvePreferredLocale({ storedLocale: "zh-CN", browserLanguage: "en-US" })).toBe("zh-CN");
    expect(resolvePreferredLocale({ storedLocale: null, browserLanguage: "zh-TW" })).toBe("zh-CN");
    expect(resolvePreferredLocale({ storedLocale: null, browserLanguage: null })).toBe("en");
  });

  it("falls back to english keys and interpolates variables", () => {
    expect(translate("zh-CN", "companySettings.archive.confirm", { name: "Acme" })).toContain("Acme");
    expect(translate("zh-CN", "missing.key")).toBe("missing.key");
  });

  it("renders translated content for the selected locale", () => {
    const html = renderToStaticMarkup(
      <I18nProvider initialLocale="zh-CN">
        <Probe messageKey="projects.addButton" />
      </I18nProvider>,
    );

    expect(html).toContain("添加项目");
  });
});
