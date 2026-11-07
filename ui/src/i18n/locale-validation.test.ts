import { describe, expect, it } from "vitest";
import { i18n, t } from ".";
import en from "./locales/en.json";
import { supportedLocales, loadLocaleMessages } from "./locales";
import { validateLocaleMessages } from "./locale-validation";

describe("locale validation", () => {
  it("resolves English messages with key and default fallbacks", () => {
    expect(t("app.noCompanies.title")).toBe(en.app.noCompanies.title);
    expect(t("app.missing", { defaultValue: "Fallback" })).toBe("Fallback");
    expect(t("app.missing")).toBe("app.missing");
  });

  it("accepts registered locale files", async () => {
    expect(supportedLocales).toContain("en");
    const catalogs = await Promise.all(supportedLocales.map(async (locale) => [locale, await loadLocaleMessages(locale)] as const));
    for (const [locale, messages] of catalogs) {
      expect(validateLocaleMessages(messages), locale).toEqual([]);
    }
  }, 60_000);

  it("rejects missing and extra nested keys", () => {
    expect(
      validateLocaleMessages({
        app: {
          noCompanies: {
            title: en.app.noCompanies.title,
            description: en.app.noCompanies.description,
            unexpected: "Unexpected",
          },
        },
      }),
    ).toEqual(
      expect.arrayContaining([
        "app.noCompanies.newCompany is missing",
        "app.noCompanies.unexpected is not defined in English",
      ]),
    );
  });

  it("rejects non-string leaves", () => {
    expect(
      validateLocaleMessages({
        app: {
          noCompanies: {
            ...en.app.noCompanies,
            title: ["Create your first company"],
          },
        },
      }),
    ).toEqual(expect.arrayContaining(["app.noCompanies.title must be a string"]));
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
          handler: '<span ONCLICK="alert(1)">Create</span>',
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

describe("on-demand locales", () => {
  it("loads a non-English catalog through i18n", async () => {
    await i18n.loadLanguages("pt-BR");
    expect(t("app.noCompanies.title", { lng: "pt-BR" })).not.toBe(en.app.noCompanies.title);
  }, 60_000);
});
