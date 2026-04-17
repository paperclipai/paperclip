import { beforeEach, describe, expect, it } from "vitest";
import { formatDate, relativeTime } from "./utils";
import { setCurrentLocale } from "@/i18n/runtime/adapter";

describe("utils i18n formatting", () => {
  beforeEach(() => {
    setCurrentLocale("en");
  });

  it("formats dates using the current locale", () => {
    const date = new Date("2026-04-01T00:00:00.000Z");

    setCurrentLocale("en");
    const english = formatDate(date);

    setCurrentLocale("zh-CN");
    const chinese = formatDate(date);

    expect(english).not.toBe(chinese);
    expect(chinese).toMatch(/2026/);
  });

  it("formats relative time using the current locale", () => {
    const now = Date.now();
    const recentDate = new Date(now - 90_000);

    setCurrentLocale("en");
    expect(relativeTime(recentDate)).toContain("ago");

    setCurrentLocale("zh-CN");
    expect(relativeTime(recentDate)).toContain("前");
  });
});
