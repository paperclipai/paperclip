import { afterEach, describe, expect, it } from "vitest";
import { i18n } from "@/i18n";
import { taskDateGroup, taskDateGroupSeparator } from "./task-date-groups";

describe("task date groups", () => {
  const now = new Date(2026, 7, 31, 9, 30);

  afterEach(async () => { await i18n.changeLanguage("en"); });

  it("uses local calendar boundaries instead of rolling 24-hour windows", () => {
    expect(taskDateGroup(new Date(2026, 7, 31, 0, 1), now)).toBe("today");
    expect(taskDateGroup(new Date(2026, 7, 30, 23, 59), now)).toBe("yesterday");
    expect(taskDateGroup(new Date(2026, 7, 29, 23, 59), now)).toBe("earlier");
  });

  it("does not emit duplicate or leading Earlier separators", () => {
    expect(taskDateGroupSeparator(null, "earlier")).toBeNull();
    expect(taskDateGroupSeparator(null, "today")).toBe("Today");
    expect(taskDateGroupSeparator("today", "today")).toBeNull();
    expect(taskDateGroupSeparator("today", "yesterday")).toBe("Yesterday");
    expect(taskDateGroupSeparator("yesterday", "earlier")).toBe("Earlier");
  });

  it("uses the selected locale without changing date groups or separator boundaries", async () => {
    for (const [locale, labels] of [
      ["ru", ["Сегодня", "Вчера", "Ранее"]],
      ["en", ["Today", "Yesterday", "Earlier"]],
    ] as const) {
      await i18n.changeLanguage(locale);
      expect(taskDateGroupSeparator(null, "today")).toBe(labels[0]);
      expect(taskDateGroupSeparator("today", "yesterday")).toBe(labels[1]);
      expect(taskDateGroupSeparator("yesterday", "earlier")).toBe(labels[2]);
      expect(taskDateGroupSeparator(null, "earlier")).toBeNull();
      expect(taskDateGroupSeparator("today", "today")).toBeNull();
      expect(taskDateGroup(new Date(2026, 7, 30, 23, 59), now)).toBe("yesterday");
    }
  });
});
