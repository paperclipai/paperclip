import { describe, expect, it } from "vitest";
import {
  formatMessage,
} from "./index";
import { normalizeLocale, resolveInitialLocale } from "./runtime";

describe("i18n helpers", () => {
  it("normalizes region-specific locales to the supported language bundle", () => {
    expect(normalizeLocale("ko-KR")).toBe("ko");
    expect(normalizeLocale("ja-JP")).toBe("ja");
    expect(normalizeLocale("en-US")).toBe("en");
  });

  it("falls back to english for unsupported locales", () => {
    expect(normalizeLocale("fr-FR")).toBe("en");
  });

  it("prefers stored locale, then navigator locale, then english", () => {
    expect(resolveInitialLocale("ja", ["ko-KR", "en-US"])).toBe("ja");
    expect(resolveInitialLocale(null, ["ko-KR", "en-US"])).toBe("ko");
    expect(resolveInitialLocale(null, ["fr-FR"])).toBe("en");
  });

  it("formats messages with interpolation and english fallback", () => {
    expect(formatMessage("ko", "language.korean")).toBe("한국어");
    expect(formatMessage("ja", "dashboard.metrics.monthSpend")).toBe("今月の支出");
    expect(formatMessage("ko", "dashboard.incidents", { count: 3 })).toBe("활성 budget incident 3건");
    expect(formatMessage("ko", "nonexistent.key")).toBe("nonexistent.key");
  });
});
