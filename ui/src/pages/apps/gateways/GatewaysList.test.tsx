// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ToolMcpGatewayWithTokens } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";
import { GatewaysList } from "./GatewaysList";

const listGatewaysMock = vi.hoisted(() => vi.fn());
const listProfilesMock = vi.hoisted(() => vi.fn());
const listConnectionsMock = vi.hoisted(() => vi.fn());
const listApplicationsMock = vi.hoisted(() => vi.fn());
const listAgentsMock = vi.hoisted(() => vi.fn());
const listProjectsMock = vi.hoisted(() => vi.fn());
const navigateMock = vi.hoisted(() => vi.fn());
const setBreadcrumbsMock = vi.hoisted(() => vi.fn());
const pushToastMock = vi.hoisted(() => vi.fn());

vi.mock("@/api/tools", () => ({
  toolsApi: {
    listGateways: (companyId: string) => listGatewaysMock(companyId),
    listProfiles: (companyId: string) => listProfilesMock(companyId),
    listConnections: (companyId: string) => listConnectionsMock(companyId),
    listApplications: (companyId: string) => listApplicationsMock(companyId),
    createGateway: vi.fn(),
    updateGateway: vi.fn(),
  },
}));

vi.mock("@/api/agents", () => ({
  agentsApi: { list: (companyId: string) => listAgentsMock(companyId) },
}));

vi.mock("@/api/projects", () => ({
  projectsApi: { list: (companyId: string) => listProjectsMock(companyId) },
}));

vi.mock("@/lib/router", () => ({
  useNavigate: () => navigateMock,
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: setBreadcrumbsMock }),
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

function gateway(): ToolMcpGatewayWithTokens {
  return {
    id: "gateway-1",
    companyId: "company-1",
    name: "Dotta's MacBook",
    displaySlug: "dottas-macbook",
    slug: "dottas-macbook",
    status: "active",
    profileId: "profile-1",
    contextScopeType: "company",
    contextScopeId: null,
    agentId: null,
    projectId: null,
    issueId: null,
    createdByAgentId: null,
    createdByUserId: "user-1",
    endpointPath: "/api/tool-gateway/gateways/gateway-1/mcp",
    tokens: [],
    clientSnippets: [],
  } as unknown as ToolMcpGatewayWithTokens;
}

describe("GatewaysList", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    listProfilesMock.mockResolvedValue({ profiles: [] });
    listConnectionsMock.mockResolvedValue({ connections: [] });
    listApplicationsMock.mockResolvedValue({ applications: [] });
    listAgentsMock.mockResolvedValue([]);
    listProjectsMock.mockResolvedValue([]);
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    flushSync(() => root?.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  async function render() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <GatewaysList />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    return client;
  }

  it("keeps loaded gateways visible when a refetch fails transiently", async () => {
    listGatewaysMock.mockResolvedValue({ gateways: [gateway()] });
    const client = await render();
    expect(container.textContent).toContain("Dotta's MacBook");

    listGatewaysMock.mockRejectedValue(
      new ApiError("Paperclip is restarting.", 503, { error: "tenant_app_unavailable" }),
    );
    await act(async () => {
      await client.invalidateQueries();
    });
    await flushReact();

    expect(container.textContent).toContain("Dotta's MacBook");
    expect(container.querySelector('[data-query-view="error"]')).toBeNull();
    expect(container.textContent).not.toContain("Paperclip is restarting.");
  });

  it("shows readable copy and a Retry button for a real error", async () => {
    listGatewaysMock
      .mockRejectedValueOnce(new ApiError("Boom", 500, { error: "Boom" }))
      .mockResolvedValue({ gateways: [gateway()] });
    await render();

    expect(container.querySelector('[data-query-view="error"]')).not.toBeNull();
    expect(container.textContent).toContain("Couldn't load gateways");
    expect(container.textContent).not.toContain("Dotta's MacBook");

    const retry = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes("Retry"));
    expect(retry, "Retry button").toBeTruthy();
    await act(async () => {
      retry!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(container.querySelector('[data-query-view="error"]')).toBeNull();
    expect(container.textContent).toContain("Dotta's MacBook");
  });
});
