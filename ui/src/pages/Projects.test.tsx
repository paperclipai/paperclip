// @vitest-environment jsdom

import { MemoryRouter, useLocation } from "react-router-dom";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Project } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../context/ToastContext";
import { Projects } from "./Projects";

const mockProjectsApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockResourceMembershipsApi = vi.hoisted(() => ({
  listMine: vi.fn(),
  updateProject: vi.fn(),
}));

const mockOpenNewProject = vi.hoisted(() => vi.fn());
const mockSetBreadcrumbs = vi.hoisted(() => vi.fn());

vi.mock("@/lib/router", async () => {
  const { Link } = await import("react-router-dom");
  return { Link };
});

function LocationProbe() {
  return <output data-testid="location">{useLocation().pathname}</output>;
}

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

vi.mock("../context/DialogContext", () => ({
  useDialogActions: () => ({ openNewProject: mockOpenNewProject }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: mockSetBreadcrumbs }),
}));

vi.mock("../api/projects", () => ({
  projectsApi: mockProjectsApi,
}));

vi.mock("../api/resourceMemberships", () => ({
  resourceMembershipsApi: mockResourceMembershipsApi,
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

if (!globalThis.PointerEvent) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).PointerEvent = MouseEvent;
}

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

function makeProject(overrides: Partial<Project>): Project {
  return {
    id: "project-a",
    companyId: "company-1",
    urlKey: "alpha",
    goalId: null,
    goalIds: [],
    goals: [],
    name: "Alpha",
    description: null,
    status: "in_progress",
    leadAgentId: null,
    targetDate: null,
    color: "#ef4444",
    icon: null,
    env: null,
    pauseReason: null,
    pausedAt: null,
    executionWorkspacePolicy: null,
    codebase: {
      workspaceId: null,
      repoUrl: null,
      repoRef: null,
      defaultRef: null,
      repoName: null,
      localFolder: null,
      managedFolder: "/tmp/project-a",
      effectiveLocalFolder: "/tmp/project-a",
      origin: "local_folder",
    },
    workspaces: [],
    primaryWorkspace: null,
    managedByPlugin: null,
    archivedAt: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe("Projects", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot> | null;
  let queryClient: QueryClient;

  beforeEach(() => {
    window.localStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = null;
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    mockProjectsApi.list.mockResolvedValue([
      makeProject({
        id: "project-c",
        urlKey: "charlie",
        name: "Charlie",
        updatedAt: new Date("2026-01-10T00:00:00Z"),
      }),
      makeProject({
        id: "project-b",
        urlKey: "bravo",
        name: "Bravo",
        updatedAt: new Date("2026-01-05T00:00:00Z"),
      }),
      makeProject({
        id: "project-a",
        urlKey: "alpha",
        name: "Alpha",
        description: "First project",
        updatedAt: new Date("2026-01-01T00:00:00Z"),
      }),
    ]);
    mockResourceMembershipsApi.listMine.mockResolvedValue({
      projectMemberships: { "project-b": "left" },
      agentMemberships: {},
      updatedAt: null,
    });
    mockResourceMembershipsApi.updateProject.mockResolvedValue({
      resourceType: "project",
      resourceId: "project-b",
      state: "joined",
      updatedAt: new Date("2026-01-05T00:00:00Z"),
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

  async function renderProjects() {
    const currentRoot = createRoot(container);
    root = currentRoot;

    await act(async () => {
      currentRoot.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={["/projects"]}>
            <ToastProvider>
              <Projects />
            </ToastProvider>
            <LocationProbe />
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();
  }

  async function openSortMenu() {
    const trigger = container.querySelector<HTMLButtonElement>('button[title="Sort"]');
    expect(trigger).not.toBeNull();

    await act(async () => {
      trigger?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
      trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
  }

  async function clickViewMode(label: string) {
    const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    expect(button).not.toBeNull();

    await act(async () => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
  }

  async function chooseSortField(label: string) {
    const item = Array.from(document.body.querySelectorAll("button"))
      .find((element) => element.textContent?.includes(label));
    expect(item).toBeTruthy();

    await act(async () => {
      item?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();
  }

  it("groups joined projects above left projects and defaults sorting by name", async () => {
    await renderProjects();

    const content = container.textContent ?? "";
    expect(container.querySelector('button[title="Sort"]')?.textContent).toContain("Sort: Name");
    expect(content.indexOf("My Projects")).toBeLessThan(content.indexOf("Alpha"));
    expect(content.indexOf("Alpha")).toBeLessThan(content.indexOf("Charlie"));
    expect(content.indexOf("Charlie")).toBeLessThan(content.indexOf("Other Projects"));
    expect(content.indexOf("Other Projects")).toBeLessThan(content.indexOf("Bravo"));
    expect(content).toContain("in progress");
  });

  it("sorts grouped projects by the selected field", async () => {
    await renderProjects();
    await openSortMenu();
    await chooseSortField("Updated");

    const content = container.textContent ?? "";
    expect(content.indexOf("My Projects")).toBeLessThan(content.indexOf("Charlie"));
    expect(content.indexOf("Charlie")).toBeLessThan(content.indexOf("Alpha"));
    expect(content.indexOf("Alpha")).toBeLessThan(content.indexOf("Other Projects"));
  });

  it("reserves description line height for projects without descriptions", async () => {
    await renderProjects();

    const bravoLink = Array.from(container.querySelectorAll<HTMLAnchorElement>("a")).find((link) =>
      link.textContent?.includes("Bravo"),
    );
    const hiddenDescriptionLine = bravoLink?.querySelector("p[aria-hidden='true']");

    expect(hiddenDescriptionLine).not.toBeNull();
    expect(hiddenDescriptionLine?.className).toContain("min-h-4");
  });

  it("defaults to the list view and switches to a card grid on request", async () => {
    await renderProjects();

    expect(container.querySelector('[data-testid="projects-list"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="projects-grid"]')).toBeNull();
    expect(container.querySelector('button[aria-label="List view"]')?.getAttribute("aria-pressed"))
      .toBe("true");

    await clickViewMode("Grid view");

    expect(container.querySelector('[data-testid="projects-list"]')).toBeNull();
    const grid = container.querySelector('[data-testid="projects-grid"]');
    expect(grid).not.toBeNull();
    expect(container.querySelector('button[aria-label="Grid view"]')?.getAttribute("aria-pressed"))
      .toBe("true");
    expect(window.localStorage.getItem("paperclip.projects.viewMode")).toBe("grid");
  });

  it("restores the stored grid preference on mount", async () => {
    window.localStorage.setItem("paperclip.projects.viewMode", "grid");
    await renderProjects();

    expect(container.querySelector('[data-testid="projects-grid"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="projects-list"]')).toBeNull();
  });

  it("keeps grouping, sorting, and project links in the grid view", async () => {
    window.localStorage.setItem("paperclip.projects.viewMode", "grid");
    await renderProjects();

    const content = container.textContent ?? "";
    expect(content.indexOf("My Projects")).toBeLessThan(content.indexOf("Alpha"));
    expect(content.indexOf("Alpha")).toBeLessThan(content.indexOf("Charlie"));
    expect(content.indexOf("Charlie")).toBeLessThan(content.indexOf("Other Projects"));
    expect(content.indexOf("Other Projects")).toBeLessThan(content.indexOf("Bravo"));

    const cardLinks = Array.from(
      container.querySelectorAll<HTMLAnchorElement>('[data-testid="projects-grid"] a'),
    );
    expect(cardLinks.map((link) => link.getAttribute("href"))).toEqual([
      "/projects/alpha",
      "/projects/charlie",
      "/projects/bravo",
    ]);
    expect(cardLinks[0]?.textContent).toContain("First project");
  });

  it("exposes the star control on each grid card", async () => {
    window.localStorage.setItem("paperclip.projects.viewMode", "grid");
    await renderProjects();

    expect(container.querySelector('button[aria-label="Star Alpha"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="Join Bravo"]')).not.toBeNull();
    for (const button of container.querySelectorAll('[data-testid="projects-grid"] button')) {
      expect(button.closest("a")).toBeNull();
    }
  });

  it.each([
    { label: "Star Alpha", projectId: "project-a", starred: false, change: { starred: true } },
    { label: "Unstar Alpha", projectId: "project-a", starred: true, change: { starred: false } },
    { label: "Join Bravo", projectId: "project-b", starred: false, change: { state: "joined" } },
    { label: "Leave Alpha", projectId: "project-a", starred: false, change: { state: "left" } },
  ])("$label mutates membership without navigating from the grid", async ({ label, projectId, starred, change }) => {
    window.localStorage.setItem("paperclip.projects.viewMode", "grid");
    mockResourceMembershipsApi.listMine.mockResolvedValue({
      projectMemberships: { "project-b": "left" },
      agentMemberships: {},
      starredProjectIds: starred ? ["project-a"] : [],
      updatedAt: null,
    });
    mockResourceMembershipsApi.updateProject.mockResolvedValue({
      resourceType: "project",
      resourceId: projectId,
      state: change.state ?? "joined",
      starredAt: change.starred ? new Date() : null,
      updatedAt: new Date(),
    });
    await renderProjects();

    const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    expect(button).not.toBeNull();
    await act(async () => {
      button!.click();
    });
    await flushReact();

    expect(mockResourceMembershipsApi.updateProject).toHaveBeenCalledExactlyOnceWith(
      "company-1", projectId, { state: undefined, starred: undefined, ...change },
    );
    expect(container.querySelector('[data-testid="location"]')?.textContent).toBe("/projects");
  });

  it("navigates when the grid project link is activated", async () => {
    window.localStorage.setItem("paperclip.projects.viewMode", "grid");
    await renderProjects();
    const link = container.querySelector<HTMLAnchorElement>('[data-testid="projects-grid"] a[href="/projects/alpha"]');
    expect(link).not.toBeNull();
    await act(async () => {
      link!.click();
    });
    await flushReact();

    expect(container.querySelector('[data-testid="location"]')?.textContent).toBe("/projects/alpha");
    expect(mockResourceMembershipsApi.updateProject).not.toHaveBeenCalled();
  });
});
