import { describe, expect, it } from "vitest";
import helloWorldManifest from "../../../packages/plugins/examples/plugin-hello-world-example/src/manifest.js";
import { pluginManifestValidator } from "../services/plugin-manifest-validator.js";
import { pluginCapabilityValidator } from "../services/plugin-capability-validator.js";

describe("first-party example plugin manifests", () => {
  const validator = pluginManifestValidator();
  const capabilityValidator = pluginCapabilityValidator();
  const manifests = [
    helloWorldManifest,
  ];

  function parseOrThrow(manifest: (typeof manifests)[number]) {
    const parsed = validator.parse(manifest);
    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      throw new Error(JSON.stringify(parsed.errors, null, 2));
    }
    return parsed.manifest;
  }

  it("parses and validates all example manifests", () => {
    for (const manifest of manifests) {
      const parsedManifest = parseOrThrow(manifest);

      const capabilities = capabilityValidator.validateManifestCapabilities(parsedManifest);
      expect(capabilities.allowed).toBe(true);
      expect(capabilities.missing).toEqual([]);
    }
  });

  it("includes the expected first-party example plugin ids", () => {
    const ids = manifests.map((manifest) => manifest.id);
    expect(ids).toEqual([
      "paperclip.hello-world-example",
    ]);
  });

  it("requests only required capabilities for each reference implementation", () => {
    expect(parseOrThrow(helloWorldManifest).capabilities).toEqual(["ui.dashboardWidget.register"]);
  });
});
