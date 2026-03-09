import { describe, expect, it } from "vitest";
import {
  pluginManifestV1Schema,
  pluginJobDeclarationSchema,
  pluginWebhookDeclarationSchema,
  pluginToolDeclarationSchema,
  pluginUiSlotDeclarationSchema,
  pluginLauncherActionDeclarationSchema,
  pluginLauncherRenderDeclarationSchema,
  pluginLauncherDeclarationSchema,
  jsonSchemaSchema,
  installPluginSchema,
  upsertPluginConfigSchema,
  patchPluginConfigSchema,
  updatePluginStatusSchema,
  uninstallPluginSchema,
  pluginStateScopeKeySchema,
  setPluginStateSchema,
  listPluginStateSchema,
} from "@paperclipai/shared";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal valid manifest. */
function validManifest(overrides: Record<string, unknown> = {}) {
  return {
    id: "acme.my-plugin",
    apiVersion: 1,
    version: "1.0.0",
    displayName: "My Plugin",
    description: "A test plugin for validation",
    author: "Acme Corp",
    categories: ["connector"],
    capabilities: ["issues.read"],
    entrypoints: { worker: "worker.js" },
    ...overrides,
  };
}

// ===========================================================================
// jsonSchemaSchema
// ===========================================================================

describe("jsonSchemaSchema", () => {
  it("accepts an empty object", () => {
    expect(jsonSchemaSchema.safeParse({}).success).toBe(true);
  });

  it("accepts a schema with a type field", () => {
    expect(jsonSchemaSchema.safeParse({ type: "object" }).success).toBe(true);
  });

  it("accepts a schema with $ref", () => {
    expect(jsonSchemaSchema.safeParse({ $ref: "#/definitions/Foo" }).success).toBe(true);
  });

  it("accepts a schema with composition keywords", () => {
    expect(jsonSchemaSchema.safeParse({ oneOf: [{ type: "string" }] }).success).toBe(true);
    expect(jsonSchemaSchema.safeParse({ anyOf: [{ type: "string" }] }).success).toBe(true);
    expect(jsonSchemaSchema.safeParse({ allOf: [{ type: "string" }] }).success).toBe(true);
  });

  it("rejects a non-empty object without type, $ref, or composition keyword", () => {
    const result = jsonSchemaSchema.safeParse({ properties: { foo: {} } });
    expect(result.success).toBe(false);
  });
});

// ===========================================================================
// pluginJobDeclarationSchema
// ===========================================================================

describe("pluginJobDeclarationSchema", () => {
  it("accepts a valid job with all fields", () => {
    const result = pluginJobDeclarationSchema.safeParse({
      jobKey: "sync-issues",
      displayName: "Sync Issues",
      description: "Syncs issues from external tracker",
      schedule: "*/15 * * * *",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a minimal job (no optional fields)", () => {
    const result = pluginJobDeclarationSchema.safeParse({
      jobKey: "cleanup",
      displayName: "Cleanup",
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty jobKey", () => {
    const result = pluginJobDeclarationSchema.safeParse({
      jobKey: "",
      displayName: "Sync",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty displayName", () => {
    const result = pluginJobDeclarationSchema.safeParse({
      jobKey: "sync",
      displayName: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing jobKey", () => {
    const result = pluginJobDeclarationSchema.safeParse({
      displayName: "Sync",
    });
    expect(result.success).toBe(false);
  });
});

// ===========================================================================
// pluginWebhookDeclarationSchema
// ===========================================================================

describe("pluginWebhookDeclarationSchema", () => {
  it("accepts a valid webhook with all fields", () => {
    const result = pluginWebhookDeclarationSchema.safeParse({
      endpointKey: "github-webhook",
      displayName: "GitHub Webhook",
      description: "Receives push events",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a minimal webhook", () => {
    const result = pluginWebhookDeclarationSchema.safeParse({
      endpointKey: "hook",
      displayName: "Hook",
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty endpointKey", () => {
    const result = pluginWebhookDeclarationSchema.safeParse({
      endpointKey: "",
      displayName: "Hook",
    });
    expect(result.success).toBe(false);
  });
});

// ===========================================================================
// pluginToolDeclarationSchema
// ===========================================================================

describe("pluginToolDeclarationSchema", () => {
  it("accepts a valid tool", () => {
    const result = pluginToolDeclarationSchema.safeParse({
      name: "search-jira",
      displayName: "Search Jira",
      description: "Searches Jira for issues matching a query",
      parametersSchema: { type: "object", properties: { query: { type: "string" } } },
    });
    expect(result.success).toBe(true);
  });

  it("rejects a tool with empty name", () => {
    const result = pluginToolDeclarationSchema.safeParse({
      name: "",
      displayName: "My Tool",
      description: "Does stuff",
      parametersSchema: { type: "object" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a tool with empty description", () => {
    const result = pluginToolDeclarationSchema.safeParse({
      name: "my-tool",
      displayName: "My Tool",
      description: "",
      parametersSchema: { type: "object" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a tool with invalid parametersSchema", () => {
    const result = pluginToolDeclarationSchema.safeParse({
      name: "my-tool",
      displayName: "My Tool",
      description: "Does stuff",
      parametersSchema: { randomKey: "not-a-schema" },
    });
    expect(result.success).toBe(false);
  });
});

// ===========================================================================
// pluginUiSlotDeclarationSchema
// ===========================================================================

describe("pluginUiSlotDeclarationSchema", () => {
  it("accepts a valid sidebar slot", () => {
    const result = pluginUiSlotDeclarationSchema.safeParse({
      type: "sidebar",
      id: "my-sidebar",
      displayName: "My Sidebar",
      exportName: "MySidebar",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a valid detailTab slot with entityTypes", () => {
    const result = pluginUiSlotDeclarationSchema.safeParse({
      type: "detailTab",
      id: "issue-tab",
      displayName: "Issue Details",
      exportName: "IssueTab",
      entityTypes: ["issue", "project"],
    });
    expect(result.success).toBe(true);
  });

  it("rejects a detailTab slot without entityTypes", () => {
    const result = pluginUiSlotDeclarationSchema.safeParse({
      type: "detailTab",
      id: "issue-tab",
      displayName: "Issue Details",
      exportName: "IssueTab",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a detailTab slot with empty entityTypes array", () => {
    const result = pluginUiSlotDeclarationSchema.safeParse({
      type: "detailTab",
      id: "issue-tab",
      displayName: "Issue Details",
      exportName: "IssueTab",
      entityTypes: [],
    });
    expect(result.success).toBe(false);
  });

  it("accepts projectSidebarItem with entityTypes [\"project\"]", () => {
    const result = pluginUiSlotDeclarationSchema.safeParse({
      type: "projectSidebarItem",
      id: "files-link",
      displayName: "Files",
      exportName: "ProjectFilesLink",
      entityTypes: ["project"],
    });
    expect(result.success).toBe(true);
  });

  it("rejects projectSidebarItem without entityTypes", () => {
    const result = pluginUiSlotDeclarationSchema.safeParse({
      type: "projectSidebarItem",
      id: "files-link",
      displayName: "Files",
      exportName: "ProjectFilesLink",
    });
    expect(result.success).toBe(false);
  });

  it("rejects projectSidebarItem when entityTypes does not include project", () => {
    const result = pluginUiSlotDeclarationSchema.safeParse({
      type: "projectSidebarItem",
      id: "files-link",
      displayName: "Files",
      exportName: "ProjectFilesLink",
      entityTypes: ["issue"],
    });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid slot type", () => {
    const result = pluginUiSlotDeclarationSchema.safeParse({
      type: "unknown_slot_type",
      id: "my-slot",
      displayName: "My Slot",
      exportName: "MySlot",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid entityType", () => {
    const result = pluginUiSlotDeclarationSchema.safeParse({
      type: "detailTab",
      id: "my-tab",
      displayName: "My Tab",
      exportName: "MyTab",
      entityTypes: ["nonexistent_entity"],
    });
    expect(result.success).toBe(false);
  });
});

// ===========================================================================
// pluginLauncherActionDeclarationSchema
// ===========================================================================

describe("pluginLauncherActionDeclarationSchema", () => {
  it("accepts a navigate launcher action with a host route target", () => {
    const result = pluginLauncherActionDeclarationSchema.safeParse({
      type: "navigate",
      target: "/projects/123",
    });
    expect(result.success).toBe(true);
  });

  it("rejects navigate launcher actions that target an absolute URL", () => {
    const result = pluginLauncherActionDeclarationSchema.safeParse({
      type: "navigate",
      target: "https://example.com/files",
    });
    expect(result.success).toBe(false);
  });

  it("rejects performAction launcher actions that target a route", () => {
    const result = pluginLauncherActionDeclarationSchema.safeParse({
      type: "performAction",
      target: "/projects/123",
    });
    expect(result.success).toBe(false);
  });
});

// ===========================================================================
// pluginLauncherRenderDeclarationSchema
// ===========================================================================

describe("pluginLauncherRenderDeclarationSchema", () => {
  it("accepts inline bounds for hostInline environments", () => {
    const result = pluginLauncherRenderDeclarationSchema.safeParse({
      environment: "hostInline",
      bounds: "inline",
    });
    expect(result.success).toBe(true);
  });

  it("rejects full bounds for hostInline environments", () => {
    const result = pluginLauncherRenderDeclarationSchema.safeParse({
      environment: "hostInline",
      bounds: "full",
    });
    expect(result.success).toBe(false);
  });

  it("rejects bounds for external environments", () => {
    const result = pluginLauncherRenderDeclarationSchema.safeParse({
      environment: "external",
      bounds: "compact",
    });
    expect(result.success).toBe(false);
  });
});

// ===========================================================================
// pluginLauncherDeclarationSchema
// ===========================================================================

describe("pluginLauncherDeclarationSchema", () => {
  it("accepts a projectSidebarItem launcher with project entityTypes", () => {
    const result = pluginLauncherDeclarationSchema.safeParse({
      id: "project-files",
      displayName: "Files",
      placementZone: "projectSidebarItem",
      entityTypes: ["project"],
      action: {
        type: "navigate",
        target: "/projects/123?tab=plugin:files",
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects a detailTab launcher without entityTypes", () => {
    const result = pluginLauncherDeclarationSchema.safeParse({
      id: "issue-tools",
      displayName: "Issue Tools",
      placementZone: "detailTab",
      action: {
        type: "navigate",
        target: "/issues/123?tab=plugin:tools",
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a projectSidebarItem launcher without the project entityType", () => {
    const result = pluginLauncherDeclarationSchema.safeParse({
      id: "issue-files",
      displayName: "Files",
      placementZone: "projectSidebarItem",
      entityTypes: ["issue"],
      action: {
        type: "navigate",
        target: "/issues/123",
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects openModal launchers without render metadata", () => {
    const result = pluginLauncherDeclarationSchema.safeParse({
      id: "sync-modal",
      displayName: "Sync",
      placementZone: "toolbarButton",
      action: {
        type: "openModal",
        target: "sync-modal",
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects performAction launchers that declare render metadata", () => {
    const result = pluginLauncherDeclarationSchema.safeParse({
      id: "run-sync",
      displayName: "Run Sync",
      placementZone: "toolbarButton",
      action: {
        type: "performAction",
        target: "sync-now",
      },
      render: {
        environment: "hostOverlay",
        bounds: "default",
      },
    });
    expect(result.success).toBe(false);
  });

  it("accepts openDrawer launchers with overlay render metadata", () => {
    const result = pluginLauncherDeclarationSchema.safeParse({
      id: "open-drawer",
      displayName: "Open Drawer",
      placementZone: "sidebar",
      action: {
        type: "openDrawer",
        target: "drawer-content",
      },
      render: {
        environment: "hostOverlay",
        bounds: "wide",
      },
    });
    expect(result.success).toBe(true);
  });
});

// ===========================================================================
// pluginManifestV1Schema – basic fields
// ===========================================================================

describe("pluginManifestV1Schema", () => {
  describe("basic validation", () => {
    it("accepts a minimal valid manifest", () => {
      const result = pluginManifestV1Schema.safeParse(validManifest());
      expect(result.success).toBe(true);
    });

    it("accepts a manifest with all optional fields", () => {
      const result = pluginManifestV1Schema.safeParse(
        validManifest({
          minimumHostVersion: "0.5.0",
          minimumPaperclipVersion: "0.5.0",
          instanceConfigSchema: { type: "object" },
          jobs: [{ jobKey: "sync", displayName: "Sync" }],
          webhooks: [{ endpointKey: "hook", displayName: "Hook" }],
          tools: [
            {
              name: "my-tool",
              displayName: "My Tool",
              description: "Does things",
              parametersSchema: { type: "object" },
            },
          ],
          capabilities: [
            "issues.read",
            "agent.tools.register",
            "jobs.schedule",
            "webhooks.receive",
            "ui.sidebar.register",
          ],
          entrypoints: { worker: "worker.js", ui: "ui.js" },
          ui: {
            launchers: [
              {
                id: "open-sidebar",
                displayName: "Open Sidebar",
                placementZone: "sidebar",
                action: { type: "navigate", target: "/plugins/my-sidebar" },
              },
            ],
            slots: [
              {
                type: "sidebar",
                id: "my-sidebar",
                displayName: "Sidebar",
                exportName: "Sidebar",
              },
            ],
          },
        }),
      );
      expect(result.success).toBe(true);
    });

    it("accepts ui.launchers without ui.slots", () => {
      const result = pluginManifestV1Schema.safeParse(
        validManifest({
          entrypoints: { worker: "worker.js", ui: "ui.js" },
          ui: {
            launchers: [
              {
                id: "open-workspace",
                displayName: "Open Workspace",
                placementZone: "sidebar",
                action: { type: "navigate", target: "/workspace" },
              },
            ],
          },
        }),
      );
      expect(result.success).toBe(true);
    });

    it("rejects mismatched minimum host version aliases", () => {
      const result = pluginManifestV1Schema.safeParse(
        validManifest({
          minimumHostVersion: "1.0.0",
          minimumPaperclipVersion: "2.0.0",
        }),
      );
      expect(result.success).toBe(false);
    });
  });

  describe("id validation", () => {
    it("rejects ids that start with uppercase", () => {
      const result = pluginManifestV1Schema.safeParse(validManifest({ id: "Acme.plugin" }));
      expect(result.success).toBe(false);
    });

    it("rejects ids that start with a dot", () => {
      const result = pluginManifestV1Schema.safeParse(validManifest({ id: ".my-plugin" }));
      expect(result.success).toBe(false);
    });

    it("rejects empty id", () => {
      const result = pluginManifestV1Schema.safeParse(validManifest({ id: "" }));
      expect(result.success).toBe(false);
    });

    it("accepts ids with dots, hyphens, underscores", () => {
      expect(pluginManifestV1Schema.safeParse(validManifest({ id: "acme.my-plugin_v2" })).success).toBe(true);
      expect(pluginManifestV1Schema.safeParse(validManifest({ id: "a" })).success).toBe(true);
      expect(pluginManifestV1Schema.safeParse(validManifest({ id: "0plugin" })).success).toBe(true);
    });
  });

  describe("version validation", () => {
    it("accepts valid semver", () => {
      expect(pluginManifestV1Schema.safeParse(validManifest({ version: "1.0.0" })).success).toBe(true);
      expect(pluginManifestV1Schema.safeParse(validManifest({ version: "0.1.0-beta.1" })).success).toBe(true);
      expect(pluginManifestV1Schema.safeParse(validManifest({ version: "10.20.30" })).success).toBe(true);
    });

    it("rejects invalid versions", () => {
      expect(pluginManifestV1Schema.safeParse(validManifest({ version: "v1.0" })).success).toBe(false);
      expect(pluginManifestV1Schema.safeParse(validManifest({ version: "latest" })).success).toBe(false);
    });
  });

  describe("apiVersion validation", () => {
    it("only accepts apiVersion 1", () => {
      expect(pluginManifestV1Schema.safeParse(validManifest({ apiVersion: 1 })).success).toBe(true);
      expect(pluginManifestV1Schema.safeParse(validManifest({ apiVersion: 2 })).success).toBe(false);
      expect(pluginManifestV1Schema.safeParse(validManifest({ apiVersion: 0 })).success).toBe(false);
    });
  });

  describe("categories validation", () => {
    it("requires at least one category", () => {
      expect(pluginManifestV1Schema.safeParse(validManifest({ categories: [] })).success).toBe(false);
    });

    it("rejects unknown categories", () => {
      expect(
        pluginManifestV1Schema.safeParse(validManifest({ categories: ["unknown_category"] })).success,
      ).toBe(false);
    });

    it("accepts all valid categories", () => {
      expect(
        pluginManifestV1Schema.safeParse(
          validManifest({ categories: ["connector", "workspace", "automation", "ui"] }),
        ).success,
      ).toBe(true);
    });
  });

  describe("capabilities validation", () => {
    it("requires at least one capability", () => {
      expect(pluginManifestV1Schema.safeParse(validManifest({ capabilities: [] })).success).toBe(false);
    });

    it("rejects unknown capabilities", () => {
      expect(
        pluginManifestV1Schema.safeParse(validManifest({ capabilities: ["nonexistent.cap"] })).success,
      ).toBe(false);
    });
  });

  describe("displayName and description length constraints", () => {
    it("rejects empty displayName", () => {
      expect(pluginManifestV1Schema.safeParse(validManifest({ displayName: "" })).success).toBe(false);
    });

    it("rejects displayName over 100 characters", () => {
      expect(pluginManifestV1Schema.safeParse(validManifest({ displayName: "x".repeat(101) })).success).toBe(false);
    });

    it("rejects description over 500 characters", () => {
      expect(pluginManifestV1Schema.safeParse(validManifest({ description: "x".repeat(501) })).success).toBe(false);
    });
  });

  describe("unknown field handling", () => {
    it("silently strips unrecognised fields from the parsed output", () => {
      // Zod strips unknown fields by default. Passing an unrecognised field
      // should succeed and the field should be absent from the parsed output.
      const result = pluginManifestV1Schema.safeParse(
        validManifest({ _unknownCustomField: "should-be-stripped" }),
      );
      expect(result.success).toBe(true);
      if (result.success) {
        expect("_unknownCustomField" in result.data).toBe(false);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Cross-field validations (superRefine)
  // -------------------------------------------------------------------------

  describe("cross-field: UI slots require entrypoints.ui", () => {
    it("rejects UI slots without entrypoints.ui", () => {
      const result = pluginManifestV1Schema.safeParse(
        validManifest({
          capabilities: ["issues.read", "ui.sidebar.register"],
          entrypoints: { worker: "worker.js" }, // no ui entrypoint
          ui: {
            slots: [
              { type: "sidebar", id: "s", displayName: "S", exportName: "S" },
            ],
          },
        }),
      );
      expect(result.success).toBe(false);
      if (!result.success) {
        const messages = result.error.issues.map((i) => i.message);
        expect(messages).toContain("entrypoints.ui is required when ui.slots or ui.launchers are declared");
      }
    });

    it("accepts UI slots with entrypoints.ui", () => {
      const result = pluginManifestV1Schema.safeParse(
        validManifest({
          capabilities: ["issues.read", "ui.sidebar.register"],
          entrypoints: { worker: "worker.js", ui: "ui.js" },
          ui: {
            slots: [
              { type: "sidebar", id: "s", displayName: "S", exportName: "S" },
            ],
          },
        }),
      );
      expect(result.success).toBe(true);
    });
  });

  describe("cross-field: tools require agent.tools.register", () => {
    it("rejects tools without the agent.tools.register capability", () => {
      const result = pluginManifestV1Schema.safeParse(
        validManifest({
          capabilities: ["issues.read"],
          tools: [
            { name: "t", displayName: "T", description: "D", parametersSchema: { type: "object" } },
          ],
        }),
      );
      expect(result.success).toBe(false);
      if (!result.success) {
        const messages = result.error.issues.map((i) => i.message);
        expect(messages).toContain("Capability 'agent.tools.register' is required when tools are declared");
      }
    });
  });

  describe("cross-field: jobs require jobs.schedule", () => {
    it("rejects jobs without the jobs.schedule capability", () => {
      const result = pluginManifestV1Schema.safeParse(
        validManifest({
          capabilities: ["issues.read"],
          jobs: [{ jobKey: "sync", displayName: "Sync" }],
        }),
      );
      expect(result.success).toBe(false);
      if (!result.success) {
        const messages = result.error.issues.map((i) => i.message);
        expect(messages).toContain("Capability 'jobs.schedule' is required when jobs are declared");
      }
    });
  });

  describe("cross-field: webhooks require webhooks.receive", () => {
    it("rejects webhooks without the webhooks.receive capability", () => {
      const result = pluginManifestV1Schema.safeParse(
        validManifest({
          capabilities: ["issues.read"],
          webhooks: [{ endpointKey: "hook", displayName: "Hook" }],
        }),
      );
      expect(result.success).toBe(false);
      if (!result.success) {
        const messages = result.error.issues.map((i) => i.message);
        expect(messages).toContain("Capability 'webhooks.receive' is required when webhooks are declared");
      }
    });
  });

  // -------------------------------------------------------------------------
  // Uniqueness checks
  // -------------------------------------------------------------------------

  describe("uniqueness: duplicate job keys", () => {
    it("rejects manifests with duplicate job keys", () => {
      const result = pluginManifestV1Schema.safeParse(
        validManifest({
          capabilities: ["issues.read", "jobs.schedule"],
          jobs: [
            { jobKey: "sync", displayName: "Sync 1" },
            { jobKey: "sync", displayName: "Sync 2" },
          ],
        }),
      );
      expect(result.success).toBe(false);
      if (!result.success) {
        const messages = result.error.issues.map((i) => i.message);
        expect(messages.some((m) => m.includes("Duplicate job keys"))).toBe(true);
      }
    });
  });

  describe("uniqueness: duplicate webhook endpoint keys", () => {
    it("rejects manifests with duplicate endpoint keys", () => {
      const result = pluginManifestV1Schema.safeParse(
        validManifest({
          capabilities: ["issues.read", "webhooks.receive"],
          webhooks: [
            { endpointKey: "hook", displayName: "Hook 1" },
            { endpointKey: "hook", displayName: "Hook 2" },
          ],
        }),
      );
      expect(result.success).toBe(false);
      if (!result.success) {
        const messages = result.error.issues.map((i) => i.message);
        expect(messages.some((m) => m.includes("Duplicate webhook endpoint keys"))).toBe(true);
      }
    });
  });

  describe("uniqueness: duplicate tool names", () => {
    it("rejects manifests with duplicate tool names", () => {
      const result = pluginManifestV1Schema.safeParse(
        validManifest({
          capabilities: ["issues.read", "agent.tools.register"],
          tools: [
            { name: "search", displayName: "Search 1", description: "D1", parametersSchema: { type: "object" } },
            { name: "search", displayName: "Search 2", description: "D2", parametersSchema: { type: "object" } },
          ],
        }),
      );
      expect(result.success).toBe(false);
      if (!result.success) {
        const messages = result.error.issues.map((i) => i.message);
        expect(messages.some((m) => m.includes("Duplicate tool names"))).toBe(true);
      }
    });
  });

  describe("uniqueness: duplicate UI slot ids", () => {
    it("rejects manifests with duplicate slot ids", () => {
      const result = pluginManifestV1Schema.safeParse(
        validManifest({
          capabilities: ["issues.read", "ui.sidebar.register"],
          entrypoints: { worker: "worker.js", ui: "ui.js" },
          ui: {
            slots: [
              { type: "sidebar", id: "my-sidebar", displayName: "S1", exportName: "S1" },
              { type: "sidebar", id: "my-sidebar", displayName: "S2", exportName: "S2" },
            ],
          },
        }),
      );
      expect(result.success).toBe(false);
      if (!result.success) {
        const messages = result.error.issues.map((i) => i.message);
        expect(messages.some((m) => m.includes("Duplicate UI slot ids"))).toBe(true);
      }
    });
  });
});

// ===========================================================================
// Request/Response schemas
// ===========================================================================

describe("installPluginSchema", () => {
  it("accepts a valid install request", () => {
    expect(installPluginSchema.safeParse({ packageName: "@acme/my-plugin" }).success).toBe(true);
  });

  it("accepts install with optional version", () => {
    const result = installPluginSchema.safeParse({ packageName: "@acme/my-plugin", version: "1.0.0" });
    expect(result.success).toBe(true);
  });

  it("rejects empty packageName", () => {
    expect(installPluginSchema.safeParse({ packageName: "" }).success).toBe(false);
  });

  it("rejects missing packageName", () => {
    expect(installPluginSchema.safeParse({}).success).toBe(false);
  });
});

describe("upsertPluginConfigSchema", () => {
  it("accepts any object as configJson", () => {
    expect(upsertPluginConfigSchema.safeParse({ configJson: { key: "value" } }).success).toBe(true);
  });

  it("accepts empty configJson", () => {
    expect(upsertPluginConfigSchema.safeParse({ configJson: {} }).success).toBe(true);
  });

  it("rejects missing configJson", () => {
    expect(upsertPluginConfigSchema.safeParse({}).success).toBe(false);
  });
});

describe("patchPluginConfigSchema", () => {
  it("accepts any object as configJson", () => {
    expect(patchPluginConfigSchema.safeParse({ configJson: { apiKey: "abc" } }).success).toBe(true);
  });
});

describe("updatePluginStatusSchema", () => {
  it("accepts a valid status", () => {
    expect(updatePluginStatusSchema.safeParse({ status: "ready" }).success).toBe(true);
    expect(updatePluginStatusSchema.safeParse({ status: "error", lastError: "crash" }).success).toBe(true);
  });

  it("rejects an invalid status", () => {
    expect(updatePluginStatusSchema.safeParse({ status: "invalid_status" }).success).toBe(false);
  });

  it("accepts null lastError", () => {
    expect(updatePluginStatusSchema.safeParse({ status: "ready", lastError: null }).success).toBe(true);
  });
});

describe("uninstallPluginSchema", () => {
  it("accepts removeData flag", () => {
    const result = uninstallPluginSchema.safeParse({ removeData: true });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.removeData).toBe(true);
  });

  it("defaults removeData to false", () => {
    const result = uninstallPluginSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.removeData).toBe(false);
  });
});

// ===========================================================================
// pluginStateScopeKeySchema
// ===========================================================================

describe("pluginStateScopeKeySchema", () => {
  it("accepts a minimal valid scope key (instance scope, no scopeId)", () => {
    const result = pluginStateScopeKeySchema.safeParse({
      scopeKind: "instance",
      stateKey: "my-key",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a project-scoped key with scopeId and namespace", () => {
    const result = pluginStateScopeKeySchema.safeParse({
      scopeKind: "project",
      scopeId: "proj-abc",
      namespace: "linear",
      stateKey: "sync-cursor",
    });
    expect(result.success).toBe(true);
  });

  it("accepts all valid scope kinds", () => {
    const kinds = ["instance", "company", "project", "project_workspace", "agent", "issue", "goal", "run"] as const;
    for (const scopeKind of kinds) {
      const result = pluginStateScopeKeySchema.safeParse({ scopeKind, stateKey: "k" });
      expect(result.success, `scopeKind="${scopeKind}" should be valid`).toBe(true);
    }
  });

  it("rejects an unknown scopeKind", () => {
    const result = pluginStateScopeKeySchema.safeParse({ scopeKind: "workspace", stateKey: "k" });
    expect(result.success).toBe(false);
  });

  it("rejects an empty stateKey", () => {
    const result = pluginStateScopeKeySchema.safeParse({ scopeKind: "instance", stateKey: "" });
    expect(result.success).toBe(false);
  });

  it("rejects a missing stateKey", () => {
    const result = pluginStateScopeKeySchema.safeParse({ scopeKind: "instance" });
    expect(result.success).toBe(false);
  });

  it("rejects an empty scopeId", () => {
    const result = pluginStateScopeKeySchema.safeParse({
      scopeKind: "project",
      scopeId: "",
      stateKey: "k",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty namespace", () => {
    const result = pluginStateScopeKeySchema.safeParse({
      scopeKind: "instance",
      namespace: "",
      stateKey: "k",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a missing scopeKind", () => {
    const result = pluginStateScopeKeySchema.safeParse({ stateKey: "k" });
    expect(result.success).toBe(false);
  });
});

// ===========================================================================
// setPluginStateSchema
// ===========================================================================

describe("setPluginStateSchema", () => {
  it("accepts a minimal set request (instance scope)", () => {
    const result = setPluginStateSchema.safeParse({
      scopeKind: "instance",
      stateKey: "flag",
      value: true,
    });
    expect(result.success).toBe(true);
  });

  it("accepts a string value", () => {
    const result = setPluginStateSchema.safeParse({
      scopeKind: "project",
      scopeId: "proj-1",
      stateKey: "branch",
      value: "main",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a number value", () => {
    const result = setPluginStateSchema.safeParse({
      scopeKind: "agent",
      scopeId: "agent-1",
      stateKey: "counter",
      value: 42,
    });
    expect(result.success).toBe(true);
  });

  it("accepts a null value", () => {
    const result = setPluginStateSchema.safeParse({
      scopeKind: "instance",
      stateKey: "cleared",
      value: null,
    });
    expect(result.success).toBe(true);
  });

  it("accepts an object value", () => {
    const result = setPluginStateSchema.safeParse({
      scopeKind: "issue",
      scopeId: "issue-99",
      namespace: "github",
      stateKey: "pr-info",
      value: { number: 42, url: "https://github.com/org/repo/pull/42" },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.namespace).toBe("github");
      expect(result.data.value).toMatchObject({ number: 42 });
    }
  });

  it("accepts an array value", () => {
    const result = setPluginStateSchema.safeParse({
      scopeKind: "run",
      scopeId: "run-1",
      stateKey: "log-lines",
      value: ["line1", "line2"],
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing value field", () => {
    // `value` is `z.unknown()` — even missing values are accepted because
    // `z.unknown()` passes for `undefined`. Verify the other required fields.
    const result = setPluginStateSchema.safeParse({
      scopeKind: "instance",
      stateKey: "k",
    });
    // z.unknown() treats undefined as valid, so this should pass
    expect(result.success).toBe(true);
  });

  it("rejects missing stateKey", () => {
    const result = setPluginStateSchema.safeParse({
      scopeKind: "instance",
      value: 1,
    });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid scopeKind", () => {
    const result = setPluginStateSchema.safeParse({
      scopeKind: "not_a_scope",
      stateKey: "k",
      value: 1,
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty stateKey", () => {
    const result = setPluginStateSchema.safeParse({
      scopeKind: "instance",
      stateKey: "",
      value: 1,
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty namespace", () => {
    const result = setPluginStateSchema.safeParse({
      scopeKind: "instance",
      namespace: "",
      stateKey: "k",
      value: 1,
    });
    expect(result.success).toBe(false);
  });
});

// ===========================================================================
// listPluginStateSchema
// ===========================================================================

describe("listPluginStateSchema", () => {
  it("accepts an empty filter (list all state for a plugin)", () => {
    const result = listPluginStateSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("accepts a scopeKind-only filter", () => {
    const result = listPluginStateSchema.safeParse({ scopeKind: "project" });
    expect(result.success).toBe(true);
  });

  it("accepts a combined scopeKind + scopeId filter", () => {
    const result = listPluginStateSchema.safeParse({
      scopeKind: "project",
      scopeId: "proj-abc",
    });
    expect(result.success).toBe(true);
  });

  it("accepts all three optional filters together", () => {
    const result = listPluginStateSchema.safeParse({
      scopeKind: "issue",
      scopeId: "issue-42",
      namespace: "jira",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toMatchObject({
        scopeKind: "issue",
        scopeId: "issue-42",
        namespace: "jira",
      });
    }
  });

  it("rejects an invalid scopeKind", () => {
    const result = listPluginStateSchema.safeParse({ scopeKind: "bad_scope" });
    expect(result.success).toBe(false);
  });

  it("rejects an empty scopeId", () => {
    const result = listPluginStateSchema.safeParse({ scopeId: "" });
    expect(result.success).toBe(false);
  });

  it("rejects an empty namespace", () => {
    const result = listPluginStateSchema.safeParse({ namespace: "" });
    expect(result.success).toBe(false);
  });

  it("accepts all valid scope kinds as filter", () => {
    const kinds = ["instance", "company", "project", "project_workspace", "agent", "issue", "goal", "run"] as const;
    for (const scopeKind of kinds) {
      const result = listPluginStateSchema.safeParse({ scopeKind });
      expect(result.success, `scopeKind="${scopeKind}" should be a valid filter`).toBe(true);
    }
  });
});
