// @vitest-environment jsdom

import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Project } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../context/ToastContext";
import { Projects } from "./Projects";

const mockProjectsApi = vi.hoisted(() => ({
  list: vi.fn(),
  update: vi.fn(),
}));

const mockResourceMembershipsApi = vi.hoisted(() => ({
  listMine: vi.fn(),
  updateProject: vi.fn(),
}));

const mockOpenNewProject = vi.hoisted(() => vi.fn());
const mockSetBreadcrumbs = vi.hoisted(() => vi.fn());
const mockNavigate = vi.hoisted(() => vi.fn());

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: { children?: ReactNode; to: string }) => (
    <a
      href={to}
      {...props}
      onClick={(event) => {
        if (!event.defaultPrevented) mockNavigate(to);
      }}
    >
      {children}
    </a>
  ),
}));

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
    parentProjectId: null,
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
      starredProjectIds: [],
      starredAgentIds: [],
      projectStarredAt: {},
      agentStarredAt: {},
      updatedAt: null,
    });
    mockResourceMembershipsApi.updateProject.mockImplementation(async (
      _companyId: string,
      resourceId: string,
      body: { state?: "joined" | "left"; starred?: boolean },
    ) => ({
      resourceType: "project",
      resourceId,
      state: body.state ?? "joined",
      starredAt: body.starred ? new Date("2026-01-05T00:00:00Z") : null,
      updatedAt: new Date("2026-01-05T00:00:00Z"),
    }));
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
          <ToastProvider>
            <Projects />
          </ToastProvider>
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

  function visibleProjectNames() {
    return Array.from(container.querySelectorAll('[role="treeitem"] a'))
      .map((element) => element.getAttribute("href")?.split("/").pop())
      .filter((name): name is string => Boolean(name));
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

  it("renders a bounded tree with only project names and status in default rows", async () => {
    mockProjectsApi.list.mockResolvedValue([
      makeProject({ id: "root", urlKey: "root", name: "Root" }),
      makeProject({ id: "child", urlKey: "child", name: "Child", parentProjectId: "root", description: "Hidden description" }),
      makeProject({ id: "grandchild", urlKey: "grandchild", name: "Grandchild", parentProjectId: "child" }),
    ]);

    await renderProjects();

    const content = container.textContent ?? "";
    expect(content.indexOf("Root")).toBeLessThan(content.indexOf("Child"));
    expect(content.indexOf("Child")).toBeLessThan(content.indexOf("Grandchild"));
    expect(content).not.toContain("Hidden description");
    expect(content).toContain("in progress");
    expect(container.querySelector('[role="tree"]')).not.toBeNull();
  });

  it("keeps children with their root section when membership differs", async () => {
    mockProjectsApi.list.mockResolvedValue([
      makeProject({ id: "root", urlKey: "root", name: "Root" }),
      makeProject({ id: "child", urlKey: "child", name: "Child", parentProjectId: "root" }),
    ]);
    mockResourceMembershipsApi.listMine.mockResolvedValue({
      projectMemberships: { child: "left" },
      agentMemberships: {},
      starredProjectIds: [],
      starredAgentIds: [],
      projectStarredAt: {},
      agentStarredAt: {},
      updatedAt: null,
    });

    await renderProjects();

    const mySection = Array.from(container.querySelectorAll("section"))
      .find((section) => section.querySelector("h2")?.textContent === "My Projects");
    expect(mySection?.textContent).toContain("Root");
    expect(mySection?.textContent).toContain("Child");
    expect(mySection?.textContent).toContain("2 projects");
    expect(container.textContent).not.toContain("Other Projects");
  });

  it("applies name and updated sorting to roots and siblings", async () => {
    mockProjectsApi.list.mockResolvedValue([
      makeProject({ id: "root-b", urlKey: "root-b", name: "Beta", updatedAt: new Date("2026-01-01T00:00:00Z") }),
      makeProject({ id: "child-b", urlKey: "child-b", name: "Bravo", parentProjectId: "root-b", updatedAt: new Date("2026-01-02T00:00:00Z") }),
      makeProject({ id: "child-a", urlKey: "child-a", name: "Alpha", parentProjectId: "root-b", updatedAt: new Date("2026-01-03T00:00:00Z") }),
      makeProject({ id: "root-a", urlKey: "root-a", name: "Able", updatedAt: new Date("2026-01-04T00:00:00Z") }),
    ]);
    mockResourceMembershipsApi.listMine.mockResolvedValue({
      projectMemberships: {},
      agentMemberships: {},
      starredProjectIds: [],
      starredAgentIds: [],
      projectStarredAt: {},
      agentStarredAt: {},
      updatedAt: null,
    });

    await renderProjects();
    expect(visibleProjectNames()).toEqual(["root-a", "root-b", "child-a", "child-b"]);

    await openSortMenu();
    await chooseSortField("Updated");
    expect(visibleProjectNames()).toEqual(["root-a", "root-b", "child-a", "child-b"]);
  });

  it("renders membership and star controls and calls their mutation", async () => {
    await renderProjects();

    const join = container.querySelector<HTMLButtonElement>('button[aria-label="Join Bravo"]');
    expect(join).not.toBeNull();
    await act(async () => { join?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await flushReact();
    expect(mockResourceMembershipsApi.updateProject).toHaveBeenCalledWith(
      "company-1",
      "project-b",
      expect.objectContaining({ state: "joined" }),
    );

    const star = container.querySelector<HTMLButtonElement>('button[aria-label="Star Alpha"]');
    expect(star).not.toBeNull();
    await act(async () => { star?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await flushReact();
    expect(mockResourceMembershipsApi.updateProject).toHaveBeenCalledWith(
      "company-1",
      "project-a",
      expect.objectContaining({ starred: true }),
    );
  });

  it("collapses and expands child projects", async () => {
    mockProjectsApi.list.mockResolvedValue([
      makeProject({ id: "root", urlKey: "root", name: "Root" }),
      makeProject({ id: "child", urlKey: "child", name: "Child", parentProjectId: "root" }),
    ]);
    await renderProjects();

    const toggle = container.querySelector<HTMLButtonElement>('button[aria-label="Collapse Root"]');
    expect(toggle).not.toBeNull();
    await act(async () => { toggle?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(container.textContent).not.toContain("Child");
    await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="Expand Root"]')?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(container.textContent).toContain("Child");
  });

  it("opens move and archive dialogs without following the row link", async () => {
    await renderProjects();

    const openActions = async () => {
      const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="Actions for Alpha"]');
      expect(trigger).not.toBeNull();
      await act(async () => {
        trigger?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
        trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await flushReact();
    };

    await openActions();
    const move = Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'))
      .find((item) => item.textContent?.includes("Move or detach"));
    expect(move).toBeTruthy();
    await act(async () => { move?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await flushReact();
    expect(document.body.textContent).toContain("Move Alpha");
    expect(mockNavigate).not.toHaveBeenCalled();

    const cancelMove = Array.from(document.body.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "Cancel");
    await act(async () => { cancelMove?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await flushReact();

    await openActions();
    const archive = Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'))
      .find((item) => item.textContent?.includes("Archive"));
    expect(archive).toBeTruthy();
    await act(async () => { archive?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await flushReact();
    expect(document.body.textContent).toContain("Archive Alpha?");
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});
