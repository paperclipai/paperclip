// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Project } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SidebarProjects } from "./SidebarProjects";

const mockProjectsApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockAuthApi = vi.hoisted(() => ({
  getSession: vi.fn(),
}));

const mockOpenNewProject = vi.hoisted(() => vi.fn());
const mockSetSidebarOpen = vi.hoisted(() => vi.fn());
const mockPersistOrder = vi.hoisted(() => vi.fn());

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: { children: ReactNode; to: string }) => (
    <a href={to} {...props}>{children}</a>
  ),
  NavLink: ({
    children,
    className,
    to,
    ...props
  }: {
    children: ReactNode;
    className?: string | ((state: { isActive: boolean }) => string);
    to: string;
  }) => (
    <a
      href={to}
      className={typeof className === "function" ? className({ isActive: false }) : className}
      {...props}
    >
      {children}
    </a>
  ),
  useLocation: () => ({ pathname: "/PAP/projects/bravo/issues", search: "", hash: "", state: null }),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    selectedCompany: { id: "company-1", issuePrefix: "PAP" },
  }),
}));

vi.mock("../context/DialogContext", () => ({
  useDialog: () => ({
    openNewProject: mockOpenNewProject,
  }),
  useDialogActions: () => ({
    openNewProject: mockOpenNewProject,
  }),
}));

vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => ({
    isMobile: false,
    setSidebarOpen: mockSetSidebarOpen,
  }),
}));

vi.mock("../api/projects", () => ({
  projectsApi: mockProjectsApi,
}));

vi.mock("../api/auth", () => ({
  authApi: mockAuthApi,
}));

vi.mock("../hooks/useProjectOrder", () => ({
  useProjectOrder: ({ projects }: { projects: Project[] }) => {
    const curatedOrder = ["project-b", "project-a", "project-c"];
    return {
      orderedProjects: [...projects].sort(
        (left, right) => curatedOrder.indexOf(left.id) - curatedOrder.indexOf(right.id),
      ),
      persistOrder: mockPersistOrder,
    };
  },
}));

vi.mock("@/plugins/slots", () => ({
  usePluginSlots: () => ({
    slots: [{ id: "slot-1", pluginKey: "plugin-1" }],
  }),
  PluginSlotMount: ({ context }: { context: { projectId: string } }) => (
    <div data-testid={`project-slot-${context.projectId}`}>Plugin slot</div>
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

if (!globalThis.PointerEvent) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).PointerEvent = MouseEvent;
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

function projectLinkLabels(container: HTMLElement) {
  return Array.from(container.querySelectorAll('a[href$="/issues"]'))
    .map((anchor) => anchor.textContent?.replace("Plugin slot", "").trim())
    .filter(Boolean);
}

async function openProjectsMenu(container: HTMLElement) {
  const trigger = container.querySelector('button[aria-label="Projects section actions"]');
  expect(trigger).not.toBeNull();

  await act(async () => {
    trigger?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flushReact();
}

async function chooseSortMode(label: string) {
  const item = Array.from(document.body.querySelectorAll('[data-slot="dropdown-menu-radio-item"]'))
    .find((element) => element.textContent?.includes(label));
  expect(item).toBeTruthy();

  await act(async () => {
    item?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flushReact();
}

describe("SidebarProjects", () => {
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
    localStorage.clear();
    mockProjectsApi.list.mockResolvedValue([
      makeProject({
        id: "project-a",
        urlKey: "alpha",
        name: "Alpha",
        createdAt: new Date("2026-01-01T00:00:00Z"),
        updatedAt: new Date("2026-01-05T00:00:00Z"),
      }),
      makeProject({
        id: "project-b",
        urlKey: "bravo",
        name: "Bravo",
        createdAt: new Date("2026-01-02T00:00:00Z"),
        updatedAt: new Date("2026-01-10T00:00:00Z"),
      }),
      makeProject({
        id: "project-c",
        urlKey: "charlie",
        name: "Charlie",
        createdAt: new Date("2026-01-03T00:00:00Z"),
        updatedAt: new Date("2026-01-12T00:00:00Z"),
      }),
    ]);
    mockAuthApi.getSession.mockResolvedValue({
      session: { id: "session-1", userId: "user-1" },
      user: { id: "user-1" },
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
    localStorage.clear();
    vi.clearAllMocks();
  });

  async function renderSidebarProjects() {
    const currentRoot = createRoot(container);
    root = currentRoot;

    await act(async () => {
      currentRoot.render(
        <QueryClientProvider client={queryClient}>
          <SidebarProjects />
        </QueryClientProvider>,
      );
    });
    await flushReact();
  }

  it("keeps top mode in curated order and renders plugin project slots", async () => {
    await renderSidebarProjects();

    expect(projectLinkLabels(container)).toEqual(["Bravo", "Alpha", "Charlie"]);
    expect(container.querySelector('[data-testid="project-slot-project-b"]')).toBeTruthy();
  });

  it("uses the heading for section menu and the plus button for project creation", async () => {
    await renderSidebarProjects();

    const sectionMenuTrigger = container.querySelector('button[aria-label="Projects section actions"]');
    expect(sectionMenuTrigger?.textContent).toContain("Projects");
    expect(sectionMenuTrigger?.querySelector("svg")).toBeNull();

    const newProjectButton = container.querySelector('button[aria-label="New project"]');
    expect(newProjectButton).toBeTruthy();
    await act(async () => {
      newProjectButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(mockOpenNewProject).toHaveBeenCalledTimes(1);

    await openProjectsMenu(container);

    const newProjectItem = Array.from(document.body.querySelectorAll('[data-slot="dropdown-menu-item"]'))
      .find((element) => element.textContent?.includes("New project"));
    expect(newProjectItem).toBeFalsy();
    const browseLink = Array.from(document.body.querySelectorAll("a"))
      .find((element) => element.textContent?.includes("Browse projects"));
    expect(browseLink?.getAttribute("href")).toBe("/projects");
  });

  it("sorts alphabetically and persists the selected mode per company and user", async () => {
    await renderSidebarProjects();
    await openProjectsMenu(container);
    await chooseSortMode("Alphabetical");

    expect(projectLinkLabels(container)).toEqual(["Alpha", "Bravo", "Charlie"]);
    expect(localStorage.getItem("paperclip.projectSortMode:company-1:user-1")).toBe("alphabetical");
  });

  it("sorts recent projects by updated time descending", async () => {
    await renderSidebarProjects();
    await openProjectsMenu(container);
    await chooseSortMode("Recent");

    expect(projectLinkLabels(container)).toEqual(["Charlie", "Bravo", "Alpha"]);
  });
});
