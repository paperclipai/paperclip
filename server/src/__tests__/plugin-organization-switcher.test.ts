import { describe, expect, it } from "vitest";
import { pluginManifestV1Schema } from "@paperclipai/shared";
import { pluginCapabilityValidator } from "../services/plugin-capability-validator.js";

describe("organization switcher installation", () => {
  it("accepts the slot and requires the sidebar capability", () => {
    const manifest = pluginManifestV1Schema.parse({
      id: "example.account", apiVersion: 1, version: "1.0.0", displayName: "Account", categories: ["ui"],
      description: "Organization navigation", author: "Example",
      capabilities: ["ui.sidebar.register"], entrypoints: { worker: "./dist/worker.js", ui: "./dist/ui" },
      ui: { slots: [{ type: "organizationSwitcher", id: "organizations", displayName: "Organizations", exportName: "Organizations" }] },
    });
    const validator = pluginCapabilityValidator();
    expect(validator.validateManifestCapabilities(manifest).allowed).toBe(true);
    expect(validator.validateManifestCapabilities({ ...manifest, capabilities: [] })).toMatchObject({ allowed: false, missing: ["ui.sidebar.register"] });
  });
});
