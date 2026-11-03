import { afterEach, describe, expect, it } from "vitest";
import { i18n } from "@/i18n";
import { adapterEnvironmentCheckMessageDisplay } from "./adapter-environment-check-display";

const verifiedMessage = "The provider verified this API key for adoption.";

afterEach(async () => { await i18n.changeLanguage("en"); });

describe("adapter environment check display", () => {
  it.each([
    ["codex_probe_cleanup_incomplete", "Temporary probe files could not be fully removed; this does not change the connection result."],
    ["grok_environment_unprepared", "Could not stage the managed account into the environment"],
    ["ai_connection_api_key_rejected", "Could not verify the account. Try again."],
    ["ai_connection_api_key_rejected", "The selected account's API key was not available to verify."],
  ])("localizes the canonical %s message without rewriting external details", async (code, message) => {
    const check = Object.freeze({ code, message });
    for (const locale of ["ru", "en", "ru"]) {
      await i18n.changeLanguage(locale);
      const display = adapterEnvironmentCheckMessageDisplay(check);
      if (locale === "ru") expect(display).toMatch(/[А-Яа-я]/);
      else expect(display).toBe(message);
      expect(check.message).toBe(message);
      expect(adapterEnvironmentCheckMessageDisplay({ code, message: "Provider-owned diagnostic" })).toBe("Provider-owned diagnostic");
      expect(adapterEnvironmentCheckMessageDisplay({ code: "unknown_check", message })).toBe(message);
    }
  });
  it("translates only the exact first-party success without mutating its source", async () => {
    const check = Object.freeze({ code: "ai_connection_api_key_reverified", message: verifiedMessage });
    for (const locale of ["en", "ru", "en"]) {
      await i18n.changeLanguage(locale);
      expect(adapterEnvironmentCheckMessageDisplay(check)).toBe(locale === "ru"
        ? "Провайдер подтвердил, что этот ключ API можно использовать для агента."
        : verifiedMessage);
      expect(check.message).toBe(verifiedMessage);
    }
  });

  it.each([
    { code: "provider_check", message: verifiedMessage },
    { code: "ai_connection_api_key_reverified", message: "Provider-owned success" },
    { code: "ai_connection_api_key_reverified", message: `${verifiedMessage} ` },
    { code: "ai_connection_api_key_rejected", message: verifiedMessage },
    { code: "ai_connection_api_key_rejected", message: "Provider rejected this key: 403 permission denied" },
  ])("preserves diagnostics or unknown code/message pairs: $code / $message", async (check) => {
    await i18n.changeLanguage("ru");
    expect(adapterEnvironmentCheckMessageDisplay(check)).toBe(check.message);
  });
});
