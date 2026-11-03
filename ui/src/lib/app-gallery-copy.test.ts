import { afterEach, expect, it } from "vitest";
import { i18n } from "@/i18n";
import { credentialFieldLabel } from "./app-gallery-copy";

afterEach(async () => { await i18n.changeLanguage("en"); });

it("classifies credential labels by canonical copy while rendering the current translation", async () => {
  const canonical = "Paste your 1Password Service Account token";
  const russian = "Вставьте токен сервисного аккаунта 1Password";
  const rawName = "Research {{RAW}} <name> — Север";
  for (const language of ["en", "ru", "en"]) {
    await i18n.changeLanguage(language);
    const displayed = language === "ru" ? russian : canonical;
    expect(credentialFieldLabel("1Password", displayed, 1, canonical)).toBe(displayed);
    expect(credentialFieldLabel(rawName, "API key", 1)).toBe(
      language === "ru" ? `Ваш ключ ${rawName}` : `Your ${rawName} key`,
    );
    expect(credentialFieldLabel(rawName, "Custom {{RAW}} <label>", 2)).toBe("Custom {{RAW}} <label>");
    expect(credentialFieldLabel("1Password", canonical, 1)).toBe(canonical);
  }
  expect(canonical).toBe("Paste your 1Password Service Account token");
});
