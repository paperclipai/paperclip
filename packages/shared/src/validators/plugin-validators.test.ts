import { describe, it, expect } from "vitest";
import {
  jsonSchemaSchema,
  pluginJobDeclarationSchema,
  pluginWebhookDeclarationSchema,
  pluginToolDeclarationSchema,
  pluginUiSlotDeclarationSchema,
} from "./plugin.js";

// ============================================================================
// jsonSchemaSchema
// ============================================================================

describe("jsonSchemaSchema", () => {
  it("accepts an empty object", () => {
    const result = jsonSchemaSchema.parse({});
    expect(result).toEqual({});
  });

  it("accepts an object with a 'type' field", () => {
    const result = jsonSchemaSchema.parse({ type: "object", properties: {} });
    expect(result.type).toBe("object");
  });

  it("accepts an object with a '$ref' field", () => {
    const result = jsonSchemaSchema.parse({ $ref: "#/definitions/Foo" });
    expect(result.$ref).toBe("#/definitions/Foo");
  });

  it("accepts a oneOf composition", () => {
    const result = jsonSchemaSchema.parse({ oneOf: [{ type: "string" }, { type: "number" }] });
    expect(result.oneOf).toBeDefined();
  });

  it("accepts anyOf composition", () => {
    const result = jsonSchemaSchema.parse({ anyOf: [{ type: "null" }] });
    expect(result.anyOf).toBeDefined();
  });

  it("accepts allOf composition", () => {
    const result = jsonSchemaSchema.parse({ allOf: [{ type: "object" }] });
    expect(result.allOf).toBeDefined();
  });

  it("rejects a non-empty object missing type/$ref/composition", () => {
    expect(() =>
      jsonSchemaSchema.parse({ description: "just a description" })
    ).toThrow(/valid JSON Schema/i);
  });
});

// ============================================================================
// pluginJobDeclarationSchema
// ============================================================================

describe("pluginJobDeclarationSchema", () => {
  it("parses a minimal job declaration", () => {
    const result = pluginJobDeclarationSchema.parse({
      jobKey: "sync",
      displayName: "Sync Job",
    });
    expect(result.jobKey).toBe("sync");
    expect(result.displayName).toBe("Sync Job");
    expect(result.schedule).toBeUndefined();
  });

  it("accepts a valid 5-field cron schedule", () => {
    const result = pluginJobDeclarationSchema.parse({
      jobKey: "hourly",
      displayName: "Hourly",
      schedule: "0 * * * *",
    });
    expect(result.schedule).toBe("0 * * * *");
  });

  it("accepts a step cron expression", () => {
    const result = pluginJobDeclarationSchema.parse({
      jobKey: "frequent",
      displayName: "Every 15 min",
      schedule: "*/15 * * * *",
    });
    expect(result.schedule).toBe("*/15 * * * *");
  });

  it("rejects a cron expression with too few fields", () => {
    expect(() =>
      pluginJobDeclarationSchema.parse({
        jobKey: "k",
        displayName: "d",
        schedule: "* * * *",
      })
    ).toThrow(/5-field cron/i);
  });

  it("rejects a cron expression with too many fields", () => {
    expect(() =>
      pluginJobDeclarationSchema.parse({
        jobKey: "k",
        displayName: "d",
        schedule: "* * * * * *",
      })
    ).toThrow(/5-field cron/i);
  });

  it("rejects empty jobKey", () => {
    expect(() =>
      pluginJobDeclarationSchema.parse({ jobKey: "", displayName: "d" })
    ).toThrow();
  });

  it("rejects empty displayName", () => {
    expect(() =>
      pluginJobDeclarationSchema.parse({ jobKey: "k", displayName: "" })
    ).toThrow();
  });
});

// ============================================================================
// pluginWebhookDeclarationSchema
// ============================================================================

describe("pluginWebhookDeclarationSchema", () => {
  it("parses a valid webhook declaration", () => {
    const result = pluginWebhookDeclarationSchema.parse({
      endpointKey: "my-hook",
      displayName: "My Webhook",
    });
    expect(result.endpointKey).toBe("my-hook");
    expect(result.displayName).toBe("My Webhook");
  });

  it("accepts optional description", () => {
    const result = pluginWebhookDeclarationSchema.parse({
      endpointKey: "k",
      displayName: "d",
      description: "handles push events",
    });
    expect(result.description).toBe("handles push events");
  });

  it("rejects empty endpointKey", () => {
    expect(() =>
      pluginWebhookDeclarationSchema.parse({ endpointKey: "", displayName: "d" })
    ).toThrow();
  });
});

// ============================================================================
// pluginToolDeclarationSchema
// ============================================================================

describe("pluginToolDeclarationSchema", () => {
  const validTool = {
    name: "search_issues",
    displayName: "Search Issues",
    description: "Search for issues",
    parametersSchema: { type: "object", properties: {} },
  };

  it("parses a valid tool declaration", () => {
    const result = pluginToolDeclarationSchema.parse(validTool);
    expect(result.name).toBe("search_issues");
  });

  it("rejects empty name", () => {
    expect(() =>
      pluginToolDeclarationSchema.parse({ ...validTool, name: "" })
    ).toThrow();
  });

  it("rejects empty description", () => {
    expect(() =>
      pluginToolDeclarationSchema.parse({ ...validTool, description: "" })
    ).toThrow();
  });

  it("rejects invalid parametersSchema", () => {
    expect(() =>
      pluginToolDeclarationSchema.parse({ ...validTool, parametersSchema: { label: "not valid" } })
    ).toThrow(/valid JSON Schema/i);
  });

  it("accepts empty parametersSchema ({})", () => {
    const result = pluginToolDeclarationSchema.parse({ ...validTool, parametersSchema: {} });
    expect(result.parametersSchema).toEqual({});
  });
});

// ============================================================================
// pluginUiSlotDeclarationSchema — superRefine cross-field validation
// ============================================================================

describe("pluginUiSlotDeclarationSchema", () => {
  it("parses a page slot without entityTypes", () => {
    const result = pluginUiSlotDeclarationSchema.parse({
      type: "page",
      id: "my-page",
      displayName: "My Page",
      exportName: "MyPage",
    });
    expect(result.type).toBe("page");
  });

  it("accepts a detailTab slot with entityTypes", () => {
    const result = pluginUiSlotDeclarationSchema.parse({
      type: "detailTab",
      id: "issue-tab",
      displayName: "Issue Tab",
      exportName: "IssueTab",
      entityTypes: ["issue"],
    });
    expect(result.entityTypes).toEqual(["issue"]);
  });

  it("rejects detailTab without entityTypes", () => {
    expect(() =>
      pluginUiSlotDeclarationSchema.parse({
        type: "detailTab",
        id: "tab",
        displayName: "Tab",
        exportName: "Tab",
      })
    ).toThrow(/entityType/i);
  });

  it("rejects projectSidebarItem without entityType 'project'", () => {
    expect(() =>
      pluginUiSlotDeclarationSchema.parse({
        type: "projectSidebarItem",
        id: "sidebar",
        displayName: "Sidebar",
        exportName: "Sidebar",
        entityTypes: ["issue"],
      })
    ).toThrow(/project/i);
  });

  it("accepts projectSidebarItem with entityType 'project'", () => {
    const result = pluginUiSlotDeclarationSchema.parse({
      type: "projectSidebarItem",
      id: "sidebar",
      displayName: "Sidebar",
      exportName: "Sidebar",
      entityTypes: ["project"],
    });
    expect(result.entityTypes).toContain("project");
  });

  it("rejects commentAnnotation without entityType 'comment'", () => {
    expect(() =>
      pluginUiSlotDeclarationSchema.parse({
        type: "commentAnnotation",
        id: "ann",
        displayName: "Annotation",
        exportName: "Ann",
        entityTypes: ["issue"],
      })
    ).toThrow(/comment/i);
  });

  it("accepts routePath as a valid lowercase slug", () => {
    const result = pluginUiSlotDeclarationSchema.parse({
      type: "page",
      id: "p",
      displayName: "Page",
      exportName: "Page",
      routePath: "my-route",
    });
    expect(result.routePath).toBe("my-route");
  });

  it("rejects routePath starting with hyphen", () => {
    expect(() =>
      pluginUiSlotDeclarationSchema.parse({
        type: "page",
        id: "p",
        displayName: "Page",
        exportName: "Page",
        routePath: "-bad",
      })
    ).toThrow();
  });

  it("rejects routePath with uppercase letters", () => {
    expect(() =>
      pluginUiSlotDeclarationSchema.parse({
        type: "page",
        id: "p",
        displayName: "Page",
        exportName: "Page",
        routePath: "MyRoute",
      })
    ).toThrow();
  });
});
