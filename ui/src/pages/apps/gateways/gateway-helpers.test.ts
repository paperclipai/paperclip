import type {
  ToolApplication,
  ToolConnection,
  ToolMcpGatewayClientSnippet,
  ToolMcpGatewayToken,
  ToolMcpGatewayWithTokens,
  ToolProfileWithDetails,
} from "@paperclipai/shared";
import { describe, expect, it } from "vitest";
import {
  activeTokenCount,
  deriveGatewayApps,
  expiringTokenCount,
  formatScope,
  isGatewayOn,
  maskedTokenLabel,
  orderedSnippets,
  tokenStatus,
} from "./gateway-helpers";

const NOW = new Date("2026-06-16T12:00:00.000Z").getTime();

function token(overrides: Partial<ToolMcpGatewayToken> = {}): ToolMcpGatewayToken {
  return {
    id: "t",
    companyId: "c",
    gatewayId: "g",
    name: "tok",
    tokenPrefix: "pcgw_abc",
    subjectType: "gateway_client",
    subjectId: null,
    clientLabel: "Cursor",
    ownerNote: "",
    allowedActions: ["tools/list", "tools/call"],
    expiresAt: null,
    expiryOverrideReason: null,
    expiryOverrideByUserId: null,
    expiryOverrideByAgentId: null,
    expiryOverrideAt: null,
    lastUsedAt: null,
    revokedAt: null,
    createdByAgentId: null,
    createdByUserId: "u",
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}

function gateway(overrides: Partial<ToolMcpGatewayWithTokens> = {}): ToolMcpGatewayWithTokens {
  return {
    id: "gateway-1",
    companyId: "c",
    gatewayPublicId: "gw",
    name: "CTO agents",
    displaySlug: "cto-agents",
    slug: "cto-agents",
    description: null,
    status: "active",
    profileId: "profile-1",
    defaultProfileMode: "gateway_only",
    contextScopeType: "none",
    contextScopeId: null,
    agentId: null,
    projectId: null,
    issueId: null,
    approvalIssueId: null,
    endpointPath: "/g/cto-agents/mcp",
    authConfig: {} as ToolMcpGatewayWithTokens["authConfig"],
    headerPolicy: {} as ToolMcpGatewayWithTokens["headerPolicy"],
    metadataPolicy: {} as ToolMcpGatewayWithTokens["metadataPolicy"],
    onDemandToolsConfig: {} as ToolMcpGatewayWithTokens["onDemandToolsConfig"],
    metadata: null,
    createdByAgentId: null,
    createdByUserId: "u",
    archivedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    tokens: [],
    clientSnippets: [],
    ...overrides,
  };
}

describe("tokenStatus", () => {
  it("classifies revoked, expired, expiring, and active", () => {
    expect(tokenStatus(token({ revokedAt: "2026-06-10T00:00:00.000Z" }), NOW)).toBe("revoked");
    expect(tokenStatus(token({ expiresAt: "2026-06-01T00:00:00.000Z" }), NOW)).toBe("expired");
    expect(tokenStatus(token({ expiresAt: "2026-06-20T00:00:00.000Z" }), NOW)).toBe("expiring");
    expect(tokenStatus(token({ expiresAt: "2026-12-01T00:00:00.000Z" }), NOW)).toBe("active");
    expect(tokenStatus(token({ expiresAt: null }), NOW)).toBe("active");
  });
});

describe("token counts", () => {
  it("counts active (incl. expiring) but not revoked/expired", () => {
    const g = gateway({
      tokens: [
        token({ id: "a", expiresAt: "2026-12-01T00:00:00.000Z" }),
        token({ id: "b", expiresAt: "2026-06-20T00:00:00.000Z" }),
        token({ id: "c", revokedAt: "2026-06-10T00:00:00.000Z" }),
        token({ id: "d", expiresAt: "2026-06-01T00:00:00.000Z" }),
      ],
    });
    expect(activeTokenCount(g, NOW)).toBe(2);
    expect(expiringTokenCount(g, NOW)).toBe(1);
  });
});

describe("maskedTokenLabel", () => {
  it("never reveals the full value — only prefix plus dots", () => {
    expect(maskedTokenLabel({ tokenPrefix: "pcgw_live_8x4Pa" })).toBe("pcgw_live_8x4Pa•••");
  });
});

describe("isGatewayOn", () => {
  it("is on only when status is active", () => {
    expect(isGatewayOn(gateway({ status: "active" }))).toBe(true);
    expect(isGatewayOn(gateway({ status: "disabled" }))).toBe(false);
  });
});

describe("formatScope", () => {
  it("labels company, project, and agent scopes", () => {
    expect(formatScope(gateway(), new Map(), new Map())).toBe("Company");
    expect(
      formatScope(
        gateway({ contextScopeType: "project", contextScopeId: "p1" }),
        new Map([["p1", "Support"]]),
        new Map(),
      ),
    ).toBe("Project · Support");
  });
});

describe("orderedSnippets", () => {
  it("orders clients cursor → claude_desktop → vscode → claude_code → opencode", () => {
    const snippets: ToolMcpGatewayClientSnippet[] = [
      { client: "opencode", label: "OpenCode", config: {}, notes: [] },
      { client: "cursor", label: "Cursor", config: {}, notes: [] },
      { client: "vscode", label: "VS Code", config: {}, notes: [] },
    ];
    expect(orderedSnippets(snippets).map((s) => s.client)).toEqual(["cursor", "vscode", "opencode"]);
  });
});

describe("deriveGatewayApps", () => {
  const profile: ToolProfileWithDetails = {
    id: "profile-1",
    companyId: "c",
    profileKey: "eng",
    name: "Engineering",
    description: null,
    status: "active",
    defaultAction: "deny",
    newToolsReviewedAt: null,
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    bindings: [],
    summary: {
      accessMode: "selected",
      allowedToolCount: 3,
      allowedApplicationCount: 2,
      excludedToolCount: 0,
      totalToolCount: 3,
      assignmentCount: 0,
      appliesToAgentCount: 0,
      isCompanyDefault: false,
    },
    entries: [
      { effect: "include", applicationId: "app-gh", catalogEntryId: "ce-1" },
      { effect: "include", applicationId: "app-gh", catalogEntryId: "ce-2" },
      { effect: "include", connectionId: "conn-sheets", catalogEntryId: "ce-3" },
      { effect: "exclude", applicationId: "app-linear", catalogEntryId: "ce-4" },
    ] as unknown as ToolProfileWithDetails["entries"],
  };

  const applications = [
    { id: "app-gh", name: "GitHub", status: "active" },
    { id: "app-sheets", name: "Sheets", status: "active" },
  ] as unknown as ToolApplication[];

  const connections = [
    { id: "conn-gh", applicationId: "app-gh", name: "GitHub", healthStatus: "healthy" },
    { id: "conn-sheets", applicationId: "app-sheets", name: "Sheets", healthStatus: "missing_secret" },
  ] as unknown as ToolConnection[];

  it("lists included apps with tool counts and surfaces attention health", () => {
    const rows = deriveGatewayApps(profile, applications, connections);
    expect(rows.map((r) => r.application.id)).toEqual(["app-gh", "app-sheets"]);
    const gh = rows.find((r) => r.application.id === "app-gh")!;
    expect(gh.toolCount).toBe(2);
    expect(gh.needsAttention).toBe(false);
    const sheets = rows.find((r) => r.application.id === "app-sheets")!;
    expect(sheets.toolCount).toBe(1);
    expect(sheets.needsAttention).toBe(true);
  });

  it("prefers a live connection over an archived connection", () => {
    const rows = deriveGatewayApps(profile, applications, [
      { ...connections[0], id: "conn-gh-archived", status: "archived" },
      { ...connections[0], id: "conn-gh-active", status: "active" },
      connections[1],
    ] as ToolConnection[]);

    expect(rows.find((row) => row.application.id === "app-gh")?.connection?.id).toBe(
      "conn-gh-active",
    );
  });

  it("returns nothing without a profile", () => {
    expect(deriveGatewayApps(undefined, applications, connections)).toEqual([]);
  });
});
