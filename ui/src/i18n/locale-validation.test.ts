import { describe, expect, it } from "vitest";
import { t } from ".";
import en from "./locales/en.json";
import { localeMessages } from "./locales";
import { validateLocaleMessages } from "./locale-validation";

describe("locale validation", () => {
  it("allows reordering complete rich-text elements but preserves their tags and attributes", () => {
    const reference = { message: 'Open <link>{{name}}</link> after reading <strong>the guide</strong>.' };
    expect(validateLocaleMessages({ message: 'Прочитайте <strong>руководство</strong> и откройте <link>{{name}}</link>.' }, reference)).toEqual([]);
    expect(validateLocaleMessages({ message: 'Откройте <a>{{name}}</a> и прочитайте <strong>руководство</strong>.' }, reference))
      .toContain("message markup tags and attributes must match English exactly");
    expect(validateLocaleMessages({ message: 'Откройте <link href="https://example.test">{{name}}</link> <strong>руководство</strong>.' }, reference))
      .toContain("message markup tags and attributes must match English exactly");
    expect(validateLocaleMessages({ message: '<link><strong>{{name}}</link></strong>' }, reference))
      .toContain("message markup must remain balanced");
  });

  it("preserves numbered Trans components and self-closing elements", () => {
    const reference = { message: '<0>{{name}}</0><br/>Done' };
    expect(validateLocaleMessages({ message: '<0>{{name}}</0><br/>Готово' }, reference)).toEqual([]);
    expect(validateLocaleMessages({ message: '<1>{{name}}</1><br/>Готово' }, reference))
      .toContain("message markup tags and attributes must match English exactly");
  });

  it("does not mistake plain angle-bracket examples for rich-text components", () => {
    expect(validateLocaleMessages({ message: "Выберите <имя папки>." }, { message: "Choose <folder name>." })).toEqual([]);
  });
  it("does not interpret punctuation after an example URL scheme as a new host", () => {
    const reference = { message: "Start with https:// — for example https://mcp.example.com/mcp." };
    expect(validateLocaleMessages({ message: "Начните с https://, например https://mcp.example.com/mcp." }, reference)).toEqual([]);
    expect(validateLocaleMessages({ message: "Начните с https://evil.example/mcp." }, reference))
      .toContain("message contains disallowed unexpected URL");
  });
  it("resolves English messages with key and default fallbacks", () => {
    expect(t("app.noCompanies.title")).toBe(en.app.noCompanies.title);
    expect(t("app.missing", { defaultValue: "Fallback" })).toBe("Fallback");
    expect(t("app.missing")).toBe("app.missing");
  });

  it("accepts registered locale files", () => {
    expect(Object.keys(localeMessages)).toContain("en");
    for (const [locale, messages] of Object.entries(localeMessages)) {
      expect(validateLocaleMessages(messages, en, locale), locale).toEqual([]);
    }
  });

  it("does not use HTML void elements as paired translation components", () => {
    function inspect(value: unknown, path: string): void {
      if (typeof value === "string") {
        // Trans parses these as self-closing HTML tags, dropping their child text.
        expect(value, path).not.toMatch(/<\/(?:area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)\s*>/i);
      } else if (value && typeof value === "object") {
        for (const [key, nested] of Object.entries(value)) inspect(nested, `${path}.${key}`);
      }
    }
    for (const [locale, messages] of Object.entries(localeMessages)) inspect(messages, locale);
  });

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

  it("validates Russian CLDR forms against an English two-form source", () => {
    const reference = { files_one: "{{count}} file", files_other: "{{count}} files" };
    const translated = { files_one: "{{count}} файл", files_few: "{{count}} файла", files_many: "{{count}} файлов", files_other: "{{count}} файла" };
    expect(validateLocaleMessages(translated, reference, "ru")).toEqual([]);
    const { files_few: _few, ...missingFew } = translated;
    expect(validateLocaleMessages(missingFew, reference, "ru")).toContain("files_few is missing");
    expect(validateLocaleMessages({ ...translated, files_many: "файлов" }, reference, "ru")).toEqual([
      'files_many interpolation placeholders must match English exactly: expected ["count"], received []',
    ]);
  });

  it("supports Arabic categories without adding those suffixes to English", () => {
    const reference = { items_one: "{{count}} item", items_other: "{{count}} items" };
    const translated = Object.fromEntries(["zero", "one", "two", "few", "many", "other"].map((category) => [`items_${category}`, "{{count}} عنصر"]));
    expect(validateLocaleMessages(translated, reference, "ar")).toEqual([]);
    expect(validateLocaleMessages({ ...translated, unrelated_few: "{{count}}" }, reference, "ar"))
      .toContain("unrelated_few is not defined in English");
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

  it("does not treat sentence punctuation as a changed example URL", () => {
    expect(validateLocaleMessages(
      { hint: "Откройте https://example.test/chat, затем войдите." },
      { hint: "Open https://example.test/chat and sign in." },
      "ru",
    )).toEqual([]);
    expect(validateLocaleMessages(
      { hint: "Откройте https://other.test/chat, затем войдите." },
      { hint: "Open https://example.test/chat and sign in." },
      "ru",
    )).toContain("hint contains disallowed unexpected URL");
  });
});
