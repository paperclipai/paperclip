import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MANAGED_CONFIG_CAPABILITIES,
  MANAGED_CONFIG_CAPABILITIES_SCHEMA_VERSION,
} from "./managed-config.js";

// The control plane fetches this file at a release commit to learn which
// managed-config sections the release accepts. It must match the parser's
// own list exactly.
const capabilitiesFile = new URL("./managed-config-capabilities.json", import.meta.url);

describe("managed-config-capabilities.json", () => {
  it("matches the capabilities the parser supports", () => {
    expect(JSON.parse(readFileSync(capabilitiesFile, "utf8"))).toEqual({
      schemaVersion: MANAGED_CONFIG_CAPABILITIES_SCHEMA_VERSION,
      capabilities: [...MANAGED_CONFIG_CAPABILITIES],
    });
  });

  it("keeps the published contract", () => {
    expect(JSON.parse(readFileSync(capabilitiesFile, "utf8"))).toEqual({
      schemaVersion: 1,
      capabilities: ["pluginEnvironments", "pluginEnvironmentRunnerLifecycleMode"],
    });
  });
});
