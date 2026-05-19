// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// React 19 production-bundle workaround — see EaosShell.test.tsx for full
// context. Must run before any React import is evaluated.
vi.hoisted(() => {
  if (process.env.NODE_ENV === "production") {
    process.env.NODE_ENV = "test";
  }
});

import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Agent, Issue } from "@paperclipai/shared";

// Stub CompanyContext to provide a deterministic active company scope.
// MissionsLanding gates fetches on `selectedCompanyId`, so the test path
// must look like a real signed-in workspace.
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompany: { id: "company-1", name: "Letsmake", issuePrefix: "LET", status: "active" },
    selectedCompanyId: "company-1",
  }),
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

import { MissionsLanding } from "./MissionsLanding";

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  const base: Issue = {
    id: overrides.id ?? "issue-1",
    companyId: "company-1",
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: "Untitled mission",
    description: null,
    status: "in_progress",
    workMode: "standard",
    priority: "medium",
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
    lastActivityAt: new Date(Date.now() - 10 * 60_000),
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  return { ...base, ...overrides } as Issue;
}

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  // MissionsLanding only reads agent.id and agent.name; cast through unknown
  // to avoid filling the full Agent surface for unrelated fields.
  return {
    id: overrides.id ?? "agent-1",
    companyId: "company-1",
    name: overrides.name ?? "EAOS Frontend Engineer",
    ...overrides,
  } as unknown as Agent;
}

let container: HTMLDivElement | null = null;
let queryClient: QueryClient;

beforeEach(() => {
  issuesListMock.mockReset();
  agentsListMock.mockReset();
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

async function renderMissions(initialPath = "/LET/eaos/missions") {
  container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[initialPath]}>
          <Routes>
            <Route path=":companyPrefix/eaos/missions" element={<MissionsLanding />} />
            <Route path=":companyPrefix/issues/:issueId" element={<div data-testid="issue-detail-stub" />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  return root;
}

describe("MissionsLanding (LET-460 thin slice)", () => {
  it("renders the EAOS Missions surface, not the LET-187 zone placeholder", async () => {
    issuesListMock.mockResolvedValue([]);
    agentsListMock.mockResolvedValue([]);
    await renderMissions();
    await waitForMicrotaskAssertion(() => {
      expect(container?.querySelector('[data-testid="eaos-missions-landing"]')).not.toBeNull();
    });

    expect(container?.querySelector('[data-testid="eaos-zone-placeholder"]')).toBeNull();

    const heading = container?.querySelector("#eaos-missions-title");
    expect(heading?.textContent?.trim()).toBe("Missions");
  });

  it("labels the data layer as backend-backed when a company scope is active", async () => {
    issuesListMock.mockResolvedValue([]);
    agentsListMock.mockResolvedValue([]);
    await renderMissions();
    await waitForMicrotaskAssertion(() => {
      const posture = container?.querySelector('[data-testid="eaos-missions-posture"]');
      const text = posture?.textContent ?? "";
      expect(text).toContain("Shell · BACKEND-BACKED");
      expect(text).toContain("Data · BACKEND-BACKED");
      // Per LET-459 truth-label rule, derived row fields still carry PREVIEW.
      expect(text).toContain("Row fields · PREVIEW");
    });
  });

  it("renders mission rows for active issues with state, owner, next action, gate, and evidence", async () => {
    issuesListMock.mockResolvedValue([
      makeIssue({
        id: "issue-active",
        identifier: "LET-100",
        title: "Ship missions thin slice",
        status: "in_progress",
        assigneeAgentId: "agent-1",
      }),
      makeIssue({
        id: "issue-blocked",
        identifier: "LET-101",
        title: "Approve deploy",
        status: "blocked",
        assigneeAgentId: null,
      }),
      makeIssue({
        id: "issue-done",
        identifier: "LET-102",
        title: "Closed mission",
        status: "done",
        assigneeAgentId: null,
      }),
    ]);
    agentsListMock.mockResolvedValue([makeAgent({ id: "agent-1", name: "EAOS Frontend" })]);
    await renderMissions();

    // Default active filter — done issue should NOT be in the rendered list.
    await waitForMicrotaskAssertion(() => {
      const rows = Array.from(container?.querySelectorAll('[data-testid^="eaos-missions-row-"]') ?? []);
      const rowIds = rows.map((row) => row.getAttribute("data-testid"));
      expect(rowIds).toContain("eaos-missions-row-issue-active");
      expect(rowIds).not.toContain("eaos-missions-row-issue-done");
      expect(rowIds).not.toContain("eaos-missions-row-issue-blocked");
    });

    const activeRow = container?.querySelector('[data-testid="eaos-missions-row-issue-active"]');
    const activeText = activeRow?.textContent ?? "";
    expect(activeText).toContain("LET-100");
    expect(activeText).toContain("Ship missions thin slice");
    expect(activeText).toContain("EAOS Frontend");
    expect(activeText).toContain("Work in progress");

    // Switch to needs-attention filter — only the blocked issue shows up.
    const blockedFilter = container?.querySelector(
      '[data-testid="eaos-missions-filter-needs-attention"]',
    ) as HTMLButtonElement | null;
    expect(blockedFilter).not.toBeNull();
    await act(async () => {
      blockedFilter?.click();
    });

    await waitForMicrotaskAssertion(() => {
      const blockedRow = container?.querySelector('[data-testid="eaos-missions-row-issue-blocked"]');
      expect(blockedRow).not.toBeNull();
      const blockedText = blockedRow?.textContent ?? "";
      expect(blockedText).toContain("Gate · FAILED");
      expect(blockedText).toContain("Unblock required");
      expect(blockedText).toContain("Unassigned");
    });
  });

  it("renders no live mutating controls — only filter buttons and the Kernel/Admin link", async () => {
    issuesListMock.mockResolvedValue([
      makeIssue({
        id: "issue-active",
        identifier: "LET-100",
        title: "Ship missions thin slice",
        status: "in_progress",
      }),
    ]);
    agentsListMock.mockResolvedValue([]);
    await renderMissions();
    await waitForMicrotaskAssertion(() => {
      expect(container?.querySelector('[data-testid="eaos-missions-row-issue-active"]')).not.toBeNull();
    });

    const buttons = Array.from(container?.querySelectorAll("button") ?? []) as HTMLButtonElement[];
    for (const button of buttons) {
      const testid = button.getAttribute("data-testid") ?? "";
      // Filter toolbar buttons are read-only state toggles, not mutations.
      expect(testid).toMatch(/^eaos-missions-filter-(active|needs-attention|done)$/);
    }

    // No forms — no submit surface on the missions page.
    expect(container?.querySelectorAll("form").length).toBe(0);

    // No anchors marketed as "Approve", "Deploy", "Apply", or other live-write verbs.
    const anchors = Array.from(container?.querySelectorAll("a") ?? []);
    for (const anchor of anchors) {
      const text = (anchor.textContent ?? "").toLowerCase();
      expect(text).not.toContain("approve");
      expect(text).not.toContain("deploy");
      expect(text).not.toContain("apply");
      expect(text).not.toContain("restart");
    }
  });

  it("links mission rows to the Kernel/Admin issue detail via a clearly demoted action", async () => {
    issuesListMock.mockResolvedValue([
      makeIssue({
        id: "issue-link",
        identifier: "LET-200",
        title: "Linkable mission",
        status: "in_progress",
      }),
    ]);
    agentsListMock.mockResolvedValue([]);
    await renderMissions();

    await waitForMicrotaskAssertion(() => {
      const link = container?.querySelector('[data-testid="eaos-missions-row-link-issue-link"]');
      expect(link).not.toBeNull();
      expect(link?.textContent ?? "").toContain("Kernel / Admin view");
      expect(link?.getAttribute("aria-label") ?? "").toContain("Kernel/Admin");
      // The href is rewritten by the company-aware Link wrapper into /LET/...
      expect(link?.getAttribute("href")).toBe("/LET/issues/LET-200");
    });
  });

  it("uses calm product copy in the empty state, not raw API error text", async () => {
    issuesListMock.mockResolvedValue([]);
    agentsListMock.mockResolvedValue([]);
    await renderMissions();

    await waitForMicrotaskAssertion(() => {
      const empty = container?.querySelector('[data-testid="eaos-missions-empty-all"]');
      expect(empty).not.toBeNull();
      const text = empty?.textContent ?? "";
      expect(text).toContain("No missions in this scope yet");
      expect(text).not.toMatch(/40\d|50\d|TypeError|fetch failed/);
    });
  });

  it("renders an enterprise-language error state on fetch failure", async () => {
    issuesListMock.mockRejectedValue(new Error("network unreachable"));
    agentsListMock.mockResolvedValue([]);
    await renderMissions();

    await waitForMicrotaskAssertion(() => {
      const error = container?.querySelector('[data-testid="eaos-missions-error"]');
      expect(error).not.toBeNull();
      const text = error?.textContent ?? "";
      expect(text).toContain("Could not load missions for this scope");
      expect(text).not.toContain("network unreachable");
    });
  });

  it("exposes accessible landmarks and a labeled filter toolbar", async () => {
    issuesListMock.mockResolvedValue([]);
    agentsListMock.mockResolvedValue([]);
    await renderMissions();
    await waitForMicrotaskAssertion(() => {
      expect(container?.querySelector('[data-testid="eaos-missions-toolbar"]')).not.toBeNull();
    });

    const section = container?.querySelector('[data-testid="eaos-missions-landing"]');
    expect(section?.tagName).toBe("SECTION");
    expect(section?.getAttribute("aria-labelledby")).toBe("eaos-missions-title");

    const toolbar = container?.querySelector('[data-testid="eaos-missions-toolbar"]');
    expect(toolbar?.getAttribute("role")).toBe("toolbar");
    expect(toolbar?.getAttribute("aria-label")).toBe("Mission filters");

    const filterButtons = container?.querySelectorAll('[data-testid^="eaos-missions-filter-"]');
    expect(filterButtons?.length).toBe(3);
    for (const btn of Array.from(filterButtons ?? [])) {
      // Each filter is a single aria-pressed toggle (read-only filter, not a mutation).
      expect(btn.getAttribute("aria-pressed")).not.toBeNull();
    }
  });
});
