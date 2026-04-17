import { describe, it, expect } from "vitest";
import { PLUGIN_API_VERSION } from "@paperclipai/shared";
import { pluginManifestValidator } from "./plugin-manifest-validator.js";

// ---------------------------------------------------------------------------
// Minimal valid manifest fixture
// ---------------------------------------------------------------------------

function makeMinimalManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "my-plugin",
    apiVersion: PLUGIN_API_VERSION,
    version: "1.0.0",
    displayName: "My Plugin",
    description: "A minimal test plugin for unit tests",
    author: "Test Author",
    categories: ["connector"],
    capabilities: ["issues.read"],
    entrypoints: { worker: "dist/worker.js" },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// pluginManifestValidator
// ---------------------------------------------------------------------------

describe("pluginManifestValidator", () => {
  it("getSupportedVersions returns an array containing PLUGIN_API_VERSION", () => {
    const validator = pluginManifestValidator();
    const versions = validator.getSupportedVersions();
    expect(Array.isArray(versions)).toBe(true);
    expect(versions).toContain(PLUGIN_API_VERSION);
  });

  it("parse returns success:true for a minimal valid manifest", () => {
    const validator = pluginManifestValidator();
    const result = validator.parse(makeMinimalManifest());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.manifest.id).toBe("my-plugin");
    }
  });

  it("parse returns success:false for null input", () => {
    const validator = pluginManifestValidator();
    const result = validator.parse(null);
    expect(result.success).toBe(false);
  });

  it("parse returns success:false for an empty object", () => {
    const validator = pluginManifestValidator();
    const result = validator.parse({});
    expect(result.success).toBe(false);
  });

  it("parse returns success:false when apiVersion is wrong", () => {
    const validator = pluginManifestValidator();
    const result = validator.parse(makeMinimalManifest({ apiVersion: 99 }));
    expect(result.success).toBe(false);
  });

  it("parse returns success:false when id is empty", () => {
    const validator = pluginManifestValidator();
    const result = validator.parse(makeMinimalManifest({ id: "" }));
    expect(result.success).toBe(false);
  });

  it("parse returns success:false when id contains invalid characters", () => {
    const validator = pluginManifestValidator();
    const result = validator.parse(makeMinimalManifest({ id: "INVALID_CAPS" }));
    expect(result.success).toBe(false);
  });

  it("parse returns success:false when categories is empty", () => {
    const validator = pluginManifestValidator();
    const result = validator.parse(makeMinimalManifest({ categories: [] }));
    expect(result.success).toBe(false);
  });

  it("parse returns success:false when capabilities is empty", () => {
    const validator = pluginManifestValidator();
    const result = validator.parse(makeMinimalManifest({ capabilities: [] }));
    expect(result.success).toBe(false);
  });

  it("parse returns success:false when version is not semver", () => {
    const validator = pluginManifestValidator();
    const result = validator.parse(makeMinimalManifest({ version: "not-semver" }));
    expect(result.success).toBe(false);
  });

  it("parse populates errors string on failure", () => {
    const validator = pluginManifestValidator();
    const result = validator.parse(makeMinimalManifest({ id: "" }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(typeof result.errors).toBe("string");
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });

  it("parse populates details array on failure", () => {
    const validator = pluginManifestValidator();
    const result = validator.parse(makeMinimalManifest({ id: "" }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(Array.isArray(result.details)).toBe(true);
      expect(result.details.length).toBeGreaterThan(0);
      expect(typeof result.details[0].message).toBe("string");
    }
  });

  it("parse accepts an optional ui entrypoint when no ui slots are declared", () => {
    const validator = pluginManifestValidator();
    const result = validator.parse(
      makeMinimalManifest({ entrypoints: { worker: "dist/worker.js", ui: "dist/ui.js" } }),
    );
    expect(result.success).toBe(true);
  });

  it("parse fails when ui slots are declared but entrypoints.ui is missing", () => {
    const validator = pluginManifestValidator();
    const result = validator.parse(
      makeMinimalManifest({
        capabilities: ["issues.read", "ui.slots"],
        ui: { slots: [{ id: "slot-a", label: "Slot A", placement: "issue.sidebar" }] },
        entrypoints: { worker: "dist/worker.js" }, // no ui entrypoint
      }),
    );
    expect(result.success).toBe(false);
  });

  it("parse succeeds with a pre-release semver version", () => {
    const validator = pluginManifestValidator();
    const result = validator.parse(makeMinimalManifest({ version: "1.0.0-beta.1" }));
    expect(result.success).toBe(true);
  });

  it("parse succeeds when tools are declared with the agent.tools.register capability", () => {
    const validator = pluginManifestValidator();
    const result = validator.parse(
      makeMinimalManifest({
        capabilities: ["issues.read", "agent.tools.register"],
        tools: [
          {
            name: "my_tool",
            displayName: "My Tool",
            description: "Does something useful",
            parametersSchema: { type: "object", properties: {} },
          },
        ],
      }),
    );
    expect(result.success).toBe(true);
  });

  it("parse fails when tools are declared without the agent.tools.register capability", () => {
    const validator = pluginManifestValidator();
    const result = validator.parse(
      makeMinimalManifest({
        capabilities: ["issues.read"],
        tools: [
          {
            name: "my_tool",
            displayName: "My Tool",
            description: "Does something useful",
            parametersSchema: { type: "object", properties: {} },
          },
        ],
      }),
    );
    expect(result.success).toBe(false);
  });

  it("parseOrThrow returns the manifest for a valid input", () => {
    const validator = pluginManifestValidator();
    const manifest = validator.parseOrThrow(makeMinimalManifest());
    expect(manifest.id).toBe("my-plugin");
  });

  it("parseOrThrow throws for an invalid input", () => {
    const validator = pluginManifestValidator();
    expect(() => validator.parseOrThrow({})).toThrow();
  });

  it("parseOrThrow throws an error whose message mentions 'Invalid plugin manifest'", () => {
    const validator = pluginManifestValidator();
    expect(() => validator.parseOrThrow({ id: "" })).toThrow(/Invalid plugin manifest/);
  });
});
