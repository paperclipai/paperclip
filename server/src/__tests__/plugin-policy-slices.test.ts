import { describe, expect, it, vi } from "vitest";
import type {
  PaperclipPluginManifestV1,
  PluginCompanySettingsJson,
} from "@paperclipai/shared";
import { pluginStateStore } from "../services/plugin-state-store.js";
import { buildHostServices } from "../services/plugin-host-services.js";
import {
  pluginCapabilityValidator,
  resolveEffectiveCapabilities,
} from "../services/plugin-capability-validator.js";
import { buildPluginHostHandlers } from "../app.js";
import { forbidden } from "../errors.js";

const baseManifest: PaperclipPluginManifestV1 = {
  id: "acme.plugin",
  apiVersion: 1,
  version: "1.0.0",
  displayName: "Acme Plugin",
  description: "Test plugin",
  author: "Acme",
  categories: ["automation"],
  capabilities: ["plugin.state.read", "plugin.state.write", "issues.read", "issues.update"],
  entrypoints: { worker: "worker.js" },
};

describe("plugin memory policy enforcement", () => {
  it("allows normal company scope writes with no restrictive policy", async () => {
    const insertValues: unknown[] = [];
    const store = pluginStateStore(
      {
        select: () => ({
          from: (table: unknown) => ({
            where: async () => table === "plugins-sentinel" ? [] : [{ id: "plugin-1" }],
          }),
        }),
        insert: () => ({
          values: (value: unknown) => {
            insertValues.push(value);
            return {
              onConflictDoUpdate: async () => undefined,
            };
          },
        }),
      } as any,
      {
        resolveCompanySettings: async () => undefined,
      },
    );

    await expect(store.set("plugin-1", {
      scopeKind: "company",
      scopeId: "company-1",
      stateKey: "summary",
      value: { ok: true },
    })).resolves.toBeUndefined();

    expect(insertValues).toHaveLength(1);
  });

  it("rejects denied scope writes", async () => {
    const store = pluginStateStore(
      {
        select: () => ({
          from: (_table: unknown) => ({
            where: async () => [{ id: "plugin-1" }],
          }),
        }),
        insert: () => ({
          values: () => ({
            onConflictDoUpdate: async () => undefined,
          }),
        }),
      } as any,
      {
        resolveCompanySettings: async () => ({
          memoryPolicy: {
            denyScopes: ["agent"],
          },
        }),
      },
    );

    await expect(store.set("plugin-1", {
      companyId: "company-1",
      scopeKind: "agent",
      scopeId: "agent-1",
      stateKey: "secret",
      value: "x",
    } as any)).rejects.toThrow(/agent/);
  });

  it("rejects get when policy forbids that scope", async () => {
    const store = pluginStateStore(
      {
        select: () => ({
          from: (_table: unknown) => ({
            where: async () => [],
          }),
        }),
      } as any,
      {
        resolveCompanySettings: async () => ({
          memoryPolicy: {
            denyScopes: ["agent"],
          },
        }),
      },
    );

    await expect(store.get("plugin-1", "agent", "secret", {
      companyId: "company-1",
      scopeId: "agent-1",
    })).rejects.toThrow(/agent/);
  });

  it("rejects delete when policy forbids that scope", async () => {
    const store = pluginStateStore(
      {
        delete: () => ({
          where: async () => undefined,
        }),
      } as any,
      {
        resolveCompanySettings: async () => ({
          memoryPolicy: {
            denyScopes: ["agent"],
          },
        }),
      },
    );

    await expect(store.delete("plugin-1", "agent", "secret", {
      companyId: "company-1",
      scopeId: "agent-1",
    })).rejects.toThrow(/agent/);
  });

  it("rejects broad list operations when policy forbids that scope", async () => {
    const store = pluginStateStore(
      {
        select: () => ({
          from: (_table: unknown) => ({
            where: async () => [],
          }),
        }),
      } as any,
      {
        resolveCompanySettings: async () => ({
          memoryPolicy: {
            denyScopes: ["agent"],
          },
        }),
      },
    );

    await expect(store.list("plugin-1", {
      companyId: "company-1",
      scopeKind: "agent",
    } as any)).rejects.toThrow(/agent/);
  });

  it("uses company settings policy when host services bridge state calls at runtime", async () => {
    const db = {
      query: {
        pluginCompanySettings: {
          findFirst: vi.fn(async () => ({
            settingsJson: {
              memoryPolicy: {
                denyScopes: ["agent"],
              },
            },
          })),
        },
      },
      select: () => ({
        from: (_table: unknown) => ({
          where: async () => [{ id: "plugin-1" }],
        }),
      }),
      insert: () => ({
        values: () => ({ onConflictDoUpdate: async () => undefined }),
      }),
      delete: () => ({
        where: async () => undefined,
      }),
    } as any;

    const services = buildHostServices(db, "plugin-1", "acme.plugin", {
      forPlugin: () => ({ emit: vi.fn(), subscribe: vi.fn(), clear: vi.fn() }),
    } as any);

    await expect(services.state.set({
      companyId: "company-1",
      scopeKind: "agent",
      scopeId: "agent-1",
      stateKey: "secret",
      value: "x",
    } as any)).rejects.toThrow(/agent/);

    expect(db.query.pluginCompanySettings.findFirst).toHaveBeenCalled();
    services.dispose();
  });
});

describe("plugin capability inheritance", () => {
  it("returns raw manifest capabilities when no policy exists", () => {
    expect(resolveEffectiveCapabilities(baseManifest)).toEqual(baseManifest.capabilities);
  });

  it("inherit mode only strips explicit false grants", () => {
    expect(resolveEffectiveCapabilities(baseManifest, {
      mode: "inherit",
      grants: {
        "issues.update": false,
      },
    })).toEqual(["plugin.state.read", "plugin.state.write", "issues.read"]);
  });

  it("override mode returns only explicit true grants", () => {
    expect(resolveEffectiveCapabilities(baseManifest, {
      mode: "override",
      grants: {
        "issues.read": true,
        "issues.update": false,
        "plugin.state.read": true,
      },
    })).toEqual(["plugin.state.read", "issues.read"]);
  });

  it("override mode with no grants returns empty capabilities", () => {
    expect(resolveEffectiveCapabilities(baseManifest, {
      mode: "override",
    })).toEqual([]);
  });

  it("validator checks operations against effective capabilities", () => {
    const validator = pluginCapabilityValidator();
    const effectiveManifest = {
      ...baseManifest,
      capabilities: resolveEffectiveCapabilities(baseManifest, {
        mode: "override",
        grants: { "issues.read": true },
      }),
    };

    expect(validator.checkOperation(effectiveManifest, "issues.get")).toMatchObject({ allowed: true });
    expect(validator.checkOperation(effectiveManifest, "issues.update")).toMatchObject({ allowed: false });
  });

  it("tests real app host-handler wiring via buildPluginHostHandlers", async () => {
    const createHostClientHandlers = vi.spyOn(await import("@paperclipai/plugin-sdk"), "createHostClientHandlers").mockImplementation(vi.fn(() => ({}) as any));
    const buildHostServicesSpy = vi.spyOn(await import("../services/plugin-host-services.js"), "buildHostServices").mockReturnValue({
      dispose: vi.fn(),
    } as any);
    const workerManager = { getWorker: vi.fn(() => null) };
    const hostServicesDisposers = new Map<string, () => void>();

    await buildPluginHostHandlers({
      db: {} as any,
      pluginId: "plugin-1",
      manifest: baseManifest,
      eventBus: {} as any,
      workerManager: workerManager as any,
      hostServicesDisposers,
    });

    expect(buildHostServicesSpy).toHaveBeenCalledWith(
      {} as any,
      "plugin-1",
      baseManifest.id,
      {} as any,
      expect.any(Function),
    );
    expect(createHostClientHandlers).toHaveBeenCalledWith(expect.objectContaining({
      capabilities: baseManifest.capabilities,
    }));

    createHostClientHandlers.mockRestore();
    buildHostServicesSpy.mockRestore();
  });
});
