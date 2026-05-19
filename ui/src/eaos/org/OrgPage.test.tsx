// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  if (process.env.NODE_ENV === "production") {
    process.env.NODE_ENV = "test";
  }
});

import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Agent } from "@paperclipai/shared";
import type { OrgNode } from "@/api/agents";

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompany: { id: "company-1", name: "Letsmake", issuePrefix: "LET", status: "active" },
    selectedCompanyId: "company-1",
  }),
}));

const agentsListMock = vi.fn<(companyId: string) => Promise<Agent[]>>();
const agentsOrgMock = vi.fn<(companyId: string) => Promise<OrgNode[]>>();

vi.mock("@/api/agents", () => ({
  agentsApi: {
    list: (companyId: string) => agentsListMock(companyId),
    org: (companyId: string) => agentsOrgMock(companyId),
  },
}));

import { OrgPage } from "./OrgPage";

function makeAgent(overrides: Partial<Agent>): Agent {
  return {
    id: "agent",
    companyId: "company-1",
    name: "Agent",
    urlKey: "agent",
    role: "engineer",
    title: null,
    icon: null,
    status: "active",
    reportsTo: null,
    capabilities: null,
    adapterType: "claude_local",
    adapterConfig: {},
    runtimeConfig: {},
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    permissions: { canCreateAgents: false },
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as unknown as Agent;
}

let container: HTMLDivElement | null = null;
let queryClient: QueryClient;

beforeEach(() => {
  agentsListMock.mockReset();
  agentsOrgMock.mockReset();
  agentsOrgMock.mockResolvedValue([]);
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
});

afterEach(() => {
  if (container) {
    container.remove();
    container = null;
  }
  queryClient.clear();
});

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

async function waitForAssertion(assertion: () => void, attempts = 30) {
  let lastError: unknown;
  for (let index = 0; index < attempts; index += 1) {
    await flushReact();
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function renderOrg() {
  container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/eaos/org"]}>
          <Routes>
            <Route path="/eaos/org" element={<OrgPage />} />
            <Route path="/agents/:agentId" element={<div data-testid="kernel-agent-detail-stub" />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  return root;
}

describe("OrgPage (LET-503)", () => {
  it("renders the org page surface with a single-noun title", async () => {
    agentsListMock.mockResolvedValue([]);
    await renderOrg();
    await waitForAssertion(() => {
      const title = container?.querySelector('[data-testid="eaos-org-title"]');
      expect(title?.textContent?.trim()).toBe("Org");
    });
  });

  it("renders the org graph canvas with a node per agent when org backend is empty", async () => {
    agentsListMock.mockResolvedValue([
      makeAgent({ id: "ceo-1", name: "Andrii", role: "ceo", status: "active" }),
      makeAgent({ id: "eng-1", name: "Alex", role: "engineer", status: "running" }),
      makeAgent({ id: "eng-2", name: "Zelda", role: "engineer", status: "paused" }),
    ]);
    await renderOrg();
    await waitForAssertion(() => {
      expect(container?.querySelector('[data-testid="eaos-org-graph"]')).not.toBeNull();
      expect(container?.querySelector('[data-testid="eaos-org-node-ceo-1"]')).not.toBeNull();
      expect(container?.querySelector('[data-testid="eaos-org-node-eng-1"]')).not.toBeNull();
      expect(container?.querySelector('[data-testid="eaos-org-node-eng-2"]')).not.toBeNull();
      const pageSource = container?.querySelector('[data-testid="eaos-org-page"]')?.getAttribute(
        "data-eaos-org-source",
      );
      expect(pageSource).toBe("derived");
    });
  });

  it("uses the backend org tree when reporting relationships are present", async () => {
    agentsListMock.mockResolvedValue([
      makeAgent({ id: "ceo-1", name: "Andrii", role: "ceo", status: "active" }),
      makeAgent({ id: "eng-1", name: "Alex", role: "engineer", status: "running" }),
    ]);
    agentsOrgMock.mockResolvedValue([
      {
        id: "ceo-1",
        name: "Andrii",
        role: "ceo",
        status: "active",
        reports: [
          { id: "eng-1", name: "Alex", role: "engineer", status: "running", reports: [] },
        ],
      },
    ]);
    await renderOrg();
    await waitForAssertion(() => {
      const pageSource = container?.querySelector('[data-testid="eaos-org-page"]')?.getAttribute(
        "data-eaos-org-source",
      );
      expect(pageSource).toBe("backend");
      const ceoWorkload = container
        ?.querySelector('[data-testid="eaos-org-node-ceo-1-workload"]')
        ?.textContent?.trim();
      expect(ceoWorkload).toMatch(/1 report/);
    });
  });

  it("opens and closes the details sidebar when a node is selected", async () => {
    agentsListMock.mockResolvedValue([
      makeAgent({
        id: "eng-1",
        name: "Alex",
        urlKey: "alex",
        role: "engineer",
        status: "running",
        title: "Senior engineer",
        capabilities: "Frontend / React",
      }),
    ]);
    await renderOrg();
    await waitForAssertion(() => {
      expect(container?.querySelector('[data-testid="eaos-org-node-eng-1"]')).not.toBeNull();
    });

    const node = container!.querySelector(
      '[data-testid="eaos-org-node-eng-1"]',
    ) as HTMLElement;
    await act(async () => {
      node.click();
    });

    await waitForAssertion(() => {
      const details = container?.querySelector('[data-testid="eaos-org-details"]');
      expect(details).not.toBeNull();
      expect(details?.textContent ?? "").toMatch(/Alex/);
      expect(details?.textContent ?? "").toMatch(/Senior engineer/);
    });

    const link = container!.querySelector(
      '[data-testid="eaos-org-details-link"]',
    ) as HTMLAnchorElement | null;
    expect(link?.getAttribute("href")).toMatch(/\/agents\/alex$/);

    const closeButton = container!.querySelector(
      '[data-testid="eaos-org-details-close"]',
    ) as HTMLButtonElement;
    await act(async () => {
      closeButton.click();
    });

    await waitForAssertion(() => {
      expect(container?.querySelector('[data-testid="eaos-org-details"]')).toBeNull();
    });
  });

  it("names the missing reporting-graph backend as a truthful gap (derived source)", async () => {
    agentsListMock.mockResolvedValue([makeAgent({ id: "eng-1", role: "engineer" })]);
    await renderOrg();
    await waitForAssertion(() => {
      const gapNote = container?.querySelector('[data-testid="eaos-org-gap-note"]');
      expect(gapNote?.textContent ?? "").toMatch(/reporting-graph endpoint is not wired/);
    });
  });

  it("falls back to a no-company-state when no company is selected", async () => {
    vi.doMock("@/context/CompanyContext", () => ({
      useCompany: () => ({ selectedCompany: null, selectedCompanyId: null }),
    }));
    vi.resetModules();
    const { OrgPage: ScopelessOrg } = await import("./OrgPage");
    container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={["/eaos/org"]}>
            <Routes>
              <Route path="/eaos/org" element={<ScopelessOrg />} />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
    await waitForAssertion(() => {
      expect(container?.querySelector('[data-testid="eaos-org-no-company"]')).not.toBeNull();
    });
    vi.doUnmock("@/context/CompanyContext");
  });
});
