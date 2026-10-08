import { describe, expect, it } from "vitest";
import { INSTANCE_FEATURE_CATALOG } from "@paperclipai/shared";
import {
  applyCloudCatalogDefaults,
  applyExperimentalSettingsPatch,
  applyManagedExperimentalOverlay,
  normalizeExperimentalSettings,
  stripCloudCatalogDefaultEchoes,
} from "../services/instance-settings.js";
import type { ManagedInstanceConfig } from "../services/managed-config.js";

function managedConfig(features: ManagedInstanceConfig["features"] = {}): ManagedInstanceConfig {
  return {
    v: 1,
    mode: "cloud",
    catalogVersion: "test",
    features,
    plugins: { autoInstall: [] },
    environments: [],
  };
}

describe("applyCloudCatalogDefaults", () => {
  it("excludes the graduated runner from Cloud opt-in flags", () => {
    // Runner execution is available on self-hosted and Cloud instances.
    const guarded = Object.entries(INSTANCE_FEATURE_CATALOG)
      .filter(([, entry]) => entry.selfHostedDefault === true && entry.cloudDefault === false)
      .map(([key]) => key);
    expect(guarded).not.toContain("enableNativeRunner");
  });

  it("leaves self-hosted instances on the schema default", () => {
    const experimental = applyCloudCatalogDefaults(normalizeExperimentalSettings({}), {}, null);
    expect(experimental.enableNativeRunner).toBe(true);
  });

  it("keeps the graduated runner enabled when Cloud omits the flag", () => {
    const experimental = applyCloudCatalogDefaults(
      normalizeExperimentalSettings({}),
      {},
      managedConfig(),
    );
    expect(experimental.enableNativeRunner).toBe(true);
    // Flags with matching defaults are untouched.
    expect(experimental.enableStreamlinedUi).toBe(true);
  });

  it("keeps an explicit tenant value", () => {
    const raw = { enableNativeRunner: true };
    const experimental = applyCloudCatalogDefaults(
      normalizeExperimentalSettings(raw),
      raw,
      managedConfig(),
    );
    expect(experimental.enableNativeRunner).toBe(true);
  });

  it("ignores the retired managed runner opt-out", () => {
    const config = managedConfig({ enableNativeRunner: false });
    const { experimental } = applyManagedExperimentalOverlay(
      applyCloudCatalogDefaults(normalizeExperimentalSettings({}), {}, config),
      config,
    );
    expect(experimental.enableNativeRunner).toBe(true);
  });

  it("does not touch flags whose Cloud default is the enabled one", () => {
    // enableOwnerInstanceAdmin defaults off for self-hosted and on for Cloud.
    // That direction is resolved elsewhere; this helper must not flip it.
    const experimental = applyCloudCatalogDefaults(
      normalizeExperimentalSettings({}),
      {},
      managedConfig(),
    );
    expect(experimental.enableOwnerInstanceAdmin).toBe(false);
  });
});

describe("stripCloudCatalogDefaultEchoes", () => {
  /** What `updateExperimental` would persist for a given row and patch. */
  function persisted(rawStored: unknown, patch: Record<string, unknown>, config: ManagedInstanceConfig | null) {
    return stripCloudCatalogDefaultEchoes(
      rawStored,
      patch,
      applyExperimentalSettingsPatch(rawStored, patch),
      config,
    ) as Record<string, unknown>;
  }

  /** What a later read of that persisted row shows. */
  function readBack(stored: Record<string, unknown>, config: ManagedInstanceConfig | null) {
    return applyManagedExperimentalOverlay(
      applyCloudCatalogDefaults(normalizeExperimentalSettings(stored), stored, config),
      config,
    ).experimental;
  }

  it("preserves the graduated default on Cloud during an unrelated write", () => {
    const config = managedConfig();
    const stored = persisted({}, { enablePipelines: true }, config);
    expect(stored.enablePipelines).toBe(true);
    expect(stored.enableNativeRunner).toBe(true);
    // Deprecated writes cannot disable execution.
    expect(readBack(stored, config).enableNativeRunner).toBe(true);
  });

  it("ignores a retired opt-out in a full settings write", () => {
    const config = managedConfig();
    const stored = persisted({}, { enableNativeRunner: false, enablePipelines: true }, config);
    expect(stored.enableNativeRunner).toBe(true);
    expect(readBack(stored, config).enableNativeRunner).toBe(true);
  });

  it("persists an explicit Cloud opt-in", () => {
    const config = managedConfig();
    const stored = persisted({}, { enableNativeRunner: true }, config);
    expect(stored.enableNativeRunner).toBe(true);
    expect(readBack(stored, config).enableNativeRunner).toBe(true);
  });

  it("keeps a stored tenant value across unrelated writes", () => {
    const config = managedConfig();
    const stored = persisted({ enableNativeRunner: true }, { enablePipelines: true }, config);
    expect(stored.enableNativeRunner).toBe(true);
    expect(readBack(stored, config).enableNativeRunner).toBe(true);
  });

  it("leaves the whole normalized object in place for self-hosted rows", () => {
    const stored = persisted({}, { enablePipelines: true }, null);
    expect(stored.enableNativeRunner).toBe(true);
    expect(stored).toEqual(applyExperimentalSettingsPatch({}, { enablePipelines: true }));
  });
});
