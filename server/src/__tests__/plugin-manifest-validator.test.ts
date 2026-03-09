import { describe, expect, it } from "vitest";
import {
  pluginManifestValidator,
  type ManifestParseSuccess,
  type ManifestParseFailure,
} from "../services/plugin-manifest-validator.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal valid raw manifest object (plain unknown, as the validator receives). */
function validRawManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "acme.test-plugin",
    apiVersion: 1,
    version: "1.0.0",
    displayName: "Test Plugin",
    description: "A valid test plugin for the validator service",
    author: "Acme Corp",
    categories: ["connector"],
    capabilities: ["issues.read"],
    entrypoints: { worker: "dist/worker.js" },
    ...overrides,
  };
}

// ===========================================================================
// Factory / constructor
// ===========================================================================

describe("pluginManifestValidator factory", () => {
  it("returns a new validator instance on each call", () => {
    const v1 = pluginManifestValidator();
    const v2 = pluginManifestValidator();
    expect(v1).not.toBe(v2);
  });

  it("exposes parse, parseOrThrow, and getSupportedVersions methods", () => {
    const validator = pluginManifestValidator();
    expect(typeof validator.parse).toBe("function");
    expect(typeof validator.parseOrThrow).toBe("function");
    expect(typeof validator.getSupportedVersions).toBe("function");
  });
});

// ===========================================================================
// getSupportedVersions
// ===========================================================================

describe("getSupportedVersions", () => {
  const validator = pluginManifestValidator();

  it("returns an array", () => {
    const versions = validator.getSupportedVersions();
    expect(Array.isArray(versions)).toBe(true);
  });

  it("includes apiVersion 1", () => {
    const versions = validator.getSupportedVersions();
    expect(versions).toContain(1);
  });

  it("returns the same supported versions on repeated calls", () => {
    // Both calls should return arrays with equal contents.
    expect(validator.getSupportedVersions()).toEqual(validator.getSupportedVersions());
  });
});

// ===========================================================================
// parse — success path
// ===========================================================================

describe("parse — success", () => {
  const validator = pluginManifestValidator();

  it("returns success=true for a minimal valid manifest", () => {
    const result = validator.parse(validRawManifest());
    expect(result.success).toBe(true);
  });

  it("returns the parsed manifest on success", () => {
    const raw = validRawManifest();
    const result = validator.parse(raw) as ManifestParseSuccess;
    expect(result.manifest).toBeDefined();
    expect(result.manifest.id).toBe("acme.test-plugin");
    expect(result.manifest.apiVersion).toBe(1);
    expect(result.manifest.version).toBe("1.0.0");
  });

  it("returns a typed PaperclipPluginManifestV1 on success", () => {
    const result = validator.parse(validRawManifest()) as ManifestParseSuccess;
    // Spot-check that key manifest fields are present
    expect(result.manifest.displayName).toBe("Test Plugin");
    expect(result.manifest.categories).toEqual(["connector"]);
    expect(result.manifest.capabilities).toEqual(["issues.read"]);
    expect(result.manifest.entrypoints.worker).toBe("dist/worker.js");
  });

  it("accepts a full-featured manifest with all optional fields", () => {
    const result = validator.parse(
      validRawManifest({
        minimumHostVersion: "0.5.0",
        minimumPaperclipVersion: "0.5.0",
        instanceConfigSchema: { type: "object" },
        capabilities: [
          "issues.read",
          "agent.tools.register",
          "jobs.schedule",
          "webhooks.receive",
          "ui.sidebar.register",
        ],
        entrypoints: { worker: "dist/worker.js", ui: "dist/ui.js" },
        tools: [
          {
            name: "search-issues",
            displayName: "Search Issues",
            description: "Searches for matching issues",
            parametersSchema: { type: "object", properties: { q: { type: "string" } } },
          },
        ],
        jobs: [{ jobKey: "nightly-sync", displayName: "Nightly Sync", schedule: "0 2 * * *" }],
        webhooks: [{ endpointKey: "push-events", displayName: "Push Events" }],
        ui: {
          launchers: [
            {
              id: "open-plugin-sidebar",
              displayName: "Open Plugin Sidebar",
              placementZone: "sidebar",
              action: { type: "navigate", target: "/plugins/sidebar" },
            },
          ],
          slots: [
            { type: "sidebar", id: "plugin-sidebar", displayName: "Plugin Sidebar", exportName: "PluginSidebar" },
          ],
        },
      }),
    );
    expect(result.success).toBe(true);
  });

  it("accepts a manifest that only declares ui.launchers", () => {
    const result = validator.parse(
      validRawManifest({
        entrypoints: { worker: "dist/worker.js", ui: "dist/ui.js" },
        ui: {
          launchers: [
            {
              id: "open-dashboard",
              displayName: "Open Dashboard",
              placementZone: "sidebar",
              action: { type: "navigate", target: "/dashboard" },
            },
          ],
        },
      }),
    );
    expect(result.success).toBe(true);
  });

  it("accepts launcher manifests with modal render metadata and project sidebar placement", () => {
    const result = validator.parse(
      validRawManifest({
        capabilities: ["issues.read", "ui.sidebar.register"],
        entrypoints: { worker: "dist/worker.js", ui: "dist/ui.js" },
        ui: {
          launchers: [
            {
              id: "project-files",
              displayName: "Files",
              placementZone: "projectSidebarItem",
              entityTypes: ["project"],
              action: { type: "openModal", target: "FilesModal" },
              render: { environment: "hostOverlay", bounds: "wide" },
            },
          ],
        },
      }),
    );

    expect(result.success).toBe(true);
  });

  it("does not have errors or details on success", () => {
    const result = validator.parse(validRawManifest());
    // Narrow: the success result should not have failure properties
    expect("errors" in result).toBe(false);
    expect("details" in result).toBe(false);
  });
});

// ===========================================================================
// parse — failure path
// ===========================================================================

describe("parse — failure", () => {
  const validator = pluginManifestValidator();

  it("returns success=false for an invalid manifest", () => {
    const result = validator.parse({ id: "INVALID_ID", apiVersion: 1 });
    expect(result.success).toBe(false);
  });

  it("returns errors string for an invalid manifest", () => {
    const result = validator.parse({}) as ManifestParseFailure;
    expect(result.success).toBe(false);
    expect(typeof result.errors).toBe("string");
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("returns a details array for an invalid manifest", () => {
    const result = validator.parse({}) as ManifestParseFailure;
    expect(Array.isArray(result.details)).toBe(true);
    expect(result.details.length).toBeGreaterThan(0);
  });

  it("each detail entry has path and message", () => {
    const result = validator.parse({}) as ManifestParseFailure;
    for (const detail of result.details) {
      expect(Array.isArray(detail.path)).toBe(true);
      expect(typeof detail.message).toBe("string");
    }
  });

  it("returns success=false for null input", () => {
    const result = validator.parse(null);
    expect(result.success).toBe(false);
  });

  it("returns success=false for a non-object input (string)", () => {
    const result = validator.parse("not-an-object");
    expect(result.success).toBe(false);
  });

  it("returns success=false for a non-object input (number)", () => {
    const result = validator.parse(42);
    expect(result.success).toBe(false);
  });

  it("returns success=false for an array input", () => {
    const result = validator.parse([validRawManifest()]);
    expect(result.success).toBe(false);
  });

  it("returns success=false for undefined", () => {
    const result = validator.parse(undefined);
    expect(result.success).toBe(false);
  });

  it("formats error messages with path context for nested fields", () => {
    // Trigger a nested field error: missing displayName inside entrypoints
    const result = validator.parse(
      validRawManifest({ entrypoints: { worker: "" } }),
    ) as ManifestParseFailure;
    expect(result.success).toBe(false);
    // The errors string should contain path information
    expect(result.errors).toMatch(/entrypoints/);
  });

  it("reports nested launcher render validation errors with path context", () => {
    const result = validator.parse(
      validRawManifest({
        capabilities: ["issues.read", "ui.action.register"],
        entrypoints: { worker: "dist/worker.js", ui: "dist/ui.js" },
        ui: {
          launchers: [
            {
              id: "sync-modal",
              displayName: "Sync",
              placementZone: "toolbarButton",
              action: { type: "openModal", target: "SyncModal" },
            },
          ],
        },
      }),
    ) as ManifestParseFailure;

    expect(result.success).toBe(false);
    expect(result.errors).toMatch(/ui\.launchers\.0\.render/);
    expect(result.details).toContainEqual({
      path: ["ui", "launchers", 0, "render"],
      message: "openModal launchers require render metadata",
    });
  });

  it("rejects projectSidebarItem launchers that do not target projects", () => {
    const result = validator.parse(
      validRawManifest({
        capabilities: ["issues.read", "ui.sidebar.register"],
        entrypoints: { worker: "dist/worker.js", ui: "dist/ui.js" },
        ui: {
          launchers: [
            {
              id: "bad-files",
              displayName: "Files",
              placementZone: "projectSidebarItem",
              entityTypes: ["issue"],
              action: { type: "navigate", target: "/projects/files" },
            },
          ],
        },
      }),
    ) as ManifestParseFailure;

    expect(result.success).toBe(false);
    expect(result.errors).toMatch(/projectSidebarItem launchers require entityTypes to include "project"/);
    expect(result.details).toContainEqual({
      path: ["ui", "launchers", 0, "entityTypes"],
      message: 'projectSidebarItem launchers require entityTypes to include "project"',
    });
  });

  it("formats top-level errors without a path prefix", () => {
    // apiVersion: 2 is invalid — triggers a top-level error with no path
    const result = validator.parse(
      validRawManifest({ apiVersion: 2 }),
    ) as ManifestParseFailure;
    expect(result.success).toBe(false);
    // Top-level issues (no path) should just be the message
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("separates multiple validation errors with semicolons", () => {
    // Provide multiple invalid fields at once
    const result = validator.parse({
      id: "",
      apiVersion: 1,
      version: "",
      displayName: "",
      description: "",
      author: "",
      categories: [],
      capabilities: [],
      entrypoints: { worker: "" },
    }) as ManifestParseFailure;
    expect(result.success).toBe(false);
    // Multiple errors should be joined by "; "
    expect(result.errors).toContain(";");
  });

  it("does not have a manifest property on failure", () => {
    const result = validator.parse({});
    expect("manifest" in result).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Specific field validation errors
  // -------------------------------------------------------------------------

  it("reports error for invalid id format (uppercase)", () => {
    const result = validator.parse(validRawManifest({ id: "Acme.Plugin" })) as ManifestParseFailure;
    expect(result.success).toBe(false);
    expect(result.errors).toMatch(/id/);
  });

  it("reports error for invalid version (non-semver)", () => {
    const result = validator.parse(validRawManifest({ version: "v1" })) as ManifestParseFailure;
    expect(result.success).toBe(false);
    expect(result.errors).toMatch(/version/i);
  });

  it("reports error for wrong apiVersion (2 instead of 1)", () => {
    const result = validator.parse(validRawManifest({ apiVersion: 2 })) as ManifestParseFailure;
    expect(result.success).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("reports error for empty capabilities array", () => {
    const result = validator.parse(validRawManifest({ capabilities: [] })) as ManifestParseFailure;
    expect(result.success).toBe(false);
    expect(result.errors).toMatch(/capabilities/);
  });

  it("reports error for displayName exceeding 100 characters", () => {
    const result = validator.parse(
      validRawManifest({ displayName: "x".repeat(101) }),
    ) as ManifestParseFailure;
    expect(result.success).toBe(false);
    expect(result.errors).toMatch(/displayName/);
  });

  it("reports error for description exceeding 500 characters", () => {
    const result = validator.parse(
      validRawManifest({ description: "y".repeat(501) }),
    ) as ManifestParseFailure;
    expect(result.success).toBe(false);
    expect(result.errors).toMatch(/description/);
  });

  it("reports error for author exceeding 200 characters", () => {
    const result = validator.parse(
      validRawManifest({ author: "a".repeat(201) }),
    ) as ManifestParseFailure;
    expect(result.success).toBe(false);
    expect(result.errors).toMatch(/author/);
  });

  it("reports cross-field error for UI slots without entrypoints.ui", () => {
    const result = validator.parse(
      validRawManifest({
        capabilities: ["issues.read", "ui.sidebar.register"],
        entrypoints: { worker: "dist/worker.js" },
        ui: {
          slots: [{ type: "sidebar", id: "s", displayName: "S", exportName: "S" }],
        },
      }),
    ) as ManifestParseFailure;
    expect(result.success).toBe(false);
    expect(result.errors).toContain("entrypoints.ui is required when ui.slots or ui.launchers are declared");
  });

  it("reports cross-field error for tools without agent.tools.register", () => {
    const result = validator.parse(
      validRawManifest({
        capabilities: ["issues.read"],
        tools: [
          { name: "my-tool", displayName: "My Tool", description: "Does stuff", parametersSchema: { type: "object" } },
        ],
      }),
    ) as ManifestParseFailure;
    expect(result.success).toBe(false);
    expect(result.errors).toContain("agent.tools.register");
  });

  it("reports cross-field error for jobs without jobs.schedule", () => {
    const result = validator.parse(
      validRawManifest({
        capabilities: ["issues.read"],
        jobs: [{ jobKey: "sync", displayName: "Sync" }],
      }),
    ) as ManifestParseFailure;
    expect(result.success).toBe(false);
    expect(result.errors).toContain("jobs.schedule");
  });

  it("reports cross-field error for webhooks without webhooks.receive", () => {
    const result = validator.parse(
      validRawManifest({
        capabilities: ["issues.read"],
        webhooks: [{ endpointKey: "hook", displayName: "Hook" }],
      }),
    ) as ManifestParseFailure;
    expect(result.success).toBe(false);
    expect(result.errors).toContain("webhooks.receive");
  });

  it("reports uniqueness error for duplicate job keys", () => {
    const result = validator.parse(
      validRawManifest({
        capabilities: ["issues.read", "jobs.schedule"],
        jobs: [
          { jobKey: "sync", displayName: "Sync 1" },
          { jobKey: "sync", displayName: "Sync 2" },
        ],
      }),
    ) as ManifestParseFailure;
    expect(result.success).toBe(false);
    expect(result.errors).toMatch(/Duplicate job keys/);
  });

  it("reports uniqueness error for duplicate webhook endpoint keys", () => {
    const result = validator.parse(
      validRawManifest({
        capabilities: ["issues.read", "webhooks.receive"],
        webhooks: [
          { endpointKey: "hook", displayName: "Hook 1" },
          { endpointKey: "hook", displayName: "Hook 2" },
        ],
      }),
    ) as ManifestParseFailure;
    expect(result.success).toBe(false);
    expect(result.errors).toMatch(/Duplicate webhook endpoint keys/);
  });

  it("reports uniqueness error for duplicate tool names", () => {
    const result = validator.parse(
      validRawManifest({
        capabilities: ["issues.read", "agent.tools.register"],
        tools: [
          { name: "search", displayName: "Search 1", description: "D1", parametersSchema: { type: "object" } },
          { name: "search", displayName: "Search 2", description: "D2", parametersSchema: { type: "object" } },
        ],
      }),
    ) as ManifestParseFailure;
    expect(result.success).toBe(false);
    expect(result.errors).toMatch(/Duplicate tool names/);
  });

  it("reports uniqueness error for duplicate UI slot ids", () => {
    const result = validator.parse(
      validRawManifest({
        capabilities: ["issues.read", "ui.sidebar.register"],
        entrypoints: { worker: "dist/worker.js", ui: "dist/ui.js" },
        ui: {
          slots: [
            { type: "sidebar", id: "my-slot", displayName: "Slot 1", exportName: "Slot1" },
            { type: "sidebar", id: "my-slot", displayName: "Slot 2", exportName: "Slot2" },
          ],
        },
      }),
    ) as ManifestParseFailure;
    expect(result.success).toBe(false);
    expect(result.errors).toMatch(/Duplicate UI slot ids/);
  });
});

// ===========================================================================
// parseOrThrow — success path
// ===========================================================================

describe("parseOrThrow — success", () => {
  const validator = pluginManifestValidator();

  it("returns the parsed manifest for a valid input", () => {
    const raw = validRawManifest();
    const manifest = validator.parseOrThrow(raw);
    expect(manifest).toBeDefined();
    expect(manifest.id).toBe("acme.test-plugin");
  });

  it("does not throw for a valid manifest", () => {
    expect(() => validator.parseOrThrow(validRawManifest())).not.toThrow();
  });

  it("returns a manifest with correct typed fields", () => {
    const manifest = validator.parseOrThrow(validRawManifest());
    expect(manifest.apiVersion).toBe(1);
    expect(manifest.version).toBe("1.0.0");
    expect(manifest.displayName).toBe("Test Plugin");
    expect(manifest.categories).toEqual(["connector"]);
    expect(manifest.capabilities).toEqual(["issues.read"]);
    expect(manifest.entrypoints.worker).toBe("dist/worker.js");
  });

  it("accepts a full-featured valid manifest without throwing", () => {
    const raw = validRawManifest({
      minimumHostVersion: "1.0.0",
      minimumPaperclipVersion: "1.0.0",
      capabilities: [
        "issues.read",
        "agent.tools.register",
        "jobs.schedule",
        "webhooks.receive",
      ],
      tools: [
        {
          name: "fetch-data",
          displayName: "Fetch Data",
          description: "Fetches external data",
          parametersSchema: { type: "object" },
        },
      ],
      jobs: [{ jobKey: "daily-sync", displayName: "Daily Sync" }],
      webhooks: [{ endpointKey: "incoming", displayName: "Incoming" }],
    });
    expect(() => validator.parseOrThrow(raw)).not.toThrow();
  });

  it("throws when minimum host version aliases disagree", () => {
    expect(() =>
      validator.parseOrThrow(
        validRawManifest({
          minimumHostVersion: "1.0.0",
          minimumPaperclipVersion: "2.0.0",
        }),
      ),
    ).toThrow(/minimumHostVersion and minimumPaperclipVersion must match/i);
  });
});

// ===========================================================================
// parseOrThrow — failure / HTTP error path
// ===========================================================================

describe("parseOrThrow — failure (throws HttpError)", () => {
  const validator = pluginManifestValidator();

  it("throws for an invalid manifest", () => {
    expect(() => validator.parseOrThrow({})).toThrow();
  });

  it("throws an error with status 400", () => {
    try {
      validator.parseOrThrow({});
      expect.unreachable("should have thrown");
    } catch (error: unknown) {
      expect((error as { status: number }).status).toBe(400);
    }
  });

  it("thrown error message includes 'Invalid plugin manifest'", () => {
    try {
      validator.parseOrThrow({ id: "INVALID", apiVersion: 99 });
      expect.unreachable("should have thrown");
    } catch (error: unknown) {
      expect((error as Error).message).toMatch(/Invalid plugin manifest/);
    }
  });

  it("thrown error message contains human-readable details", () => {
    try {
      validator.parseOrThrow(validRawManifest({ id: "UPPERCASE" }));
      expect.unreachable("should have thrown");
    } catch (error: unknown) {
      // The error message should embed the Zod error description
      expect((error as Error).message.length).toBeGreaterThan("Invalid plugin manifest: ".length);
    }
  });

  it("thrown error has details containing raw Zod issues", () => {
    try {
      validator.parseOrThrow({});
      expect.unreachable("should have thrown");
    } catch (error: unknown) {
      const details = (error as { details?: unknown }).details;
      expect(Array.isArray(details)).toBe(true);
      expect((details as unknown[]).length).toBeGreaterThan(0);
    }
  });

  it("thrown error details have path and message entries", () => {
    try {
      validator.parseOrThrow({});
      expect.unreachable("should have thrown");
    } catch (error: unknown) {
      const details = (error as { details?: Array<{ path: unknown[]; message: string }> }).details ?? [];
      for (const detail of details) {
        expect(Array.isArray(detail.path)).toBe(true);
        expect(typeof detail.message).toBe("string");
      }
    }
  });

  it("throws for null input", () => {
    expect(() => validator.parseOrThrow(null)).toThrow();
  });

  it("throws for string input", () => {
    expect(() => validator.parseOrThrow("a string")).toThrow();
  });

  it("throws for wrong apiVersion", () => {
    expect(() => validator.parseOrThrow(validRawManifest({ apiVersion: 2 }))).toThrow();
  });

  it("throws for invalid id format", () => {
    expect(() => validator.parseOrThrow(validRawManifest({ id: "Has Spaces" }))).toThrow();
  });

  it("throws for missing required fields", () => {
    // Only provide id; all other required fields missing
    expect(() => validator.parseOrThrow({ id: "acme.plugin", apiVersion: 1 })).toThrow();
  });
});

// ===========================================================================
// parse is safe — never throws
// ===========================================================================

describe("parse — never throws", () => {
  const validator = pluginManifestValidator();

  it("does not throw for null", () => {
    expect(() => validator.parse(null)).not.toThrow();
  });

  it("does not throw for undefined", () => {
    expect(() => validator.parse(undefined)).not.toThrow();
  });

  it("does not throw for a completely empty object", () => {
    expect(() => validator.parse({})).not.toThrow();
  });

  it("does not throw for deeply invalid input", () => {
    expect(() =>
      validator.parse({
        id: 123,
        apiVersion: "not-a-number",
        version: false,
        capabilities: "should-be-array",
      }),
    ).not.toThrow();
  });

  it("always returns an object with a boolean success field", () => {
    const cases: unknown[] = [null, undefined, {}, [], "string", 42, validRawManifest()];
    for (const input of cases) {
      const result = validator.parse(input);
      expect(typeof result.success).toBe("boolean");
    }
  });
});

// ===========================================================================
// Consistency: parse and parseOrThrow agree
// ===========================================================================

describe("parse and parseOrThrow consistency", () => {
  const validator = pluginManifestValidator();

  it("parse succeeds iff parseOrThrow does not throw", () => {
    const validInput = validRawManifest();
    const parseResult = validator.parse(validInput);
    expect(parseResult.success).toBe(true);
    expect(() => validator.parseOrThrow(validInput)).not.toThrow();
  });

  it("parse fails iff parseOrThrow throws", () => {
    const invalidInput = {};
    const parseResult = validator.parse(invalidInput);
    expect(parseResult.success).toBe(false);
    expect(() => validator.parseOrThrow(invalidInput)).toThrow();
  });

  it("manifest returned by parseOrThrow matches manifest in parse result", () => {
    const raw = validRawManifest();
    const parseResult = validator.parse(raw) as ManifestParseSuccess;
    const thrownManifest = validator.parseOrThrow(raw);
    expect(thrownManifest.id).toBe(parseResult.manifest.id);
    expect(thrownManifest.version).toBe(parseResult.manifest.version);
    expect(thrownManifest.displayName).toBe(parseResult.manifest.displayName);
  });
});
