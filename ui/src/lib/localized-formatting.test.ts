import { afterEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../i18n";
import { timeAgo } from "./timeAgo";
import {
  billingTypeDisplayName,
  financeDirectionDisplayName,
  financeEventKindDisplayName,
  formatCents,
  formatDate,
  formatDateTime,
  formatDetailedCents,
  formatDurationMs,
  formatNumber,
  formatProjectBudget,
  formatShortDate,
  relativeTime,
} from "./utils";

afterEach(async () => {
  vi.useRealTimers();
  await i18n.changeLanguage("en");
});

describe("localized product formatting", () => {
  it("uses the selected locale for dates without changing the instant", async () => {
    const date = new Date("2026-11-05T04:30:00Z");
    await i18n.changeLanguage("zh-CN");
    expect(formatDate(date)).toBe(date.toLocaleDateString("zh-CN", { month: "short", day: "numeric", year: "numeric" }));
    expect(formatShortDate(date)).toBe(date.toLocaleString("zh-CN", { month: "short", day: "numeric" }));
    expect(formatDateTime(date)).toBe(date.toLocaleString("zh-CN", {
      month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit",
    }));
    expect(date.toISOString()).toBe("2026-11-05T04:30:00.000Z");
  });

  it("translates relative time at call time after a language switch", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-05T04:30:00Z"));
    expect(timeAgo("2026-11-05T04:25:00Z")).toBe("5m ago");
    await i18n.changeLanguage("zh-CN");
    expect(timeAgo("2026-11-05T04:25:00Z")).toBe("5 分钟前");
    expect(relativeTime("2026-11-05T04:25:00Z")).toBe("5 分钟前");
    expect(timeAgo("2026-11-05T04:29:59Z")).toBe("刚刚");
    expect(relativeTime("2026-11-05T04:29:59Z")).toBe("刚刚");
  });

  it("keeps the upstream English format and duration rounding", async () => {
    await i18n.changeLanguage("en");
    expect(formatDurationMs(0)).toBe("0s");
    expect(formatDurationMs(62_000)).toBe("1m 2s");
    expect(formatDurationMs(3_660_000)).toBe("1h 1m");
    expect(formatCents(12345)).toBe("$123.45");
    expect(formatProjectBudget({ amountCents: 1000, windowKind: "calendar_month_utc" })).toBe("$10.00/mo");
  });

  it("translates duration units and monthly-budget labels without changing amounts", async () => {
    await i18n.changeLanguage("zh-CN");
    expect(formatDurationMs(0)).toBe("0秒");
    expect(formatDurationMs(62_000)).toBe("1分钟 2秒");
    expect(formatDurationMs(3_660_000)).toBe("1小时 1分钟");
    expect(formatProjectBudget({ amountCents: 1000, windowKind: "calendar_month_utc" })).toBe(`${formatCents(1000)}/月`);
    expect(formatCents(12345, "USD")).toBe((123.45).toLocaleString("zh-CN", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }));
    expect(formatDetailedCents("1.234")).toBe((0.01234).toLocaleString("zh-CN", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 9 }));
    expect(formatNumber(12345)).toBe((12345).toLocaleString("zh-CN"));
  });

  it("translates display names without modifying canonical enum values", async () => {
    await i18n.changeLanguage("zh-CN");
    expect(billingTypeDisplayName("metered_api")).toBe("按量计费 API");
    expect(billingTypeDisplayName("subscription_included")).toBe("订阅");
    expect(financeEventKindDisplayName("inference_charge")).toBe("推理费用");
    expect(financeDirectionDisplayName("credit")).toBe("贷记");
    expect(financeDirectionDisplayName("debit")).toBe("借记");
    await i18n.changeLanguage("en");
    expect(billingTypeDisplayName("metered_api")).toBe("Metered API");
  });
});
