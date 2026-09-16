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
  it("pins the catalog so this rule has something to guard", () => {
    // The rule exists for flags that default on for self-hosted and off for
    // Cloud. If that set ever empties, the helper is dead code and should go.
    const guarded = Object.entries(INSTANCE_FEATURE_CATALOG)
      .filter(([, entry]) => entry.selfHostedDefault === true && entry.cloudDefault === false)
      .map(([key]) => key);
    expect(guarded).toContain("enableNativeRunner");
  });

  it("leaves self-hosted instances on the schema default", () => {
    const experimental = applyCloudCatalogDefaults(normalizeExperimentalSettings({}), {}, null);
    expect(experimental.enableNativeRunner).toBe(true);
  });

  it("re-asserts the Cloud default when the tenant row and the overlay omit the flag", () => {
    const experimental = applyCloudCatalogDefaults(
      normalizeExperimentalSettings({}),
      {},
      managedConfig(),
    );
    expect(experimental.enableNativeRunner).toBe(false);
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

  it("lets a managed feature value win through the overlay", () => {
    const config = managedConfig({ enableNativeRunner: true });
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

  it("does not persist the self-hosted default on Cloud during an unrelated write", () => {
    const config = managedConfig();
    const stored = persisted({}, { enablePipelines: true }, config);
    expect(stored.enablePipelines).toBe(true);
    expect("enableNativeRunner" in stored).toBe(false);
    // The Cloud default still applies on the next read.
    expect(readBack(stored, config).enableNativeRunner).toBe(false);
  });

  it("treats a full-GET echo of the Cloud default as no choice", () => {
    const config = managedConfig();
    const stored = persisted({}, { enableNativeRunner: false, enablePipelines: true }, config);
    expect("enableNativeRunner" in stored).toBe(false);
    expect(readBack(stored, config).enableNativeRunner).toBe(false);
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
