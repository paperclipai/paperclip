import { describe, expect, it, vi } from "vitest";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import {
  assertCompanyEnablement,
  createPluginEventDeliverabilityChecker,
  evaluateCompanyEnablement,
  pluginCompanyEnablementService,
  type PluginEnablementRegistry,
} from "./plugin-company-enablement.js";

const pluginUuid = "11111111-1111-4111-8111-111111111111";
const companyId = "22222222-2222-4222-8222-222222222222";

function manifestWith(
  companyEnablement?: { default: "on" | "off"; locked?: boolean },
): Pick<PaperclipPluginManifestV1, "companyEnablement"> {
  return companyEnablement ? { companyEnablement } : {};
}

describe("evaluateCompanyEnablement", () => {
  it("defaults to enabled when the manifest has no companyEnablement and no row exists", () => {
    expect(evaluateCompanyEnablement(undefined, null)).toBe(true);
    expect(evaluateCompanyEnablement(null, undefined)).toBe(true);
    expect(evaluateCompanyEnablement(manifestWith(), null)).toBe(true);
  });

  it("honors an explicit row over any manifest default", () => {
    expect(evaluateCompanyEnablement(manifestWith(), { enabled: false })).toBe(false);
    expect(evaluateCompanyEnablement(manifestWith(), { enabled: true })).toBe(true);
    expect(
      evaluateCompanyEnablement(manifestWith({ default: "off" }), { enabled: true }),
    ).toBe(true);
    expect(
      evaluateCompanyEnablement(manifestWith({ default: "on" }), { enabled: false }),
    ).toBe(false);
  });

  it("uses the manifest default when no row exists", () => {
    expect(evaluateCompanyEnablement(manifestWith({ default: "on" }), null)).toBe(true);
    expect(evaluateCompanyEnablement(manifestWith({ default: "off" }), null)).toBe(false);
  });

  it("treats locked as read-transparent: manifest default unless a row overrides", () => {
    // Lock enforcement is write-time (the toggle route 409s non-admins);
    // an existing row on a locked plugin is instance-admin-written by
    // construction, so the read path honors it.
    expect(
      evaluateCompanyEnablement(manifestWith({ default: "off", locked: true }), null),
    ).toBe(false);
    expect(
      evaluateCompanyEnablement(manifestWith({ default: "off", locked: true }), { enabled: true }),
    ).toBe(true);
    expect(
      evaluateCompanyEnablement(manifestWith({ default: "on", locked: true }), null),
    ).toBe(true);
  });
});

describe("assertCompanyEnablement", () => {
  it("throws the typed 403 when the effective state is disabled", () => {
    let caught: unknown;
    try {
      assertCompanyEnablement(manifestWith({ default: "off" }), null);
    } catch (err) {
      caught = err;
    }
    expect(caught).toMatchObject({
      status: 403,
      details: { code: "plugin_not_enabled_for_company" },
    });
  });

  it("does not throw when the effective state is enabled", () => {
    expect(() => assertCompanyEnablement(undefined, null)).not.toThrow();
  });
});

function fakeRegistry(overrides: Partial<PluginEnablementRegistry> = {}): PluginEnablementRegistry {
  return {
    getById: vi.fn(async () => ({ manifestJson: {} as PaperclipPluginManifestV1 })),
    getByKey: vi.fn(async () => null),
    getCompanySettings: vi.fn(async () => null),
    ...overrides,
  };
}

describe("pluginCompanyEnablementService", () => {
  it("resolves the manifest via getById and combines it with the settings row", async () => {
    const registry = fakeRegistry({
      getById: vi.fn(async () => ({
        manifestJson: { companyEnablement: { default: "off" } } as PaperclipPluginManifestV1,
      })),
      getCompanySettings: vi.fn(async () => null),
    });
    const service = pluginCompanyEnablementService(registry);

    await expect(service.isPluginEnabledForCompany(pluginUuid, companyId)).resolves.toBe(false);
    expect(registry.getById).toHaveBeenCalledWith(pluginUuid);
    expect(registry.getCompanySettings).toHaveBeenCalledWith(pluginUuid, companyId);
  });

  it("returns true for a default-on plugin without a row and false with a disabled row", async () => {
    const service = pluginCompanyEnablementService(fakeRegistry());
    await expect(service.isPluginEnabledForCompany(pluginUuid, companyId)).resolves.toBe(true);

    const disabled = pluginCompanyEnablementService(fakeRegistry({
      getCompanySettings: vi.fn(async () => ({ enabled: false }) as never),
    }));
    await expect(disabled.isPluginEnabledForCompany(pluginUuid, companyId)).resolves.toBe(false);
  });

  it("treats an unknown pluginId as disabled (fail closed)", async () => {
    const service = pluginCompanyEnablementService(fakeRegistry({
      getById: vi.fn(async () => null),
    }));
    await expect(service.isPluginEnabledForCompany(pluginUuid, companyId)).resolves.toBe(false);
  });

  it("ensurePluginEnabledForCompany throws the typed 403 when disabled", async () => {
    const service = pluginCompanyEnablementService(fakeRegistry({
      getCompanySettings: vi.fn(async () => ({ enabled: false }) as never),
    }));
    await expect(
      service.ensurePluginEnabledForCompany(pluginUuid, companyId),
    ).rejects.toMatchObject({
      status: 403,
      details: { code: "plugin_not_enabled_for_company" },
    });
  });

  it("ensurePluginEnabledForCompany resolves when enabled", async () => {
    const service = pluginCompanyEnablementService(fakeRegistry());
    await expect(
      service.ensurePluginEnabledForCompany(pluginUuid, companyId),
    ).resolves.toBeUndefined();
  });
});

describe("createPluginEventDeliverabilityChecker", () => {
  const pluginKey = "acme.linear";

  it("resolves the plugin key via getByKey and evaluates manifest + row", async () => {
    const getByKey = vi.fn(async () => ({
      id: pluginUuid,
      manifestJson: {} as PaperclipPluginManifestV1,
    }));
    const getCompanySettings = vi.fn(async () => ({ enabled: true }) as never);
    const log = vi.fn();
    const checker = createPluginEventDeliverabilityChecker(
      fakeRegistry({ getByKey, getCompanySettings }),
      log,
    );

    await expect(checker(pluginKey, companyId)).resolves.toBe(true);
    expect(getByKey).toHaveBeenCalledWith(pluginKey);
    expect(getCompanySettings).toHaveBeenCalledWith(pluginUuid, companyId);
    expect(log).not.toHaveBeenCalled();
  });

  it("returns false when the row disables the plugin", async () => {
    const checker = createPluginEventDeliverabilityChecker(
      fakeRegistry({
        getByKey: vi.fn(async () => ({ id: pluginUuid, manifestJson: {} as PaperclipPluginManifestV1 })),
        getCompanySettings: vi.fn(async () => ({ enabled: false }) as never),
      }),
      vi.fn(),
    );
    await expect(checker(pluginKey, companyId)).resolves.toBe(false);
  });

  it("returns false for a default-off plugin with no row (manifest-aware)", async () => {
    const checker = createPluginEventDeliverabilityChecker(
      fakeRegistry({
        getByKey: vi.fn(async () => ({
          id: pluginUuid,
          manifestJson: { companyEnablement: { default: "off" } } as PaperclipPluginManifestV1,
        })),
        getCompanySettings: vi.fn(async () => null),
      }),
      vi.fn(),
    );
    await expect(checker(pluginKey, companyId)).resolves.toBe(false);
  });

  it("fails open and skips the settings lookup when the plugin key is unknown", async () => {
    const getCompanySettings = vi.fn();
    const checker = createPluginEventDeliverabilityChecker(
      fakeRegistry({ getByKey: vi.fn(async () => null), getCompanySettings }),
      vi.fn(),
    );
    await expect(checker(pluginKey, companyId)).resolves.toBe(true);
    expect(getCompanySettings).not.toHaveBeenCalled();
  });

  it("fails open and logs when the lookup throws", async () => {
    const err = new Error("db exploded");
    const log = vi.fn();
    const checker = createPluginEventDeliverabilityChecker(
      fakeRegistry({ getByKey: vi.fn(async () => { throw err; }) }),
      log,
    );
    await expect(checker(pluginKey, companyId)).resolves.toBe(true);
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ err, pluginKey, companyId }),
      expect.any(String),
    );
  });
});
