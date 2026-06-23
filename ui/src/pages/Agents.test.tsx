// @vitest-environment jsdom

import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Agent } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../context/ToastContext";
import { Agents } from "./Agents";
import type { AgentOrgChainHealth } from "@paperclipai/shared";

const mockAgentsApi = vi.hoisted(() => ({
  list: vi.fn(),
  org: vi.fn(),
}));

const mockHeartbeatsApi = vi.hoisted(() => ({
  liveRunsForCompany: vi.fn(),
}));

const mockResourceMembershipsApi = vi.hoisted(() => ({
  listMine: vi.fn(),
  updateAgent: vi.fn(),
}));

const mockOpenNewAgent = vi.hoisted(() => vi.fn());
const mockSetBreadcrumbs = vi.hoisted(() => vi.fn());

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: { children: ReactNode; to: string }) => (
    <a href={to} {...props}>{children}</a>
  ),
  useLocation: () => ({ pathname: "/agents/all", search: "", hash: "", state: null }),
  useNavigate: () => vi.fn(),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

vi.mock("../context/DialogContext", () => ({
  useDialogActions: () => ({ openNewAgent: mockOpenNewAgent }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: mockSetBreadcrumbs }),
}));

vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => ({ isMobile: false }),
}));

vi.mock("../api/agents", () => ({
  agentsApi: mockAgentsApi,
}));

vi.mock("../api/heartbeats", () => ({
  heartbeatsApi: mockHeartbeatsApi,
}));

vi.mock("../api/resourceMemberships", () => ({
  resourceMembershipsApi: mockResourceMembershipsApi,
}));

vi.mock("../adapters/adapter-display-registry", () => ({
  getAdapterLabel: (type: string) => type,
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

function makeAgent(overrides: Partial<Agent>): Agent {
  return {
    id: "agent-1",
    companyId: "company-1",
    name: "Alpha",
    urlKey: "alpha",
    role: "engineer",
    title: null,
    icon: null,
    status: "active",
    reportsTo: null,
    capabilities: null,
    adapterType: "codex_local",
    adapterConfig: {},
    runtimeConfig: {},
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    permissions: { canCreateAgents: false },
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

const invalidOrgChainHealth: AgentOrgChainHealth = {
  status: "invalid_org_chain",
  reason: "terminated_ancestor",
  fullChain: [
    {
      id: "agent-1",
      companyId: "company-1",
      name: "Alpha",
      status: "active",
      reportsTo: "manager-1",
      depth: 0,
      relation: "self",
    },
    {
      id: "manager-1",
      companyId: "company-1",
      name: "Terminated Manager",
      status: "terminated",
      reportsTo: null,
      depth: 1,
      relation: "ancestor",
    },
  ],
  firstInvalidAncestor: { id: "manager-1", name: "Terminated Manager", status: "terminated" },
  invalidAncestors: [{ id: "manager-1", name: "Terminated Manager", status: "terminated" }],
  repairGuidance: "Alpha reports through terminated ancestor Terminated Manager.",
};

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe("Agents", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot> | null;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = null;
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    mockAgentsApi.list.mockResolvedValue([
      makeAgent({
        adapterConfig: { model: "gpt-5.4" },
        // Old enough that relativeTime() falls back to an absolute date string.
        lastHeartbeatAt: new Date("2026-01-15T00:00:00Z"),
      }),
    ]);
    mockAgentsApi.org.mockResolvedValue([
      {
        id: "agent-1",
        name: "Alpha",
        role: "engineer",
        status: "active",
        reports: [],
      },
    ]);
    mockHeartbeatsApi.liveRunsForCompany.mockResolvedValue([]);
    mockResourceMembershipsApi.listMine.mockResolvedValue({
      projectMemberships: {},
      agentMemberships: {},
      updatedAt: null,
    });
    mockResourceMembershipsApi.updateAgent.mockResolvedValue({
      resourceType: "agent",
      resourceId: "agent-1",
      state: "left",
      updatedAt: new Date("2026-01-02T00:00:00Z"),
    });
  });

  afterEach(async () => {
    const currentRoot = root;
    if (currentRoot) {
      await act(async () => {
        currentRoot.unmount();
      });
    }
    queryClient.clear();
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("shows the configured model beside the adapter on the all agents page", async () => {
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <ToastProvider>
            <Agents />
          </ToastProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("codex_local");
    expect(container.textContent).toContain("gpt-5.4");

    // The heartbeat cell must render on a single line so full dates like
    // "Apr 30, 2026" never wrap (PAP-85 defect #2).
    const heartbeatCell = container.querySelector(".whitespace-nowrap.w-24");
    expect(heartbeatCell).not.toBeNull();
    expect(heartbeatCell?.textContent).not.toContain("\n");
  });

  it("gives list-view rows a fixed-width title so meta columns align (PAP-86)", async () => {
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <ToastProvider>
            <Agents />
          </ToastProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    // Switch from the default org view to the list view.
    const listToggle = Array.from(container.querySelectorAll("button")).find(
      (btn) => btn.querySelector("svg.lucide-list"),
    );
    expect(listToggle).toBeDefined();
    await act(async () => {
      listToggle!.click();
    });
    await flushReact();

    // The title cell carries a constant width (`w-56`), not a content-sized
    // `min-w-[7rem]`, so the `meta` group starts at the same x on every row and
    // the model + timestamp columns line up vertically.
    const titleCell = container.querySelector(".w-56");
    expect(titleCell).not.toBeNull();
    expect(titleCell?.textContent).toContain("Alpha");
    expect(container.querySelector(".min-w-\\[7rem\\]")).toBeNull();
  });

  it("keeps invalid-org-chain agents visible with a warning marker", async () => {
    mockAgentsApi.list.mockResolvedValue([
      makeAgent({ orgChainHealth: invalidOrgChainHealth }),
    ]);

    root = createRoot(container);
    await act(async () => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <ToastProvider>
            <Agents />
          </ToastProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("Alpha");
    expect(container.querySelector('[aria-label="Invalid reporting chain"]')).not.toBeNull();
  });
});
