// @vitest-environment jsdom

import type { ComponentProps, ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NewIssueDialog } from "./NewIssueDialog";

const dialogState = vi.hoisted(() => ({
  newIssueOpen: true,
  newIssueDefaults: {} as Record<string, unknown>,
  closeNewIssue: vi.fn(),
}));

const dialogContentState = vi.hoisted(() => ({
  onPointerDownOutside: null as null | ((event: {
    detail: { originalEvent: { target: EventTarget | null } };
    preventDefault: () => void;
  }) => void),
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
  listSummaries: vi.fn(),
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
  useToastActions: () => toastState,
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
        placeholder?: string;
        renderTriggerValue?: (option: { id: string; label: string } | null) => ReactNode;
      }
    >(function InlineEntitySelectorMock({ value, placeholder, renderTriggerValue }, ref) {
      return (
        <button ref={ref} type="button">
          {(renderTriggerValue?.(value ? { id: value, label: value } : null) ?? value) || placeholder}
        </button>
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
    onPointerDownOutside,
    ...props
  }: ComponentProps<"div"> & {
    showCloseButton?: boolean;
    onEscapeKeyDown?: (event: unknown) => void;
    onPointerDownOutside?: (event: unknown) => void;
  }) => {
    dialogContentState.onPointerDownOutside = onPointerDownOutside as typeof dialogContentState.onPointerDownOutside;
    return <div {...props}>{children}</div>;
  },
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
  PopoverContent: ({ children, disablePortal }: { children: ReactNode; disablePortal?: boolean }) => (
    <div data-disable-portal={String(Boolean(disablePortal))}>{children}</div>
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function act(callback: () => void | Promise<void>): void | Promise<void> {
  let result: unknown;
  flushSync(() => {
    result = callback();
  });
  return result && typeof (result as Promise<void>).then === "function"
    ? (result as Promise<void>).then(() => undefined)
    : undefined;
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function typeTextareaValue(textarea: HTMLTextAreaElement, value: string) {
  await act(async () => {
    const valueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    valueSetter?.call(textarea, value);
    textarea.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        data: value,
        inputType: "insertText",
      }),
    );
    textarea.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await flush();
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

  throw lastError;
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
  let originalResizeObserver: typeof ResizeObserver | undefined;

  beforeEach(() => {
    vi.useRealTimers();
    originalResizeObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    container = document.createElement("div");
    document.body.appendChild(container);
    dialogState.newIssueOpen = true;
    dialogState.newIssueDefaults = {};
    dialogState.closeNewIssue.mockReset();
    dialogContentState.onPointerDownOutside = null;
    toastState.pushToast.mockReset();
    mockIssuesApi.create.mockReset();
    mockIssuesApi.upsertDocument.mockReset();
    mockIssuesApi.uploadAttachment.mockReset();
    mockExecutionWorkspacesApi.list.mockReset();
    mockExecutionWorkspacesApi.listSummaries.mockReset();
    mockExecutionWorkspacesApi.listSummaries.mockResolvedValue([]);
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
    localStorage.clear();
    mockIssuesApi.create.mockResolvedValue({
      id: "issue-2",
      companyId: "company-1",
      identifier: "PAP-2",
    });
  });

  afterEach(() => {
    globalThis.ResizeObserver = originalResizeObserver!;
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

    expect(container.textContent).toContain("New sub-task");
    expect(container.textContent).toContain("Sub-task of");
    expect(container.textContent).toContain("PAP-1");
    expect(container.textContent).toContain("Parent issue");
    expect(container.textContent).toContain("Create Sub-Task");

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
    mockExecutionWorkspacesApi.listSummaries.mockResolvedValue([
      {
        id: "workspace-1",
        name: "Parent workspace",
        mode: "isolated_workspace",
        status: "active",
        branchName: "feature/pap-1",
        cwd: "/tmp/workspace-1",
        projectWorkspaceId: null,
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

    await waitForAssertion(() => {
      expect(mockExecutionWorkspacesApi.listSummaries).toHaveBeenCalledWith("company-1", {
        projectId: "project-1",
        projectWorkspaceId: undefined,
        reuseEligible: true,
      });
    });
    expect(mockExecutionWorkspacesApi.list).not.toHaveBeenCalled();

    const submitButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Create Sub-Task"));
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
        title: "Child issue",
        parentId: "issue-1",
        goalId: "goal-1",
        projectId: "project-1",
        executionWorkspaceId: "workspace-1",
        workMode: "standard",
      }),
    );

    act(() => root.unmount());
  });

  it("restores the planning mode from dialog defaults", async () => {
    dialogState.newIssueDefaults = {
      title: "Planned from defaults",
      workMode: "planning",
    };

    const { root } = renderDialog(container);
    await flush();

    const planningButton = container.querySelector('[data-issue-work-mode="planning"]');
    expect(planningButton?.className).toContain("bg-accent");

    const submitButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Create Task"));
    expect(submitButton).not.toBeUndefined();
    await vi.waitFor(() => {
      expect(submitButton?.hasAttribute("disabled")).toBe(false);
    });

    await act(async () => {
      submitButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(mockIssuesApi.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        title: "Planned from defaults",
        workMode: "planning",
      }),
    );

    act(() => root.unmount());
  });

  it("restores ask mode from dialog defaults", async () => {
    dialogState.newIssueDefaults = {
      title: "Question from defaults",
      workMode: "ask",
    };

    const { root } = renderDialog(container);
    await flush();

    const askButton = container.querySelector('[data-issue-work-mode="ask"]');
    expect(askButton?.className).toContain("bg-accent");

    const submitButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Create Task"));
    expect(submitButton).not.toBeUndefined();
    await vi.waitFor(() => {
      expect(submitButton?.hasAttribute("disabled")).toBe(false);
    });

    await act(async () => {
      submitButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(mockIssuesApi.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        title: "Question from defaults",
        workMode: "ask",
      }),
    );

    act(() => root.unmount());
  });

  it("applies project and execution workspace defaults for normal new issues", async () => {
    mockProjectsApi.list.mockResolvedValue([
      {
        id: "project-1",
        name: "Alpha",
        description: null,
        archivedAt: null,
        color: "#445566",
        workspaces: [
          {
            id: "project-workspace-1",
            name: "Primary",
            isPrimary: true,
          },
          {
            id: "project-workspace-2",
            name: "Isolated checkout",
            isPrimary: false,
          },
        ],
        executionWorkspacePolicy: {
          enabled: true,
          defaultMode: "shared_workspace",
        },
      },
    ]);
    mockExecutionWorkspacesApi.listSummaries.mockResolvedValue([
      {
        id: "workspace-1",
        name: "PAP-100",
        mode: "isolated_workspace",
        status: "active",
        branchName: "feature/pap-100",
        cwd: "/tmp/workspace-1",
        projectWorkspaceId: "project-workspace-2",
        lastUsedAt: new Date("2026-04-06T16:00:00.000Z"),
      },
    ]);
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableIsolatedWorkspaces: true });
    dialogState.newIssueDefaults = {
      title: "Follow-up issue",
      projectId: "project-1",
      projectWorkspaceId: "project-workspace-2",
      executionWorkspaceId: "workspace-1",
    };

    const { root } = renderDialog(container);
    await flush();

    expect(container.textContent).toContain("New task");
    expect(container.textContent).not.toContain("New sub-task");
    await waitForAssertion(() => {
      expect(container.textContent).toContain("Reusing PAP-100");
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
        title: "Follow-up issue",
        projectId: "project-1",
        projectWorkspaceId: "project-workspace-2",
        executionWorkspaceId: "workspace-1",
        executionWorkspacePreference: "reuse_existing",
        executionWorkspaceSettings: {
          mode: "isolated_workspace",
        },
      }),
    );

    act(() => root.unmount());
  });

  it("keeps the reusable workspace search popover inside the modal", async () => {
    mockProjectsApi.list.mockResolvedValue([
      {
        id: "project-1",
        name: "Alpha",
        description: null,
        archivedAt: null,
        color: "#445566",
        workspaces: [
          {
            id: "project-workspace-1",
            name: "Primary",
            isPrimary: true,
          },
        ],
        executionWorkspacePolicy: {
          enabled: true,
          defaultMode: "shared_workspace",
        },
      },
    ]);
    mockExecutionWorkspacesApi.listSummaries.mockResolvedValue([
      {
        id: "workspace-1",
        name: "PAP-11446-on-mobile-the-agent-chat",
        mode: "isolated_workspace",
        status: "active",
        branchName: "PAP-11446-on-mobile-the-agent-chat",
        cwd: "/tmp/workspace-1",
        projectWorkspaceId: "project-workspace-1",
        lastUsedAt: new Date("2026-04-06T16:00:00.000Z"),
      },
    ]);
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableIsolatedWorkspaces: true });
    dialogState.newIssueDefaults = {
      title: "Follow-up issue",
      projectId: "project-1",
      executionWorkspaceId: "workspace-1",
    };

    const { root } = renderDialog(container);
    await flush();

    await waitForAssertion(() => {
      const workspaceInput = container.querySelector('input[placeholder="Search workspaces..."]');
      expect(workspaceInput?.closest("[data-disable-portal]")?.getAttribute("data-disable-portal")).toBe("true");
    });

    act(() => root.unmount());
  });

  it("submits the latest locally typed title and description", async () => {
    let resolveProjects: (projects: Array<{
      id: string;
      name: string;
      description: string | null;
      archivedAt: string | null;
      color: string;
    }>) => void = () => undefined;
    mockProjectsApi.list.mockReturnValue(new Promise((resolve) => {
      resolveProjects = resolve;
    }));

    const { root } = renderDialog(container);
    await flush();

    const titleInput = container.querySelector('textarea[placeholder="Task title"]') as HTMLTextAreaElement | null;
    const descriptionInput = container.querySelector('textarea[aria-label="Add description..."]') as HTMLTextAreaElement | null;
    expect(titleInput).not.toBeNull();
    expect(descriptionInput).not.toBeNull();

    await typeTextareaValue(titleInput!, "Typed issue");
    await typeTextareaValue(descriptionInput!, "Typed description");

    await act(async () => {
      resolveProjects([
        {
          id: "project-1",
          name: "Alpha",
          description: null,
          archivedAt: null,
          color: "#445566",
        },
      ]);
      await Promise.resolve();
    });
    await flush();

    const submitButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Create Task"));
    expect(submitButton).not.toBeUndefined();
    await vi.waitFor(() => {
      expect(submitButton?.hasAttribute("disabled")).toBe(false);
    });

    await act(async () => {
      submitButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(mockIssuesApi.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        title: "Typed issue",
        description: "Typed description",
        workMode: "standard",
      }),
    );

    act(() => root.unmount());
  });

  it("submits Chinese, Japanese, and Hindi issue text without normalization", async () => {
    const title = "验证中文任务";
    const description = [
      "请用中文回复。",
      "日本語: 次の手順を書いてください。",
      "हिन्दी: कृपया स्थिति बताएं।",
    ].join("\n");

    const { root } = renderDialog(container);
    await flush();

    const titleInput = container.querySelector('textarea[placeholder="Task title"]') as HTMLTextAreaElement | null;
    const descriptionInput = container.querySelector('textarea[aria-label="Add description..."]') as HTMLTextAreaElement | null;
    expect(titleInput).not.toBeNull();
    expect(descriptionInput).not.toBeNull();

    await typeTextareaValue(titleInput!, title);
    await typeTextareaValue(descriptionInput!, description);

    const submitButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Create Task"));
    expect(submitButton).not.toBeUndefined();
    await vi.waitFor(() => {
      expect(submitButton?.hasAttribute("disabled")).toBe(false);
    });

    await act(async () => {
      submitButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(mockIssuesApi.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        title,
        description,
        workMode: "standard",
      }),
    );

    act(() => root.unmount());
  });

  it("submits planning work mode when planning is selected", async () => {
    const { root } = renderDialog(container);
    await flush();

    const titleInput = container.querySelector('textarea[placeholder="Task title"]') as HTMLTextAreaElement | null;
    expect(titleInput).not.toBeNull();
    await typeTextareaValue(titleInput!, "Plan this first");

    const planningButton = container.querySelector('[data-issue-work-mode="planning"]');
    expect(planningButton).not.toBeNull();
    await act(async () => {
      planningButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    const submitButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Create Task"));
    expect(submitButton).not.toBeUndefined();
    await vi.waitFor(() => {
      expect(submitButton?.hasAttribute("disabled")).toBe(false);
    });

    await act(async () => {
      submitButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(mockIssuesApi.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        title: "Plan this first",
        workMode: "planning",
      }),
    );

    act(() => root.unmount());
  });

  it("submits ask work mode when ask is selected", async () => {
    const { root } = renderDialog(container);
    await flush();

    const titleInput = container.querySelector('textarea[placeholder="Task title"]') as HTMLTextAreaElement | null;
    expect(titleInput).not.toBeNull();
    await typeTextareaValue(titleInput!, "Answer this first");

    const askButton = container.querySelector('[data-issue-work-mode="ask"]');
    expect(askButton).not.toBeNull();
    await act(async () => {
      askButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    const submitButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Create Task"));
    expect(submitButton).not.toBeUndefined();
    await vi.waitFor(() => {
      expect(submitButton?.hasAttribute("disabled")).toBe(false);
    });

    await act(async () => {
      submitButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(mockIssuesApi.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        title: "Answer this first",
        workMode: "ask",
      }),
    );

    act(() => root.unmount());
  });

  it("cycles work modes with cmd-period", async () => {
    const { root } = renderDialog(container);
    await flush();

    const modeChip = () => container.querySelector("[data-issue-work-mode-chip]");
    expect(modeChip()?.getAttribute("data-issue-work-mode-chip")).toBe("standard");

    await act(async () => {
      modeChip()?.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        code: "Period",
        key: ".",
        metaKey: true,
      }));
    });
    expect(modeChip()?.getAttribute("data-issue-work-mode-chip")).toBe("planning");

    await act(async () => {
      modeChip()?.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        code: "Period",
        key: ".",
        metaKey: true,
      }));
    });
    expect(modeChip()?.getAttribute("data-issue-work-mode-chip")).toBe("ask");

    await act(async () => {
      modeChip()?.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        code: "Period",
        key: ".",
        metaKey: true,
      }));
    });
    expect(modeChip()?.getAttribute("data-issue-work-mode-chip")).toBe("standard");

    act(() => root.unmount());
  });

  it("submits the parent assignee when a sub-issue opens with inherited defaults", async () => {
    dialogState.newIssueDefaults = {
      parentId: "issue-1",
      parentIdentifier: "PAP-1",
      parentTitle: "Parent issue",
      title: "Child issue",
      projectId: "project-1",
      goalId: "goal-1",
      assigneeAgentId: "agent-1",
    };

    const { root } = renderDialog(container);
    await flush();

    const submitButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Create Sub-Task"));
    expect(submitButton).not.toBeUndefined();

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
        assigneeAgentId: "agent-1",
      }),
    );

    act(() => root.unmount());
  });

  it("keeps the mobile dialog bounded with an internal flexible scroll region", async () => {
    const { root } = renderDialog(container);
    await flush();

    const dialogContent = Array.from(container.querySelectorAll("div")).find((element) =>
      typeof element.className === "string" && element.className.includes("max-h-[var(--new-issue-dialog-height)]"),
    );
    expect(dialogContent?.className).toContain("h-[var(--new-issue-dialog-height)]");
    expect(dialogContent?.className).toContain("overflow-hidden");
    expect(dialogContent?.getAttribute("style")).toContain("env(safe-area-inset-top)");
    expect(dialogContent?.getAttribute("style")).toContain("env(safe-area-inset-bottom)");

    const titleInput = container.querySelector('textarea[placeholder="Task title"]');
    const descriptionInput = container.querySelector('textarea[aria-label="Add description..."]');
    const bodyScrollRegion = Array.from(container.querySelectorAll("div")).find((element) =>
      typeof element.className === "string" && element.className.includes("overscroll-contain"),
    );
    expect(bodyScrollRegion?.className).toContain("flex-1");
    expect(bodyScrollRegion?.className).toContain("overflow-y-auto");
    expect(bodyScrollRegion?.contains(titleInput ?? null)).toBe(true);
    expect(bodyScrollRegion?.contains(descriptionInput ?? null)).toBe(true);

    act(() => root.unmount());
  });

  it("keeps priority under the mobile overflow menu", async () => {
    const { root } = renderDialog(container);
    await flush();

    const priorityChip = container.querySelector('[data-testid="new-issue-priority-chip"]');
    expect(priorityChip?.className).toContain("hidden");
    expect(priorityChip?.className).toContain("sm:inline-flex");

    const highPriorityOption = container.querySelector('[data-testid="new-issue-more-priority-high"]');
    expect(highPriorityOption?.textContent).toContain("High");

    await act(async () => {
      highPriorityOption?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    const selectedHighPriorityOption = container.querySelector('[data-testid="new-issue-more-priority-high"]');
    expect(selectedHighPriorityOption?.className).toContain("bg-accent");

    act(() => root.unmount());
  });

  it("allows editor autocomplete portal pointer events inside the modal", async () => {
    const { root } = renderDialog(container);
    await flush();

    const menu = document.createElement("div");
    menu.setAttribute("data-paperclip-floating-ui", "");
    const option = document.createElement("button");
    menu.appendChild(option);
    document.body.appendChild(menu);
    const preventDefault = vi.fn();

    dialogContentState.onPointerDownOutside?.({
      detail: { originalEvent: { target: option } },
      preventDefault,
    });

    expect(preventDefault).toHaveBeenCalledTimes(1);

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
    mockExecutionWorkspacesApi.listSummaries.mockResolvedValue([
      {
        id: "workspace-1",
        name: "Parent workspace",
        mode: "isolated_workspace",
        status: "active",
        branchName: "feature/pap-1",
        cwd: "/tmp/workspace-1",
        projectWorkspaceId: null,
        lastUsedAt: new Date("2026-04-06T16:00:00.000Z"),
      },
      {
        id: "workspace-2",
        name: "Other workspace",
        mode: "isolated_workspace",
        status: "active",
        branchName: "feature/pap-2",
        cwd: "/tmp/workspace-2",
        projectWorkspaceId: null,
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
    await flush();

    expect(container.textContent).not.toContain("will no longer use the parent task workspace");

    const selects = Array.from(container.querySelectorAll("select"));
    const modeSelect = selects[0] as HTMLSelectElement | undefined;
    expect(modeSelect).not.toBeUndefined();

    await act(async () => {
      modeSelect!.value = "shared_workspace";
      modeSelect!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();

    expect(container.textContent).toContain("will no longer use the parent task workspace");
    expect(container.textContent).toContain("Parent workspace");

    act(() => root.unmount());
  });

  it("reveals the watchdog editor from the overflow menu", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({
      enableIsolatedWorkspaces: false,
      enableTaskWatchdogs: true,
    });

    const { root } = renderDialog(container);
    await flush();

    // The watchdog row is hidden until the menu item is toggled on.
    expect(container.querySelector('textarea[placeholder^="What should the watchdog"]')).toBeNull();

    const watchdogMenuItem = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.trim() === "Watchdog");
    expect(watchdogMenuItem).not.toBeUndefined();

    await act(async () => {
      watchdogMenuItem!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(container.textContent).toContain("Set watchdog");
    expect(container.querySelector('textarea[placeholder^="What should the watchdog"]')).not.toBeNull();

    act(() => root.unmount());
  });

  it("submits the configured watchdog from a restored draft", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({
      enableIsolatedWorkspaces: false,
      enableTaskWatchdogs: true,
    });
    localStorage.setItem(
      "paperclip:issue-draft",
      JSON.stringify({
        title: "Watched task",
        description: "",
        status: "todo",
        priority: "medium",
        assigneeValue: "",
        reviewerValue: "",
        approverValue: "",
        watchdogAgentId: "agent-9",
        watchdogInstructions: "Keep it moving",
        projectId: "",
        assigneeModelOverride: "",
        assigneeThinkingEffort: "",
        assigneeChrome: false,
        workMode: "standard",
      }),
    );

    const { root } = renderDialog(container);
    await flush();

    expect(container.textContent).toContain("Keep it moving");

    const submitButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Create Task"));
    expect(submitButton).not.toBeUndefined();
    await vi.waitFor(() => {
      expect(submitButton?.hasAttribute("disabled")).toBe(false);
    });

    await act(async () => {
      submitButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(mockIssuesApi.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        title: "Watched task",
        watchdog: { agentId: "agent-9", instructions: "Keep it moving" },
      }),
    );

    act(() => root.unmount());
  });

  describe("graduated work-mode labels and status hues", () => {
    function workModeOption(value: string) {
      return container.querySelector(`[data-issue-work-mode="${value}"]`);
    }

    function statusOptionIconClass(label: string, description?: string) {
      const button = Array.from(container.querySelectorAll("button")).find((candidate) => {
        const text = candidate.textContent ?? "";
        return (
          candidate.querySelector("svg") !== null &&
          text.includes(label) &&
          (description === undefined || text.includes(description))
        );
      });
      return button?.querySelector("svg")?.getAttribute("class") ?? "";
    }

    it("uses agent-mode labels and brand status hues by default", async () => {
      const { root } = renderDialog(container);
      await waitForAssertion(() => {
        expect(workModeOption("standard")?.textContent).toContain("Agent mode");
      });

      expect(workModeOption("standard")?.textContent).toContain("Agent mode");
      expect(workModeOption("ask")?.textContent).toContain("Ask mode");
      expect(workModeOption("planning")?.textContent).toContain("Plan mode");

      expect(statusOptionIconClass("Todo", "Executable — assignee will be woken")).toContain("text-amber-600");
      expect(statusOptionIconClass("In Progress")).toContain("text-blue-600");

      act(() => root.unmount());
    });
  });
});
