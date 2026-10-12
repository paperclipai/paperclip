import { describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import { patchInstanceGeneralSettingsSchema } from "@paperclipai/shared";
import { instanceSettingsService } from "../services/instance-settings.js";
import { getOperatorSettingDefaults } from "../services/setting-defaults.js";

const DEFAULTS_RAW = JSON.stringify({ feedbackDataSharingPreference: "allowed" });

function defaultsEnv(raw: string | undefined = DEFAULTS_RAW) {
  return { PAPERCLIP_SETTING_DEFAULTS: raw };
}

/** Mirrors the stub in instance-settings-managed-overlay.test.ts. */
function stubDb(row: Record<string, unknown>) {
  const persistedSets: Array<Record<string, unknown>> = [];
  const db = {
    select: () => ({ from: () => ({ where: () => Promise.resolve([row]) }) }),
    insert: () => {
      throw new Error("unexpected insert in test");
    },
    update: () => ({
      set: (values: Record<string, unknown>) => {
        persistedSets.push(values);
        return { where: () => ({ returning: () => Promise.resolve([{ ...row, ...values }]) }) };
      },
    }),
  } as unknown as Db;
  return { db, persistedSets };
}

function settingsRow(general: Record<string, unknown>) {
  return {
    id: "row-1",
    singletonKey: "default",
    defaultEnvironmentId: null,
    general,
    experimental: {},
    createdAt: new Date("2026-06-20T00:00:00.000Z"),
    updatedAt: new Date("2026-06-20T00:00:00.000Z"),
  };
}

describe("getOperatorSettingDefaults", () => {
  it("returns null with the variable unset", () => {
    expect(getOperatorSettingDefaults({})).toBeNull();
  });

  it("parses once and ignores unknown fields", () => {
    const defaults = getOperatorSettingDefaults(
      defaultsEnv('{"feedbackDataSharingPreference":"allowed","futureField":1}'),
    );
    expect(defaults).toEqual({ feedbackDataSharingPreference: "allowed" });
  });

  it("throws on malformed policy JSON (fail closed)", () => {
    expect(() => getOperatorSettingDefaults(defaultsEnv("{broken"))).toThrow(
      /PAPERCLIP_SETTING_DEFAULTS/,
    );
  });
});

describe("instanceSettingsService operator setting defaults", () => {
  it("persists a partial retention patch without resetting the stored hourly and longer tiers", async () => {
    const stored = { hourlyHours: 48, dailyDays: 7, weeklyWeeks: 2, monthlyMonths: 3 };
    const { db, persistedSets } = stubDb(settingsRow({ backupRetention: stored }));
    const svc = instanceSettingsService(db, { runtimeEnv: {} });
    const patch = patchInstanceGeneralSettingsSchema.parse({ backupRetention: { dailyDays: 14 } });
    expect(patch.backupRetention).toEqual({ dailyDays: 14 });
    const result = await svc.updateGeneral(patch);
    const expected = { ...stored, dailyDays: 14 };
    expect(result.general.backupRetention).toEqual(expected);
    expect(persistedSets).toHaveLength(1);
    expect(persistedSets[0]!.general).toMatchObject({ backupRetention: expected });
  });

  it("rejects unsupported and unknown retention patch fields", () => {
    for (const backupRetention of [{ hourlyHours: 5 }, { hourlyHours: 48, unknown: 1 }]) {
      expect(() => patchInstanceGeneralSettingsSchema.parse({ backupRetention })).toThrow();
    }
  });
  it("substitutes the operator value where the schema default holds", async () => {
    const { db } = stubDb(settingsRow({}));
    const svc = instanceSettingsService(db, { runtimeEnv: defaultsEnv() });
    const general = await svc.getGeneral();
    expect(general.feedbackDataSharingPreference).toBe("allowed");
  });

  it("treats a stored schema-default value as unchosen", async () => {
    // updateGeneral materializes every field with its schema default, so a
    // stored "prompt" does not mean the user chose "prompt" — the operator
    // default still substitutes.
    const { db } = stubDb(settingsRow({ feedbackDataSharingPreference: "prompt" }));
    const svc = instanceSettingsService(db, { runtimeEnv: defaultsEnv() });
    const general = await svc.getGeneral();
    expect(general.feedbackDataSharingPreference).toBe("allowed");
  });

  it("keeps an explicit non-default user choice", async () => {
    const { db } = stubDb(settingsRow({ feedbackDataSharingPreference: "not_allowed" }));
    const svc = instanceSettingsService(db, { runtimeEnv: defaultsEnv() });
    const general = await svc.getGeneral();
    expect(general.feedbackDataSharingPreference).toBe("not_allowed");
  });

  it("changes nothing with the variable unset (self-hosted)", async () => {
    const { db } = stubDb(settingsRow({}));
    const svc = instanceSettingsService(db, { runtimeEnv: {} });
    const general = await svc.getGeneral();
    expect(general.feedbackDataSharingPreference).toBe("prompt");
  });

  it("overlays reads but never persists the operator value", async () => {
    const { db, persistedSets } = stubDb(settingsRow({}));
    const svc = instanceSettingsService(db, { runtimeEnv: defaultsEnv() });
    const result = await svc.updateGeneral({ censorUsernameInLogs: true });
    // The response reflects the overlay...
    expect(result.general.feedbackDataSharingPreference).toBe("allowed");
    // ...but what hit the database is the schema default, not the operator's.
    expect(persistedSets).toHaveLength(1);
    const persistedGeneral = persistedSets[0]!.general as Record<string, unknown>;
    expect(persistedGeneral.censorUsernameInLogs).toBe(true);
    expect(persistedGeneral.feedbackDataSharingPreference).toBe("prompt");
  });

  it("does not let a full-GET echo promote the operator value into a choice", async () => {
    // A client PUTs back the full object it read, including the overlaid
    // "allowed". The stored value is still the schema default (unchosen), so
    // the echo maps back to the schema default: changing or unsetting
    // PAPERCLIP_SETTING_DEFAULTS later still takes effect.
    const { db, persistedSets } = stubDb(settingsRow({}));
    const svc = instanceSettingsService(db, { runtimeEnv: defaultsEnv() });
    const echoed = await svc.getGeneral();
    expect(echoed.feedbackDataSharingPreference).toBe("allowed");
    const result = await svc.updateGeneral({ ...echoed, censorUsernameInLogs: true });
    expect(result.general.feedbackDataSharingPreference).toBe("allowed");
    expect(persistedSets).toHaveLength(1);
    const persistedGeneral = persistedSets[0]!.general as Record<string, unknown>;
    expect(persistedGeneral.censorUsernameInLogs).toBe(true);
    expect(persistedGeneral.feedbackDataSharingPreference).toBe("prompt");
  });

  it("persists an explicit write of a value that differs from the operator default", async () => {
    const { db, persistedSets } = stubDb(settingsRow({}));
    const svc = instanceSettingsService(db, { runtimeEnv: defaultsEnv() });
    const result = await svc.updateGeneral({ feedbackDataSharingPreference: "not_allowed" });
    expect(result.general.feedbackDataSharingPreference).toBe("not_allowed");
    expect(persistedSets).toHaveLength(1);
    const persistedGeneral = persistedSets[0]!.general as Record<string, unknown>;
    expect(persistedGeneral.feedbackDataSharingPreference).toBe("not_allowed");
  });
});
