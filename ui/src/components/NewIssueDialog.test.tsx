// @vitest-environment jsdom

import { act } from "react";
import type { ComponentProps, ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NewIssueDialog } from "./NewIssueDialog";

const dialogState = vi.hoisted(() => ({
  newIssueOpen: true,
  newIssueDefaults: {} as Record<string, unknown>,
  closeNewIssue: vi.fn(),
}));

const companyState = vi.hoisted(() => ({
  companies: [
    {
      id: "company-1",
      name: "Paperclip",
      status: "active",
      brandColor: "#123456",
      issuePrefix: "PAP",
    },
  ],
  selectedCompanyId: "company-1",
  selectedCompany: {
    id: "company-1",
    name: "Paperclip",
    status: "active",
    brandColor: "#123456",
    issuePrefix: "PAP",
  },
}));

const toastState = vi.hoisted(() => ({
  pushToast: vi.fn(),
}));

const mockIssuesApi = vi.hoisted(() => ({
  create: vi.fn(),
  upsertDocument: vi.fn(),
  uploadAttachment: vi.fn(),
}));

const mockExecutionWorkspacesApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockAccessApi = vi.hoisted(() => ({
  listMyEffectivePermissions: vi.fn(),
}));

const mockDepartmentsApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockProjectsApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockAgentsApi = vi.hoisted(() => ({
  list: vi.fn(),
  adapterModels: vi.fn(),
}));

const mockAuthApi = vi.hoisted(() => ({
  getSession: vi.fn(),
}));

const mockAssetsApi = vi.hoisted(() => ({
  uploadImage: vi.fn(),
}));

const mockInstanceSettingsApi = vi.hoisted(() => ({
  getExperimental: vi.fn(),
}));

vi.mock("../context/DialogContext", () => ({
  useDialog: () => dialogState,
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => companyState,
}));

vi.mock("../context/ToastContext", () => ({
  useToast: () => toastState,
}));

vi.mock("../api/issues", () => ({
  issuesApi: mockIssuesApi,
}));

vi.mock("../api/execution-workspaces", () => ({
  executionWorkspacesApi: mockExecutionWorkspacesApi,
}));

vi.mock("../api/access", () => ({
  accessApi: mockAccessApi,
}));

vi.mock("../api/departments", () => ({
  departmentsApi: mockDepartmentsApi,
}));

vi.mock("../api/projects", () => ({
  projectsApi: mockProjectsApi,
}));

vi.mock("../api/agents", () => ({
  agentsApi: mockAgentsApi,
}));

vi.mock("../api/auth", () => ({
  authApi: mockAuthApi,
}));

vi.mock("../api/assets", () => ({
  assetsApi: mockAssetsApi,
}));

vi.mock("../api/instanceSettings", () => ({
  instanceSettingsApi: mockInstanceSettingsApi,
}));

vi.mock("../hooks/useProjectOrder", () => ({
  useProjectOrder: ({ projects }: { projects: unknown[] }) => ({
    orderedProjects: projects,
  }),
}));

vi.mock("../lib/recent-assignees", () => ({
  getRecentAssigneeIds: () => [],
  sortAgentsByRecency: (agents: unknown[]) => agents,
  trackRecentAssignee: vi.fn(),
}));

vi.mock("../lib/assignees", () => ({
  assigneeValueFromSelection: ({
    assigneeAgentId,
    assigneeUserId,
  }: {
    assigneeAgentId?: string;
    assigneeUserId?: string;
  }) => assigneeAgentId ? `agent:${assigneeAgentId}` : assigneeUserId ? `user:${assigneeUserId}` : "",
  currentUserAssigneeOption: () => [],
  parseAssigneeValue: (value: string) => ({
    assigneeAgentId: value.startsWith("agent:") ? value.slice("agent:".length) : null,
    assigneeUserId: value.startsWith("user:") ? value.slice("user:".length) : null,
  }),
}));

vi.mock("./MarkdownEditor", async () => {
  const React = await import("react");
  return {
    MarkdownEditor: React.forwardRef<
      { focus: () => void },
      {
        value: string;
        onChange?: (value: string) => void;
        placeholder?: string;
        mentions?: Array<{ id: string; name: string }>;
      }
    >(function MarkdownEditorMock({ value, onChange, placeholder, mentions }, ref) {
      React.useImperativeHandle(ref, () => ({
        focus: () => undefined,
      }));
      return (
        <div>
          <textarea
            aria-label={placeholder ?? "Description"}
            value={value}
            onChange={(event) => onChange?.(event.target.value)}
          />
          <div data-testid="issue-mentions">{(mentions ?? []).map((mention) => mention.name).join("|")}</div>
        </div>
      );
    }),
  };
});

vi.mock("./InlineEntitySelector", async () => {
  const React = await import("react");
  return {
    InlineEntitySelector: React.forwardRef<
      HTMLButtonElement,
      {
        value: string;
        options?: Array<{ id: string; label: string }>;
        placeholder?: string;
        renderTriggerValue?: (option: { id: string; label: string } | null) => ReactNode;
      }
    >(function InlineEntitySelectorMock({ value, options, placeholder, renderTriggerValue }, ref) {
      return (
        <div>
          <button ref={ref} type="button">
            {(renderTriggerValue?.(value ? { id: value, label: value } : null) ?? value) || placeholder}
          </button>
          <div data-testid="inline-options">{(options ?? []).map((option) => option.label).join("|")}</div>
        </div>
      );
    }),
  };
});

vi.mock("./AgentIconPicker", () => ({
  AgentIcon: () => null,
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) => (open ? <div>{children}</div> : null),
  DialogContent: ({
    children,
    showCloseButton: _showCloseButton,
    onEscapeKeyDown: _onEscapeKeyDown,
    onPointerDownOutside: _onPointerDownOutside,
    ...props
  }: ComponentProps<"div"> & {
    showCloseButton?: boolean;
    onEscapeKeyDown?: (event: unknown) => void;
    onPointerDownOutside?: (event: unknown) => void;
  }) => <div {...props}>{children}</div>,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, onClick, type = "button", ...props }: ComponentProps<"button">) => (
    <button type={type} onClick={onClick} {...props}>{children}</button>
  ),
}));

vi.mock("@/components/ui/toggle-switch", () => ({
  ToggleSwitch: ({ checked, onCheckedChange }: { checked: boolean; onCheckedChange: () => void }) => (
    <button type="button" aria-pressed={checked} onClick={onCheckedChange}>toggle</button>
  ),
}));

vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function waitForAssertion(assertion: () => void, attempts = 20) {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await flush();
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Assertion did not pass in time");
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function renderDialog(container: HTMLDivElement) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const root = createRoot(container);
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <NewIssueDialog />
      </QueryClientProvider>,
    );
  });
  return { root, queryClient };
}

describe("NewIssueDialog", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    window.localStorage.clear();
    dialogState.newIssueOpen = true;
    dialogState.newIssueDefaults = {};
    dialogState.closeNewIssue.mockReset();
    toastState.pushToast.mockReset();
    mockIssuesApi.create.mockReset();
    mockIssuesApi.upsertDocument.mockReset();
    mockIssuesApi.uploadAttachment.mockReset();
    mockExecutionWorkspacesApi.list.mockResolvedValue([]);
    mockAccessApi.listMyEffectivePermissions.mockResolvedValue([
      {
        permissionKey: "issues:manage",
        companyWide: true,
        departmentIds: [],
      },
    ]);
    mockDepartmentsApi.list.mockResolvedValue([]);
    mockProjectsApi.list.mockResolvedValue([
      {
        id: "project-1",
        name: "Alpha",
        description: null,
        archivedAt: null,
        color: "#445566",
      },
    ]);
    mockAgentsApi.list.mockResolvedValue([]);
    mockAgentsApi.adapterModels.mockResolvedValue([]);
    mockAuthApi.getSession.mockResolvedValue({ user: { id: "user-1" } });
    mockAssetsApi.uploadImage.mockResolvedValue({ contentPath: "/uploads/asset.png" });
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableIsolatedWorkspaces: false });
    mockIssuesApi.create.mockResolvedValue({
      id: "issue-2",
      companyId: "company-1",
      identifier: "PAP-2",
    });
  });

  afterEach(() => {
    window.localStorage.clear();
    document.body.innerHTML = "";
  });

  it("shows sub-issue context only when opened from a sub-issue action", async () => {
    dialogState.newIssueDefaults = {
      parentId: "issue-1",
      parentIdentifier: "PAP-1",
      parentTitle: "Parent issue",
      projectId: "project-1",
      goalId: "goal-1",
    };

    const { root } = renderDialog(container);
    await flush();

    expect(container.textContent).toContain("New sub-issue");
    expect(container.textContent).toContain("Sub-issue of");
    expect(container.textContent).toContain("PAP-1");
    expect(container.textContent).toContain("Parent issue");
    expect(container.textContent).toContain("Create Sub-Issue");

    act(() => root.unmount());

    dialogState.newIssueDefaults = {};
    const rerendered = renderDialog(container);
    await flush();

    expect(container.textContent).toContain("New issue");
    expect(container.textContent).toContain("Create Issue");
    expect(container.textContent).not.toContain("Sub-issue of");

    act(() => rerendered.root.unmount());
  });

  it("submits parent and goal context for sub-issues", async () => {
    mockProjectsApi.list.mockResolvedValue([
      {
        id: "project-1",
        name: "Alpha",
        description: null,
        archivedAt: null,
        color: "#445566",
        executionWorkspacePolicy: {
          enabled: true,
          defaultMode: "shared_workspace",
        },
      },
    ]);
    mockExecutionWorkspacesApi.list.mockResolvedValue([
      {
        id: "workspace-1",
        name: "Parent workspace",
        status: "active",
        branchName: "feature/pap-1",
        cwd: "/tmp/workspace-1",
        lastUsedAt: new Date("2026-04-06T16:00:00.000Z"),
      },
    ]);
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableIsolatedWorkspaces: true });
    dialogState.newIssueDefaults = {
      parentId: "issue-1",
      parentIdentifier: "PAP-1",
      parentTitle: "Parent issue",
      title: "Child issue",
      projectId: "project-1",
      executionWorkspaceId: "workspace-1",
      goalId: "goal-1",
    };

    const { root } = renderDialog(container);
    await flush();

    const submitButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Create Sub-Issue"));
    expect(submitButton).not.toBeUndefined();
    expect(submitButton?.hasAttribute("disabled")).toBe(false);

    await act(async () => {
      submitButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(mockIssuesApi.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        title: "Child issue",
        parentId: "issue-1",
        goalId: "goal-1",
        projectId: "project-1",
        executionWorkspaceId: "workspace-1",
      }),
    );

    act(() => root.unmount());
  });

  it("warns when a sub-issue stops matching the parent workspace", async () => {
    mockProjectsApi.list.mockResolvedValue([
      {
        id: "project-1",
        name: "Alpha",
        description: null,
        archivedAt: null,
        color: "#445566",
        executionWorkspacePolicy: {
          enabled: true,
          defaultMode: "shared_workspace",
        },
      },
    ]);
    mockExecutionWorkspacesApi.list.mockResolvedValue([
      {
        id: "workspace-1",
        name: "Parent workspace",
        status: "active",
        branchName: "feature/pap-1",
        cwd: "/tmp/workspace-1",
        lastUsedAt: new Date("2026-04-06T16:00:00.000Z"),
      },
      {
        id: "workspace-2",
        name: "Other workspace",
        status: "active",
        branchName: "feature/pap-2",
        cwd: "/tmp/workspace-2",
        lastUsedAt: new Date("2026-04-06T16:01:00.000Z"),
      },
    ]);
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableIsolatedWorkspaces: true });
    dialogState.newIssueDefaults = {
      parentId: "issue-1",
      parentIdentifier: "PAP-1",
      parentTitle: "Parent issue",
      title: "Child issue",
      projectId: "project-1",
      executionWorkspaceId: "workspace-1",
      parentExecutionWorkspaceLabel: "Parent workspace",
      goalId: "goal-1",
    };

    const { root } = renderDialog(container);
    await flush();

    expect(container.textContent).not.toContain("will no longer use the parent issue workspace");

    let modeSelect: HTMLSelectElement | undefined;
    await waitForAssertion(() => {
      const selects = Array.from(container.querySelectorAll("select"));
      modeSelect = selects[0] as HTMLSelectElement | undefined;
      expect(modeSelect).not.toBeUndefined();
    });

    await act(async () => {
      modeSelect!.value = "shared_workspace";
      modeSelect!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();

    expect(container.textContent).toContain("will no longer use the parent issue workspace");
    expect(container.textContent).toContain("Parent workspace");

    act(() => root.unmount());
  });

  it("requires a department when issue manage access is department-scoped", async () => {
    mockAccessApi.listMyEffectivePermissions.mockResolvedValue([
      {
        permissionKey: "issues:manage",
        companyWide: false,
        departmentIds: ["dept-1", "dept-2"],
      },
    ]);
    mockDepartmentsApi.list.mockResolvedValue([
      { id: "dept-1", companyId: "company-1", name: "Engineering", description: null, parentId: null, status: "active", sortOrder: 0, createdAt: "", updatedAt: "" },
      { id: "dept-2", companyId: "company-1", name: "Finance", description: null, parentId: null, status: "active", sortOrder: 1, createdAt: "", updatedAt: "" },
    ]);
    dialogState.newIssueDefaults = {
      title: "Scoped issue",
    };

    const { root } = renderDialog(container);
    await flush();

    const submitButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Create Issue"));
    await waitForAssertion(() => {
      expect(submitButton?.hasAttribute("disabled")).toBe(true);
    });

    act(() => root.unmount());
  });

  it("includes the selected department in the create payload", async () => {
    mockAccessApi.listMyEffectivePermissions.mockResolvedValue([
      {
        permissionKey: "issues:manage",
        companyWide: false,
        departmentIds: ["dept-1"],
      },
    ]);
    mockDepartmentsApi.list.mockResolvedValue([
      { id: "dept-1", companyId: "company-1", name: "Engineering", description: null, parentId: null, status: "active", sortOrder: 0, createdAt: "", updatedAt: "" },
    ]);
    dialogState.newIssueDefaults = {
      title: "Scoped issue",
    };

    const { root } = renderDialog(container);
    await flush();

    const submitButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Create Issue"));
    expect(submitButton).not.toBeUndefined();
    await waitForAssertion(() => {
      expect(submitButton?.hasAttribute("disabled")).toBe(false);
    });

    await act(async () => {
      submitButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(mockIssuesApi.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        title: "Scoped issue",
        departmentId: "dept-1",
      }),
    );

    act(() => root.unmount());
  });

  it("keeps submit disabled while scoped permissions are still loading", async () => {
    const permissions = createDeferred<Array<{
      permissionKey: string;
      companyWide: boolean;
      departmentIds: string[];
    }>>();
    mockAccessApi.listMyEffectivePermissions.mockReturnValue(permissions.promise);
    mockDepartmentsApi.list.mockResolvedValue([
      { id: "dept-1", companyId: "company-1", name: "Engineering", description: null, parentId: null, status: "active", sortOrder: 0, createdAt: "", updatedAt: "" },
    ]);
    dialogState.newIssueDefaults = {
      title: "Scoped issue",
    };

    const { root } = renderDialog(container);
    await flush();

    const submitButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Create Issue"));
    expect(submitButton).not.toBeUndefined();
    expect(submitButton?.hasAttribute("disabled")).toBe(true);

    await act(async () => {
      permissions.resolve([
        {
          permissionKey: "issues:manage",
          companyWide: false,
          departmentIds: ["dept-1"],
        },
      ]);
    });

    await waitForAssertion(() => {
      expect(submitButton?.hasAttribute("disabled")).toBe(false);
    });

    act(() => root.unmount());
  });

  it("filters assignee and project candidates to the active scoped department", async () => {
    mockAccessApi.listMyEffectivePermissions.mockResolvedValue([
      {
        permissionKey: "issues:manage",
        companyWide: false,
        departmentIds: ["dept-1"],
      },
      {
        permissionKey: "org:view",
        companyWide: false,
        departmentIds: ["dept-1"],
      },
    ]);
    mockProjectsApi.list.mockResolvedValue([
      {
        id: "project-1",
        name: "Engineering Roadmap",
        description: null,
        departmentId: "dept-1",
        archivedAt: null,
        color: "#445566",
      },
      {
        id: "project-2",
        name: "Finance Close",
        description: null,
        departmentId: "dept-2",
        archivedAt: null,
        color: "#667788",
      },
    ]);
    mockDepartmentsApi.list.mockResolvedValue([
      { id: "dept-1", companyId: "company-1", name: "Engineering", description: null, parentId: null, status: "active", sortOrder: 0, createdAt: "", updatedAt: "" },
      { id: "dept-2", companyId: "company-1", name: "Finance", description: null, parentId: null, status: "active", sortOrder: 1, createdAt: "", updatedAt: "" },
    ]);
    mockAgentsApi.list.mockResolvedValue([
      {
        id: "agent-1",
        companyId: "company-1",
        departmentId: "dept-1",
        name: "Eng Agent",
        role: "engineer",
        title: null,
        status: "active",
        icon: "bot",
      },
      {
        id: "agent-2",
        companyId: "company-1",
        departmentId: "dept-2",
        name: "Finance Agent",
        role: "engineer",
        title: null,
        status: "active",
        icon: "bot",
      },
    ]);

    const { root } = renderDialog(container);
    await flush();

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Eng Agent");
      expect(container.textContent).toContain("Engineering Roadmap");
      expect(container.textContent).not.toContain("Finance Agent");
      expect(container.textContent).not.toContain("Finance Close");
    });

    act(() => root.unmount());
  });
});
