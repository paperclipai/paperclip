import { describe, expect, it } from "vitest";
import manifest from "../src/manifest.js";
import { PLUGIN_ID, PLUGIN_VERSION, TOOL_NAMES, DATA_KEYS, DEFAULT_CONFIG } from "../src/constants.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe("constants", () => {
  it("defines expected plugin identity", () => {
    expect(PLUGIN_ID).toBe("paperclip-sentry");
    expect(PLUGIN_VERSION).toBe("0.1.0");
  });

  it("defines all tool names", () => {
    expect(TOOL_NAMES.listIssues).toBe("sentry.list-issues");
    expect(TOOL_NAMES.getIssue).toBe("sentry.get-issue");
    expect(TOOL_NAMES.search).toBe("sentry.search");
  });

  it("defines all data keys", () => {
    expect(DATA_KEYS.overview).toBe("overview");
    expect(DATA_KEYS.issueDetail).toBe("issue-detail");
  });

  it("provides sensible default config", () => {
    expect(DEFAULT_CONFIG.authToken).toBe("");
    expect(DEFAULT_CONFIG.organizationSlug).toBe("");
    expect(DEFAULT_CONFIG.sentryBaseUrl).toBe("https://sentry.io");
  });
});

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

describe("manifest", () => {
  it("has correct id and version", () => {
    expect(manifest.id).toBe(PLUGIN_ID);
    expect(manifest.version).toBe(PLUGIN_VERSION);
  });

  it("declares required capabilities", () => {
    expect(manifest.capabilities).toContain("http.outbound");
    expect(manifest.capabilities).toContain("agent.tools.register");
  });

  it("declares all three tools", () => {
    const toolNames = manifest.tools!.map((t) => t.name);
    expect(toolNames).toContain(TOOL_NAMES.listIssues);
    expect(toolNames).toContain(TOOL_NAMES.getIssue);
    expect(toolNames).toContain(TOOL_NAMES.search);
  });

  it("requires issueId on getIssue tool", () => {
    const getIssueTool = manifest.tools!.find((t) => t.name === TOOL_NAMES.getIssue);
    expect(getIssueTool).toBeDefined();
    expect(getIssueTool!.parametersSchema.required).toContain("issueId");
  });

  it("requires query on search tool", () => {
    const searchTool = manifest.tools!.find((t) => t.name === TOOL_NAMES.search);
    expect(searchTool).toBeDefined();
    expect(searchTool!.parametersSchema.required).toContain("query");
  });

  it("declares config schema with required fields", () => {
    expect(manifest.instanceConfigSchema!.required).toContain("authToken");
    expect(manifest.instanceConfigSchema!.required).toContain("organizationSlug");
  });

  it("declares UI slots for page, settings, dashboard, and sidebar", () => {
    const slotTypes = manifest.ui!.slots.map((s) => s.type);
    expect(slotTypes).toContain("page");
    expect(slotTypes).toContain("settingsPage");
    expect(slotTypes).toContain("dashboardWidget");
    expect(slotTypes).toContain("sidebar");
  });

  it("uses org-scoped API path pattern in tool descriptions", () => {
    // Verify the getIssue tool description mentions detail retrieval
    // (this guards against the PAP-148 regression where org scope was missing)
    const getIssueTool = manifest.tools!.find((t) => t.name === TOOL_NAMES.getIssue);
    expect(getIssueTool!.description).toContain("stacktrace");
  });

  it("supports self-hosted Sentry via sentryBaseUrl config", () => {
    const props = manifest.instanceConfigSchema!.properties as Record<string, { type: string }>;
    expect(props.sentryBaseUrl).toBeDefined();
    expect(props.sentryBaseUrl.type).toBe("string");
  });

  it("lists sort options for listIssues tool", () => {
    const listTool = manifest.tools!.find((t) => t.name === TOOL_NAMES.listIssues);
    const sortProp = (listTool!.parametersSchema.properties as Record<string, { enum?: string[] }>).sort;
    expect(sortProp.enum).toEqual(["date", "new", "freq", "priority"]);
  });

  it("lists level options for search tool", () => {
    const searchTool = manifest.tools!.find((t) => t.name === TOOL_NAMES.search);
    const levelProp = (searchTool!.parametersSchema.properties as Record<string, { enum?: string[] }>).level;
    expect(levelProp.enum).toEqual(["fatal", "error", "warning", "info", "debug"]);
  });
});
