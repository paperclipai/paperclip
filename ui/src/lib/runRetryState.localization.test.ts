import { afterEach, describe, expect, it } from "vitest";
import { i18n } from "@/i18n";
import { describeRunRetryState, formatRetryReason } from "./runRetryState";

afterEach(async () => { await i18n.changeLanguage("en"); });

describe("known workspace and native retry labels", () => {
  it.each([
    ["workspace_busy", "Workspace busy", "Рабочая область занята"],
    ["native_safe_replacement", "Safe continuation in a new session", "Безопасное продолжение в новой сессии"],
  ])("translates %s without changing retry metadata", async (code, english, russian) => {
    const run = Object.freeze({ status: "scheduled_retry", scheduledRetryReason: code });
    for (const locale of ["en", "ru", "en"]) {
      await i18n.changeLanguage(locale);
      const expected = locale === "ru" ? russian : english;
      expect(formatRetryReason(code)).toBe(expected);
      expect(describeRunRetryState(run)?.detail).toBe(expected);
      expect(run.scheduledRetryReason).toBe(code);
    }
  });

  it("retains the existing unknown-reason fallback and raw exhausted diagnostic", async () => {
    await i18n.changeLanguage("ru");
    expect(formatRetryReason("provider_custom_reason")).toBe("provider custom reason");
    const result = describeRunRetryState({
      status: "failed",
      scheduledRetryReason: "native_safe_replacement",
      retryExhaustedReason: "Provider rejected this request: account exhausted",
    });
    expect(result?.secondary).toContain("Provider rejected this request: account exhausted");
  });
});
