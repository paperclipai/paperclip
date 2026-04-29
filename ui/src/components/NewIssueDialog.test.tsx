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

  it("submits the latest locally typed title and description", async () => {
    const { root } = renderDialog(container);
    await flush();

    const titleInput = container.querySelector('textarea[placeholder="Issue title"]') as HTMLTextAreaElement | null;
    const descriptionInput = container.querySelector('textarea[aria-label="Add description..."]') as HTMLTextAreaElement | null;
    expect(titleInput).not.toBeNull();
    expect(descriptionInput).not.toBeNull();

    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      valueSetter?.call(titleInput, "Typed issue");
      titleInput!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flush();

    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      valueSetter?.call(descriptionInput, "Typed description");
      descriptionInput!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flush();

    const submitButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Create Issue"));
    expect(submitButton).not.toBeUndefined();
    expect(submitButton?.hasAttribute("disabled")).toBe(false);

    await act(async () => {
      submitButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(mockIssuesApi.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        title: "Typed issue",
        description: "Typed description",
      }),
    );

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
      .find((button) => button.textContent?.includes("Create Sub-Issue"));
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
      typeof element.className === "string" && element.className.includes("max-h-[calc(100dvh-2rem)]"),
    );
    expect(dialogContent?.className).toContain("h-[calc(100dvh-2rem)]");
    expect(dialogContent?.className).toContain("overflow-hidden");

    const titleInput = container.querySelector('textarea[placeholder="Issue title"]');
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
    await flush();

    expect(container.textContent).not.toContain("will no longer use the parent issue workspace");

    const selects = Array.from(container.querySelectorAll("select"));
    const modeSelect = selects[0] as HTMLSelectElement | undefined;
    expect(modeSelect).not.toBeUndefined();

    await act(async () => {
      modeSelect!.value = "shared_workspace";
      modeSelect!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();

    expect(container.textContent).toContain("will no longer use the parent issue workspace");
    expect(container.textContent).toContain("Parent workspace");

    act(() => root.unmount());
  });
});
