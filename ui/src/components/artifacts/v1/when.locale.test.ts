import { afterEach, expect, it } from "vitest";
import { i18n } from "@/i18n";
import { countLabel, panelDateLabel, updatedLabel, sizeLabel } from "./when";

afterEach(async () => { await i18n.changeLanguage("en"); });
it("formats artifact counts and dates in the current language, including zero", async () => {
  const now = new Date(2026, 10, 5, 16, 5);
  await i18n.changeLanguage("en");
  const english = [0, 1, 2].map(countLabel);
  expect(english).toEqual(["0 Artifacts", "1 Artifact", "2 Artifacts"]);
  await i18n.changeLanguage("zh-CN");
  expect([0, 1, 2].map(countLabel)).toEqual(["0 个产物", "1 个产物", "2 个产物"]);
  expect(panelDateLabel(now.toISOString(), now)).toBe("今天");
  expect(panelDateLabel(new Date(2026, 10, 4).toISOString(), now)).toBe("昨天");
  expect(panelDateLabel(new Date(2026, 10, 3).toISOString(), now)).toBe("2 天前");
  expect(updatedLabel(new Date(2026, 10, 3).toISOString(), now)).toBe("星期二");
  expect(sizeLabel(2048)).toBe("2.0 KB");
  await i18n.changeLanguage("en");
  expect([0, 1, 2].map(countLabel)).toEqual(english);
});

it("preserves English's exact singular predicate for unusual numeric input", async () => {
  await i18n.changeLanguage("en");
  expect([-1, 0, 1, 1.5, 2].map(countLabel)).toEqual([
    "-1 Artifacts", "0 Artifacts", "1 Artifact", "1.5 Artifacts", "2 Artifacts",
  ]);
});
