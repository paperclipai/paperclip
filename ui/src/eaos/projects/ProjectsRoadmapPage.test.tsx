// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  if (process.env.NODE_ENV === "production") {
    process.env.NODE_ENV = "test";
  }
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Goal, Project } from "@paperclipai/shared";

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompany: { id: "company-1", name: "Letsmake", issuePrefix: "LET", status: "active" },
    selectedCompanyId: "company-1",
  }),
}));

// LET-513 §6 — kernel/legacy escape hatch is now gated by viewer role. The
// existing suite was written when every row showed the link; mock the
// viewer role hook with operator=true so those assertions still hold, and
// add dedicated cases below for the customer-gated path.
const viewerRoleMock = vi.fn<() => {
  isOperator: boolean;
  isInstanceAdmin: boolean;
  membershipRole: string | null;
  loading: boolean;
}>();

vi.mock("../useEaosViewerRole", () => ({
  useEaosViewerRole: () => viewerRoleMock(),
}));

const projectsListMock = vi.fn<(companyId: string) => Promise<Project[]>>();
const goalsListMock = vi.fn<(companyId: string) => Promise<Goal[]>>();

vi.mock("@/api/projects", () => ({
  projectsApi: {
    list: (companyId: string) => projectsListMock(companyId),
  },
}));

vi.mock("@/api/goals", () => ({
  goalsApi: {
    list: (companyId: string) => goalsListMock(companyId),
  },
}));

import { ProjectsRoadmapPage } from "./ProjectsRoadmapPage";

function makeProject(overrides: Partial<Project> & { id: string; name: string }): Project {
  return {
    id: overrides.id,
    companyId: "company-1",
    urlKey: overrides.urlKey ?? overrides.id,
    goalId: overrides.goalId ?? null,
    goalIds: overrides.goalIds ?? [],
    goals: overrides.goals ?? [],
    name: overrides.name,
    description: overrides.description ?? null,
    status: overrides.status ?? "in_progress",
    leadAgentId: overrides.leadAgentId ?? null,
    targetDate: overrides.targetDate ?? null,
    color: overrides.color ?? null,
    env: overrides.env ?? null,
    pauseReason: overrides.pauseReason ?? null,
    pausedAt: overrides.pausedAt ?? null,
    executionWorkspacePolicy: overrides.executionWorkspacePolicy ?? null,
    codebase: overrides.codebase ?? ({} as Project["codebase"]),
    workspaces: overrides.workspaces ?? [],
    primaryWorkspace: overrides.primaryWorkspace ?? null,
    archivedAt: overrides.archivedAt ?? null,
    createdAt: overrides.createdAt ?? new Date(),
    updatedAt: overrides.updatedAt ?? new Date(),
  } as Project;
}

function makeGoal(overrides: Partial<Goal> & { id: string; title: string }): Goal {
  return {
    id: overrides.id,
    companyId: "company-1",
    title: overrides.title,
    description: overrides.description ?? null,
    level: overrides.level ?? "company",
    status: overrides.status ?? "active",
    parentId: overrides.parentId ?? null,
    ownerAgentId: overrides.ownerAgentId ?? null,
    createdAt: overrides.createdAt ?? new Date(),
    updatedAt: overrides.updatedAt ?? new Date(),
  };
}

let container: HTMLDivElement | null = null;
let queryClient: QueryClient;

beforeEach(() => {
  projectsListMock.mockReset();
  goalsListMock.mockReset();
  viewerRoleMock.mockReset();
  viewerRoleMock.mockReturnValue({
    isOperator: true,
    isInstanceAdmin: true,
    membershipRole: "owner",
    loading: false,
  });
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

async function renderRoadmap() {
  container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const now = new Date("2026-05-19T16:00:00.000Z");
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/eaos/projects"]}>
          <Routes>
            <Route path="/eaos/projects" element={<ProjectsRoadmapPage now={now} />} />
            <Route path="/projects/:projectId" element={<div data-testid="kernel-project-stub" />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  return root;
}

describe("ProjectsRoadmapPage (LET-484 working-product slice)", () => {
  it("renders the roadmap surface (not the EaosZonePlaceholder)", async () => {
    projectsListMock.mockResolvedValue([]);
    goalsListMock.mockResolvedValue([]);
    await renderRoadmap();
    await waitForMicrotaskAssertion(() => {
      expect(container?.querySelector('[data-testid="eaos-projects-page"]')).not.toBeNull();
    });
    expect(container?.querySelector('[data-testid="eaos-zone-placeholder"]')).toBeNull();
  });

  it("renders a clean single-word title and no internal posture chips", async () => {
    projectsListMock.mockResolvedValue([
      makeProject({ id: "p-1", name: "Alpha", status: "in_progress" }),
    ]);
    goalsListMock.mockResolvedValue([
      makeGoal({ id: "g-1", title: "Ship Alpha", status: "active" }),
    ]);
    await renderRoadmap();
    await waitForMicrotaskAssertion(() => {
      const title = container?.querySelector('[data-testid="eaos-projects-title"]');
      expect(title?.textContent).toBe("Projects");
      const posture = container?.querySelector('[data-testid="eaos-projects-posture"]');
      expect(posture).toBeNull();
      const html = container?.innerHTML ?? "";
      expect(html).not.toContain("BACKEND-BACKED");
    });
  });

  it("groups projects into status buckets with summary counts", async () => {
    projectsListMock.mockResolvedValue([
      makeProject({ id: "ip", name: "Active", status: "in_progress" }),
      makeProject({ id: "p", name: "Planned", status: "planned" }),
      makeProject({ id: "b", name: "Bucket", status: "backlog" }),
      makeProject({ id: "s", name: "Shipped", status: "completed" }),
      makeProject({ id: "x", name: "Stopped", status: "cancelled" }),
    ]);
    goalsListMock.mockResolvedValue([
      makeGoal({ id: "g1", title: "Active goal", status: "active" }),
    ]);
    await renderRoadmap();
    await waitForMicrotaskAssertion(() => {
      expect(container?.querySelector('[data-testid="eaos-projects-summary-total"]')?.textContent).toContain("5");
      expect(container?.querySelector('[data-testid="eaos-projects-summary-in-progress"]')?.textContent).toContain("1");
      expect(container?.querySelector('[data-testid="eaos-projects-summary-active-goals"]')?.textContent).toContain("1");
      expect(container?.querySelector('[data-testid="eaos-projects-bucket-in_progress-rows"]')).not.toBeNull();
      expect(container?.querySelector('[data-testid="eaos-projects-bucket-planned-rows"]')).not.toBeNull();
      expect(container?.querySelector('[data-testid="eaos-projects-bucket-shipped-rows"]')).not.toBeNull();
      expect(container?.querySelector('[data-testid="eaos-projects-bucket-stopped-rows"]')).not.toBeNull();
    });
  });

  it("renders goal titles when projects link to backend goals", async () => {
    projectsListMock.mockResolvedValue([
      makeProject({
        id: "p-1",
        name: "EAOS shell",
        status: "in_progress",
        goalIds: ["g-1", "g-2"],
      }),
    ]);
    goalsListMock.mockResolvedValue([
      makeGoal({ id: "g-1", title: "Hyperagents-style UX", status: "active" }),
      makeGoal({ id: "g-2", title: "Truthful posture chips", status: "active" }),
    ]);
    await renderRoadmap();
    await waitForMicrotaskAssertion(() => {
      const titlesList = container?.querySelector('[data-testid="eaos-projects-row-goal-titles"]');
      const text = titlesList?.textContent ?? "";
      expect(text).toContain("Hyperagents-style UX");
      expect(text).toContain("Truthful posture chips");
    });
  });

  it("does NOT render any mutating action controls on rows", async () => {
    projectsListMock.mockResolvedValue([
      makeProject({ id: "p", name: "Alpha", status: "in_progress" }),
    ]);
    goalsListMock.mockResolvedValue([]);
    await renderRoadmap();
    await waitForMicrotaskAssertion(() => {
      expect(container?.querySelector('[data-testid="eaos-projects-row"]')).not.toBeNull();
    });
    // LET-513 §5 — the view-mode segmented control adds two buttons
    // (Cards / List), but they only change the visible layout. No row
    // renders a mutate / approve / archive / start-workspace control.
    const rowButtons = container?.querySelectorAll(
      '[data-testid="eaos-projects-row"] button',
    );
    expect(rowButtons?.length ?? 0).toBe(0);
    const kernelLink = container?.querySelector('[data-testid="eaos-projects-row-kernel-link"]');
    expect(kernelLink?.getAttribute("href")).toBe("/LET/projects/p");
  });

  it("hides the legacy kernel link for customer-member viewers", async () => {
    viewerRoleMock.mockReturnValue({
      isOperator: false,
      isInstanceAdmin: false,
      membershipRole: "member",
      loading: false,
    });
    projectsListMock.mockResolvedValue([
      makeProject({ id: "p", name: "Alpha", status: "in_progress" }),
    ]);
    goalsListMock.mockResolvedValue([]);
    await renderRoadmap();
    await waitForMicrotaskAssertion(() => {
      expect(container?.querySelector('[data-testid="eaos-projects-row"]')).not.toBeNull();
    });
    const kernelLink = container?.querySelector(
      '[data-testid="eaos-projects-row-kernel-link"]',
    );
    expect(kernelLink).toBeNull();
  });

  it("filters and toggles view mode via the EaosViewControls", async () => {
    projectsListMock.mockResolvedValue([
      makeProject({ id: "ip-1", name: "Alpha mission", status: "in_progress" }),
      makeProject({ id: "ip-2", name: "Beta launch", status: "in_progress" }),
    ]);
    goalsListMock.mockResolvedValue([]);
    await renderRoadmap();
    await waitForMicrotaskAssertion(() => {
      expect(
        container?.querySelectorAll(
          '[data-testid="eaos-projects-bucket-in_progress-rows"] [data-testid="eaos-projects-row"]',
        ).length,
      ).toBe(2);
    });
    const input = container?.querySelector(
      '[data-testid="eaos-projects-filter-input"]',
    ) as HTMLInputElement | null;
    expect(input).not.toBeNull();
    const nativeSetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    await act(async () => {
      if (input) {
        nativeSetter?.call(input, "alpha");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });
    await waitForMicrotaskAssertion(() => {
      const rows = container?.querySelectorAll(
        '[data-testid="eaos-projects-bucket-in_progress-rows"] [data-testid="eaos-projects-row"]',
      );
      expect(rows?.length).toBe(1);
      expect(rows?.[0]?.getAttribute("data-project-id")).toBe("ip-1");
    });
    const listBtn = container?.querySelector(
      '[data-testid="eaos-projects-view-mode-list"]',
    ) as HTMLButtonElement | null;
    await act(async () => {
      listBtn?.click();
    });
    await waitForMicrotaskAssertion(() => {
      const list = container?.querySelector(
        '[data-testid="eaos-projects-bucket-in_progress-rows"]',
      );
      expect(list?.getAttribute("data-eaos-view-mode")).toBe("list");
    });
  });
});
