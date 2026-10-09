import { describe, expect, it } from "vitest";
import {
  DEFAULTABLE_GENERAL_SETTINGS,
  SETTING_DEFAULTS_ENV_KEY,
  applyOperatorGeneralDefaults,
  parseSettingDefaults,
  stripOperatorGeneralEchoes,
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

describe("stripOperatorGeneralEchoes", () => {
  const schemaDefaults = instanceGeneralSettingsSchema.parse({});
  const defaults = { feedbackDataSharingPreference: "allowed" as const };

  it("is the identity when no operator defaults are configured", () => {
    const next = { ...schemaDefaults, feedbackDataSharingPreference: "allowed" as const };
    expect(stripOperatorGeneralEchoes(schemaDefaults, next, null)).toBe(next);
  });

  it("maps an echoed operator value on an unchosen field back to the schema default", () => {
    // Stored is still the schema default (unchosen); the incoming full-object
    // echo carries the overlaid operator value. Persisting it would make the
    // operator value sticky, so it maps back to the schema default.
    const next = { ...schemaDefaults, feedbackDataSharingPreference: "allowed" as const };
    const stripped = stripOperatorGeneralEchoes(schemaDefaults, next, defaults);
    expect(stripped.feedbackDataSharingPreference).toBe(
      schemaDefaults.feedbackDataSharingPreference,
    );
  });

  it("keeps an incoming value that differs from the operator default", () => {
    const next = { ...schemaDefaults, feedbackDataSharingPreference: "not_allowed" as const };
    const stripped = stripOperatorGeneralEchoes(schemaDefaults, next, defaults);
    expect(stripped).toBe(next);
    expect(stripped.feedbackDataSharingPreference).toBe("not_allowed");
  });

  it("keeps a write over an explicit stored choice, even at the operator value", () => {
    // The user previously chose "not_allowed" and now picks the operator's
    // value: stored is not the schema default, so this is a real transition
    // and persists as given.
    const stored = { ...schemaDefaults, feedbackDataSharingPreference: "not_allowed" as const };
    const next = { ...schemaDefaults, feedbackDataSharingPreference: "allowed" as const };
    const stripped = stripOperatorGeneralEchoes(stored, next, defaults);
    expect(stripped).toBe(next);
    expect(stripped.feedbackDataSharingPreference).toBe("allowed");
  });

  it("does not mutate its inputs", () => {
    const stored = { ...schemaDefaults };
    const next = { ...schemaDefaults, feedbackDataSharingPreference: "allowed" as const };
    stripOperatorGeneralEchoes(stored, next, defaults);
    expect(next.feedbackDataSharingPreference).toBe("allowed");
    expect(stored.feedbackDataSharingPreference).toBe(
      schemaDefaults.feedbackDataSharingPreference,
    );
  });
});
