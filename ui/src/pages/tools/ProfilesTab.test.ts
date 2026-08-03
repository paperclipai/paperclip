// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import type {
  ToolCatalogEntry,
  ToolProfileEntry,
  ToolProfileWithDetails,
} from "@paperclipai/shared";
import { resolveAllowList } from "./ProfilesTab";

function tool(partial: Partial<ToolCatalogEntry> & { id: string; toolName: string }): ToolCatalogEntry {
  return {
    companyId: "c1",
    applicationId: "app-slack",
    connectionId: "conn-1",
    entryKind: "tool",
    title: null,
    description: null,
    inputSchema: null,
    outputSchema: null,
    annotations: null,
    riskLevel: "read",
    isReadOnly: true,
    isWrite: false,
    isDestructive: false,
    status: "active",
    version: null,
    schemaHash: null,
    firstSeenAt: new Date(),
    lastSeenAt: new Date(),
    reviewedAt: null,
    reviewedByAgentId: null,
    reviewedByUserId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...partial,
  } as ToolCatalogEntry;
}

function entry(partial: Partial<ToolProfileEntry> & Pick<ToolProfileEntry, "selectorType">): ToolProfileEntry {
  return {
    id: `e-${Math.round(Math.random() * 1e9)}`,
    companyId: "c1",
    profileId: "p1",
    effect: "include",
    applicationId: null,
    connectionId: null,
    catalogEntryId: null,
    toolName: null,
    riskLevel: null,
    conditions: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...partial,
  } as ToolProfileEntry;
}

function profile(partial: Partial<ToolProfileWithDetails>): ToolProfileWithDetails {
  return {
    id: "p1",
    companyId: "c1",
    profileKey: "k",
    name: "Profile",
    description: null,
    status: "active",
    defaultAction: "deny",
    newToolsReviewedAt: null,
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    entries: [],
    bindings: [],
    summary: {
      accessMode: "selected",
      allowedToolCount: 0,
      allowedApplicationCount: 0,
      excludedToolCount: 0,
      totalToolCount: 0,
      assignmentCount: 0,
      appliesToAgentCount: 0,
      isCompanyDefault: false,
    },
    ...partial,
  };
}

const appsById = new Map([["app-slack", "Slack"]]);
const connsById = new Map([["conn-1", "Slack prod"]]);

const catalog: ToolCatalogEntry[] = [
  tool({ id: "t-list-channels", toolName: "slack.list_channels", riskLevel: "read" }),
  tool({ id: "t-list-users", toolName: "slack.list_users", riskLevel: "read" }),
  tool({
    id: "t-post",
    toolName: "slack.post_message",
    riskLevel: "medium",
    isReadOnly: false,
    isWrite: true,
  }),
];

describe("resolveAllowList", () => {
  it("marks an exact tool_name include as explicit", () => {
    const rows = resolveAllowList(
      profile({ entries: [entry({ selectorType: "tool_name", toolName: "slack.post_message" })] }),
      catalog,
      appsById,
      connsById,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].toolName).toBe("slack.post_message");
    expect(rows[0].source).toEqual({ kind: "explicit" });
    expect(rows[0].applicationName).toBe("Slack");
    expect(rows[0].isWrite).toBe(true);
  });

  it("flags wildcard tool_name matches as a pattern source", () => {
    const rows = resolveAllowList(
      profile({ entries: [entry({ selectorType: "tool_name", toolName: "slack.list_*" })] }),
      catalog,
      appsById,
      connsById,
    );
    const names = rows.map((r) => r.toolName).sort();
    expect(names).toEqual(["slack.list_channels", "slack.list_users"]);
    expect(rows.every((r) => r.source.kind === "pattern" && r.source.label === "slack.list_*")).toBe(true);
  });

  it("labels application selectors as pattern app:<name>", () => {
    const rows = resolveAllowList(
      profile({ entries: [entry({ selectorType: "application", applicationId: "app-slack" })] }),
      catalog,
      appsById,
      connsById,
    );
    expect(rows).toHaveLength(3);
    expect(rows[0].source).toEqual({ kind: "pattern", label: "app:Slack" });
  });

  it("prefers an explicit grant over an overlapping pattern", () => {
    const rows = resolveAllowList(
      profile({
        entries: [
          entry({ selectorType: "application", applicationId: "app-slack" }),
          entry({ selectorType: "tool_name", toolName: "slack.post_message" }),
        ],
      }),
      catalog,
      appsById,
      connsById,
    );
    const post = rows.find((r) => r.toolName === "slack.post_message");
    expect(post?.source).toEqual({ kind: "explicit" });
  });

  it("removes excluded tools even when a pattern would include them", () => {
    const rows = resolveAllowList(
      profile({
        entries: [
          entry({ selectorType: "application", applicationId: "app-slack" }),
          entry({ selectorType: "tool_name", toolName: "slack.post_message", effect: "exclude" }),
        ],
      }),
      catalog,
      appsById,
      connsById,
    );
    expect(rows.find((r) => r.toolName === "slack.post_message")).toBeUndefined();
    expect(rows).toHaveLength(2);
  });

  it("includes the whole catalog by default when defaultAction is allow", () => {
    const rows = resolveAllowList(
      profile({ defaultAction: "allow" }),
      catalog,
      appsById,
      connsById,
    );
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.source.kind === "default")).toBe(true);
  });

  it("keeps an explicit grant visible even when the catalog has no match", () => {
    const rows = resolveAllowList(
      profile({ entries: [entry({ selectorType: "tool_name", toolName: "github.create_pr" })] }),
      catalog,
      appsById,
      connsById,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].toolName).toBe("github.create_pr");
    expect(rows[0].source).toEqual({ kind: "explicit" });
    expect(rows[0].risk).toBeNull();
  });
});
