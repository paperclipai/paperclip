import { describe, expect, it } from "vitest";
import { INSTANCE_FEATURE_CATALOG } from "@paperclipai/shared";
import {
  applyCloudCatalogDefaults,
  applyManagedExperimentalOverlay,
  normalizeExperimentalSettings,
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
