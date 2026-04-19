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
  currentUserAssigneeOption: (currentUserId: string | null | undefined) =>
    currentUserId ? [{ id: `user:${currentUserId}`, label: "Me" }] : [],
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
      { value: string; onChange?: (value: string) => void; placeholder?: string }
    >(function MarkdownEditorMock({ value, onChange, placeholder }, ref) {
      React.useImperativeHandle(ref, () => ({
        focus: () => undefined,
      }));
      return (
        <textarea
          aria-label={placeholder ?? "Description"}
          value={value}
          onChange={(event) => onChange?.(event.target.value)}
        />
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
        onChange?: (value: string) => void;
        renderTriggerValue?: (option: { id: string; label: string } | null) => ReactNode;
      }
    >(function InlineEntitySelectorMock({ value, options = [], placeholder, onChange, renderTriggerValue }, ref) {
      return (
        <div>
          <button ref={ref} type="button">
            {(renderTriggerValue?.(value ? { id: value, label: value } : null) ?? value) || placeholder}
          </button>
          <select
            aria-label={placeholder ?? "Selector"}
            value={value}
            onChange={(event) => onChange?.(event.target.value)}
          >
            <option value="">{placeholder ?? "None"}</option>
            {options.map((option) => (
              <option key={option.id} value={option.id}>{option.label}</option>
            ))}
          </select>
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

async function waitForExpectation(assertion: () => void) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 25; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await flush();
    }
  }
  throw lastError;
}

function changeInputValue(input: HTMLInputElement, value: string) {
  const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  valueSetter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
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
    localStorage.clear();
    dialogState.newIssueOpen = true;
    dialogState.newIssueDefaults = {};
    dialogState.closeNewIssue.mockReset();
    toastState.pushToast.mockReset();
    mockIssuesApi.create.mockReset();
    mockIssuesApi.upsertDocument.mockReset();
    mockIssuesApi.uploadAttachment.mockReset();
    mockExecutionWorkspacesApi.list.mockResolvedValue([]);
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
    document.body.innerHTML = "";
    localStorage.clear();
  });

  it("shows sub-issue context only when opened from a sub-issue action", async () => {
    dialogState.newIssueDefaults = {
      parentId: "issue-1",
      parentIdentifier: "PAP-1",
      parentTitle: "Parent task",
      projectId: "project-1",
      goalId: "goal-1",
    };

    const { root } = renderDialog(container);
    await flush();

    expect(container.textContent).toContain("New sub-task");
    expect(container.textContent).toContain("Sub-task of");
    expect(container.textContent).toContain("PAP-1");
    expect(container.textContent).toContain("Parent task");
    expect(container.textContent).toContain("Create Sub-task");

    act(() => root.unmount());

    dialogState.newIssueDefaults = {};
    const rerendered = renderDialog(container);
    await flush();

    expect(container.textContent).toContain("New task");
    expect(container.textContent).toContain("Create Task");
    expect(container.textContent).not.toContain("Sub-task of");

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
      parentTitle: "Parent task",
      title: "Child task",
      projectId: "project-1",
      executionWorkspaceId: "workspace-1",
      goalId: "goal-1",
    };

    const { root } = renderDialog(container);
    await flush();

    const submitButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Create Sub-task"));
    expect(submitButton).not.toBeUndefined();
    expect(submitButton?.hasAttribute("disabled")).toBe(false);

    await act(async () => {
      submitButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(mockIssuesApi.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        title: "Child task",
        parentId: "issue-1",
        goalId: "goal-1",
        projectId: "project-1",
        executionWorkspaceId: "workspace-1",
      }),
    );

    act(() => root.unmount());
  });

  it("submits a selected due date", async () => {
    dialogState.newIssueDefaults = {
      title: "Due task",
    };

    const { root } = renderDialog(container);
    await flush();

    const dueDateInput = container.querySelector('input[aria-label="Due date"]') as HTMLInputElement | null;
    expect(dueDateInput).not.toBeNull();

    await act(async () => {
      changeInputValue(dueDateInput!, "2026-05-01");
    });
    await flush();

    const submitButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Create Task"));
    expect(submitButton).not.toBeUndefined();

    await act(async () => {
      submitButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(mockIssuesApi.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        title: "Due task",
        dueDate: "2026-05-01",
      }),
    );

    act(() => root.unmount());
  });

  it("defaults an unassigned in-progress task to the current board user", async () => {
    dialogState.newIssueDefaults = {
      title: "Started task",
      status: "in_progress",
    };

    const { root } = renderDialog(container);
    await flush();

    const assigneeSelect = container.querySelector('select[aria-label="Assignee"]') as HTMLSelectElement | null;
    await waitForExpectation(() => {
      expect(assigneeSelect?.value).toBe("user:user-1");
    });

    const submitButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Create Task"));
    expect(submitButton).not.toBeUndefined();

    await act(async () => {
      submitButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(mockIssuesApi.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        title: "Started task",
        status: "in_progress",
        assigneeUserId: "user-1",
      }),
    );

    act(() => root.unmount());
  });

  it("keeps an explicit agent assignee for an in-progress task", async () => {
    mockAgentsApi.list.mockResolvedValue([
      {
        id: "agent-1",
        companyId: "company-1",
        name: "Engineer",
        role: "engineer",
        status: "active",
        icon: "code",
      },
    ]);
    dialogState.newIssueDefaults = {
      title: "Agent-started task",
      status: "in_progress",
      assigneeAgentId: "agent-1",
    };

    const { root } = renderDialog(container);
    await flush();

    const assigneeSelect = container.querySelector('select[aria-label="Assignee"]') as HTMLSelectElement | null;
    await waitForExpectation(() => {
      expect(assigneeSelect?.value).toBe("agent:agent-1");
    });

    const submitButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Create Task"));
    expect(submitButton).not.toBeUndefined();

    await act(async () => {
      submitButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    const payload = mockIssuesApi.create.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(payload).toMatchObject({
      title: "Agent-started task",
      status: "in_progress",
      assigneeAgentId: "agent-1",
    });
    expect(payload.assigneeUserId).toBeUndefined();

    act(() => root.unmount());
  });

  it("uses the current board user instead of a project lead for ordinary project tasks", async () => {
    mockProjectsApi.list.mockResolvedValue([
      {
        id: "project-1",
        name: "Mission Control",
        description: null,
        archivedAt: null,
        color: "#445566",
        leadAgentId: "agent-ceo",
      },
    ]);
    mockAgentsApi.list.mockResolvedValue([
      {
        id: "agent-ceo",
        companyId: "company-1",
        name: "CEO",
        role: "ceo",
        status: "active",
        icon: "briefcase",
      },
    ]);
    dialogState.newIssueDefaults = {
      title: "Project lead task",
      status: "in_progress",
      projectId: "project-1",
    };

    const { root } = renderDialog(container);
    await flush();

    const assigneeSelect = container.querySelector('select[aria-label="Assignee"]') as HTMLSelectElement | null;
    await waitForExpectation(() => {
      expect(assigneeSelect?.value).toBe("user:user-1");
    });

    const submitButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Create Task"));
    expect(submitButton).not.toBeUndefined();

    await act(async () => {
      submitButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    const payload = mockIssuesApi.create.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(payload).toMatchObject({
      title: "Project lead task",
      status: "in_progress",
      projectId: "project-1",
      assigneeUserId: "user-1",
    });
    expect(payload.assigneeAgentId).toBeUndefined();

    act(() => root.unmount());
  });

  it("defaults a normal todo task to the current board user", async () => {
    dialogState.newIssueDefaults = {
      title: "Todo task",
      status: "todo",
    };

    const { root } = renderDialog(container);
    await flush();

    const assigneeSelect = container.querySelector('select[aria-label="Assignee"]') as HTMLSelectElement | null;
    await waitForExpectation(() => {
      expect(assigneeSelect?.value).toBe("user:user-1");
    });

    const submitButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Create Task"));
    expect(submitButton).not.toBeUndefined();

    await act(async () => {
      submitButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    const payload = mockIssuesApi.create.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(payload).toMatchObject({
      title: "Todo task",
      status: "todo",
      assigneeUserId: "user-1",
    });
    expect(payload.assigneeAgentId).toBeUndefined();

    act(() => root.unmount());
  });

  it("keeps a manually cleared assignee unassigned on submit", async () => {
    dialogState.newIssueDefaults = {
      title: "Cleared assignee task",
      status: "todo",
    };

    const { root } = renderDialog(container);
    await flush();

    const assigneeSelect = container.querySelector('select[aria-label="Assignee"]') as HTMLSelectElement | null;
    await waitForExpectation(() => {
      expect(assigneeSelect?.value).toBe("user:user-1");
    });

    await act(async () => {
      assigneeSelect!.value = "";
      assigneeSelect!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();

    expect(assigneeSelect?.value).toBe("");

    const submitButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Create Task"));
    expect(submitButton).not.toBeUndefined();

    await act(async () => {
      submitButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    const payload = mockIssuesApi.create.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(payload).toMatchObject({
      title: "Cleared assignee task",
      status: "todo",
    });
    expect(payload.assigneeAgentId).toBeUndefined();
    expect(payload.assigneeUserId).toBeUndefined();

    act(() => root.unmount());
  });

  it("restores and clears a draft due date", async () => {
    localStorage.setItem("paperclip:issue-draft", JSON.stringify({
      title: "Draft due task",
      description: "",
      dueDate: "2026-05-02",
      status: "todo",
      priority: "",
      assigneeValue: "",
      reviewerValue: "",
      approverValue: "",
      projectId: "",
      projectWorkspaceId: "",
      assigneeModelOverride: "",
      assigneeThinkingEffort: "",
      assigneeChrome: false,
      executionWorkspaceMode: "shared_workspace",
      selectedExecutionWorkspaceId: "",
    }));

    const { root } = renderDialog(container);
    await flush();

    const dueDateInput = container.querySelector('input[aria-label="Due date"]') as HTMLInputElement | null;
    expect(dueDateInput?.value).toBe("2026-05-02");

    const clearButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Clear due date"));
    expect(clearButton).not.toBeUndefined();

    await act(async () => {
      clearButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(dueDateInput?.value).toBe("");

    act(() => root.unmount());
  });

  it("restores a draft with a manually cleared assignee as unassigned", async () => {
    localStorage.setItem("paperclip:issue-draft", JSON.stringify({
      title: "Draft cleared assignee task",
      description: "",
      dueDate: "",
      status: "todo",
      priority: "",
      assigneeValue: "",
      assigneeManuallyEdited: true,
      reviewerValue: "",
      approverValue: "",
      projectId: "",
      projectWorkspaceId: "",
      assigneeModelOverride: "",
      assigneeThinkingEffort: "",
      assigneeChrome: false,
      executionWorkspaceMode: "shared_workspace",
      selectedExecutionWorkspaceId: "",
    }));

    const { root } = renderDialog(container);
    await flush();

    const assigneeSelect = container.querySelector('select[aria-label="Assignee"]') as HTMLSelectElement | null;
    await waitForExpectation(() => {
      expect(assigneeSelect?.value).toBe("");
    });

    const submitButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Create Task"));
    expect(submitButton).not.toBeUndefined();

    await act(async () => {
      submitButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    const payload = mockIssuesApi.create.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(payload).toMatchObject({
      title: "Draft cleared assignee task",
      status: "todo",
    });
    expect(payload.assigneeAgentId).toBeUndefined();
    expect(payload.assigneeUserId).toBeUndefined();

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
      parentTitle: "Parent task",
      title: "Child task",
      projectId: "project-1",
      executionWorkspaceId: "workspace-1",
      parentExecutionWorkspaceLabel: "Parent workspace",
      goalId: "goal-1",
    };

    const { root } = renderDialog(container);
    await flush();

    expect(container.textContent).not.toContain("will no longer use the parent task workspace");

    let modeSelect: HTMLSelectElement | undefined;
    await waitForExpectation(() => {
      modeSelect = Array.from(container.querySelectorAll("select"))
        .find((select) => Array.from(select.options).some((option) => option.value === "shared_workspace")) as HTMLSelectElement | undefined;
      expect(modeSelect).not.toBeUndefined();
    });

    await act(async () => {
      modeSelect!.value = "shared_workspace";
      modeSelect!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();

    expect(container.textContent).toContain("will no longer use the parent task workspace");
    expect(container.textContent).toContain("Parent workspace");

    act(() => root.unmount());
  });

  it("keeps the current board user when selecting a project with a lead agent", async () => {
    mockProjectsApi.list.mockResolvedValue([
      {
        id: "project-1",
        name: "Mission Control",
        description: null,
        archivedAt: null,
        color: "#445566",
        leadAgentId: "agent-ceo",
      },
    ]);
    mockAgentsApi.list.mockResolvedValue([
      {
        id: "agent-ceo",
        companyId: "company-1",
        name: "CEO",
        role: "ceo",
        status: "active",
        icon: "briefcase",
      },
    ]);

    const { root } = renderDialog(container);
    await flush();

    const projectSelect = container.querySelector('select[aria-label="Project"]') as HTMLSelectElement | null;
    const assigneeSelect = container.querySelector('select[aria-label="Assignee"]') as HTMLSelectElement | null;

    expect(projectSelect).not.toBeNull();
    expect(assigneeSelect).not.toBeNull();
    await waitForExpectation(() => {
      expect(Array.from(projectSelect!.options).some((option) => option.value === "project-1")).toBe(true);
    });
    await waitForExpectation(() => {
      expect(assigneeSelect?.value).toBe("user:user-1");
    });

    await act(async () => {
      projectSelect!.value = "project-1";
      projectSelect!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();

    await waitForExpectation(() => {
      expect(assigneeSelect?.value).toBe("user:user-1");
    });

    act(() => root.unmount());
  });
});
