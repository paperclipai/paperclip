import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setCurrentLocale } from "@/i18n/runtime";
import { timeAgo } from "./timeAgo";

describe("timeAgo", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-12T00:00:00Z"));
    setCurrentLocale("en");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns Chinese relative time when the current locale is zh-CN", () => {
    setCurrentLocale("zh-CN");

    expect(timeAgo("2026-04-11T23:59:30Z")).toBe("刚刚");
    expect(timeAgo("2026-04-11T23:57:00Z")).toBe("3 分钟前");
    expect(timeAgo("2026-03-29T00:00:00Z")).toBe("2 周前");
    expect(timeAgo("2026-02-11T00:00:00Z")).toBe("2 个月前");
  });

  it("keeps English output by default", () => {
    expect(timeAgo("2026-04-11T22:00:00Z")).toBe("2h ago");
  });

  it("clamps future timestamps to just now", () => {
    expect(timeAgo("2026-04-12T00:05:00Z")).toBe("just now");
  });

  it("falls back to just now for invalid dates", () => {
    expect(timeAgo("not-a-date")).toBe("just now");
  });
});
