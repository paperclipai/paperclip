import i18next from "i18next";
import { describe, expect, it } from "vitest";
import { t } from ".";
import en from "./locales/en.json";
import { DEFAULT_LOCALE, localeMessages } from "./locales";
import { validateLocaleMessages } from "./locale-validation";

describe("locale validation", () => {
  it("resolves English messages with key and default fallbacks", () => {
    expect(t("app.noCompanies.title")).toBe(en.app.noCompanies.title);
    expect(t("app.missing", { defaultValue: "Fallback" })).toBe("Fallback");
    expect(t("app.missing")).toBe("app.missing");
  });

  it("accepts registered locale files", () => {
    expect(Object.keys(localeMessages)).toContain("en");
    for (const [locale, messages] of Object.entries(localeMessages)) {
      expect(validateLocaleMessages(messages), locale).toEqual([]);
    }
  });

  it("accepts a partial locale file", () => {
    expect(
      validateLocaleMessages({
        app: {
          noCompanies: {
            title: en.app.noCompanies.title,
          },
        },
      }),
    ).toEqual([]);
  });

  it("accepts an empty locale file", () => {
    expect(validateLocaleMessages({})).toEqual([]);
  });

  it("rejects an extra nested key in a partial locale file", () => {
    expect(
      validateLocaleMessages({
        app: {
          noCompanies: {
            title: en.app.noCompanies.title,
            unexpected: "Unexpected",
          },
        },
      }),
    ).toEqual(["app.noCompanies.unexpected is not defined in English"]);
  });

  it("keeps every safety check active on a partial locale file", () => {
    const reference = {
      placeholder: "Invite {{name}}",
      html: "Create company",
      url: "Create company",
      length: "Short",
    };

    expect(
      validateLocaleMessages(
        {
          placeholder: "Invita {{nome}}",
          html: "<strong>Crea azienda</strong>",
          url: "https://example.test",
          length: "x".repeat(200),
        },
        reference,
      ),
    ).toEqual([
      "html contains disallowed raw HTML tag",
      "length is too long: 200 characters exceeds 133",
      'placeholder interpolation placeholders must match English exactly: expected ["name"], received ["nome"]',
      "url contains disallowed unexpected URL",
    ]);
  });

  it("falls back to English for a key that a partial locale omits", async () => {
    const partialItalian = {
      app: {
        noCompanies: {
          title: "Crea la tua prima azienda",
        },
      },
    };
    expect(validateLocaleMessages(partialItalian)).toEqual([]);

    const instance = i18next.createInstance();
    await instance.init({
      resources: {
        [DEFAULT_LOCALE]: { translation: en },
        it: { translation: partialItalian },
      },
      lng: "it",
      fallbackLng: DEFAULT_LOCALE,
      defaultNS: "translation",
      initAsync: false,
    });

    expect(instance.t("app.noCompanies.title")).toBe(partialItalian.app.noCompanies.title);
    expect(instance.t("app.noCompanies.newCompany")).toBe(en.app.noCompanies.newCompany);
    expect(instance.t("app.noCompanies.description")).toBe(en.app.noCompanies.description);
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
