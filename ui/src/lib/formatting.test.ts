// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { formatCents, formatDate, formatDateTime, formatTokens, relativeTime } from "./utils";

describe("locale-aware formatting", () => {
  afterEach(() => {
    window.localStorage.clear();
  });

  it("formats currency using the synced locale", () => {
    window.localStorage.setItem("hublit-ui-lang", "ko");
    expect(formatCents(12345)).toContain("US$");
  });

  it("formats compact tokens using the synced locale", () => {
    window.localStorage.setItem("hublit-ui-lang", "ja");
    expect(formatTokens(12_300)).not.toBe("12.3k");
  });

  it("formats dates using the synced locale", () => {
    window.localStorage.setItem("hublit-ui-lang", "ko");
    expect(formatDate("2026-03-31T00:00:00.000Z")).toMatch(/2026/);
    expect(formatDateTime("2026-03-31T12:34:00.000Z")).toMatch(/2026/);
  });

  it("formats relative time using the synced locale", () => {
    window.localStorage.setItem("hublit-ui-lang", "ja");
    const now = Date.now();
    expect(relativeTime(new Date(now - 60 * 60 * 1000))).toContain("前");
  });
});
