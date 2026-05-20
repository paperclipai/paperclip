// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  if (process.env.NODE_ENV === "production") {
    process.env.NODE_ENV = "test";
  }
});

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  Agent,
  AgentDetail,
  AgentRuntimeState,
  AgentSkillSnapshot,
  AgentTaskSession,
} from "@paperclipai/shared";

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompany: { id: "company-1", name: "Letsmake", issuePrefix: "LET", status: "active" },
    selectedCompanyId: "company-1",
  }),
}));

const agentsGetMock = vi.fn<(id: string, companyId?: string) => Promise<AgentDetail>>();
const agentsListMock = vi.fn<(companyId: string) => Promise<Agent[]>>();
const runtimeStateMock = vi.fn<(id: string, companyId?: string) => Promise<AgentRuntimeState | null>>();
const taskSessionsMock = vi.fn<(id: string, companyId?: string) => Promise<AgentTaskSession[]>>();
const skillsMock = vi.fn<(id: string, companyId?: string) => Promise<AgentSkillSnapshot | null>>();

vi.mock("@/api/agents", () => ({
  agentsApi: {
    get: (id: string, companyId?: string) => agentsGetMock(id, companyId),
    list: (companyId: string) => agentsListMock(companyId),
    runtimeState: (id: string, companyId?: string) => runtimeStateMock(id, companyId),
    taskSessions: (id: string, companyId?: string) => taskSessionsMock(id, companyId),
    skills: (id: string, companyId?: string) => skillsMock(id, companyId),
  },
}));

import { AgentDetailPage } from "./AgentDetailPage";

function makeAgent(overrides: Partial<AgentDetail> = {}): AgentDetail {
  return {
    id: overrides.id ?? "agent-1",
    companyId: "company-1",
    name: overrides.name ?? "Frontend Builder token=SHOULD_NOT_RENDER",
    urlKey: overrides.urlKey ?? "frontend-builder",
    role: overrides.role ?? "engineer",
    title: overrides.title ?? "Customer shell",
    icon: null,
    status: overrides.status ?? "running",
    reportsTo: overrides.reportsTo ?? "ceo-1",
    capabilities: null,
    adapterType: overrides.adapterType ?? "claude_local",
    adapterConfig: {},
    runtimeConfig: {},
    budgetMonthlyCents: overrides.budgetMonthlyCents ?? 50_000,
    spentMonthlyCents: overrides.spentMonthlyCents ?? 12_345,
    pauseReason: overrides.pauseReason ?? null,
    pausedAt: overrides.pausedAt ?? null,
    permissions: overrides.permissions ?? { canCreateAgents: true },
    lastHeartbeatAt: overrides.lastHeartbeatAt ?? new Date("2026-05-19T15:45:00.000Z"),
    metadata: null,
    createdAt: new Date("2026-05-01T00:00:00.000Z"),
    updatedAt: new Date("2026-05-19T15:45:00.000Z"),
    chainOfCommand: overrides.chainOfCommand ?? [
      { id: "ceo-1", name: "CEO", role: "ceo", title: "Chief Executive" },
    ],
    access: overrides.access ?? {
      canAssignTasks: true,
      taskAssignSource: "ceo_role",
      membership: null,
      grants: [],
    },
    ...overrides,
  } as unknown as AgentDetail;
}

function makeRuntime(overrides: Partial<AgentRuntimeState> = {}): AgentRuntimeState {
  return {
    agentId: "agent-1",
    companyId: "company-1",
    adapterType: "claude_local",
    sessionId: "session-secret-token=SHOULD_NOT_RENDER",
    sessionDisplayId: "worker-session",
    sessionParamsJson: null,
    stateJson: {},
    lastRunId: "run-1",
    lastRunStatus: "completed",
    totalInputTokens: 1200,
    totalOutputTokens: 450,
    totalCachedInputTokens: 300,
    totalCostCents: 234,
    lastError: null,
    createdAt: new Date("2026-05-19T12:00:00.000Z"),
    updatedAt: new Date("2026-05-19T15:45:00.000Z"),
    ...overrides,
  } as unknown as AgentRuntimeState;
}

function makeSkills(): AgentSkillSnapshot {
  return {
    adapterType: "claude_local",
    supported: true,
    mode: "persistent",
    desiredSkills: ["github-pr-workflow"],
    warnings: [],
    entries: [
      {
        key: "github-pr-workflow",
        runtimeName: "GitHub PR workflow",
        desired: true,
        managed: true,
        state: "installed",
      },
    ],
  };
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let queryClient: QueryClient;

beforeEach(() => {
  agentsGetMock.mockReset();
  agentsListMock.mockReset();
  runtimeStateMock.mockReset();
  taskSessionsMock.mockReset();
  skillsMock.mockReset();
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
});

afterEach(async () => {
  if (root) {
    await act(async () => {
      root?.unmount();
    });
    root = null;
  }
  if (container) {
    container.remove();
    container = null;
  }
  queryClient.clear();
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

async function waitForMicrotaskAssertion(assertion: () => void, attempts = 30) {
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

async function renderDetail(initialPath = "/eaos/agents/frontend-builder") {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const now = new Date("2026-05-19T16:00:00.000Z");
  await act(async () => {
    root!.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[initialPath]}>
          <Routes>
            <Route path="/eaos/agents/:agentRef" element={<AgentDetailPage now={now} />} />
            <Route path="/agents/:agentId" element={<div data-testid="kernel-agent-detail-stub" />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
}

describe("AgentDetailPage (LET-506)", () => {
  it("renders a Multica-style inspector + overview from backend-backed agent data", async () => {
    const agent = makeAgent();
    agentsGetMock.mockResolvedValue(agent);
    agentsListMock.mockResolvedValue([
      makeAgent({ id: "ceo-1", name: "Andrii", role: "ceo", reportsTo: null, title: "CEO" }),
      agent,
    ]);
    runtimeStateMock.mockResolvedValue(makeRuntime());
    taskSessionsMock.mockResolvedValue([
      {
        id: "session-1",
        companyId: "company-1",
        agentId: "agent-1",
        adapterType: "claude_local",
        taskKey: "LET-506",
        sessionParamsJson: null,
        sessionDisplayId: "task-session-1",
        lastRunId: "run-1",
        lastError: null,
        createdAt: new Date("2026-05-19T12:00:00.000Z"),
        updatedAt: new Date("2026-05-19T15:00:00.000Z"),
      },
    ] as AgentTaskSession[]);
    skillsMock.mockResolvedValue(makeSkills());

    await renderDetail();

    await waitForMicrotaskAssertion(() => {
      expect(container?.querySelector('[data-testid="eaos-agent-detail-page"]')).not.toBeNull();
      expect(container?.querySelector('[data-testid="eaos-agent-detail-inspector"]')).not.toBeNull();
      expect(container?.querySelector('[data-testid="eaos-agent-detail-overview"]')).not.toBeNull();
    });

    expect(agentsGetMock).toHaveBeenCalledWith("frontend-builder", "company-1");
    await waitForMicrotaskAssertion(() => {
      const visibleText = container?.querySelector('[data-testid="eaos-agent-detail-page"]')?.textContent ?? "";
      expect(visibleText).toContain("Frontend Builder token=[REDACTED]");
      expect(visibleText).toContain("Running");
      expect(visibleText).toContain("Claude Local");
      expect(visibleText).toContain("Andrii");
      expect(visibleText).toContain("GitHub PR workflow");
      expect(visibleText).toContain("LET-506");
      expect(visibleText).not.toContain("claude_local");
      expect(visibleText).not.toContain("SHOULD_NOT_RENDER");
    });
  });

  it("keeps the EAOS detail page read-only and exposes Kernel as the only action escape hatch", async () => {
    agentsGetMock.mockResolvedValue(makeAgent());
    agentsListMock.mockResolvedValue([]);
    runtimeStateMock.mockResolvedValue(null);
    taskSessionsMock.mockResolvedValue([]);
    skillsMock.mockResolvedValue(null);

    await renderDetail();

    await waitForMicrotaskAssertion(() => {
      expect(container?.querySelector('[data-testid="eaos-agent-detail-page"]')).not.toBeNull();
    });

    const buttons = container?.querySelectorAll("button");
    expect(buttons?.length ?? 0).toBe(0);
    const kernelLink = container?.querySelector('[data-testid="eaos-agent-detail-kernel-link"]');
    expect(kernelLink?.getAttribute("href")).toContain("/agents/agent-1");
    const visibleText = container?.querySelector('[data-testid="eaos-agent-detail-page"]')?.textContent ?? "";
    expect(visibleText).not.toMatch(/pause|resume|approve|terminate|revoke|reset session/i);
  });
});
