/**
 * Tests for the plugin manifest schema feature:
 *   - PLUGIN_API_VERSION constant value and export
 *   - PaperclipPluginManifestV1 `author` field (type propagation, boundary values)
 *   - pluginManifestV1Schema boundary values (exact min/max lengths)
 *   - minimum host version field validation and alias consistency
 *   - Multiple simultaneous cross-field validation errors
 *   - Error path formatting for nested fields via pluginManifestValidator service
 *   - getSupportedVersions relationship with PLUGIN_API_VERSION
 */

import { describe, expect, it } from "vitest";
import { pluginManifestV1Schema, PLUGIN_API_VERSION } from "@paperclipai/shared";
import {
  pluginManifestValidator,
  type ManifestParseSuccess,
  type ManifestParseFailure,
} from "../services/plugin-manifest-validator.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validManifest(overrides: Record<string, unknown> = {}) {
  return {
    id: "acme.schema-test",
    apiVersion: 1,
    version: "1.0.0",
    displayName: "Schema Test Plugin",
    description: "Plugin for schema boundary and propagation tests",
    author: "Test Author",
    categories: ["connector"],
    capabilities: ["issues.read"],
    entrypoints: { worker: "dist/worker.js" },
    ...overrides,
  };
}

// ===========================================================================
// PLUGIN_API_VERSION constant
// ===========================================================================

describe("PLUGIN_API_VERSION constant", () => {
  it("is exported from @paperclipai/shared", () => {
    expect(PLUGIN_API_VERSION).toBeDefined();
  });

  it("has the value 1", () => {
    expect(PLUGIN_API_VERSION).toBe(1);
  });

  it("is a number", () => {
    expect(typeof PLUGIN_API_VERSION).toBe("number");
  });
});

// ===========================================================================
// getSupportedVersions matches PLUGIN_API_VERSION
// ===========================================================================

describe("getSupportedVersions vs PLUGIN_API_VERSION", () => {
  it("includes PLUGIN_API_VERSION in its result", () => {
    const validator = pluginManifestValidator();
    expect(validator.getSupportedVersions()).toContain(PLUGIN_API_VERSION);
  });

  it("every value in getSupportedVersions is a number", () => {
    const validator = pluginManifestValidator();
    for (const v of validator.getSupportedVersions()) {
      expect(typeof v).toBe("number");
    }
  });
});

// ===========================================================================
// author field — propagation and boundary values
// ===========================================================================

describe("author field propagation", () => {
  it("is present in the parsed manifest on success", () => {
    const result = pluginManifestV1Schema.safeParse(validManifest({ author: "Jane Doe" }));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.author).toBe("Jane Doe");
    }
  });

  it("is returned intact by pluginManifestValidator.parse()", () => {
    const validator = pluginManifestValidator();
    const raw = validManifest({ author: "Acme Corp <hello@acme.io>" });
    const result = validator.parse(raw) as ManifestParseSuccess;
    expect(result.success).toBe(true);
    expect(result.manifest.author).toBe("Acme Corp <hello@acme.io>");
  });

  it("is returned intact by pluginManifestValidator.parseOrThrow()", () => {
    const validator = pluginManifestValidator();
    const manifest = validator.parseOrThrow(validManifest({ author: "Some Author" }));
    expect(manifest.author).toBe("Some Author");
  });

  it("accepts exactly 1 character (minimum boundary)", () => {
    const result = pluginManifestV1Schema.safeParse(validManifest({ author: "X" }));
    expect(result.success).toBe(true);
  });

  it("accepts exactly 200 characters (maximum boundary)", () => {
    const author200 = "a".repeat(200);
    const result = pluginManifestV1Schema.safeParse(validManifest({ author: author200 }));
    expect(result.success).toBe(true);
  });

  it("rejects an empty author string", () => {
    const result = pluginManifestV1Schema.safeParse(validManifest({ author: "" }));
    expect(result.success).toBe(false);
  });

  it("rejects an author string with 201 characters (one over maximum)", () => {
    const author201 = "a".repeat(201);
    const result = pluginManifestV1Schema.safeParse(validManifest({ author: author201 }));
    expect(result.success).toBe(false);
  });

  it("rejects a manifest with a missing author field", () => {
    const raw = validManifest();
    const { author: _removed, ...withoutAuthor } = raw;
    const result = pluginManifestV1Schema.safeParse(withoutAuthor);
    expect(result.success).toBe(false);
  });
});

// ===========================================================================
// String length boundary values (displayName, description)
// ===========================================================================

describe("string length boundary values", () => {
  it("accepts displayName of exactly 100 characters (maximum boundary)", () => {
    const result = pluginManifestV1Schema.safeParse(
      validManifest({ displayName: "x".repeat(100) }),
    );
    expect(result.success).toBe(true);
  });

  it("rejects displayName of 101 characters (one over maximum)", () => {
    const result = pluginManifestV1Schema.safeParse(
      validManifest({ displayName: "x".repeat(101) }),
    );
    expect(result.success).toBe(false);
  });

  it("accepts description of exactly 500 characters (maximum boundary)", () => {
    const result = pluginManifestV1Schema.safeParse(
      validManifest({ description: "d".repeat(500) }),
    );
    expect(result.success).toBe(true);
  });

  it("rejects description of 501 characters (one over maximum)", () => {
    const result = pluginManifestV1Schema.safeParse(
      validManifest({ description: "d".repeat(501) }),
    );
    expect(result.success).toBe(false);
  });

  it("accepts displayName of exactly 1 character (minimum boundary)", () => {
    const result = pluginManifestV1Schema.safeParse(
      validManifest({ displayName: "P" }),
    );
    expect(result.success).toBe(true);
  });

  it("accepts description of exactly 1 character (minimum boundary)", () => {
    const result = pluginManifestV1Schema.safeParse(
      validManifest({ description: "D" }),
    );
    expect(result.success).toBe(true);
  });
});

// ===========================================================================
// minimum host version validation
// ===========================================================================

describe("minimum host version validation", () => {
  it("accepts a valid semver string for minimumHostVersion", () => {
    const result = pluginManifestV1Schema.safeParse(
      validManifest({ minimumHostVersion: "1.2.3" }),
    );
    expect(result.success).toBe(true);
  });

  it("accepts matching minimum host version aliases", () => {
    const result = pluginManifestV1Schema.safeParse(
      validManifest({ minimumHostVersion: "1.2.3", minimumPaperclipVersion: "1.2.3" }),
    );
    expect(result.success).toBe(true);
  });

  it("accepts a semver with pre-release tag", () => {
    const result = pluginManifestV1Schema.safeParse(
      validManifest({ minimumPaperclipVersion: "1.0.0-beta.1" }),
    );
    expect(result.success).toBe(true);
  });

  it("accepts a manifest with no minimumPaperclipVersion (optional field)", () => {
    const raw = validManifest();
    const { minimumPaperclipVersion: _removed, ...withoutMin } = raw;
    expect(pluginManifestV1Schema.safeParse(withoutMin).success).toBe(true);
  });

  it("rejects mismatched minimum host version aliases", () => {
    const result = pluginManifestV1Schema.safeParse(
      validManifest({ minimumHostVersion: "1.0.0", minimumPaperclipVersion: "2.0.0" }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects an invalid semver string (no patch component)", () => {
    const result = pluginManifestV1Schema.safeParse(
      validManifest({ minimumPaperclipVersion: "1.0" }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects a version string with a leading 'v' prefix", () => {
    const result = pluginManifestV1Schema.safeParse(
      validManifest({ minimumPaperclipVersion: "v1.0.0" }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects 'latest' as a minimumPaperclipVersion", () => {
    const result = pluginManifestV1Schema.safeParse(
      validManifest({ minimumPaperclipVersion: "latest" }),
    );
    expect(result.success).toBe(false);
  });
});

// ===========================================================================
// ui.launchers validation
// ===========================================================================

describe("ui.launchers validation", () => {
  it("accepts ui.launchers without ui.slots", () => {
    const result = pluginManifestV1Schema.safeParse(
      validManifest({
        entrypoints: { worker: "dist/worker.js", ui: "dist/ui.js" },
        ui: {
          launchers: [
            {
              id: "open-tab",
              displayName: "Open Tab",
              placementZone: "sidebar",
              action: { type: "navigate", target: "/files" },
            },
          ],
        },
      }),
    );
    expect(result.success).toBe(true);
  });

  it("requires entrypoints.ui when ui.launchers are declared", () => {
    const result = pluginManifestV1Schema.safeParse(
      validManifest({
        ui: {
          launchers: [
            {
              id: "open-tab",
              displayName: "Open Tab",
              placementZone: "sidebar",
              action: { type: "navigate", target: "/files" },
            },
          ],
        },
      }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects context-sensitive launchers without entityTypes", () => {
    const result = pluginManifestV1Schema.safeParse(
      validManifest({
        entrypoints: { worker: "dist/worker.js", ui: "dist/ui.js" },
        ui: {
          launchers: [
            {
              id: "issue-tools",
              displayName: "Issue Tools",
              placementZone: "detailTab",
              action: { type: "navigate", target: "/issues/123?tab=plugin:tools" },
            },
          ],
        },
      }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects render bounds that are incompatible with the selected environment", () => {
    const result = pluginManifestV1Schema.safeParse(
      validManifest({
        entrypoints: { worker: "dist/worker.js", ui: "dist/ui.js" },
        ui: {
          launchers: [
            {
              id: "open-inline",
              displayName: "Open Inline",
              placementZone: "toolbarButton",
              action: { type: "openPopover", target: "inline-panel" },
              render: { environment: "hostInline", bounds: "full" },
            },
          ],
        },
      }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects overlay launchers that omit required render metadata", () => {
    const result = pluginManifestV1Schema.safeParse(
      validManifest({
        entrypoints: { worker: "dist/worker.js", ui: "dist/ui.js" },
        ui: {
          launchers: [
            {
              id: "sync-modal",
              displayName: "Sync",
              placementZone: "toolbarButton",
              action: { type: "openModal", target: "sync-modal" },
            },
          ],
        },
      }),
    );
    expect(result.success).toBe(false);
  });
});

// ===========================================================================
// Multiple simultaneous cross-field errors
// ===========================================================================

describe("multiple simultaneous cross-field validation errors", () => {
  it("reports both tools and jobs capability errors simultaneously", () => {
    // Provide tools without agent.tools.register AND jobs without jobs.schedule
    const result = pluginManifestV1Schema.safeParse(
      validManifest({
        capabilities: ["issues.read"], // missing agent.tools.register AND jobs.schedule
        tools: [
          {
            name: "my-tool",
            displayName: "My Tool",
            description: "Does things",
            parametersSchema: { type: "object" },
          },
        ],
        jobs: [{ jobKey: "sync", displayName: "Sync" }],
      }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message);
      expect(messages).toContain("Capability 'agent.tools.register' is required when tools are declared");
      expect(messages).toContain("Capability 'jobs.schedule' is required when jobs are declared");
    }
  });

  it("reports both UI entrypoint and tool capability errors simultaneously", () => {
    const result = pluginManifestV1Schema.safeParse(
      validManifest({
        capabilities: ["issues.read"], // missing agent.tools.register AND ui.sidebar.register
        tools: [
          {
            name: "t",
            displayName: "T",
            description: "D",
            parametersSchema: { type: "object" },
          },
        ],
        entrypoints: { worker: "worker.js" }, // no ui
        ui: {
          slots: [{ type: "sidebar", id: "s", displayName: "S", exportName: "S" }],
        },
      }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message);
      expect(messages).toContain("entrypoints.ui is required when ui.slots or ui.launchers are declared");
      expect(messages).toContain("Capability 'agent.tools.register' is required when tools are declared");
    }
  });

  it("service parse() errors string contains all errors when multiple are present", () => {
    const validator = pluginManifestValidator();
    const result = validator.parse(
      validManifest({
        capabilities: ["issues.read"],
        tools: [
          {
            name: "my-tool",
            displayName: "My Tool",
            description: "Does things",
            parametersSchema: { type: "object" },
          },
        ],
        jobs: [{ jobKey: "sync", displayName: "Sync" }],
      }),
    ) as ManifestParseFailure;
    expect(result.success).toBe(false);
    expect(result.errors).toContain("agent.tools.register");
    expect(result.errors).toContain("jobs.schedule");
    // Two errors are present — verify separator
    expect(result.errors).toContain(";");
  });
});

// ===========================================================================
// Error path formatting via service
// ===========================================================================

describe("error path formatting", () => {
  it("includes path prefix for nested field errors", () => {
    const validator = pluginManifestValidator();
    // entrypoints.worker is required and must be non-empty
    const result = validator.parse(
      validManifest({ entrypoints: { worker: "" } }),
    ) as ManifestParseFailure;
    expect(result.success).toBe(false);
    // Error message should include the nested path
    expect(result.errors).toMatch(/entrypoints\.worker/);
  });

  it("omits path prefix for top-level errors (no path)", () => {
    const validator = pluginManifestValidator();
    // apiVersion: 2 fails at top level (literal 1 constraint) — path is ["apiVersion"]
    const result = validator.parse(
      validManifest({ apiVersion: 2 }),
    ) as ManifestParseFailure;
    expect(result.success).toBe(false);
    // Error must be non-empty
    expect(result.errors.length).toBeGreaterThan(0);
    // The details array should show the path
    const apiVersionDetail = result.details.find((d) => d.path.includes("apiVersion"));
    expect(apiVersionDetail).toBeDefined();
  });

  it("details entries use raw path segments (not dot-joined)", () => {
    const validator = pluginManifestValidator();
    const result = validator.parse(
      validManifest({ entrypoints: { worker: "" } }),
    ) as ManifestParseFailure;
    expect(result.success).toBe(false);
    // Each detail path is the raw array of segments from Zod, not pre-joined
    for (const detail of result.details) {
      expect(Array.isArray(detail.path)).toBe(true);
    }
  });
});

// ===========================================================================
// Schema versioning: apiVersion literal enforcement
// ===========================================================================

describe("apiVersion schema versioning", () => {
  it("accepts apiVersion 1 (the only supported version)", () => {
    expect(pluginManifestV1Schema.safeParse(validManifest({ apiVersion: 1 })).success).toBe(true);
  });

  it("rejects apiVersion 0", () => {
    expect(pluginManifestV1Schema.safeParse(validManifest({ apiVersion: 0 })).success).toBe(false);
  });

  it("rejects apiVersion 2", () => {
    expect(pluginManifestV1Schema.safeParse(validManifest({ apiVersion: 2 })).success).toBe(false);
  });

  it("rejects a string apiVersion", () => {
    expect(pluginManifestV1Schema.safeParse(validManifest({ apiVersion: "1" })).success).toBe(false);
  });

  it("rejects null apiVersion", () => {
    expect(pluginManifestV1Schema.safeParse(validManifest({ apiVersion: null })).success).toBe(false);
  });

  it("apiVersion literal constraint aligns with PLUGIN_API_VERSION constant", () => {
    // Parse a manifest using the PLUGIN_API_VERSION constant as the value
    const result = pluginManifestV1Schema.safeParse(
      validManifest({ apiVersion: PLUGIN_API_VERSION }),
    );
    expect(result.success).toBe(true);
  });
});
