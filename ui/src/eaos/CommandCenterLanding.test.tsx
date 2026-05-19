// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

// React 19 production-bundle workaround — see EaosShell.test.tsx for full
// context. Must run before any React import is evaluated.
vi.hoisted(() => {
  if (process.env.NODE_ENV === "production") {
    process.env.NODE_ENV = "test";
  }
  // React 19 act() guard — set before React is imported so legacy
  // jsdom-based hooks (createRoot.render flush) don't warn.
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { Agent, Issue } from "@paperclipai/shared";

// Mutable scope handle so individual tests can toggle between an active
// company scope and the no-scope path without re-mocking modules.
const SCOPED_COMPANY = {
  selectedCompany: { id: "company-1", name: "Letsmake", issuePrefix: "LET", status: "active" },
  selectedCompanyId: "company-1" as string | null,
};
const NO_SCOPE_COMPANY = {
  selectedCompany: null,
  selectedCompanyId: null as string | null,
};
let companyState: typeof SCOPED_COMPANY | typeof NO_SCOPE_COMPANY = SCOPED_COMPANY;

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => companyState,
}));

const issuesListMock = vi.fn<(companyId: string, filters?: unknown) => Promise<Issue[]>>();
const agentsListMock = vi.fn<(companyId: string) => Promise<Agent[]>>();

vi.mock("@/api/issues", () => ({
  issuesApi: {
    list: (companyId: string, filters?: unknown) => issuesListMock(companyId, filters),
  },
}));

vi.mock("@/api/agents", () => ({
  agentsApi: {
    list: (companyId: string) => agentsListMock(companyId),
  },
}));

import { CommandCenterLanding } from "./CommandCenterLanding";

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  const base = {
    id: "issue-1",
    companyId: "company-1",
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: "Untitled mission",
    description: null,
    status: "in_progress" as Issue["status"],
    workMode: "standard" as Issue["workMode"],
    priority: "medium" as Issue["priority"],
    assigneeAgentId: null,
    assigneeUserId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    issueNumber: null,
    identifier: null,
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    lastActivityAt: new Date(Date.now() - 5 * 60_000),
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  return { ...base, ...overrides } as Issue;
}

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

let container: HTMLDivElement | null = null;

async function flushQueries() {
  // Drain microtasks + one macrotask so react-query's mocked promises resolve
  // and the resulting render commits before we assert on values.
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

async function renderLanding() {
  container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={makeQueryClient()}>
        <MemoryRouter initialEntries={["/eaos"]}>
          <Routes>
            <Route path="/eaos" element={<CommandCenterLanding />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await flushQueries();
  return { root };
}

afterEach(() => {
  if (container) {
    container.remove();
    container = null;
  }
  issuesListMock.mockReset();
  agentsListMock.mockReset();
  companyState = SCOPED_COMPANY;
});

describe("CommandCenterLanding — backend-backed telemetry", () => {
  it("renders backend-backed mission counts from the live issues feed", async () => {
    issuesListMock.mockResolvedValue([
      makeIssue({ id: "a", status: "in_progress", priority: "high" }),
      makeIssue({ id: "b", status: "in_progress", priority: "medium" }),
      makeIssue({ id: "c", status: "in_review", priority: "critical" }),
      makeIssue({ id: "d", status: "blocked", priority: "high" }),
      makeIssue({ id: "e", status: "done", priority: "low" }),
    ]);
    agentsListMock.mockResolvedValue([
      { id: "ag-1", status: "active" } as Agent,
      { id: "ag-2", status: "running" } as Agent,
      { id: "ag-3", status: "paused" } as Agent,
    ]);

    await renderLanding();

    const active = container?.querySelector('[data-testid="eaos-command-center-telemetry-active-value"]');
    const attention = container?.querySelector('[data-testid="eaos-command-center-telemetry-attention-value"]');
    const inReview = container?.querySelector('[data-testid="eaos-command-center-telemetry-in-review-value"]');
    const high = container?.querySelector('[data-testid="eaos-command-center-telemetry-high-priority-value"]');
    const done = container?.querySelector('[data-testid="eaos-command-center-telemetry-done-value"]');

    expect(active?.textContent).toBe("2");
    // blocked + in_review
    expect(attention?.textContent).toBe("2");
    expect(inReview?.textContent).toBe("1");
    // high/critical open work: a, c, d
    expect(high?.textContent).toBe("3");
    expect(done?.textContent).toBe("1");
  });

  it("claims Data · BACKEND-BACKED in the header when company scope is active", async () => {
    issuesListMock.mockResolvedValue([]);
    agentsListMock.mockResolvedValue([]);

    await renderLanding();
    const headerText = container?.querySelector('[data-testid="eaos-command-center-header"]')?.textContent ?? "";
    expect(headerText).toContain("Data · BACKEND-BACKED");
    expect(headerText).toContain("Shell · BACKEND-BACKED");
  });

  it("redacts secret-looking strings in recent activity titles", async () => {
    issuesListMock.mockResolvedValue([
      makeIssue({
        id: "leak",
        identifier: "LET-999",
        title: "Mission ghp_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIII contains a credential",
      }),
    ]);
    agentsListMock.mockResolvedValue([]);

    await renderLanding();
    const rowText = container?.querySelector('[data-testid="eaos-command-center-activity-row-leak"]')?.textContent ?? "";
    expect(rowText).not.toContain("ghp_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIII");
    expect(rowText).toContain("LET-999");
  });

  it("falls back to a non-numeric placeholder when there is no company scope", async () => {
    companyState = NO_SCOPE_COMPANY;
    // The api mocks must still resolve to keep react-query happy even though
    // the queries are gated `enabled: !!selectedCompanyId` and won't fire.
    issuesListMock.mockResolvedValue([]);
    agentsListMock.mockResolvedValue([]);

    await renderLanding();

    const landing = container?.querySelector('[data-testid="eaos-command-center-landing"]');
    expect(landing?.getAttribute("data-eaos-data-connected")).toBe("false");

    const tileValues = Array.from(
      container?.querySelectorAll('[data-testid^="eaos-command-center-telemetry-"][data-testid$="-value"]') ?? [],
    );
    expect(tileValues.length).toBeGreaterThan(0);
    for (const node of tileValues) {
      // Never claim a fake numeric value when the company scope is missing —
      // collapse to the `·` placeholder so operators can tell `0` from `n/a`.
      expect(node.textContent?.trim()).toBe("·");
    }

    const headerText = container?.querySelector('[data-testid="eaos-command-center-header"]')?.textContent ?? "";
    expect(headerText).toContain("Data · PREVIEW");
    expect(headerText).toContain("Not connected");
    expect(headerText).not.toContain("Data · BACKEND-BACKED");
  });
});
