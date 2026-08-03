// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { ToolMcpGatewayToken, ToolMcpGatewayWithTokens, ToolProfileWithDetails } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewaysTab } from "./GatewaysTab";
import { RelativeTime } from "./shared";

const listGatewaysMock = vi.hoisted(() => vi.fn());
const listProfilesMock = vi.hoisted(() => vi.fn());
const listAgentsMock = vi.hoisted(() => vi.fn());
const listProjectsMock = vi.hoisted(() => vi.fn());
const pushToastMock = vi.hoisted(() => vi.fn());

vi.mock("@/api/tools", () => ({
  toolsApi: {
    listGateways: (companyId: string) => listGatewaysMock(companyId),
    listProfiles: (companyId: string) => listProfilesMock(companyId),
    createGateway: vi.fn(),
    createGatewayToken: vi.fn(),
    revokeGatewayToken: vi.fn(),
  },
}));

vi.mock("@/api/agents", () => ({
  agentsApi: {
    list: (companyId: string) => listAgentsMock(companyId),
  },
}));

vi.mock("@/api/projects", () => ({
  projectsApi: {
    list: (companyId: string) => listProjectsMock(companyId),
  },
}));

vi.mock("@/context/ToastContext", () => ({
  useToast: () => ({ pushToast: pushToastMock }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

async function flushReact() {
  for (let i = 0; i < 3; i += 1) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  }
}

function profile(overrides: Partial<ToolProfileWithDetails> = {}): ToolProfileWithDetails {
  return {
    id: "profile-1",
    companyId: "company-1",
    profileKey: "engineering",
    name: "Engineering",
    description: null,
    status: "active",
    defaultAction: "deny",
    newToolsReviewedAt: null,
    metadata: null,
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    entries: [],
    bindings: [],
    summary: {
      accessMode: "selected",
      allowedToolCount: 2,
      allowedApplicationCount: 1,
      excludedToolCount: 0,
      totalToolCount: 5,
      assignmentCount: 1,
      appliesToAgentCount: 0,
      isCompanyDefault: false,
    },
    ...overrides,
  };
}

function token(overrides: Partial<ToolMcpGatewayToken> = {}): ToolMcpGatewayToken {
  return {
    id: "token-1",
    companyId: "company-1",
    gatewayId: "gateway-1",
    name: "Token",
    tokenPrefix: "pcgw_token",
    subjectType: "gateway_client",
    subjectId: null,
    clientLabel: "Cursor",
    ownerNote: "Local IDE",
    allowedActions: ["tools/list", "tools/call"],
    expiresAt: "2026-06-18T12:00:00.000Z",
    expiryOverrideReason: null,
    expiryOverrideByUserId: null,
    expiryOverrideByAgentId: null,
    expiryOverrideAt: null,
    lastUsedAt: null,
    revokedAt: null,
    createdByAgentId: null,
    createdByUserId: "user-1",
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}

function gateway(overrides: Partial<ToolMcpGatewayWithTokens> = {}): ToolMcpGatewayWithTokens {
  return {
    id: "gateway-1",
    companyId: "company-1",
    gatewayPublicId: "gw_public",
    name: "Dotta's MacBook",
    displaySlug: "dottas-macbook",
    slug: "dottas-macbook",
    description: null,
    status: "active",
    profileId: "profile-1",
    defaultProfileMode: "gateway_only",
    contextScopeType: "company",
    contextScopeId: null,
    agentId: null,
    projectId: null,
    issueId: null,
    approvalIssueId: null,
    endpointPath: "/api/tool-gateway/gateways/gateway-1/mcp",
    authConfig: {
      version: 1,
      bearer: {
        enabled: true,
        tokenPrefix: "pcgw",
        defaultTtlSeconds: 7776000,
        requireFiniteExpiry: true,
        longLivedTokenRequiresOverride: true,
      },
      oauth: {
        enabled: false,
        reservedFor: "v1_5",
        dynamicClientRegistration: false,
        authorizationCodePkce: false,
      },
    },
    headerPolicy: {
      version: 1,
      callerPassthrough: { enabled: false, allowedHeaders: [] },
      staticHeaders: [],
      generatedMetadata: { enabled: false, allowedHeaders: [] },
      responseHeaders: { forwardMcpRequiredHeaders: true, forwardSafeCacheHeaders: true },
    },
    metadataPolicy: {
      version: 1,
      forwardCompanyId: false,
      forwardGatewayId: false,
      forwardProjectId: false,
      forwardIssueId: false,
      forwardAgentId: false,
      forwardRunId: false,
      forwardCorrelationId: true,
    },
    onDemandToolsConfig: {
      enabled: false,
      searchToolName: "search_tools",
      runToolName: "run_tool",
    },
    metadata: null,
    createdByAgentId: null,
    createdByUserId: "user-1",
    archivedAt: null,
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    tokens: [],
    clientSnippets: [],
    ...overrides,
  };
}

describe("GatewaysTab", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(new Date("2026-06-16T12:00:00.000Z").getTime());
    listProfilesMock.mockResolvedValue({ profiles: [profile()] });
    listAgentsMock.mockResolvedValue([]);
    listProjectsMock.mockResolvedValue([]);
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    flushSync(() => root?.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  async function render(node: ReactNode) {
    root = createRoot(container);
    await act(async () => {
      root.render(node);
    });
    await flushReact();
  }

  it("renders future relative times as an in-prefix and preserves past ago labels", async () => {
    await render(
      <>
        <RelativeTime value="2026-06-18T12:00:00.000Z" />
        <RelativeTime value="2026-06-14T12:00:00.000Z" />
      </>,
    );

    expect(container.textContent).toContain("in 2d");
    expect(container.textContent).toContain("2d ago");
  });

  it("renders token expiry, revocation date, and empty snippets copy", async () => {
    listGatewaysMock.mockResolvedValue({
      gateways: [
        gateway({
          tokens: [
            token({
              id: "token-future",
              name: "Future token",
              expiresAt: "2026-06-18T12:00:00.000Z",
            }),
            token({
              id: "token-revoked",
              name: "Revoked token",
              expiresAt: "2026-06-18T12:00:00.000Z",
              revokedAt: "2026-06-16T09:00:00.000Z",
            }),
          ],
          clientSnippets: [],
        }),
      ],
    });

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await render(
      <QueryClientProvider client={client}>
        <GatewaysTab companyId="company-1" />
      </QueryClientProvider>,
    );

    expect(container.textContent).toContain("expires in 2d");
    expect(container.textContent).not.toContain("expires 2d ago");
    expect(container.textContent).toContain("revoked 3h ago");
    expect(container.textContent).toContain("No snippets available.");
  });
});
