import { describe, expect, it } from "vitest";
import { formatDate, formatDateTime, relativeTime } from "./utils";

describe("locale-aware utils", () => {
  it("formats dates with the provided locale", () => {
    const value = "2026-03-15T12:34:00.000Z";
    expect(formatDate(value, "en-US")).toBe(
      new Intl.DateTimeFormat("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      }).format(new Date(value)),
    );
    expect(formatDate(value, "zh-CN")).toBe(
      new Intl.DateTimeFormat("zh-CN", {
        month: "short",
        day: "numeric",
        year: "numeric",
      }).format(new Date(value)),
    );
  });

  it("formats date-time with the provided locale", () => {
    const value = "2026-03-15T12:34:00.000Z";
    expect(formatDateTime(value, "en-US")).toBe(
      new Intl.DateTimeFormat("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }).format(new Date(value)),
    );
  });

  it("uses Intl.RelativeTimeFormat for relative output", () => {
    const value = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    expect(relativeTime(value, "en-US")).toBe(
      new Intl.RelativeTimeFormat("en-US", { numeric: "auto" }).format(-5, "minute"),
    );
  });
});
