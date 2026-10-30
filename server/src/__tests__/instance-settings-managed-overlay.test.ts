import { describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import { INSTANCE_FEATURE_CATALOG } from "@paperclipai/shared";
import {
  applyManagedExperimentalOverlay,
  instanceSettingsService,
  normalizeExperimentalSettings,
} from "../services/instance-settings.js";
import { parseManagedConfigEnv } from "../services/managed-config.js";
import { evaluateExecutionAllowlist } from "../services/execution-allowlist.js";

const MANAGED_RAW = JSON.stringify({
  v: 1,
  mode: "cloud",
  catalogVersion: "2026.720.0",
  // enableApps is retained only for compatibility and must be ignored;
  // enableStatusCards remains a live managed feature.
  features: { enableApps: false, enableStatusCards: true },
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
    transaction: (fn: (tx: Db) => Promise<unknown>) => fn(db),
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

  it("ignores the retired Apps flag while overlaying live managed values", () => {
    const config = parseManagedConfigEnv(managedEnv())!;
    const stored = normalizeExperimentalSettings({ enableApps: true });
    const { experimental, managedKeys } = applyManagedExperimentalOverlay(stored, config);

    expect(experimental.enableApps).toBe(true);
    // managed overlay > schema default
    expect(experimental.enableStatusCards).toBe(true);
    // unmanaged keys keep their stored/default values
    expect(experimental.enableCases).toBe(false);
    expect(managedKeys).toEqual({
      enableStatusCards: { managed: true, managedBy: "paperclip-cloud" },
    });
    // input is not mutated
    expect(stored.enableApps).toBe(true);
  });
});

describe("instanceSettingsService managed overlay", () => {
  it.each(["team.staging.paperclip.app", "team.paperclip.app"])(
    "enables private Notebook through managed config without changing stored opt-out on %s",
    async (primaryHost) => {
      const row = settingsRow({ enablePaperclipNotebook: false });
      const { db, persistedSets } = stubDb(row);
      const service = instanceSettingsService(db, { runtimeEnv: {
        PAPERCLIP_PRIMARY_HOST: primaryHost,
        ...managedEnv(JSON.stringify({
          v: 1, mode: "cloud", catalogVersion: "test",
          features: { enablePaperclipNotebook: true }, plugins: { autoInstall: [] },
        })),
      } });
      expect(await service.getExperimental()).toMatchObject({
        enablePaperclipNotebook: true,
        managedKeys: { enablePaperclipNotebook: { managed: true, managedBy: "paperclip-cloud" } },
      });
      expect((await service.get()).experimental.enablePaperclipNotebook).toBe(true);
      expect(persistedSets).toHaveLength(0);
      expect(row.experimental).toEqual({ enablePaperclipNotebook: false });
      expect((await instanceSettingsService(db, { runtimeEnv: {} }).getExperimental()).enablePaperclipNotebook).toBe(false);
    },
  );

  it("persists an explicit self-hosted Notebook opt-in and disable across service recreation", async () => {
    const row = settingsRow({});
    const { db, persistedSets } = stubDb(row);
    expect((await instanceSettingsService(db, { runtimeEnv: {} }).getExperimental()).enablePaperclipNotebook).toBe(false);
    for (const enabled of [true, false]) {
      const service = instanceSettingsService(db, { runtimeEnv: {} });
      const updated = await service.updateExperimental({ enablePaperclipNotebook: enabled });
      Object.assign(row, persistedSets.at(-1));
      expect(updated.experimental.enablePaperclipNotebook).toBe(enabled);
      expect((row.experimental as Record<string, unknown>).enablePaperclipNotebook).toBe(enabled);
      expect((await instanceSettingsService(db, { runtimeEnv: {} }).getExperimental()).enablePaperclipNotebook).toBe(enabled);
    }
  });

  it.each(["team.staging.paperclip.app", "team.paperclip.app", undefined])(
    "enforces every Cloud-enabled flag over old tenant values on %s",
    async (primaryHost) => {
      const features = Object.fromEntries(Object.entries(INSTANCE_FEATURE_CATALOG)
        .filter(([, entry]) => entry.tier === "managed")
        .map(([key]) => [key, true]));
      const stored = Object.fromEntries(Object.keys(features).map((key) => [key, false]));
      const { db, persistedSets } = stubDb(settingsRow(stored));
      const runtimeEnv = {
        PAPERCLIP_PRIMARY_HOST: primaryHost,
        ...managedEnv(JSON.stringify({
          v: 1, mode: "cloud", catalogVersion: "test",
          features, plugins: { autoInstall: [] },
        })),
      };
      const service = instanceSettingsService(db, { runtimeEnv });
      expect(await service.getExperimental()).toMatchObject(features);
      expect((await service.get()).experimental).toMatchObject(features);
      expect((await service.getExperimental()).managedKeys).toMatchObject(
        Object.fromEntries(Object.keys(features)
          .filter((key) => key !== "enableApps" && key !== "enableMcpAggregators")
          .map((key) => [key, { managed: true, managedBy: "paperclip-cloud" }])),
      );
      for (const key of Object.keys(features)) {
        await expect(service.updateExperimental({ [key]: false })).rejects.toMatchObject({
          status: 403,
          details: { code: "settings_operator_managed" },
        });
      }
      expect(persistedSets).toHaveLength(0);
      expect(await instanceSettingsService(db, { runtimeEnv }).getExperimental()).toMatchObject(features);
    },
  );

  it("keeps sandbox policy enforced on staging after a tenant tries to disable it", async () => {
    const row = settingsRow({ enableManagedSandboxOnly: false });
    const { db, persistedSets } = stubDb(row);
    const runtimeEnv = {
      PAPERCLIP_PRIMARY_HOST: "team.staging.paperclip.app",
      ...managedEnv(JSON.stringify({
        v: 1, mode: "cloud", catalogVersion: "test",
        features: { enableManagedSandboxOnly: true }, plugins: { autoInstall: [] },
      })),
    };
    const service = instanceSettingsService(db, { runtimeEnv });
    await expect(service.updateExperimental({ enableManagedSandboxOnly: false })).rejects.toMatchObject({ status: 403 });
    expect(persistedSets).toHaveLength(0);
    const restored = await instanceSettingsService(db, { runtimeEnv }).getExperimental();
    for (const experimental of [await service.getExperimental(), restored]) {
      expect(experimental).toMatchObject({
        enableManagedSandboxOnly: true,
        managedKeys: { enableManagedSandboxOnly: { managed: true, managedBy: "paperclip-cloud" } },
      });
      expect(evaluateExecutionAllowlist(
        { managedSandboxOnly: experimental.enableManagedSandboxOnly },
        { driver: "local", provider: null },
      )).toMatchObject({ allowed: false, deniedDriver: "local" });
    }
  });

  it("lets staging override disabled defaults while keeping Cloud-enabled features managed", async () => {
    const row = settingsRow({});
    const { db, persistedSets } = stubDb(row);
    const runtimeEnv = {
      ...managedEnv(JSON.stringify({
        v: 1, mode: "cloud", catalogVersion: "test",
        features: { enableStatusCards: true, enableChatConnectors: false, enableNativeRunner: true },
        plugins: { autoInstall: [] },
      })),
      PAPERCLIP_PRIMARY_HOST: "team.staging.paperclip.app",
    };
    const service = instanceSettingsService(db, { runtimeEnv });
    const managedKeys = {
      enableStatusCards: { managed: true, managedBy: "paperclip-cloud" },
      enableNativeRunner: { managed: true, managedBy: "paperclip-cloud" },
    };
    expect(await service.getExperimental()).toMatchObject({
      enableStatusCards: true, enableChatConnectors: false, enableNativeRunner: true, managedKeys,
    });
    expect(persistedSets).toHaveLength(0);

    for (const enabled of [true, false]) {
      const updated = await service.updateExperimental({ enableChatConnectors: enabled });
      Object.assign(row, persistedSets.at(-1));
      const expected = {
        enableStatusCards: true, enableChatConnectors: enabled, enableNativeRunner: true, managedKeys,
      };
      expect(updated.experimental).toMatchObject(expected);
      const restored = instanceSettingsService(db, { runtimeEnv });
      expect(await restored.getExperimental()).toMatchObject(expected);
      expect((await restored.get()).experimental).toMatchObject(expected);
      expect(row.experimental).not.toHaveProperty("managedKeys");
      expect(row.experimental).not.toHaveProperty("enableStatusCards");
    }
    expect((await service.updateExperimental({ enableNativeRunner: true })).experimental.enableNativeRunner).toBe(true);

    const changedDefaults = instanceSettingsService(db, { runtimeEnv: {
      ...runtimeEnv,
      PAPERCLIP_MANAGED_CONFIG: JSON.stringify({
        v: 1, mode: "cloud", catalogVersion: "test",
        features: { enableStatusCards: false, enableChatConnectors: true, enableNativeRunner: true },
        plugins: { autoInstall: [] },
      }),
    } });
    expect(await changedDefaults.getExperimental()).toMatchObject({
      enableStatusCards: false, enableChatConnectors: true, enableNativeRunner: true,
    });

    const production = instanceSettingsService(db, { runtimeEnv: { ...runtimeEnv, PAPERCLIP_PRIMARY_HOST: "team.paperclip.app" } });
    expect(await production.getExperimental()).toMatchObject({
      enableChatConnectors: false, enableNativeRunner: true,
      managedKeys: { enableChatConnectors: { managed: true }, enableNativeRunner: { managed: true } },
    });
  });

  it("preserves Cloud owner access policy on staging", async () => {
    const { db } = stubDb(settingsRow({ enableOwnerInstanceAdmin: false }));
    const service = instanceSettingsService(db, { runtimeEnv: {
      PAPERCLIP_PRIMARY_HOST: "team.staging.paperclip.app",
      ...managedEnv(JSON.stringify({
        v: 1, mode: "cloud", catalogVersion: "test",
        features: { enableOwnerInstanceAdmin: true }, plugins: { autoInstall: [] },
      })),
    } });
    expect(await service.getExperimental()).toMatchObject({
      enableOwnerInstanceAdmin: true,
      managedKeys: { enableOwnerInstanceAdmin: { managed: true, managedBy: "paperclip-cloud" } },
    });
    await expect(service.updateExperimental({ enableOwnerInstanceAdmin: false })).rejects.toMatchObject({ status: 403 });
  });

  it.each([{}, { enableMcpAggregators: false }])("keeps aggregators on with legacy stored and managed values: %j", async (stored) => {
    const { db } = stubDb(settingsRow({ ...stored, enableChatConnectors: true }));
    const service = instanceSettingsService(db, { runtimeEnv: managedEnv(JSON.stringify({
      v: 1, mode: "cloud", catalogVersion: "legacy", features: { enableMcpAggregators: false }, plugins: { autoInstall: [] },
    })) });
    expect(await service.getExperimental()).toMatchObject({ enableMcpAggregators: true, enableChatConnectors: true, managedKeys: {} });
    expect(await service.updateExperimental({ enableMcpAggregators: false })).toMatchObject({ experimental: { enableMcpAggregators: true, enableChatConnectors: true } });
  });

  it("persists chat connector opt-in and reads it back after service reconstruction", async () => {
    const row = settingsRow({});
    const { db, persistedSets } = stubDb(row);
    const service = instanceSettingsService(db, { runtimeEnv: {} });
    expect((await service.getExperimental()).enableChatConnectors).toBe(false);
    for (const enabled of [true, false]) {
      const updated = await service.updateExperimental({ enableChatConnectors: enabled });
      Object.assign(row, persistedSets.at(-1));
      expect(updated.experimental.enableChatConnectors).toBe(enabled);
      const restored = await instanceSettingsService(db, { runtimeEnv: {} }).getExperimental();
      expect(restored).toMatchObject({ enableApps: true, enableChatConnectors: enabled });
    }
  });

  it("overlays the managed chat connector gate without changing stored data", async () => {
    const { db, persistedSets } = stubDb(settingsRow({ enableChatConnectors: true }));
    const service = instanceSettingsService(db, { runtimeEnv: managedEnv(JSON.stringify({
      v: 1, mode: "cloud", catalogVersion: "test", features: { enableChatConnectors: false }, plugins: { autoInstall: [] },
    })) });
    expect(await service.getExperimental()).toMatchObject({
      enableChatConnectors: false,
      managedKeys: { enableChatConnectors: { managed: true, managedBy: "paperclip-cloud" } },
    });
    expect(persistedSets).toHaveLength(0);
  });
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
    expect(experimental.enableApps).toBe(true);
    expect(experimental.enableStatusCards).toBe(true);
    expect(experimental.managedKeys).toEqual({
      enableStatusCards: { managed: true, managedBy: "paperclip-cloud" },
    });
  });

  it("overlays managed values on get()", async () => {
    const { db } = stubDb(settingsRow({ enableApps: true }));
    const svc = instanceSettingsService(db, { runtimeEnv: managedEnv() });

    const settings = await svc.get();
    expect(settings.experimental.enableApps).toBe(true);
    expect(settings.experimental.managedKeys?.enableApps).toBeUndefined();
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
    // The retired compatibility key normalizes on, independent of the
    // managed document's historical value.
    expect(persisted.enableApps).toBe(true);
    // The overlay-added value is not written.
    expect(persisted.enableStatusCards).toBe(false);
    expect(persisted.enableCases).toBe(true);
    expect(persisted).not.toHaveProperty("managedKeys");

    // The response still reflects the overlay.
    expect(updated.experimental.enableApps).toBe(true);
    expect(updated.experimental.enableStatusCards).toBe(true);
    expect(updated.experimental.managedKeys?.enableApps).toBeUndefined();
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
