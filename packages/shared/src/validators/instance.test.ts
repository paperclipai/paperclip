import { describe, expect, it } from "vitest";
import {
  backupRetentionPolicySchema,
  instanceGeneralSettingsSchema,
  patchInstanceGeneralSettingsSchema,
  instanceExperimentalSettingsSchema,
  patchInstanceExperimentalSettingsSchema,
} from "./instance.js";

describe("backupRetentionPolicySchema", () => {
  it("accepts all valid preset combinations", () => {
    for (const dailyDays of [3, 7, 14]) {
      for (const weeklyWeeks of [1, 2, 4]) {
        for (const monthlyMonths of [1, 3, 6]) {
          expect(
            backupRetentionPolicySchema.safeParse({ dailyDays, weeklyWeeks, monthlyMonths }).success,
          ).toBe(true);
        }
      }
    }
  });

  it("defaults to the default backup retention values", () => {
    const result = backupRetentionPolicySchema.safeParse({});
    expect(result.success && result.data.dailyDays).toBe(7);
    expect(result.success && result.data.weeklyWeeks).toBe(4);
    expect(result.success && result.data.monthlyMonths).toBe(1);
  });

  it("rejects a dailyDays value not in presets", () => {
    expect(backupRetentionPolicySchema.safeParse({ dailyDays: 5 }).success).toBe(false);
    expect(backupRetentionPolicySchema.safeParse({ dailyDays: 30 }).success).toBe(false);
  });

  it("rejects a weeklyWeeks value not in presets", () => {
    expect(backupRetentionPolicySchema.safeParse({ weeklyWeeks: 3 }).success).toBe(false);
  });

  it("rejects a monthlyMonths value not in presets", () => {
    expect(backupRetentionPolicySchema.safeParse({ monthlyMonths: 12 }).success).toBe(false);
  });
});

describe("instanceGeneralSettingsSchema", () => {
  it("accepts an empty object (all defaults)", () => {
    const result = instanceGeneralSettingsSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("defaults censorUsernameInLogs to false", () => {
    const result = instanceGeneralSettingsSchema.safeParse({});
    expect(result.success && result.data.censorUsernameInLogs).toBe(false);
  });

  it("defaults keyboardShortcuts to false", () => {
    const result = instanceGeneralSettingsSchema.safeParse({});
    expect(result.success && result.data.keyboardShortcuts).toBe(false);
  });

  it("defaults feedbackDataSharingPreference to prompt", () => {
    const result = instanceGeneralSettingsSchema.safeParse({});
    expect(result.success && result.data.feedbackDataSharingPreference).toBe("prompt");
  });

  it("accepts valid feedbackDataSharingPreference values", () => {
    for (const pref of ["allowed", "not_allowed", "prompt"]) {
      expect(
        instanceGeneralSettingsSchema.safeParse({ feedbackDataSharingPreference: pref }).success,
      ).toBe(true);
    }
  });

  it("rejects unknown fields (strict schema)", () => {
    expect(
      instanceGeneralSettingsSchema.safeParse({ unknownField: true }).success,
    ).toBe(false);
  });

  it("accepts a full valid config", () => {
    const result = instanceGeneralSettingsSchema.safeParse({
      censorUsernameInLogs: true,
      keyboardShortcuts: true,
      feedbackDataSharingPreference: "allowed",
      backupRetention: { dailyDays: 3, weeklyWeeks: 1, monthlyMonths: 1 },
    });
    expect(result.success).toBe(true);
  });
});

describe("patchInstanceGeneralSettingsSchema", () => {
  it("accepts an empty object (all optional)", () => {
    expect(patchInstanceGeneralSettingsSchema.safeParse({}).success).toBe(true);
  });

  it("accepts a partial update", () => {
    expect(
      patchInstanceGeneralSettingsSchema.safeParse({ censorUsernameInLogs: true }).success,
    ).toBe(true);
  });
});

describe("instanceExperimentalSettingsSchema", () => {
  it("accepts an empty object (all defaults)", () => {
    const result = instanceExperimentalSettingsSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("defaults enableIsolatedWorkspaces to false", () => {
    const result = instanceExperimentalSettingsSchema.safeParse({});
    expect(result.success && result.data.enableIsolatedWorkspaces).toBe(false);
  });

  it("defaults autoRestartDevServerWhenIdle to false", () => {
    const result = instanceExperimentalSettingsSchema.safeParse({});
    expect(result.success && result.data.autoRestartDevServerWhenIdle).toBe(false);
  });

  it("rejects unknown fields (strict schema)", () => {
    expect(
      instanceExperimentalSettingsSchema.safeParse({ unknownField: true }).success,
    ).toBe(false);
  });
});

describe("patchInstanceExperimentalSettingsSchema", () => {
  it("accepts an empty object (all optional)", () => {
    expect(patchInstanceExperimentalSettingsSchema.safeParse({}).success).toBe(true);
  });

  it("accepts a partial update", () => {
    expect(
      patchInstanceExperimentalSettingsSchema.safeParse({ enableIsolatedWorkspaces: true }).success,
    ).toBe(true);
  });
});
