// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Projects } from "./Projects";

const companyState = vi.hoisted(() => ({
  selectedCompanyId: "company-1",
}));

const dialogState = vi.hoisted(() => ({
  openNewProject: vi.fn(),
}));

const breadcrumbsState = vi.hoisted(() => ({
  setBreadcrumbs: vi.fn(),
}));

const projectsApiMock = vi.hoisted(() => ({
  list: vi.fn(),
}));

const authApiMock = vi.hoisted(() => ({
  getSession: vi.fn(),
}));

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => companyState,
}));

vi.mock("../context/DialogContext", () => ({
  useDialog: () => dialogState,
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => breadcrumbsState,
}));

vi.mock("../api/projects", () => ({
  projectsApi: projectsApiMock,
}));

vi.mock("../api/auth", () => ({
  authApi: authApiMock,
}));

vi.mock("../hooks/useProjectPins", () => ({
  useProjectPins: ({ projects }: { projects: unknown[] }) => ({
    orderedProjects: projects,
    pinnedIds: [],
    togglePinned: vi.fn(),
  }),
}));

vi.mock("../components/ProjectStarButton", () => ({
  ProjectStarButton: () => null,
}));

vi.mock("../components/ProjectLabelPills", () => ({
  ProjectLabelPills: () => null,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function makeProject(overrides: Record<string, unknown> = {}) {
  return {
    id: "project-1",
    companyId: "company-1",
    urlKey: "project-one",
    code: null,
    parentId: null,
    goalId: null,
    goalIds: [],
    goals: [],
    name: "Project One",
    description: null,
    status: "planned",
    leadAgentId: null,
    targetDate: null,
    color: "#6366f1",
    env: null,
    pauseReason: null,
    pausedAt: null,
    executionWorkspacePolicy: null,
    labelIds: [],
    labels: [],
    codebase: null,
    workspaces: [],
    primaryWorkspace: null,
    archivedAt: null,
    createdAt: new Date("2026-04-01T00:00:00.000Z"),
    updatedAt: new Date("2026-04-01T00:00:00.000Z"),
    ...overrides,
  };
}

function setInputValue(input: HTMLInputElement, value: string) {
  const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  valueSetter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderProjects(container: HTMLElement): Promise<Root> {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <Projects />
      </QueryClientProvider>,
    );
  });
  await flush();
  return root;
}

describe("Projects page", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    projectsApiMock.list.mockReset();
    authApiMock.getSession.mockReset();
    authApiMock.getSession.mockResolvedValue({ user: { id: "user-1" } });
  });

  afterEach(() => {
    container.remove();
    vi.clearAllMocks();
  });

  it("shows project codes and filters search by code", async () => {
    projectsApiMock.list.mockResolvedValue([
      makeProject({ id: "project-ops", name: "Operations", urlKey: "operations", code: "OPS7" }),
      makeProject({ id: "project-launch", name: "Launch", urlKey: "launch", code: "PAPA" }),
    ]);

    const root = await renderProjects(container);

    expect(container.textContent).toContain("OPS7");
    expect(container.textContent).toContain("PAPA");

    const searchInput = container.querySelector('input[aria-label="Search projects"]') as HTMLInputElement | null;
    expect(searchInput).not.toBeNull();

    await act(async () => {
      if (!searchInput) return;
      setInputValue(searchInput, "papa");
    });
    await flush();

    expect(container.textContent).toContain("Launch");
    expect(container.textContent).toContain("PAPA");
    expect(container.textContent).not.toContain("Operations");

    act(() => root.unmount());
  });
});
