import { afterEach, describe, expect, it } from "vitest";

import { i18n } from ".";
import en from "./locales/en.json";
import zhCN from "./locales/zh-CN.json";

function flattenKeys(value: unknown, prefix: string[] = []): string[] {
  if (typeof value === "string") return [prefix.join(".")];
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, child]) => flattenKeys(child, [...prefix, key]));
  }
  return [prefix.join(".")];
}

function flattenMessages(value: unknown, prefix: string[] = []): Record<string, string> {
  if (typeof value === "string") return { [prefix.join(".")]: value };
  if (!value || typeof value !== "object") return {};
  return Object.assign(
    {},
    ...Object.entries(value).map(([key, child]) => flattenMessages(child, [...prefix, key])),
  );
}

const INTENTIONALLY_UNTRANSLATED = [
  "pages.agentDetail.id",
  "pages.agentDetail.stderr",
  "pages.agentDetail.stdout",
  "pages.agents.env.title",
  "pages.auth.paperclip",
  "pages.caseDetail.markdownTitle",
  "pages.cases.columnId",
  "pages.cases.sortId",
  "pages.cliAuth.defaultClientName",
  "pages.pipelines.pipelineDescription",
].sort();

describe("locale sync", () => {
  afterEach(async () => {
    await i18n.changeLanguage("en");
  });

  it("keeps Simplified Chinese in exact key parity with en.json", () => {
    const englishKeys = flattenKeys(en).sort();
    expect(flattenKeys(zhCN).sort()).toEqual(englishKeys);
  });

  it("keeps English plural suffixes so translated plural forms survive sync", () => {
    const englishKeys = flattenKeys(en);
    for (const pluralBase of englishKeys.filter((key) => key.endsWith("_one"))) {
      const otherKey = `${pluralBase.slice(0, -"_one".length)}_other`;
      expect(englishKeys, pluralBase).toContain(otherKey);
    }
  });

  it("does not silently ship English copy as Simplified Chinese", () => {
    const english = flattenMessages(en);
    const chinese = flattenMessages(zhCN);
    const identical = Object.keys(english).filter((key) => english[key] === chinese[key]).sort();
    expect(identical).toEqual(INTENTIONALLY_UNTRANSLATED);
  });

});
