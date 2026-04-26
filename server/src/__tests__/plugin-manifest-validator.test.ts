import { describe, it, expect } from "vitest";
import { pluginManifestValidator } from "../services/plugin-manifest-validator.js";
import { PLUGIN_API_VERSION } from "@paperclipai/shared";

// A minimal valid manifest that passes all schema checks.
function validManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "my-plugin",
    apiVersion: PLUGIN_API_VERSION,
    version: "1.0.0",
    displayName: "My Plugin",
    description: "Does something useful",
    author: "Acme Corp",
    categories: ["connector"],
    capabilities: ["issues.read"],
    entrypoints: { worker: "dist/worker.js" },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// getSupportedVersions
// ---------------------------------------------------------------------------

describe("getSupportedVersions", () => {
  it("returns an array containing the current PLUGIN_API_VERSION", () => {
    const v = pluginManifestValidator().getSupportedVersions();
    expect(v).toContain(PLUGIN_API_VERSION);
  });

  it("returns a non-empty array", () => {
    expect(pluginManifestValidator().getSupportedVersions().length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// parse — success paths
// ---------------------------------------------------------------------------

describe("parse (success)", () => {
  it("returns success=true for a minimal valid manifest", () => {
    const result = pluginManifestValidator().parse(validManifest());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.manifest.id).toBe("my-plugin");
    }
  });

  it("accepts optional minimumHostVersion in semver format", () => {
    const result = pluginManifestValidator().parse(validManifest({ minimumHostVersion: "2.3.4" }));
    expect(result.success).toBe(true);
  });

  it("accepts multiple categories", () => {
    const result = pluginManifestValidator().parse(
      validManifest({ categories: ["connector", "workspace"] }),
    );
    expect(result.success).toBe(true);
  });

  it("accepts optional ui entrypoint alongside ui.slots", () => {
    const result = pluginManifestValidator().parse(
      validManifest({
        entrypoints: { worker: "dist/worker.js", ui: "dist/ui.js" },
        ui: {
          slots: [{ type: "page", id: "my-page", displayName: "My Page", exportName: "MyPage" }],
        },
      }),
    );
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parse — failure paths
// ---------------------------------------------------------------------------

describe("parse (failure)", () => {
  it("returns success=false for null input", () => {
    const result = pluginManifestValidator().parse(null);
    expect(result.success).toBe(false);
  });

  it("returns success=false for a plain string", () => {
    const result = pluginManifestValidator().parse("not a manifest");
    expect(result.success).toBe(false);
  });

  it("returns success=false when apiVersion is wrong", () => {
    const result = pluginManifestValidator().parse(validManifest({ apiVersion: 99 }));
    expect(result.success).toBe(false);
  });

  it("returns success=false when id is empty", () => {
    const result = pluginManifestValidator().parse(validManifest({ id: "" }));
    expect(result.success).toBe(false);
  });

  it("returns success=false when id has uppercase letters", () => {
    const result = pluginManifestValidator().parse(validManifest({ id: "MyPlugin" }));
    expect(result.success).toBe(false);
  });

  it("returns success=false when version is not semver", () => {
    const result = pluginManifestValidator().parse(validManifest({ version: "not-semver" }));
    expect(result.success).toBe(false);
  });

  it("returns success=false when categories is empty", () => {
    const result = pluginManifestValidator().parse(validManifest({ categories: [] }));
    expect(result.success).toBe(false);
  });

  it("returns success=false when categories contains an unknown value", () => {
    const result = pluginManifestValidator().parse(
      validManifest({ categories: ["unknown-category"] }),
    );
    expect(result.success).toBe(false);
  });

  it("returns success=false when capabilities is empty", () => {
    const result = pluginManifestValidator().parse(validManifest({ capabilities: [] }));
    expect(result.success).toBe(false);
  });

  it("returns success=false when entrypoints.worker is missing", () => {
    const result = pluginManifestValidator().parse(
      validManifest({ entrypoints: { ui: "dist/ui.js" } }),
    );
    expect(result.success).toBe(false);
  });

  it("returns errors string describing each issue", () => {
    const result = pluginManifestValidator().parse({ apiVersion: PLUGIN_API_VERSION });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(typeof result.errors).toBe("string");
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });

  it("includes path and message in details array", () => {
    const result = pluginManifestValidator().parse(validManifest({ id: "" }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(Array.isArray(result.details)).toBe(true);
      expect(result.details.length).toBeGreaterThan(0);
      const detail = result.details[0];
      expect(detail).toHaveProperty("path");
      expect(detail).toHaveProperty("message");
    }
  });

  it("superRefine: rejects ui.slots without entrypoints.ui", () => {
    const result = pluginManifestValidator().parse(
      validManifest({
        // no entrypoints.ui — only worker entrypoint
        ui: {
          slots: [{ type: "page", id: "my-page", displayName: "My Page", exportName: "MyPage" }],
        },
      }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors).toContain("entrypoints.ui");
    }
  });
});

// ---------------------------------------------------------------------------
// parseOrThrow
// ---------------------------------------------------------------------------

describe("parseOrThrow", () => {
  it("returns the manifest on success", () => {
    const manifest = pluginManifestValidator().parseOrThrow(validManifest());
    expect(manifest.id).toBe("my-plugin");
  });

  it("throws an error on invalid input", () => {
    expect(() => pluginManifestValidator().parseOrThrow(null)).toThrow();
  });

  it("thrown error message contains 'Invalid plugin manifest'", () => {
    expect(() => pluginManifestValidator().parseOrThrow({ apiVersion: 99 })).toThrow(
      /Invalid plugin manifest/,
    );
  });
});
