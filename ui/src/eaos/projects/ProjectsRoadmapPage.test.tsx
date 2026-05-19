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

  it("labels the roadmap as backend-backed once both reads resolve", async () => {
    projectsListMock.mockResolvedValue([
      makeProject({ id: "p-1", name: "Alpha", status: "in_progress" }),
    ]);
    goalsListMock.mockResolvedValue([
      makeGoal({ id: "g-1", title: "Ship Alpha", status: "active" }),
    ]);
    await renderRoadmap();
    await waitForMicrotaskAssertion(() => {
      const posture = container?.querySelector('[data-testid="eaos-projects-posture"]');
      const text = posture?.textContent ?? "";
      expect(text).toContain("Shell · BACKEND-BACKED");
      expect(text).toContain("Roadmap · BACKEND-BACKED");
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

  it("does NOT render any live action buttons", async () => {
    projectsListMock.mockResolvedValue([
      makeProject({ id: "p", name: "Alpha", status: "in_progress" }),
    ]);
    goalsListMock.mockResolvedValue([]);
    await renderRoadmap();
    await waitForMicrotaskAssertion(() => {
      expect(container?.querySelector('[data-testid="eaos-projects-row"]')).not.toBeNull();
    });
    expect(container?.querySelectorAll("button").length).toBe(0);
    const kernelLink = container?.querySelector('[data-testid="eaos-projects-row-kernel-link"]');
    expect(kernelLink?.getAttribute("href")).toBe("/LET/projects/p");
  });
});
