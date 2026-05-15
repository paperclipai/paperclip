import { describe, expect, it } from "vitest";
import { t } from ".";
import en from "./locales/en.json";
import { localeMessages } from "./locales";
import { validateLocaleMessages } from "./locale-validation";

describe("locale validation", () => {
  it("resolves English messages with key and default fallbacks", () => {
    expect(t("account.language")).toBe(en.account.language);
    expect(t("app.missing", { defaultValue: "Fallback" })).toBe("Fallback");
    expect(t("app.missing")).toBe("app.missing");
  });

  it("accepts registered locale files", () => {
    expect(Object.keys(localeMessages).sort()).toEqual(["en"]);
    for (const [locale, messages] of Object.entries(localeMessages)) {
      expect(validateLocaleMessages(messages), locale).toEqual([]);
    }
  });

  it("rejects missing and extra nested keys", () => {
    expect(
      validateLocaleMessages({
        account: {
          language: en.account.language,
          unexpected: "Unexpected",
        },
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining("is missing"),
        "account.unexpected is not defined in English",
      ]),
    );
  });

  it("rejects non-string leaves", () => {
    expect(
      validateLocaleMessages({
        account: {
          language: ["Language"],
        },
      }),
    ).toEqual(expect.arrayContaining(["account.language must be a string"]));
  });

  it("requires interpolation placeholders to match English", () => {
    const reference = {
      message: "Invite {{name}} to {{company}}",
    };

    expect(validateLocaleMessages({ message: "Invite {{name}}" }, reference)).toEqual([
      'message interpolation placeholders must match English exactly: expected ["company","name"], received ["name"]',
    ]);
  });

  it("rejects executable, raw HTML, and unexpected link payloads not present in English", () => {
    const reference = {
      script: "Create company",
      handler: "Create company",
      js: "Create company",
      data: "Create company",
      url: "Create company",
      html: "Create company",
    };

    expect(
      validateLocaleMessages(
        {
          script: "<script>alert(1)</script>",
          handler: '<span onclick="alert(1)">Create</span>',
          js: "javascript:alert(1)",
          data: "data:text/html,hello",
          url: "https://example.test",
          html: "<strong>Create company</strong>",
        },
        reference,
      ),
    ).toEqual(
      expect.arrayContaining([
        "script contains disallowed <script",
        "handler contains disallowed event-handler attribute",
        "js contains disallowed javascript:",
        "data contains disallowed data:",
        "url contains disallowed unexpected URL",
        "html contains disallowed raw HTML tag",
      ]),
    );
  });

  it("caps localized string length relative to English", () => {
    expect(validateLocaleMessages({ message: "x".repeat(200) }, { message: "Short" })).toEqual([
      "message is too long: 200 characters exceeds 133",
    ]);
  });
});
