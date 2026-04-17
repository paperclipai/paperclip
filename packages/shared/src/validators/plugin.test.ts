import { describe, it, expect } from "vitest";
import {
  jsonSchemaSchema,
  pluginJobDeclarationSchema,
  pluginWebhookDeclarationSchema,
  pluginToolDeclarationSchema,
  pluginUiSlotDeclarationSchema,
  installPluginSchema,
  upsertPluginConfigSchema,
} from "./plugin.js";

// ---------------------------------------------------------------------------
// jsonSchemaSchema
// ---------------------------------------------------------------------------

describe("jsonSchemaSchema", () => {
  it("accepts an empty object (no fields required)", () => {
    expect(jsonSchemaSchema.safeParse({}).success).toBe(true);
  });

  it("accepts an object with a 'type' field", () => {
    expect(jsonSchemaSchema.safeParse({ type: "object", properties: {} }).success).toBe(true);
  });

  it("accepts an object with a '$ref' field", () => {
    expect(jsonSchemaSchema.safeParse({ $ref: "#/definitions/Foo" }).success).toBe(true);
  });

  it("accepts an object with an 'oneOf' field", () => {
    expect(jsonSchemaSchema.safeParse({ oneOf: [{ type: "string" }] }).success).toBe(true);
  });

  it("accepts an object with an 'anyOf' field", () => {
    expect(jsonSchemaSchema.safeParse({ anyOf: [{ type: "string" }] }).success).toBe(true);
  });

  it("accepts an object with an 'allOf' field", () => {
    expect(jsonSchemaSchema.safeParse({ allOf: [{ type: "object" }] }).success).toBe(true);
  });

  it("rejects a non-empty object missing type/$ref/composition keywords", () => {
    expect(jsonSchemaSchema.safeParse({ description: "just a description" }).success).toBe(false);
  });

  it("rejects a non-object value (string)", () => {
    expect(jsonSchemaSchema.safeParse("not-an-object").success).toBe(false);
  });

  it("rejects an array", () => {
    expect(jsonSchemaSchema.safeParse([]).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// pluginJobDeclarationSchema
// ---------------------------------------------------------------------------

describe("pluginJobDeclarationSchema", () => {
  it("accepts a minimal valid job declaration (no schedule)", () => {
    const result = pluginJobDeclarationSchema.safeParse({
      jobKey: "daily-sync",
      displayName: "Daily Sync",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a job with a valid cron schedule", () => {
    const result = pluginJobDeclarationSchema.safeParse({
      jobKey: "hourly",
      displayName: "Hourly Job",
      schedule: "0 * * * *",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a job with a wildcard schedule", () => {
    const result = pluginJobDeclarationSchema.safeParse({
      jobKey: "minutely",
      displayName: "Minutely",
      schedule: "* * * * *",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a job with an invalid cron schedule", () => {
    const result = pluginJobDeclarationSchema.safeParse({
      jobKey: "bad",
      displayName: "Bad Job",
      schedule: "not-a-cron",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a job with an empty jobKey", () => {
    const result = pluginJobDeclarationSchema.safeParse({
      jobKey: "",
      displayName: "Job",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a job with an empty displayName", () => {
    const result = pluginJobDeclarationSchema.safeParse({
      jobKey: "my-job",
      displayName: "",
    });
    expect(result.success).toBe(false);
  });

  it("accepts a description field", () => {
    const result = pluginJobDeclarationSchema.safeParse({
      jobKey: "my-job",
      displayName: "My Job",
      description: "Does something",
    });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// pluginWebhookDeclarationSchema
// ---------------------------------------------------------------------------

describe("pluginWebhookDeclarationSchema", () => {
  it("accepts a minimal valid webhook declaration", () => {
    const result = pluginWebhookDeclarationSchema.safeParse({
      endpointKey: "push",
      displayName: "Push Event",
    });
    expect(result.success).toBe(true);
  });

  it("accepts an optional description", () => {
    const result = pluginWebhookDeclarationSchema.safeParse({
      endpointKey: "push",
      displayName: "Push Event",
      description: "Fired on push",
    });
    expect(result.success).toBe(true);
  });

  it("rejects an empty endpointKey", () => {
    const result = pluginWebhookDeclarationSchema.safeParse({
      endpointKey: "",
      displayName: "Push Event",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty displayName", () => {
    const result = pluginWebhookDeclarationSchema.safeParse({
      endpointKey: "push",
      displayName: "",
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// pluginToolDeclarationSchema
// ---------------------------------------------------------------------------

describe("pluginToolDeclarationSchema", () => {
  const VALID_TOOL = {
    name: "search_issues",
    displayName: "Search Issues",
    description: "Search for issues by query",
    parametersSchema: { type: "object", properties: {} },
  };

  it("accepts a valid tool declaration", () => {
    expect(pluginToolDeclarationSchema.safeParse(VALID_TOOL).success).toBe(true);
  });

  it("rejects when name is empty", () => {
    expect(pluginToolDeclarationSchema.safeParse({ ...VALID_TOOL, name: "" }).success).toBe(false);
  });

  it("rejects when displayName is empty", () => {
    expect(pluginToolDeclarationSchema.safeParse({ ...VALID_TOOL, displayName: "" }).success).toBe(false);
  });

  it("rejects when description is empty", () => {
    expect(pluginToolDeclarationSchema.safeParse({ ...VALID_TOOL, description: "" }).success).toBe(false);
  });

  it("rejects when parametersSchema is a string (not an object)", () => {
    expect(
      pluginToolDeclarationSchema.safeParse({ ...VALID_TOOL, parametersSchema: "string" }).success,
    ).toBe(false);
  });

  it("rejects when parametersSchema is missing type/$ref/composition (non-empty)", () => {
    expect(
      pluginToolDeclarationSchema.safeParse({
        ...VALID_TOOL,
        parametersSchema: { description: "no type" },
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// pluginUiSlotDeclarationSchema
// ---------------------------------------------------------------------------

describe("pluginUiSlotDeclarationSchema", () => {
  const VALID_SIDEBAR_SLOT = {
    type: "sidebar",
    id: "my-sidebar",
    displayName: "My Sidebar",
    exportName: "MySidebar",
  };

  const VALID_DETAIL_TAB_SLOT = {
    type: "detailTab",
    id: "my-tab",
    displayName: "My Tab",
    exportName: "MyTab",
    entityTypes: ["issue"],
  };

  it("accepts a valid sidebar slot", () => {
    expect(pluginUiSlotDeclarationSchema.safeParse(VALID_SIDEBAR_SLOT).success).toBe(true);
  });

  it("accepts a valid detailTab slot with entityTypes", () => {
    expect(pluginUiSlotDeclarationSchema.safeParse(VALID_DETAIL_TAB_SLOT).success).toBe(true);
  });

  it("rejects a detailTab slot without entityTypes", () => {
    const { entityTypes: _, ...withoutEntityTypes } = VALID_DETAIL_TAB_SLOT;
    expect(pluginUiSlotDeclarationSchema.safeParse(withoutEntityTypes).success).toBe(false);
  });

  it("rejects a contextMenuItem slot without entityTypes", () => {
    const result = pluginUiSlotDeclarationSchema.safeParse({
      type: "contextMenuItem",
      id: "my-menu",
      displayName: "My Menu",
      exportName: "MyMenu",
    });
    expect(result.success).toBe(false);
  });

  it("accepts a page slot with a valid routePath", () => {
    const result = pluginUiSlotDeclarationSchema.safeParse({
      type: "page",
      id: "my-page",
      displayName: "My Page",
      exportName: "MyPage",
      routePath: "my-page",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a sidebar slot with a routePath (not supported)", () => {
    const result = pluginUiSlotDeclarationSchema.safeParse({
      ...VALID_SIDEBAR_SLOT,
      routePath: "some-path",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a page slot with an invalid routePath (uppercase)", () => {
    const result = pluginUiSlotDeclarationSchema.safeParse({
      type: "page",
      id: "my-page",
      displayName: "My Page",
      exportName: "MyPage",
      routePath: "MyPage",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a projectSidebarItem slot without entityTypes including 'project'", () => {
    const result = pluginUiSlotDeclarationSchema.safeParse({
      type: "projectSidebarItem",
      id: "proj-item",
      displayName: "Proj Item",
      exportName: "ProjItem",
      entityTypes: ["issue"], // missing 'project'
    });
    expect(result.success).toBe(false);
  });

  it("accepts a projectSidebarItem slot with entityTypes including 'project'", () => {
    const result = pluginUiSlotDeclarationSchema.safeParse({
      type: "projectSidebarItem",
      id: "proj-item",
      displayName: "Proj Item",
      exportName: "ProjItem",
      entityTypes: ["project"],
    });
    expect(result.success).toBe(true);
  });

  it("rejects a commentAnnotation slot without entityTypes including 'comment'", () => {
    const result = pluginUiSlotDeclarationSchema.safeParse({
      type: "commentAnnotation",
      id: "annotation",
      displayName: "Annotation",
      exportName: "Annotation",
      entityTypes: ["issue"], // missing 'comment'
    });
    expect(result.success).toBe(false);
  });

  it("accepts a commentAnnotation slot with entityTypes including 'comment'", () => {
    const result = pluginUiSlotDeclarationSchema.safeParse({
      type: "commentAnnotation",
      id: "annotation",
      displayName: "Annotation",
      exportName: "Annotation",
      entityTypes: ["comment"],
    });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// installPluginSchema
// ---------------------------------------------------------------------------

describe("installPluginSchema", () => {
  it("accepts a minimal install request with just packageName", () => {
    expect(installPluginSchema.safeParse({ packageName: "my-plugin" }).success).toBe(true);
  });

  it("accepts an install request with an optional version", () => {
    expect(installPluginSchema.safeParse({ packageName: "my-plugin", version: "1.0.0" }).success).toBe(true);
  });

  it("accepts an install request with a packagePath", () => {
    expect(installPluginSchema.safeParse({ packageName: "my-plugin", packagePath: "/path/to/pkg" }).success).toBe(true);
  });

  it("rejects an empty packageName", () => {
    expect(installPluginSchema.safeParse({ packageName: "" }).success).toBe(false);
  });

  it("rejects a missing packageName", () => {
    expect(installPluginSchema.safeParse({}).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// upsertPluginConfigSchema
// ---------------------------------------------------------------------------

describe("upsertPluginConfigSchema", () => {
  it("accepts a config with an empty configJson object", () => {
    expect(upsertPluginConfigSchema.safeParse({ configJson: {} }).success).toBe(true);
  });

  it("accepts a config with arbitrary key-value pairs in configJson", () => {
    expect(
      upsertPluginConfigSchema.safeParse({ configJson: { key: "value", num: 42 } }).success,
    ).toBe(true);
  });

  it("rejects when configJson is missing", () => {
    expect(upsertPluginConfigSchema.safeParse({}).success).toBe(false);
  });

  it("rejects when configJson is not an object", () => {
    expect(upsertPluginConfigSchema.safeParse({ configJson: "not-an-object" }).success).toBe(false);
  });

  it("rejects when configJson is an array", () => {
    expect(upsertPluginConfigSchema.safeParse({ configJson: [] }).success).toBe(false);
  });
});
