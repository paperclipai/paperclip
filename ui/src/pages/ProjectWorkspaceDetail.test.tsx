// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Project, ProjectWorkspace } from "@paperclipai/shared";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectWorkspaceDetail } from "./ProjectWorkspaceDetail";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mockProjectsApi = vi.hoisted(() => ({
  get: vi.fn(),
  updateWorkspace: vi.fn(),
  controlWorkspaceCommands: vi.fn(),
}));
const mockNavigate = vi.hoisted(() => vi.fn());
const mockSetBreadcrumbs = vi.hoisted(() => vi.fn());
const mockSetSelectedCompanyId = vi.hoisted(() => vi.fn());
const mockUsePluginSlots = vi.hoisted(() => vi.fn());
const mockPluginSlotMount = vi.hoisted(() => vi.fn());
const mockRouteSearch = vi.hoisted(() => ({ value: "" }));
const mockPluginSlotState = vi.hoisted(() => ({
  slots: [] as unknown[],
  isLoading: false,
  errorMessage: null as string | null,
}));

vi.mock("../api/projects", () => ({ projectsApi: mockProjectsApi }));

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, className }: { children?: ReactNode; to: string; className?: string }) => (
    <a href={to} className={className}>{children}</a>
  ),
  useLocation: () => ({
    pathname: "/PAP/projects/paperclip-app/workspaces/workspace-1",
    search: mockRouteSearch.value,
    hash: "",
    state: null,
  }),
  useNavigate: () => mockNavigate,
  useParams: () => ({ companyPrefix: "PAP", projectId: "paperclip-app", workspaceId: "workspace-1" }),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    companies: [{ id: "company-1", issuePrefix: "PAP" }],
    selectedCompanyId: "company-1",
    setSelectedCompanyId: mockSetSelectedCompanyId,
  }),
}));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: mockSetBreadcrumbs }) }));
vi.mock("../components/PathInstructionsModal", () => ({ ChoosePathButton: () => null }));
vi.mock("../components/WorkspaceRuntimeControls", () => ({
  buildWorkspaceRuntimeControlSections: () => [],
  WorkspaceRuntimeControls: () => <div data-testid="runtime-controls" />,
}));
vi.mock("@/plugins/slots", () => ({
  PluginSlotMount: (props: unknown) => {
    mockPluginSlotMount(props);
    return <div data-testid="plugin-slot-mount" />;
  },
  usePluginSlots: (filters: unknown) => {
    mockUsePluginSlots(filters);
    const entityType = (filters as { entityType?: string }).entityType;
    return {
      slots: entityType === "project_workspace" ? mockPluginSlotState.slots : [],
      isLoading: mockPluginSlotState.isLoading,
      errorMessage: mockPluginSlotState.errorMessage,
    };
  },
}));
vi.mock("../components/PageTabBar", () => ({
  PageTabBar: ({
    items,
    onValueChange,
  }: {
    items: Array<{ value: string; label: string }>;
    onValueChange?: (value: string) => void;
  }) => (
    <div data-testid="page-tab-bar">
      {items.map((item) => (
        <button
          key={item.value}
          data-tab-value={item.value}
          type="button"
          onClick={() => onValueChange?.(item.value)}
        >
          {item.label}
        </button>
      ))}
    </div>
  ),
}));

function projectWorkspace(overrides: Partial<ProjectWorkspace> = {}): ProjectWorkspace {
  const now = new Date("2026-05-01T00:00:00Z");
  return {
    id: "workspace-1",
    companyId: "company-1",
    projectId: "project-1",
    name: "Primary checkout",
    sourceType: "local_path",
    cwd: "/tmp/paperclip",
    repoUrl: "https://github.com/paperclipai/paperclip",
    repoRef: "master",
    defaultRef: "origin/main",
    visibility: "default",
    setupCommand: null,
    cleanupCommand: null,
    remoteProvider: null,
    remoteWorkspaceRef: null,
    sharedWorkspaceKey: null,
    metadata: null,
    runtimeConfig: null,
    runtimeServices: [],
    isPrimary: true,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function project(overrides: Partial<Project> = {}): Project {
  const now = new Date("2026-05-01T00:00:00Z");
  const workspace = projectWorkspace();
  return {
    id: "project-1",
    companyId: "company-1",
    urlKey: "paperclip-app",
    goalId: null,
    goalIds: [],
    goals: [],
    name: "Paperclip App",
    description: null,
    status: "in_progress",
    leadAgentId: null,
    targetDate: null,
    color: "#14b8a6",
    icon: null,
    env: null,
    pauseReason: null,
    pausedAt: null,
    executionWorkspacePolicy: null,
    codebase: {
      workspaceId: workspace.id,
      repoUrl: workspace.repoUrl,
      repoRef: workspace.repoRef,
      defaultRef: workspace.defaultRef,
      repoName: "paperclip",
      localFolder: workspace.cwd,
      managedFolder: workspace.cwd ?? "/tmp/paperclip",
      effectiveLocalFolder: workspace.cwd ?? "/tmp/paperclip",
      origin: "local_folder",
    },
    workspaces: [workspace],
    primaryWorkspace: workspace,
    managedByPlugin: null,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function pluginSlot(overrides: Record<string, unknown> = {}) {
  return {
    id: "quality-tab",
    type: "detailTab",
    displayName: "Quality",
    exportName: "ProjectWorkspaceQualityTab",
    entityTypes: ["project_workspace"],
    pluginId: "plugin-1",
    pluginKey: "paperclip.quality",
    pluginDisplayName: "Quality Plugin",
    pluginVersion: "0.1.0",
    ...overrides,
  };
}

describe("ProjectWorkspaceDetail plugin tabs", () => {
  let root: Root | null = null;
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockProjectsApi.get.mockResolvedValue(project());
    mockPluginSlotState.slots = [];
    mockPluginSlotState.isLoading = false;
    mockPluginSlotState.errorMessage = null;
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container.remove();
    vi.clearAllMocks();
    mockRouteSearch.value = "";
  });

  async function render() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root = createRoot(container);
      root.render(
        <QueryClientProvider client={queryClient}>
          <ProjectWorkspaceDetail />
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      await flush();
    });
  }

  it("scopes plugin detail-tab discovery to project_workspace and the project's company", async () => {
    await render();

    const enabledDetailTabFilters = mockUsePluginSlots.mock.calls
      .map(([filters]) => filters as { slotTypes: string[]; entityType: string; companyId: string | null; enabled?: boolean })
      .filter((filters) => filters.slotTypes.includes("detailTab") && filters.enabled !== false);

    expect(enabledDetailTabFilters.length).toBeGreaterThan(0);
    for (const filters of enabledDetailTabFilters) {
      expect(filters.entityType).toBe("project_workspace");
      expect(filters.companyId).toBe("company-1");
    }
  });

  it("renders an arbitrary project_workspace plugin detail tab from the generic URL value", async () => {
    mockPluginSlotState.slots = [pluginSlot()];
    mockRouteSearch.value = "?tab=plugin%3Apaperclip.quality%3Aquality-tab&diffView=head&baseRef=origin%2Fmaster";

    await render();

    expect(container.querySelector('[data-tab-value="configuration"]')?.textContent).toBe("Configuration");
    expect(container.querySelector('[data-tab-value="plugin:paperclip.quality:quality-tab"]')?.textContent).toBe("Quality");
    expect(container.querySelector('[data-tab-value="changes"]')).toBeNull();
    expect(container.querySelector('[data-testid="plugin-slot-mount"]')).not.toBeNull();
    expect(mockPluginSlotMount).toHaveBeenCalledWith(
      expect.objectContaining({
        slot: expect.objectContaining({ pluginKey: "paperclip.quality", id: "quality-tab" }),
        context: expect.objectContaining({ entityType: "project_workspace", entityId: "workspace-1" }),
      }),
    );
  });

  it("keeps the project workspace heading visible on plugin tabs", async () => {
    mockPluginSlotState.slots = [pluginSlot({ displayName: "Changes" })];
    mockRouteSearch.value = "?tab=plugin%3Apaperclip.quality%3Aquality-tab";

    await render();

    expect(container.querySelector("h1")?.textContent).toBe("Primary checkout");
    expect(container.textContent).toContain("Project workspace");
    expect(container.textContent).toContain("This is the project’s primary codebase workspace.");
    expect(container.querySelector('[data-testid="plugin-slot-mount"]')).not.toBeNull();
    expect(container.textContent).not.toContain("Configure the concrete workspace");
    expect(container.textContent).not.toContain("Workspace name");
  });

  it("orders project workspace plugin tabs against built-in tabs by slot order", async () => {
    mockPluginSlotState.slots = [
      pluginSlot({ id: "late-tab", displayName: "Late", order: 40 }),
      pluginSlot({ id: "early-tab", displayName: "Early", order: 20 }),
      pluginSlot({ id: "default-tab", displayName: "Default" }),
    ];

    await render();

    const tabLabels = Array.from(container.querySelectorAll("[data-tab-value]")).map((tab) => tab.textContent);
    expect(tabLabels).toEqual(["Early", "Configuration", "Late", "Default"]);
  });

  it("navigates plugin tabs with only the generic plugin tab parameter", async () => {
    mockPluginSlotState.slots = [pluginSlot()];

    await render();

    await act(async () => {
      (container.querySelector('[data-tab-value="plugin:paperclip.quality:quality-tab"]') as HTMLButtonElement).click();
    });

    expect(mockNavigate).toHaveBeenCalledWith(
      "/projects/paperclip-app/workspaces/workspace-1?tab=plugin%3Apaperclip.quality%3Aquality-tab",
    );
    expect(mockNavigate).not.toHaveBeenCalledWith(expect.stringContaining("diffView"));
    expect(mockNavigate).not.toHaveBeenCalledWith(expect.stringContaining("baseRef"));
  });

  it("does not treat the old changes tab query as a core plugin tab", async () => {
    mockPluginSlotState.slots = [pluginSlot()];
    mockRouteSearch.value = "?tab=changes&diffView=head&baseRef=origin%2Fmain";

    await render();

    expect(container.querySelector('[data-tab-value="changes"]')).toBeNull();
    expect(container.querySelector('[data-testid="plugin-slot-mount"]')).toBeNull();
    expect(container.textContent).toContain("Project workspace");
  });

  it("shows a missing plugin placeholder instead of configuration for stale plugin tab URLs", async () => {
    mockRouteSearch.value = "?tab=plugin%3Amissing%3Aslot";

    await render();

    expect(container.textContent).toContain("Workspace plugin tab is not available.");
    expect(container.querySelector('a[href="/projects/paperclip-app/workspaces/workspace-1?tab=configuration"]')?.textContent).toBe(
      "Back to configuration",
    );
    expect(container.querySelector('[data-testid="plugin-slot-mount"]')).toBeNull();
    expect(container.textContent).not.toContain("Configure the concrete workspace");
    expect(container.textContent).not.toContain("Workspace name");
  });

  it("shows loading and error states for plugin tab manifests", async () => {
    mockPluginSlotState.isLoading = true;
    mockRouteSearch.value = "?tab=plugin%3Apaperclip.quality%3Aquality-tab";

    await render();

    expect(container.textContent).toContain("Loading workspace plugin...");

    act(() => root?.unmount());
    root = null;
    container.innerHTML = "";
    vi.clearAllMocks();
    mockProjectsApi.get.mockResolvedValue(project());
    mockPluginSlotState.isLoading = false;
    mockPluginSlotState.errorMessage = "Plugin manifest failed";

    await render();

    expect(container.textContent).toContain("Plugin manifest failed");
  });
});
