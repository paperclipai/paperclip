// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import { i18n } from "@/i18n";
import {
  formatCents,
  formatDate,
  formatDurationMs,
  formatNumber,
  formatProjectBudget,
  relativeTime,
} from "./utils";

describe("localized display formatting", () => {
  afterEach(async () => {
    vi.useRealTimers();
    await i18n.changeLanguage("en");
  });

  it("uses Russian number, money, date, and budget conventions", async () => {
    await i18n.changeLanguage("ru");

    expect(formatNumber(1_234_567).replace(/\s/g, " ")).toBe("1 234 567");
    expect(formatCents(120_000).replace(/\s/g, " ")).toBe("1 200,00 $");
    expect(formatProjectBudget({ amountCents: 120_000, windowKind: "calendar_month_utc" }).replace(/\s/g, " "))
      .toBe("1 200,00 $/мес.");
    expect(formatDate("2026-09-05T12:00:00Z")).toMatch(/5\s+сент\.\s+2026\s*г?\.?/i);
  });

  it("uses Russian relative time and compact duration labels", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-05T12:00:00Z"));
    await i18n.changeLanguage("ru");

    expect(relativeTime("2026-09-05T11:55:00Z")).toBe("5 мин назад");
    expect(formatDurationMs(3_723_000)).toBe("1 ч 2 мин");
  });
});
