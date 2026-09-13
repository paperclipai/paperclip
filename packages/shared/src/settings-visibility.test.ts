import { describe, expect, it } from "vitest";
import { INSTANCE_FEATURE_KEYS } from "./feature-catalog.js";
import {
  HIDEABLE_COMPANY_PAGES,
  HIDEABLE_COMPANY_SECTIONS,
  HIDEABLE_GENERAL_SECTIONS,
  HIDEABLE_SETTING_KEYS,
  UI_ONLY_GENERAL_SECTIONS,
  experimentalSettingKey,
  hidesCompanyPage,
  hidesCompanySection,
  hidesExperimentalSetting,
  hidesGeneralSection,
  hidesInstancePage,
  parseHiddenSettingsList,
} from "./settings-visibility.js";
import { instanceGeneralSettingsSchema } from "./validators/instance.js";

describe("hideable setting keys", () => {
  it("derives one key per experimental flag and has no duplicates", () => {
    const experimental = HIDEABLE_SETTING_KEYS.filter(
      (key) => key.startsWith("instance.experimental."),
    );
    expect(experimental).toEqual(INSTANCE_FEATURE_KEYS.map(experimentalSettingKey));
    expect(new Set(HIDEABLE_SETTING_KEYS).size).toBe(HIDEABLE_SETTING_KEYS.length);
  });

  it("covers every top-level company settings page except the General root", () => {
    expect(HIDEABLE_COMPANY_PAGES).toEqual([
      "company.members",
      "company.invites",
      "company.secrets",
      "company.export",
      "company.import",
    ]);
    for (const page of HIDEABLE_COMPANY_PAGES) {
      expect(HIDEABLE_SETTING_KEYS).toContain(page);
    }
  });

  it("maps field-backed general sections onto real general-settings fields", () => {
    const generalFields = Object.keys(instanceGeneralSettingsSchema.shape);
    const uiOnly = new Set<string>(UI_ONLY_GENERAL_SECTIONS);
    for (const section of HIDEABLE_GENERAL_SECTIONS) {
      if (uiOnly.has(section)) continue;
      expect(generalFields).toContain(section.slice("instance.general.".length));
    }
  });
});

describe("parseHiddenSettingsList", () => {
  it("returns nothing hidden for undefined or empty input", () => {
    expect(parseHiddenSettingsList(undefined)).toEqual({ hidden: [], unknown: [] });
    expect(parseHiddenSettingsList(" , ,")).toEqual({ hidden: [], unknown: [] });
  });

  it("splits known from unknown keys, trims, and deduplicates", () => {
    const parsed = parseHiddenSettingsList(
      "instance.plugins, instance.general.backupRetention ,instance.bogus,instance.plugins,instance.experimental.enableEnvironments",
    );
    expect(parsed.hidden).toEqual([
      "instance.plugins",
      "instance.general.backupRetention",
      "instance.experimental.enableEnvironments",
    ]);
    expect(parsed.unknown).toEqual(["instance.bogus"]);
  });
});

describe("membership helpers", () => {
  const hidden = new Set(
    parseHiddenSettingsList(
      "instance.plugins,instance.general.censorUsernameInLogs,instance.experimental.enableEnvironments",
    ).hidden,
  );

  it("answers company-page membership", () => {
    const companyHidden = new Set(parseHiddenSettingsList("company.import,company.secrets").hidden);
    expect(hidesCompanyPage(companyHidden, "company.import")).toBe(true);
    expect(hidesCompanyPage(companyHidden, "company.secrets")).toBe(true);
    expect(hidesCompanyPage(companyHidden, "company.export")).toBe(false);
  });

  it("answers company-section membership independently of the parent page", () => {
    const sectionHidden = new Set(parseHiddenSettingsList("company.secrets.vaults").hidden);
    expect(hidesCompanySection(sectionHidden, "company.secrets.vaults")).toBe(true);
    expect(hidesCompanySection(sectionHidden, "company.secrets.proposals")).toBe(false);
    expect(hidesCompanyPage(sectionHidden, "company.secrets")).toBe(false);
  });

  it("keeps every company section key parseable and prefixed by its page", () => {
    for (const key of HIDEABLE_COMPANY_SECTIONS) {
      expect(parseHiddenSettingsList(key).hidden).toEqual([key]);
      expect(key.startsWith("company.")).toBe(true);
    }
  });

  it("answers page, section, and experimental membership", () => {
    expect(hidesInstancePage(hidden, "instance.plugins")).toBe(true);
    expect(hidesInstancePage(hidden, "instance.adapters")).toBe(false);
    expect(hidesGeneralSection(hidden, "instance.general.censorUsernameInLogs")).toBe(true);
    expect(hidesGeneralSection(hidden, "instance.general.backupRetention")).toBe(false);
    expect(hidesExperimentalSetting(hidden, "enableEnvironments")).toBe(true);
    expect(hidesExperimentalSetting(hidden, "enableIsolatedWorkspaces")).toBe(false);
  });

  it("treats a hidden Experimental page as hiding every toggle", () => {
    const pageHidden = new Set(parseHiddenSettingsList("instance.experimental").hidden);
    expect(hidesExperimentalSetting(pageHidden, "enableEnvironments")).toBe(true);
  });
});
