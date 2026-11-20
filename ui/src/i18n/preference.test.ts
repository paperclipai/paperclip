import { afterEach, describe, expect, it } from "vitest";

import {
  clearUiLanguageChoice,
  isSelectableLocale,
  noteUiLanguageChoice,
  SELECTABLE_LOCALES,
  selectedSelectableLocale,
} from "./preference";
import { effectiveUiLanguage } from "./tx";

describe("selectable locales", () => {
  afterEach(() => {
    clearUiLanguageChoice();
  });

  it("accepts only the codes listed in SELECTABLE_LOCALES", () => {
    for (const locale of SELECTABLE_LOCALES) {
      expect(isSelectableLocale(locale)).toBe(true);
    }
    expect(isSelectableLocale("zh-CN")).toBe(false);
    expect(isSelectableLocale("ru-RU")).toBe(false);
    expect(isSelectableLocale(null)).toBe(false);
  });

  it("selects a regional code when its base language is listed", () => {
    expect(selectedSelectableLocale("ru-RU")).toBe("ru");
    expect(selectedSelectableLocale("en-US")).toBe("en");
    expect(selectedSelectableLocale("zh-CN")).toBe("en");
  });

  it("keeps an in-memory choice ahead of the resolved language", () => {
    noteUiLanguageChoice("ru");
    expect(selectedSelectableLocale("en")).toBe("ru");
  });

  it("lets every non-English listed locale beat a stale English resolution", () => {
    for (const locale of SELECTABLE_LOCALES) {
      if (locale === "en") {
        expect(effectiveUiLanguage("en", locale)).toBe("en");
      } else {
        expect(effectiveUiLanguage("en", locale)).toBe(locale);
      }
    }
  });
});
