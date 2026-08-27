import { describe, expect, it } from "vitest";
import {
  DEFAULTABLE_GENERAL_SETTINGS,
  SETTING_DEFAULTS_ENV_KEY,
  applyOperatorGeneralDefaults,
  parseSettingDefaults,
} from "./setting-defaults.js";
import { instanceGeneralSettingsSchema } from "./validators/instance.js";

describe("parseSettingDefaults", () => {
  it("returns null defaults for an unset or blank variable", () => {
    expect(parseSettingDefaults(undefined)).toEqual({ defaults: null, unknown: [] });
    expect(parseSettingDefaults("")).toEqual({ defaults: null, unknown: [] });
    expect(parseSettingDefaults("   ")).toEqual({ defaults: null, unknown: [] });
  });

  it("parses known fields and validates their values", () => {
    const { defaults, unknown } = parseSettingDefaults(
      '{"feedbackDataSharingPreference":"allowed"}',
    );
    expect(defaults).toEqual({ feedbackDataSharingPreference: "allowed" });
    expect(unknown).toEqual([]);
  });

  it("collects unknown fields instead of failing, for mixed-version fleets", () => {
    const { defaults, unknown } = parseSettingDefaults(
      '{"feedbackDataSharingPreference":"not_allowed","someFutureSetting":true}',
    );
    expect(defaults).toEqual({ feedbackDataSharingPreference: "not_allowed" });
    expect(unknown).toEqual(["someFutureSetting"]);
  });

  it("fails closed on malformed JSON and non-object shapes", () => {
    expect(() => parseSettingDefaults("{nope")).toThrow(SETTING_DEFAULTS_ENV_KEY);
    expect(() => parseSettingDefaults('"allowed"')).toThrow(/JSON object/);
    expect(() => parseSettingDefaults("[1,2]")).toThrow(/JSON object/);
    expect(() => parseSettingDefaults("null")).toThrow(/JSON object/);
  });

  it("fails closed on an invalid value for a known field", () => {
    expect(() =>
      parseSettingDefaults('{"feedbackDataSharingPreference":"sometimes"}'),
    ).toThrow(/feedbackDataSharingPreference/);
  });

  it("keeps every registry entry a real general-settings field", () => {
    const shape = Object.keys(instanceGeneralSettingsSchema.shape);
    for (const key of DEFAULTABLE_GENERAL_SETTINGS) {
      expect(shape).toContain(key);
    }
  });
});

describe("applyOperatorGeneralDefaults", () => {
  const schemaDefaults = instanceGeneralSettingsSchema.parse({});

  it("is the identity when no operator defaults are configured", () => {
    expect(applyOperatorGeneralDefaults(schemaDefaults, null)).toBe(schemaDefaults);
  });

  it("substitutes the operator value where the schema default still holds", () => {
    const overlaid = applyOperatorGeneralDefaults(schemaDefaults, {
      feedbackDataSharingPreference: "allowed",
    });
    expect(overlaid.feedbackDataSharingPreference).toBe("allowed");
    // Other fields are untouched.
    expect(overlaid.backupRetention).toEqual(schemaDefaults.backupRetention);
  });

  it("never overrides an explicit non-default choice", () => {
    const chosen = { ...schemaDefaults, feedbackDataSharingPreference: "not_allowed" as const };
    const overlaid = applyOperatorGeneralDefaults(chosen, {
      feedbackDataSharingPreference: "allowed",
    });
    expect(overlaid.feedbackDataSharingPreference).toBe("not_allowed");
    expect(overlaid).toBe(chosen);
  });

  it("does not mutate its input", () => {
    const input = { ...schemaDefaults };
    applyOperatorGeneralDefaults(input, { feedbackDataSharingPreference: "allowed" });
    expect(input.feedbackDataSharingPreference).toBe(
      schemaDefaults.feedbackDataSharingPreference,
    );
  });
});
