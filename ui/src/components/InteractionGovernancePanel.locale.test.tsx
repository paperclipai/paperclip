import { afterEach, describe, expect, it } from "vitest";
import { i18n } from "@/i18n";
import { validateLocaleMessages } from "@/i18n/locale-validation";
import { governanceValueLabel } from "./InteractionGovernancePanel";

const copy = {
  en: { labels: [["Anyone (default)", "Anyone except creator", "Human only"], ["No cap", "Anyone except creator", "Human only"]] },
  "zh-CN": { labels: [["任何人（默认）", "除创建者外的任何人", "仅限人员"], ["不设上限", "除创建者外的任何人", "仅限人员"]] },
};
afterEach(async () => { await i18n.changeLanguage("en"); });

it("resolves exported labels at call time including open and legacy policies", async () => {
  for (const locale of ["en", "zh-CN", "en"] as const) {
    await i18n.changeLanguage(locale);
    expect(governanceValueLabel("defaultPolicy", "default")).toBe(copy[locale].labels[0][0]);
    expect(governanceValueLabel("cap", "default")).toBe(copy[locale].labels[1][0]);
    expect(governanceValueLabel("cap", "not_creator")).toBe(copy[locale].labels[1][1]);
    expect(governanceValueLabel("defaultPolicy", "human_only")).toBe(copy[locale].labels[0][2]);
    expect(governanceValueLabel("cap", "board_only")).toBe(copy[locale].labels[1][2]);
    expect(governanceValueLabel("defaultPolicy", "anyone")).toBe(locale === "en" ? "Anyone" : "任何人");
    expect(governanceValueLabel("cap", "board_or_agents")).toBe(locale === "en" ? "Anyone" : "任何人");
  }
});

describe("governance catalog", () => {
  it("has exact key and placeholder parity with no empty or untranslated Chinese messages", () => {
    const en = i18n.getResourceBundle("en", "governance") as Record<string, string> | undefined;
    const zh = i18n.getResourceBundle("zh-CN", "governance") as Record<string, string> | undefined;
    expect(en).toBeTruthy();
    expect(zh).toBeTruthy();
    expect(validateLocaleMessages(zh, en)).toEqual([]);
    for (const key of Object.keys(en!)) {
      expect(zh![key].trim()).not.toBe("");
      expect(zh![key]).not.toBe(en![key]);
    }
  });
});
