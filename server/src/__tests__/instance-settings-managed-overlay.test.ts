import { describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import {
  applyManagedExperimentalOverlay,
  instanceSettingsService,
  normalizeExperimentalSettings,
} from "../services/instance-settings.js";
import { parseManagedConfigEnv } from "../services/managed-config.js";

const MANAGED_RAW = JSON.stringify({
  v: 1,
  mode: "cloud",
  catalogVersion: "2026.720.0",
  // enableApps stored true in the DB gets forced off; enablePipelines has no
  // stored value, so the overlay wins over the schema default (false).
  features: { enableApps: false, enablePipelines: true },
  plugins: { autoInstall: [] },
});

function managedEnv(raw: string | undefined = MANAGED_RAW) {
  return { PAPERCLIP_MANAGED_CONFIG: raw };
}

/**
 * Minimal stand-in for the drizzle query chains instanceSettingsService uses.
 * Captures every `update().set()` payload so tests can assert what would be
 * persisted.
 */
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

function settingsRow(experimental: Record<string, unknown>) {
  return {
    id: "row-1",
    singletonKey: "default",
    defaultEnvironmentId: null,
    general: {},
    experimental,
    createdAt: new Date("2026-06-20T00:00:00.000Z"),
    updatedAt: new Date("2026-06-20T00:00:00.000Z"),
  };
}

describe("applyManagedExperimentalOverlay", () => {
  it("is the identity with no managed config (self-hosted)", () => {
    const experimental = normalizeExperimentalSettings({ enableApps: true });
    const result = applyManagedExperimentalOverlay(experimental, null);
    expect(result.experimental).toEqual(experimental);
    expect(result.managedKeys).toEqual({});
  });

  it("overlays managed values over stored values and records metadata", () => {
    const config = parseManagedConfigEnv(managedEnv())!;
    const stored = normalizeExperimentalSettings({ enableApps: true });
    const { experimental, managedKeys } = applyManagedExperimentalOverlay(stored, config);

    // managed overlay > tenant DB value
    expect(experimental.enableApps).toBe(false);
    // managed overlay > schema default
    expect(experimental.enablePipelines).toBe(true);
    // unmanaged keys keep their stored/default values
    expect(experimental.enableCases).toBe(false);
    expect(managedKeys).toEqual({
      enableApps: { managed: true, managedBy: "paperclip-cloud" },
      enablePipelines: { managed: true, managedBy: "paperclip-cloud" },
    });
    // input is not mutated
    expect(stored.enableApps).toBe(true);
  });
});

describe("instanceSettingsService managed overlay", () => {
  it("fails closed at construction on a malformed managed config", () => {
    const { db } = stubDb(settingsRow({}));
    expect(() => instanceSettingsService(db, { runtimeEnv: managedEnv("{bad") })).toThrow(
      /PAPERCLIP_MANAGED_CONFIG is not valid JSON/,
    );
  });

  it("overlays managed values on getExperimental and exposes managedKeys", async () => {
    const { db } = stubDb(settingsRow({ enableApps: true }));
    const svc = instanceSettingsService(db, { runtimeEnv: managedEnv() });

    const experimental = await svc.getExperimental();
    expect(experimental.enableApps).toBe(false);
    expect(experimental.enablePipelines).toBe(true);
    expect(experimental.managedKeys).toEqual({
      enableApps: { managed: true, managedBy: "paperclip-cloud" },
      enablePipelines: { managed: true, managedBy: "paperclip-cloud" },
    });
  });

  it("overlays managed values on get()", async () => {
    const { db } = stubDb(settingsRow({ enableApps: true }));
    const svc = instanceSettingsService(db, { runtimeEnv: managedEnv() });

    const settings = await svc.get();
    expect(settings.experimental.enableApps).toBe(false);
    expect(settings.experimental.managedKeys?.enableApps).toEqual({
      managed: true,
      managedBy: "paperclip-cloud",
    });
  });

  it("leaves the self-hosted read path unchanged (no managedKeys field)", async () => {
    const { db } = stubDb(settingsRow({ enableApps: true }));
    const svc = instanceSettingsService(db, { runtimeEnv: {} });

    const experimental = await svc.getExperimental();
    expect(experimental.enableApps).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(experimental, "managedKeys")).toBe(false);
    expect(experimental).toEqual(normalizeExperimentalSettings({ enableApps: true }));

    const settings = await svc.get();
    expect(Object.prototype.hasOwnProperty.call(settings.experimental, "managedKeys")).toBe(false);
  });

  it("never persists the overlay: updates write stored values, responses show managed ones", async () => {
    const { db, persistedSets } = stubDb(settingsRow({ enableApps: true }));
    const svc = instanceSettingsService(db, { runtimeEnv: managedEnv() });

    const updated = await svc.updateExperimental({ enableCases: true });

    expect(persistedSets).toHaveLength(1);
    const persisted = persistedSets[0]!.experimental as Record<string, unknown>;
    // The tenant's stored value survives in the DB even though the overlay
    // masks it at read time — a later un-managing restores tenant intent.
    expect(persisted.enableApps).toBe(true);
    // The overlay-added value is not written.
    expect(persisted.enablePipelines).toBe(false);
    expect(persisted.enableCases).toBe(true);
    expect(persisted).not.toHaveProperty("managedKeys");

    // The response still reflects the overlay.
    expect(updated.experimental.enableApps).toBe(false);
    expect(updated.experimental.enablePipelines).toBe(true);
    expect(updated.experimental.managedKeys?.enableApps).toEqual({
      managed: true,
      managedBy: "paperclip-cloud",
    });
  });

  it("does not let managed metadata leak into self-hosted writes", async () => {
    const { db, persistedSets } = stubDb(settingsRow({}));
    const svc = instanceSettingsService(db, { runtimeEnv: {} });

    const updated = await svc.updateExperimental({ enableCases: true });
    expect(persistedSets).toHaveLength(1);
    expect(persistedSets[0]!.experimental).not.toHaveProperty("managedKeys");
    expect(Object.prototype.hasOwnProperty.call(updated.experimental, "managedKeys")).toBe(false);
  });
});
