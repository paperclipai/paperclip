// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Costs } from "./Costs";

const budgetOverviewMock = vi.hoisted(() => vi.fn());
const setBreadcrumbsMock = vi.hoisted(() => vi.fn());
const resolveIncidentMock = vi.hoisted(() => vi.fn());
const pushToastMock = vi.hoisted(() => vi.fn());
const costsApiMocks = vi.hoisted(() => ({
  summary: vi.fn(),
  byAgent: vi.fn(),
  byProject: vi.fn(),
  byAgentModel: vi.fn(),
  financeSummary: vi.fn(),
  financeByBiller: vi.fn(),
  financeByKind: vi.fn(),
  financeEvents: vi.fn(),
  byProvider: vi.fn(),
  byBiller: vi.fn(),
  windowSpend: vi.fn(),
  quotaWindows: vi.fn(),
}));

vi.mock("../api/budgets", () => ({
  budgetsApi: {
    overview: (...args: unknown[]) => budgetOverviewMock(...args),
    upsertPolicy: vi.fn(),
    resolveIncident: (...args: unknown[]) => resolveIncidentMock(...args),
  },
}));

vi.mock("../api/costs", () => ({ costsApi: costsApiMocks }));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: setBreadcrumbsMock }),
}));

vi.mock("../context/ToastContext", () => ({
  useToastActions: () => ({ pushToast: pushToastMock }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("Costs embedded Audit surfaces", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    budgetOverviewMock.mockResolvedValue({
      policies: [],
      activeIncidents: [],
      pendingApprovalCount: 0,
      pausedAgentCount: 0,
      pausedProjectCount: 0,
    });
  });

  afterEach(() => {
    act(() => root?.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("renders a focused Budgets section without duplicate Costs chrome or spend queries", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Costs embedded initialTab="budgets" lockTab />
        </QueryClientProvider>,
      );
      await Promise.resolve();
    });

    await act(async () => {
      await vi.waitFor(() => {
        expect(budgetOverviewMock).toHaveBeenCalledWith("company-1");
        expect(container.textContent).toContain("Budget control plane");
      });
    });
    expect(container.textContent).not.toContain("Inference spend");
    expect(container.querySelector('[role="tab"]')).toBeFalsy();
    expect(setBreadcrumbsMock).not.toHaveBeenCalled();
    for (const mock of Object.values(costsApiMocks)) expect(mock).not.toHaveBeenCalled();
  });

  it("shows the server error inside the incident card when resolving it fails", async () => {
    budgetOverviewMock.mockResolvedValue({
      policies: [],
      activeIncidents: [{
        id: "incident-1",
        companyId: "company-1",
        policyId: "policy-1",
        scopeType: "agent",
        scopeId: "agent-1",
        scopeName: "Budget Agent",
        metric: "billed_cents",
        windowKind: "calendar_month_utc",
        windowStart: "2026-09-01T00:00:00.000Z",
        windowEnd: "2026-10-01T00:00:00.000Z",
        thresholdType: "hard",
        amountLimit: 100,
        amountObserved: 150,
        status: "open",
        approvalId: "approval-1",
        approvalStatus: "pending",
        resolvedAt: null,
        createdAt: "2026-09-28T00:00:00.000Z",
        updatedAt: "2026-09-28T00:00:00.000Z",
      }],
      pendingApprovalCount: 1,
      pausedAgentCount: 1,
      pausedProjectCount: 0,
    });
    resolveIncidentMock.mockRejectedValueOnce(new Error("Budget incident not found"));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Costs embedded initialTab="budgets" lockTab />
        </QueryClientProvider>,
      );
      await Promise.resolve();
    });
    await act(async () => {
      await vi.waitFor(() => expect(container.textContent).toContain("Keep paused"));
    });

    const keepPaused = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Keep paused",
    );
    await act(async () => {
      keepPaused?.click();
      await vi.waitFor(() => expect(container.querySelector('[role="alert"]')).toBeTruthy());
    });

    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Budget incident not found");
    expect(pushToastMock).not.toHaveBeenCalled();
  });
});
