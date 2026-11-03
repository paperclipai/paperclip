import { afterEach, describe, expect, it } from "vitest";
import { i18n } from "@/i18n";
import { companyExportFidelityWarningDisplay } from "./company-export-fidelity-display";

const warningKinds = [
  {
    code: "cost_history_not_exported",
    singular: "cost event",
    plural: "cost events",
    key: "localizationProjects.exportCostEventsOmitted",
    ruSuffix: "о расходах",
  },
  {
    code: "activity_history_not_exported",
    singular: "activity log entry",
    plural: "activity log entries",
    key: "localizationProjects.exportActivityEntriesOmitted",
    ruSuffix: "журнала активности",
  },
];

const pluralExamples = [
  [1, "не включена 1 запись"],
  [2, "не включены 2 записи"],
  [5, "не включено 5 записей"],
  [7, "не включено 7 записей"],
  [11, "не включено 11 записей"],
  [21, "не включена 21 запись"],
  [22, "не включены 22 записи"],
  [101, "не включена 101 запись"],
  [111, "не включено 111 записей"],
  [214, "не включено 214 записей"],
] as const;

afterEach(async () => { await i18n.changeLanguage("en"); });

describe.each(warningKinds)("export fidelity display: $code", (kind) => {
  it.each(pluralExamples)("uses Russian plurals for %s and restores exact English without mutating the warning", async (count, ruCount) => {
    const message = `${count} ${count === 1 ? `${kind.singular} is` : `${kind.plural} are`} not included in the export bundle.`;
    const warning = Object.freeze({ code: kind.code, severity: "warning", message });
    const before = JSON.stringify(warning);
    for (const language of ["ru", "en", "ru"]) {
      await i18n.changeLanguage(language);
      expect(companyExportFidelityWarningDisplay(warning)).toBe(language === "en"
        ? message
        : `В пакет экспорта ${ruCount} ${kind.ruSuffix}.`);
      expect(JSON.stringify(warning)).toBe(before);
    }
  });

  it("defines the Russian fractional fallback without accepting fractional server counts", async () => {
    await i18n.changeLanguage("ru");
    expect(i18n.t(kind.key, { count: 1.5 })).toBe(`В пакет экспорта не включено 1.5 записи ${kind.ruSuffix}.`);
  });

  it.each([
    "0", "-1", "1.5", "01", "+2", "1e3", "1,000", "NaN", "Infinity", "9007199254740992",
  ])("keeps non-canonical or unsupported count %s raw", async (count) => {
    const message = `${count} ${kind.plural} are not included in the export bundle.`;
    await i18n.changeLanguage("ru");
    expect(companyExportFidelityWarningDisplay({ code: kind.code, message })).toBe(message);
  });

  it.each([
    "", " ", "\n", "\r\n", "\nProvider detail", " Additional context.",
  ])("preserves altered or wrapped messages (suffix %j)", async (suffix) => {
    const canonical = `7 ${kind.plural} are not included in the export bundle.`;
    const messages = [
      suffix ? canonical + suffix : canonical.slice(0, -1),
      " " + canonical,
      `1 ${kind.plural} are not included in the export bundle.`,
      `2 ${kind.singular} is not included in the export bundle.`,
      canonical.replace("not included", "included"),
      canonical.replace("export bundle", "custom export bundle"),
    ];
    await i18n.changeLanguage("ru");
    for (const message of messages) {
      expect(companyExportFidelityWarningDisplay({ code: kind.code, message })).toBe(message);
    }
  });

  it.each(["custom_warning", "approvals_not_exported", "constructor", "__proto__", "toString", ""])(
    "does not translate matching text with unknown code %j", async (code) => {
      const message = `7 ${kind.plural} are not included in the export bundle.`;
      await i18n.changeLanguage("ru");
      expect(companyExportFidelityWarningDisplay({ code, message })).toBe(message);
    },
  );

  it("keeps the other warning kind and arbitrary diagnostics raw under a known code", async () => {
    const other = warningKinds.find((candidate) => candidate.code !== kind.code)!;
    const messages = [
      `7 ${other.plural} are not included in the export bundle.`,
      "Provider error: raw_name /API/path unchanged.",
    ];
    for (const language of ["ru", "en", "ru"]) {
      await i18n.changeLanguage(language);
      for (const message of messages) {
        expect(companyExportFidelityWarningDisplay({ code: kind.code, message })).toBe(message);
      }
    }
  });
});
