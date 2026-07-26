import { afterEach, describe, expect, it } from "vitest";

import { i18n, matchOperatorLocale, setOperatorLocale } from ".";

describe("operator locale", () => {
  afterEach(async () => {
    await setOperatorLocale("en");
  });

  it("matches English and Chinese browser locales", () => {
    expect(matchOperatorLocale("en-US")).toBe("en");
    expect(matchOperatorLocale("zh")).toBe("zh-CN");
    expect(matchOperatorLocale("zh-Hant-TW")).toBe("zh-CN");
    expect(matchOperatorLocale("fr-FR")).toBeNull();
  });

  it("changes the active locale", async () => {
    await setOperatorLocale("zh-CN");

    expect(i18n.resolvedLanguage).toBe("zh-CN");
  });
});
