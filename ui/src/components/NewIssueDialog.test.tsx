// @vitest-environment jsdom

import type { ComponentProps, ReactNode } from "react";
import { webcrypto } from "node:crypto";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "../lib/queryKeys";
import { trackRecentAssignee, trackRecentAssigneeUser } from "../lib/recent-assignees";
import { getLastProjectId, trackRecentProject } from "../lib/recent-projects";
import { rememberComposerEffort } from "../lib/recent-composer-effort";
import { addStagedFilesToIssue, NewIssueDialog } from "./NewIssueDialog";

const primaryState = vi.hoisted(() => ({ primaryAgentId: null as string | null, loading: false }));
vi.mock("./primary-agent/PrimaryAgentPresentation", () => ({ usePrimaryAgentPresentation: () => primaryState }));

const dialogState = vi.hoisted(() => ({
  newIssueOpen: true,
  newIssueDefaults: {} as Record<string, unknown>,
  closeNewIssue: vi.fn(),
}));

const dialogContentState = vi.hoisted(() => ({
  onEscapeKeyDown: null as null | ((event: KeyboardEvent) => void),
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
      issuePrefix: "PAP",
    },
  ],
  selectedCompanyId: "company-1",
  selectedCompany: {
    id: "company-1",
    name: "Paperclip",
    status: "active",
    issuePrefix: "PAP",
  },
}));

const toastState = vi.hoisted(() => ({
  pushToast: vi.fn(),
}));
const navigateMock = vi.hoisted(() => vi.fn());

const mockIssuesApi = vi.hoisted(() => ({
  get: vi.fn(),
  list: vi.fn(),
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
const mockMissingUserSecretsBannerRender = vi.hoisted(() => vi.fn());

vi.mock("../context/DialogContext", () => ({
  useDialog: () => dialogState,
}));

vi.mock("../context/SidebarContext", () => ({ useSidebar: () => ({ isMobile: false }) }));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => companyState,
}));

vi.mock("../context/ToastContext", () => ({
  useToastActions: () => toastState,
}));

vi.mock("../lib/router", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/router")>(),
  useNavigate: () => navigateMock,
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

vi.mock("../pages/secrets/MissingUserSecretsBanner", async () => {
  const React = await import("react");
  return {
    MissingUserSecretsBanner: (props: { definitionKeys?: string[] }) => {
      mockMissingUserSecretsBannerRender(props);
      return React.createElement(
        "div",
        { "data-testid": "missing-user-secrets-banner" },
        props.definitionKeys?.join(",") ?? "",
      );
    },
  };
});

vi.mock("../hooks/useProjectOrder", () => ({
  useProjectOrder: ({ projects }: { projects: unknown[] }) => ({
    orderedProjects: projects,
  }),
}));

vi.mock("../api/access", () => ({
  accessApi: { listUserDirectory: async () => ({ users: [] }) },
}));

vi.mock("../lib/assignees", () => ({
  assigneeValueFromSelection: ({
    assigneeAgentId,
    assigneeUserId,
  }: {
    assigneeAgentId?: string;
    assigneeUserId?: string;
  }) => assigneeAgentId ? `agent:${assigneeAgentId}` : assigneeUserId ? `user:${assigneeUserId}` : "",
  currentUserAssigneeOption: (id: string | null) => id ? [{ id: `user:${id}`, label: "Me" }] : [],
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
        className?: string;
        triggerDataSlot?: string;
        noneAtTop?: boolean;
        options?: { id: string; label: string }[];
        onChange?: (id: string) => void;
        renderTriggerValue?: (option: { id: string; label: string } | null) => ReactNode;
      }
    >(function InlineEntitySelectorMock({ value, placeholder, className, triggerDataSlot, noneAtTop, renderTriggerValue, options = [], onChange }, ref) {
      return (
        <button ref={ref} type="button" className={className} data-slot={triggerDataSlot} data-none-at-top={noneAtTop || undefined} onClick={() => onChange?.(options[options.findIndex((option) => option.id === value) + 1]?.id ?? "")}>
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
  DialogTitle: ({ children, ...props }: ComponentProps<"h2">) => <h2 {...props}>{children}</h2>,
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) => (open ? <div>{children}</div> : null),
  DialogContent: ({
    children,
    showCloseButton: _showCloseButton,
    onEscapeKeyDown,
    onPointerDownOutside,
    ...props
  }: ComponentProps<"div"> & {
    showCloseButton?: boolean;
    onEscapeKeyDown?: (event: KeyboardEvent) => void;
    onPointerDownOutside?: (event: unknown) => void;
  }) => {
    dialogContentState.onEscapeKeyDown = onEscapeKeyDown ?? null;
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
  ToggleSwitch: ({ checked, onCheckedChange, ...props }: {
    checked: boolean;
    onCheckedChange: (checked: boolean) => void;
    "aria-label"?: string;
  }) => (
    <button type="button" aria-pressed={checked} onClick={() => onCheckedChange(!checked)} {...props}>toggle</button>
  ),
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({ children, onSelect, ...props }: Omit<ComponentProps<"button">, "onSelect"> & { onSelect?: () => void }) => <button {...props} onClick={onSelect}>{children}</button>,
}));

vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverAnchor: ({ children }: { children: ReactNode }) => <>{children}</>,
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

async function typeTextareaValue(textarea: HTMLTextAreaElement | HTMLInputElement, value: string) {
  await act(async () => {
    const valueSetter = Object.getOwnPropertyDescriptor(
      textarea instanceof HTMLInputElement ? window.HTMLInputElement.prototype : window.HTMLTextAreaElement.prototype,
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

function renderDialog(container: HTMLDivElement, hiddenSettings: string[] = []) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  queryClient.setQueryData(queryKeys.health, { hiddenSettings });
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
  let originalVisualViewportDescriptor: PropertyDescriptor | undefined;
  let originalInnerHeightDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    primaryState.primaryAgentId = null;
    primaryState.loading = false;
    vi.useRealTimers();
    originalResizeObserver = globalThis.ResizeObserver;
    originalVisualViewportDescriptor = Object.getOwnPropertyDescriptor(window, "visualViewport");
    originalInnerHeightDescriptor = Object.getOwnPropertyDescriptor(window, "innerHeight");
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
    dialogContentState.onEscapeKeyDown = null;
    dialogContentState.onPointerDownOutside = null;
    toastState.pushToast.mockReset();
    navigateMock.mockReset();
    mockIssuesApi.create.mockReset();
    mockIssuesApi.list.mockReset().mockResolvedValue([]);
    mockIssuesApi.upsertDocument.mockReset();
    mockIssuesApi.uploadAttachment.mockReset();
    mockIssuesApi.get.mockResolvedValue({ id: "issue-1", visibility: "open" });
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
    mockMissingUserSecretsBannerRender.mockReset();
    localStorage.clear();
    mockIssuesApi.create.mockResolvedValue({
      id: "issue-2",
      companyId: "company-1",
      identifier: "PAP-2",
    });
  });

  afterEach(() => {
    globalThis.ResizeObserver = originalResizeObserver!;
    if (originalVisualViewportDescriptor) {
      Object.defineProperty(window, "visualViewport", originalVisualViewportDescriptor);
    } else {
      Reflect.deleteProperty(window, "visualViewport");
    }
    if (originalInnerHeightDescriptor) {
      Object.defineProperty(window, "innerHeight", originalInnerHeightDescriptor);
    } else {
      Reflect.deleteProperty(window, "innerHeight");
    }
    document.body.innerHTML = "";
  });

  const defaultAgents = [
    { id: "worker", name: "Worker", role: "engineer", status: "idle", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    { id: "ceo", name: "CEO", role: "ceo", status: "idle", adapterType: "claude_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
  ];

  it("accepts a draft while agents and projects load, then fills defaults in place", async () => {
    let resolveAgents!: (agents: typeof defaultAgents) => void;
    let resolveProjects!: (projects: { id: string; name: string; archivedAt: null }[]) => void;
    mockAgentsApi.list.mockImplementationOnce(() => new Promise((resolve) => { resolveAgents = resolve; }));
    mockProjectsApi.list.mockImplementationOnce(() => new Promise((resolve) => { resolveProjects = resolve; }));
    trackRecentProject("project-1", "company-1");

    const { root } = renderDialog(container);
    try {
      const editor = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Describe a task…"]')!;
      expect(editor).not.toBeNull();
      expect(editor.disabled).toBe(false);
      await typeTextareaValue(editor, "Keep writing while the lists load");

      resolveAgents(defaultAgents);
      resolveProjects([{ id: "project-1", name: "Alpha", archivedAt: null }]);
      await waitForAssertion(() => {
        expect(container.querySelector('[data-slot="new-issue-compact-control"]')?.textContent).toContain("project-1");
        expect(container.textContent).toContain("CEO");
      });
      expect(container.querySelector('textarea[aria-label="Describe a task…"]')).toBe(editor);
      expect(editor.value).toBe("Keep writing while the lists load");
    } finally {
      act(() => root.unmount());
    }
  });

  it.each([
    { remembered: "project-1", expected: "project-1" },
    { remembered: "", expected: "Project" },
    { remembered: "deleted", expected: "Project" },
  ])("restores the last available project ($remembered)", async ({ remembered, expected }) => {
    trackRecentProject(remembered, "company-1");
    const { root } = renderDialog(container);
    await waitForAssertion(() => expect(container.querySelector('[data-slot="new-issue-compact-control"]')?.textContent).toContain(expected));
    await typeTextareaValue(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Describe a task…"]')!, "Check project memory");
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Create task"]')!.click());
    await waitForAssertion(() => expect(mockIssuesApi.create).toHaveBeenCalled());
    expect(mockIssuesApi.create.mock.calls[0][1].projectId).toBe(remembered === "project-1" ? "project-1" : undefined);
    act(() => root.unmount());
  });

  it("keeps explicit launch context ahead of another company's project history", async () => {
    trackRecentProject("project-1", "company-2");
    trackRecentProject("deleted", "company-1");
    dialogState.newIssueDefaults = { projectId: "project-1" };
    const { root } = renderDialog(container);
    await waitForAssertion(() => expect(container.querySelector('[data-slot="new-issue-compact-control"]')?.textContent).toContain("project-1"));
    act(() => root.unmount());
    dialogState.newIssueDefaults = {};
    const next = renderDialog(container);
    await flush();
    expect(container.querySelector('[data-slot="new-issue-compact-control"]')?.textContent).toContain("Project");
    act(() => next.root.unmount());
  });

  it("remembers a project selection even when the composer is dismissed without submitting", async () => {
    const { root } = renderDialog(container);
    await flush();
    act(() => container.querySelector<HTMLElement>('[data-slot="new-issue-compact-control"]')!.click());
    expect(getLastProjectId("company-1")).toBe("project-1");
    act(() => root.unmount());
    const next = renderDialog(container);
    await waitForAssertion(() => expect(container.querySelector('[data-slot="new-issue-compact-control"]')?.textContent).toContain("project-1"));
    act(() => next.root.unmount());
  });

  it("shows No project first and lets a selected project be cleared", async () => {
    dialogState.newIssueDefaults = { projectId: "project-1" };
    const { root } = renderDialog(container);
    await waitForAssertion(() => expect(container.querySelector('[data-slot="new-issue-compact-control"]')?.textContent).toContain("project-1"));

    const projectPicker = container.querySelector<HTMLButtonElement>('[data-slot="new-issue-compact-control"]')!;
    expect(projectPicker.dataset.noneAtTop).toBe("true");
    act(() => projectPicker.click());

    await typeTextareaValue(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Describe a task…"]')!, "Create without a project");
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Create task"]')!.click());
    await waitForAssertion(() => expect(mockIssuesApi.create).toHaveBeenCalled());
    expect(mockIssuesApi.create.mock.calls[0][1].projectId).toBeUndefined();
    expect(getLastProjectId("company-1")).toBe("");
    act(() => root.unmount());
  });

  it("submits remembered effort with the agent's default model", async () => {
    mockAgentsApi.list.mockResolvedValue(defaultAgents.map((agent) => agent.id === "ceo"
      ? { ...agent, adapterConfig: { model: "claude-opus-5" } } : agent));
    mockAgentsApi.adapterModels.mockResolvedValue([{ id: "claude-opus-5", label: "Claude Opus 5" }]);
    rememberComposerEffort("company-1", "high");
    const { root } = renderDialog(container);
    await waitForAssertion(() => expect(container.querySelector('[data-testid="task-chat-composer-model-label"]')?.textContent).toBe("Claude Opus 5"));
    await typeTextareaValue(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Describe a task…"]')!, "Check effort memory");
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Create task"]')!.click());
    await waitForAssertion(() => expect(mockIssuesApi.create).toHaveBeenCalled());
    expect(mockIssuesApi.create.mock.calls[0][1].assigneeAdapterOverrides).toEqual({ adapterConfig: { effort: "high" } });
    act(() => root.unmount());
  });

  it.each([
    { recent: "", expected: "CEO" },
    { recent: "agent:worker", expected: "Worker" },
    { recent: "user:user-1", expected: "Me" },
    { recent: "agent:deleted", expected: "CEO" },
  ])("defaults to $expected for recent selection $recent without inserting a mention", async ({ recent, expected }) => {
    mockAgentsApi.list.mockResolvedValue(defaultAgents);
    if (recent.startsWith("agent:")) trackRecentAssignee(recent.slice(6), "company-1");
    if (recent.startsWith("user:")) trackRecentAssigneeUser(recent.slice(5), "company-1");
    const { root } = renderDialog(container);
    await waitForAssertion(() => expect(container.querySelector('[data-testid="task-chat-composer-assignee-label"]')?.textContent).toBe(expected));
    expect(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Describe a task…"]')?.value).toBe("");
    expect(container.textContent).not.toContain("@CEO");
    act(() => root.unmount());
  });

  it.each([
    { recent: null, explicit: null, draft: null, primary: "worker", expected: "Worker" },
    { recent: "ceo", explicit: null, draft: null, primary: "worker", expected: "CEO" },
    { recent: "worker", explicit: "ceo", draft: null, primary: "worker", expected: "CEO" },
    { recent: "worker", explicit: null, draft: "ceo", primary: "worker", expected: "CEO" },
    { recent: null, explicit: null, draft: null, primary: "missing", expected: "CEO" },
  ])("preserves task selection precedence ($recent, $explicit, $draft, $primary)", async ({ recent, explicit, draft, primary, expected }) => {
    mockAgentsApi.list.mockResolvedValue(defaultAgents);
    primaryState.primaryAgentId = primary;
    if (recent) trackRecentAssignee(recent, "company-1");
    if (explicit) dialogState.newIssueDefaults = { assigneeAgentId: explicit };
    if (draft) localStorage.setItem("paperclip:issue-draft:user-1", JSON.stringify({ title: "Saved request", description: "", assigneeValue: `agent:${draft}`, projectId: "" }));
    const { root } = renderDialog(container);
    await waitForAssertion(() => expect(container.querySelector('[data-testid="task-chat-composer-assignee-label"]')?.textContent).toBe(expected));
    act(() => root.unmount());
  });

  it("ignores another company's remembered human and keeps explicit launch assignees", async () => {
    mockAgentsApi.list.mockResolvedValue(defaultAgents);
    trackRecentAssigneeUser("user-1", "company-2");
    dialogState.newIssueDefaults = { assigneeAgentId: "worker" };
    const { root } = renderDialog(container);
    await waitForAssertion(() => expect(container.querySelector('[data-testid="task-chat-composer-assignee-label"]')?.textContent).toBe("Worker"));
    act(() => root.unmount());
    dialogState.newIssueDefaults = {};
    const next = renderDialog(container);
    await waitForAssertion(() => expect(container.querySelector('[data-testid="task-chat-composer-assignee-label"]')?.textContent).toBe("CEO"));
    act(() => next.root.unmount());
  });

  it("uses older agent history only when the agent belongs to the current company", async () => {
    mockAgentsApi.list.mockResolvedValue(defaultAgents);
    trackRecentAssignee("worker");
    trackRecentAssignee("another-company-agent");
    const { root } = renderDialog(container);
    await waitForAssertion(() => expect(container.querySelector('[data-testid="task-chat-composer-assignee-label"]')?.textContent).toBe("Worker"));
    act(() => root.unmount());
  });

  it("remembers a chosen human and leaves the request empty", async () => {
    mockAgentsApi.list.mockResolvedValue(defaultAgents);
    const { root } = renderDialog(container);
    await waitForAssertion(() => expect(container.querySelector('[data-testid="task-chat-composer-assignee-label"]')?.textContent).toBe("CEO"));
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Select assignee"]')!.click());
    const me = [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')].find((button) => button.textContent?.includes("Me"))!;
    act(() => me.click());
    expect(localStorage.getItem("paperclip:recent-assignees:company-1")).toContain("user:user-1");
    expect(container.querySelector('[data-testid="task-chat-composer-model-label"]')).toBeNull();
    expect(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Describe a task…"]')?.value).toBe("");
    act(() => root.unmount());
  });

  it("applies the default after agents load without replacing a request typed meanwhile", async () => {
    let resolveAgents!: (agents: typeof defaultAgents) => void;
    mockAgentsApi.list.mockReturnValue(new Promise((resolve) => { resolveAgents = resolve; }));
    const { root } = renderDialog(container);
    await flush();
    await typeTextareaValue(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Describe a task…"]')!, "hello there");
    resolveAgents(defaultAgents);
    await waitForAssertion(() => expect(container.querySelector('[data-testid="task-chat-composer-assignee-label"]')?.textContent).toBe("CEO"));
    expect(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Describe a task…"]')?.value).toBe("hello there");
    act(() => root.unmount());
  });

  it("keeps an explicitly chosen human while agents are still loading", async () => {
    let resolveAgents!: (agents: typeof defaultAgents) => void;
    mockAgentsApi.list.mockReturnValue(new Promise((resolve) => { resolveAgents = resolve; }));
    const { root } = renderDialog(container);
    await flush();
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Select assignee"]')!.click());
    const me = [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')].find((button) => button.textContent?.includes("Me"))!;
    act(() => me.click());
    resolveAgents(defaultAgents);
    await flush();
    expect(container.querySelector('[data-testid="task-chat-composer-assignee-label"]')?.textContent).toBe("Me");
    act(() => root.unmount());
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
    expect(container.querySelector('[aria-label="Create sub-task"]')).not.toBeNull();

    act(() => root.unmount());

    dialogState.newIssueDefaults = {};
    const rerendered = renderDialog(container);
    await flush();

    expect(container.textContent).toContain("New task");
    expect(container.querySelector('[aria-label="Create task"]')).not.toBeNull();
    expect(container.textContent).not.toContain("Sub-task of");

    act(() => rerendered.root.unmount());
  });

  it("uses the task chat composer for the editor and send control", async () => {
    mockAgentsApi.list.mockResolvedValue([{ id: "agent-1", name: "Coder", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} }]);
    const { root } = renderDialog(container);
    await flush();
    const composer = container.querySelector(".paperclip-task-chat-composer");
    expect(composer).not.toBeNull();
    expect(composer?.querySelector('[data-testid="task-chat-composer-input"]')).not.toBeNull();
    expect(composer?.querySelector('[aria-label="Create task"]')).not.toBeNull();
    expect(composer?.querySelector('[aria-label="Task settings"]')).toBeNull();
    expect(container.querySelector("h2")?.className).toBe("sr-only");
    expect(composer?.textContent).not.toContain("PAP");
    await waitForAssertion(() => expect(composer?.querySelector('[data-testid="task-chat-composer-assignee"]')).not.toBeNull());
    const toolbar = composer?.querySelector('[data-testid="task-chat-composer-actions"]');
    const context = container.querySelector('[data-testid="task-chat-composer-context"]');
    const project = context?.querySelector('[data-slot="new-issue-compact-control"]');
    const assignee = toolbar?.querySelector('[data-testid="task-chat-composer-assignee"]');
    expect(project).not.toBeNull();
    expect(context?.nextElementSibling).toBe(composer);
    expect(assignee).not.toBeNull();
    expect(toolbar?.querySelector('[data-slot="new-issue-compact-control"]')).toBeNull();
    act(() => root.unmount());
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
        reuseEligible: true,
      });
    });
    expect(mockExecutionWorkspacesApi.list).not.toHaveBeenCalled();

    const submitButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.getAttribute("aria-label") === "Create sub-task");
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

  it("restores private visibility from a saved draft without a project", async () => {
    localStorage.setItem("paperclip:issue-draft:user-1", JSON.stringify({ title: "Private draft", description: "", status: "todo", priority: "", projectId: "", isPrivate: true }));
    const { root } = renderDialog(container);
    await flush();
    const toggle = container.querySelector<HTMLButtonElement>('button[data-testid="composer-private-chip"]')!;
    await waitForAssertion(() => expect(toggle).not.toBeNull());
    const submit = Array.from(container.querySelectorAll("button")).find(button => button.getAttribute("aria-label") === "Create task")!;
    await act(async () => submit.click());
    await flush();
    expect(mockIssuesApi.create).toHaveBeenCalledWith("company-1", expect.objectContaining({ title: "Private draft", visibility: "private" }));
    act(() => root.unmount());
  });

  it("waits for parent access before offering privacy or creating a child", async () => {
    let resolveParent!: (value: unknown) => void;
    mockIssuesApi.get.mockReturnValue(new Promise(resolve => { resolveParent = resolve; }));
    dialogState.newIssueDefaults = { parentId: "issue-1", title: "Private child" };
    const { root } = renderDialog(container);
    await flush();
    const submit = container.querySelector<HTMLButtonElement>('button[aria-label="Create sub-task"]')!;
    expect(submit.disabled).toBe(true);
    expect(container.textContent).toContain("Checking parent access");
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="task-chat-composer-add"]')!.click());
    await flush();
    expect(document.querySelector('[data-testid="composer-add-private"]')).toBeNull();
    expect(mockIssuesApi.create).not.toHaveBeenCalled();
    await act(async () => resolveParent({ id: "issue-1", visibility: "private" }));
    await flush();
    await waitForAssertion(() => expect(container.querySelector<HTMLButtonElement>('[data-testid="composer-private-chip"]')?.disabled).toBe(true));
    expect(submit.disabled).toBe(false);
    act(() => root.unmount());
  });

  it("keeps submission blocked after a parent lookup error and lets the user retry", async () => {
    mockIssuesApi.get.mockRejectedValueOnce(new Error("Unavailable")).mockResolvedValue({ id: "issue-1", visibility: "private" });
    dialogState.newIssueDefaults = { parentId: "issue-1", title: "Private child" };
    const { root } = renderDialog(container);
    await flush();
    await waitForAssertion(() => expect(container.textContent).toContain("Couldn't check parent access."));
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Create sub-task"]')?.disabled).toBe(true);
    await act(async () => Array.from(container.querySelectorAll('button')).find(button => button.textContent === "Retry")!.click());
    await flush();
    await waitForAssertion(() => expect(container.querySelector<HTMLButtonElement>('[data-testid="composer-private-chip"]')?.disabled).toBe(true));
    expect(mockIssuesApi.create).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  it("locks inherited privacy and submits the child as private", async () => {
    mockIssuesApi.get.mockResolvedValue({ id: "issue-1", visibility: "private", title: "Board briefing" });
    dialogState.newIssueDefaults = { parentId: "issue-1", title: "Private child" };
    const { root } = renderDialog(container);
    await flush();
    await flush();
    const toggle = container.querySelector<HTMLButtonElement>('button[data-testid="composer-private-chip"]')!;
    await waitForAssertion(() => expect(toggle).not.toBeNull());
    expect(toggle.disabled).toBe(true);
    expect(toggle.title).toBe("Subtask of private task Board briefing");
    await typeTextareaValue(container.querySelector('textarea')!, "Private child draft");
    // Saving this form must retain only the explicit toggle choice. A later
    // standalone draft must not acquire a sticky private flag from its parent.
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 850)); });
    expect(JSON.parse(localStorage.getItem("paperclip:issue-draft:user-1")!).isPrivate).toBe(false);
    const submit = Array.from(container.querySelectorAll("button")).find(button => button.getAttribute("aria-label") === "Create sub-task")!;
    await act(async () => submit.click());
    await flush();
    expect(mockIssuesApi.create).toHaveBeenCalledWith("company-1", expect.objectContaining({ parentId: "issue-1", visibility: "private" }));
    act(() => root.unmount());
  });

  it("names the private project inherited through an open parent", async () => {
    mockIssuesApi.get.mockResolvedValue({ id: "issue-1", visibility: "open", title: "Board briefing", project: { id: "private-project", name: "Executive planning", visibility: "private" } });
    dialogState.newIssueDefaults = { parentId: "issue-1", title: "Private child" };
    const { root } = renderDialog(container);
    await flush();
    await waitForAssertion(() => {
      const chip = container.querySelector<HTMLButtonElement>('[data-testid="composer-private-chip"]');
      expect(chip?.disabled).toBe(true);
      expect(chip?.title).toBe("In private project Executive planning");
    });
    act(() => root.unmount());
  });

  it("defaults a private task to the current user's personal private project", async () => {
    mockProjectsApi.list.mockResolvedValue([
      {
        id: "personal-project",
        companyId: "company-1",
        name: "My private tasks",
        visibility: "private",
        personalOwnerUserId: "user-1",
        archivedAt: null,
      },
    ]);
    dialogState.newIssueDefaults = { title: "Private scratch task" };

    const { root } = renderDialog(container);
    await flush();
    await flush();
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="task-chat-composer-add"]')!.click());
    await flush();
    const privateToggle = document.querySelector<HTMLButtonElement>('[data-testid="composer-add-private"]');
    expect(privateToggle).not.toBeNull();
    await act(async () => privateToggle!.click());
    await flush();

    const submitButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.getAttribute("aria-label") === "Create task");
    await waitForAssertion(() => expect(submitButton?.hasAttribute("disabled")).toBe(false));
    await act(async () => submitButton!.click());
    await flush();

    expect(mockIssuesApi.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        title: "Private scratch task",
        visibility: "private",
        projectId: "personal-project",
      }),
    );
    act(() => root.unmount());
  });

  it("does not show user-secret warnings when the draft will not run an env binding that needs them", async () => {
    const { root } = renderDialog(container);
    await flush();

    expect(mockMissingUserSecretsBannerRender).not.toHaveBeenCalled();

    act(() => root.unmount());
  });

  it("scopes user-secret warnings to selected runnable agent and project env bindings", async () => {
    dialogState.newIssueDefaults = {
      title: "Run with scoped secrets",
      assigneeAgentId: "agent-1",
      projectId: "project-1",
    };
    mockAgentsApi.list.mockResolvedValue([
      {
        id: "agent-1",
        name: "CodexCoder",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {
          env: {
            AGENT_TOKEN: { type: "user_secret_ref", key: "agent_token", required: true },
            OPTIONAL_TOKEN: { type: "user_secret_ref", key: "optional_token", required: false },
          },
        },
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    mockProjectsApi.list.mockResolvedValue([
      {
        id: "project-1",
        name: "Alpha",
        description: null,
        archivedAt: null,
        color: "#445566",
        env: {
          PROJECT_TOKEN: { type: "user_secret_ref", key: "project_token", required: true },
        },
      },
    ]);

    const { root } = renderDialog(container);
    await waitForAssertion(() => {
      expect(mockMissingUserSecretsBannerRender).toHaveBeenCalledWith(
        expect.objectContaining({
          definitionKeys: ["agent_token", "project_token"],
        }),
      );
    });

    expect(container.textContent).toContain("agent_token,project_token");

    act(() => root.unmount());
  });

  it("shows Astra-only efforts when a task inherits the agent model", async () => {
    dialogState.newIssueDefaults = {
      title: "Use inherited Astra",
      assigneeAgentId: "agent-1",
    };
    mockAgentsApi.list.mockResolvedValue([
      {
        id: "agent-1",
        name: "CodexCoder",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: { model: "gpt-6-astra" },
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    const { root } = renderDialog(container);
    await waitForAssertion(() => {
      expect(container.querySelector('[aria-label="Select model and effort"]')).not.toBeNull();
      expect(container.querySelector('[aria-label="Effort"]')?.getAttribute("max")).toBe("6");
    });
    expect(container.textContent).not.toContain("Codex options");

    act(() => root.unmount());
  });

  it("warns when the selected assignee is a paused imported agent", async () => {
    dialogState.newIssueDefaults = {
      title: "Compare onboarding flows",
      assigneeAgentId: "agent-1",
    };
    mockAgentsApi.list.mockResolvedValue([
      {
        id: "agent-1",
        name: "CEO",
        status: "paused",
        pauseReason: "import",
        adapterType: "claude_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    const { root } = renderDialog(container);
    await waitForAssertion(() => {
      expect(container.querySelector('[data-testid="new-issue-paused-assignee-note"]')).not.toBeNull();
    });
    expect(container.textContent).toContain("arrived paused from an organization import");

    act(() => root.unmount());
  });

  it("restores the planning mode from dialog defaults", async () => {
    dialogState.newIssueDefaults = {
      title: "Planned from defaults",
      workMode: "planning",
    };

    const { root } = renderDialog(container);
    await flush();

    const planningButton = container.querySelector('[data-testid="composer-add-plan"]');
    expect(container.querySelector("[data-pending-work-mode=planning]")).not.toBeNull();

    const submitButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.getAttribute("aria-label") === "Create task");
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

    const askButton = container.querySelector('[data-testid="composer-add-ask"]');
    expect(container.querySelector("[data-pending-work-mode=ask]")).not.toBeNull();

    const submitButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.getAttribute("aria-label") === "Create task");
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

  it("hides isolation choices and omits stale workspace draft overrides", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableIsolatedWorkspaces: true });
    mockProjectsApi.list.mockResolvedValue([{
      id: "project-1", name: "Alpha", workspaces: [{ id: "source-default", isPrimary: true }],
      executionWorkspacePolicy: { enabled: true, defaultMode: "isolated_workspace" },
    }]);
    localStorage.setItem("paperclip:issue-draft:user-1", JSON.stringify({
      title: "Draft task", description: "", status: "todo", priority: "medium", assigneeValue: "",
      reviewerValue: "", approverValue: "", projectId: "project-1",
      projectWorkspaceId: "stale-source", selectedExecutionWorkspaceId: "stale-workspace", executionWorkspaceMode: "reuse_existing",
      assigneeModelOverride: "", assigneeThinkingEffort: "", assigneeChrome: false, workMode: "standard",
    }));
    const { root } = renderDialog(container, ["workspaces.isolation"]);
    await flush();
    expect(container.textContent).not.toContain("Execution workspace");
    expect(container.querySelector('option[value="isolated_workspace"]')).toBeNull();
    await typeTextareaValue(container.querySelector('textarea[aria-label="Describe a task…"]')!, "Managed task");
    const create = Array.from(container.querySelectorAll("button")).find((button) => button.getAttribute("aria-label") === "Create task");
    act(() => create!.click());
    await waitForAssertion(() => expect(mockIssuesApi.create).toHaveBeenCalled());
    const payload = mockIssuesApi.create.mock.calls[0][1];
    expect(payload).not.toHaveProperty("executionWorkspacePreference");
    expect(payload).not.toHaveProperty("executionWorkspaceSettings");
    expect(payload).not.toHaveProperty("executionWorkspaceId");
    expect(payload).not.toHaveProperty("projectWorkspaceId");
    act(() => root.unmount());
  });

  it("leaves a fresh hidden project source choice to the server default", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableIsolatedWorkspaces: true });
    mockProjectsApi.list.mockResolvedValue([{
      id: "project-1", name: "Alpha", workspaces: [{ id: "source-default", isPrimary: true }],
      executionWorkspacePolicy: { enabled: true, defaultMode: "isolated_workspace" },
    }]);
    dialogState.newIssueDefaults = { projectId: "project-1" };
    const { root } = renderDialog(container, ["workspaces.isolation"]);
    await flush();
    await typeTextareaValue(container.querySelector('textarea[aria-label="Describe a task…"]')!, "Managed task");
    const create = Array.from(container.querySelectorAll("button")).find((button) => button.getAttribute("aria-label") === "Create task");
    act(() => create!.click());
    await waitForAssertion(() => expect(mockIssuesApi.create).toHaveBeenCalled());
    const payload = mockIssuesApi.create.mock.calls[0][1];
    expect(payload.projectId).toBe("project-1");
    expect(payload).not.toHaveProperty("projectWorkspaceId");
    expect(payload).not.toHaveProperty("executionWorkspaceId");
    act(() => root.unmount());
  });

  it.each([false, true])("keeps explicit workspace launch context when isolation controls are hidden (subtask: %s)", async (subtask) => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableIsolatedWorkspaces: true });
    dialogState.newIssueDefaults = {
      projectId: "project-1", projectWorkspaceId: "source-context", executionWorkspaceId: "workspace-context",
      ...(subtask ? { parentId: "parent-task", parentIdentifier: "TEST-1" } : {}),
    };
    const { root } = renderDialog(container, ["workspaces.isolation"]);
    await flush();
    expect(container.querySelector('option[value="isolated_workspace"]')).toBeNull();
    await typeTextareaValue(container.querySelector('textarea[aria-label="Describe a task…"]')!, "Context task");
    const create = Array.from(container.querySelectorAll("button")).find((button) => button.getAttribute("aria-label") === (subtask ? "Create sub-task" : "Create task"));
    act(() => create!.click());
    await waitForAssertion(() => expect(mockIssuesApi.create).toHaveBeenCalled());
    expect(mockIssuesApi.create.mock.calls[0][1]).toMatchObject({
      executionWorkspaceId: "workspace-context", executionWorkspacePreference: "reuse_existing",
      projectWorkspaceId: "source-context",
    });
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

    const { root, queryClient } = renderDialog(container);
    await flush();

    await waitForAssertion(() => {
      expect(queryClient.getQueryData(queryKeys.executionWorkspaces.summaryList("company-1", {
        projectId: "project-1", reuseEligible: true,
      }))).toEqual(expect.arrayContaining([expect.objectContaining({ id: "workspace-1" })]));
    });
    await flush();
    expect(container.textContent).toContain("New task");
    expect(container.textContent).not.toContain("New sub-task");

    const submitButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.getAttribute("aria-label") === "Create task");
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

  function enableWorktrees(mode = "shared_workspace") {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableIsolatedWorkspaces: true });
    mockProjectsApi.list.mockResolvedValue([
      { id: "project-1", name: "Alpha", executionWorkspacePolicy: { enabled: true, defaultMode: mode }, workspaces: [{ id: "source-1", isPrimary: true }] },
      { id: "project-2", name: "Beta", executionWorkspacePolicy: { enabled: false }, workspaces: [] },
    ]);
    dialogState.newIssueDefaults = { projectId: "project-1", description: "Fix sign-in" };
  }

  function selectWorktree(value: string) {
    const option = container.querySelector<HTMLElement>(`[cmdk-item][data-value="${value}"]`);
    expect(option).not.toBeNull();
    act(() => option!.click());
  }

  it.each(["isolated_workspace", "operator_branch", "adapter_managed"])("reuses a worktree with its actual mode (%s)", async (mode) => {
    enableWorktrees();
    mockExecutionWorkspacesApi.listSummaries.mockResolvedValue([{
      id: "worktree-1", name: "Sign-in fix", mode, status: "active", branchName: "fix/sign-in",
      cwd: "/tmp/worktree-1", projectWorkspaceId: "source-1", lastUsedAt: new Date(),
    }]);
    const { root } = renderDialog(container);
    await waitForAssertion(() => expect(container.querySelector('[cmdk-item][data-value="reuse:worktree-1"]')).not.toBeNull());
    const context = container.querySelector('[data-testid="task-chat-composer-context"]');
    const project = context?.querySelector('[data-slot="new-issue-compact-control"]');
    const worktrees = context?.querySelector('[aria-label="Worktrees"]');
    expect(worktrees).not.toBeNull();
    expect(project?.compareDocumentPosition(worktrees!)! & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    selectWorktree("reuse:worktree-1");
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Create task"]')!.click());
    await waitForAssertion(() => expect(mockIssuesApi.create).toHaveBeenCalled());
    expect(mockIssuesApi.create.mock.calls[0][1]).toMatchObject({
      projectId: "project-1", projectWorkspaceId: "source-1", executionWorkspaceId: "worktree-1",
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: { mode: mode === "adapter_managed" ? "agent_default" : mode },
    });
    act(() => root.unmount());
  });

  it.each(["isolated_workspace", "shared_workspace"])("restores the project checkout and clears reuse when choosing %s", async (mode) => {
    enableWorktrees();
    mockExecutionWorkspacesApi.listSummaries.mockResolvedValue([{
      id: "worktree-1", name: "Sign-in fix", mode: "isolated_workspace", status: "idle",
      branchName: "fix/sign-in", cwd: "/tmp/worktree-1", projectWorkspaceId: "source-2", lastUsedAt: new Date(),
    }]);
    const { root } = renderDialog(container);
    await waitForAssertion(() => expect(container.querySelector('[cmdk-item][data-value="reuse:worktree-1"]')).not.toBeNull());
    selectWorktree("reuse:worktree-1");
    selectWorktree(mode);
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Create task"]')!.click());
    await waitForAssertion(() => expect(mockIssuesApi.create).toHaveBeenCalled());
    const payload = mockIssuesApi.create.mock.calls[0][1];
    expect(payload).toMatchObject({ projectWorkspaceId: "source-1", executionWorkspacePreference: mode, executionWorkspaceSettings: { mode } });
    expect(payload).not.toHaveProperty("executionWorkspaceId");
    act(() => root.unmount());
  });

  it.each([false, true])("carries the source checkout when reusing another worktree in the same project (inherited: %s)", async (inherited) => {
    enableWorktrees();
    if (inherited) dialogState.newIssueDefaults.executionWorkspaceId = "worktree-secondary";
    mockExecutionWorkspacesApi.listSummaries.mockResolvedValue([{
      id: "worktree-secondary", name: "Secondary checkout fix", mode: "isolated_workspace", status: "active",
      branchName: "fix/secondary", cwd: "/tmp/worktree-secondary", projectWorkspaceId: "source-2", lastUsedAt: new Date(),
    }]);
    const { root } = renderDialog(container);
    await waitForAssertion(() => expect(container.querySelector('[cmdk-item][data-value="reuse:worktree-secondary"]')).not.toBeNull());
    expect(mockExecutionWorkspacesApi.listSummaries).toHaveBeenCalledWith("company-1", { projectId: "project-1", reuseEligible: true });
    if (!inherited) selectWorktree("reuse:worktree-secondary");
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Create task"]')!.click());
    await waitForAssertion(() => expect(mockIssuesApi.create).toHaveBeenCalled());
    expect(mockIssuesApi.create.mock.calls[0][1]).toMatchObject({ projectWorkspaceId: "source-2", executionWorkspaceId: "worktree-secondary" });
    act(() => root.unmount());
  });

  it("clears a reused worktree when switching to a project without isolation", async () => {
    enableWorktrees();
    dialogState.newIssueDefaults.executionWorkspaceId = "worktree-1";
    const { root } = renderDialog(container);
    await flush();
    act(() => container.querySelector<HTMLButtonElement>('[data-slot="new-issue-compact-control"]')!.click());
    await flush();
    expect(container.querySelector('[aria-label="Worktrees"]')).toBeNull();
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Create task"]')!.click());
    await waitForAssertion(() => expect(mockIssuesApi.create).toHaveBeenCalled());
    const payload = mockIssuesApi.create.mock.calls[0][1];
    expect(payload.projectId).toBe("project-2");
    expect(payload).not.toHaveProperty("executionWorkspaceId");
    expect(payload).not.toHaveProperty("executionWorkspacePreference");
    expect(payload).not.toHaveProperty("executionWorkspaceSettings");
    act(() => root.unmount());
  });

  it.each([false, true])("hides worktrees and skips reuse queries when the project has isolation disabled (instance: %s)", async (instanceEnabled) => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableIsolatedWorkspaces: instanceEnabled });
    dialogState.newIssueDefaults = { projectId: "project-1" };
    const { root } = renderDialog(container);
    await flush();
    expect(container.querySelector('[aria-label="Worktrees"]')).toBeNull();
    expect(mockExecutionWorkspacesApi.listSummaries).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  it.each(["loading", "error", "missing"])("blocks an unchecked reused worktree but still permits a new one (%s)", async (state) => {
    enableWorktrees();
    dialogState.newIssueDefaults.executionWorkspaceId = "stale-worktree";
    if (state === "loading") mockExecutionWorkspacesApi.listSummaries.mockImplementation(() => new Promise(() => {}));
    if (state === "error") mockExecutionWorkspacesApi.listSummaries.mockRejectedValue(new Error("Unavailable"));
    const { root } = renderDialog(container);
    await waitForAssertion(() => expect(container.querySelector('[aria-label="Worktrees"]')).not.toBeNull());
    await flush();
    const submit = container.querySelector<HTMLButtonElement>('[aria-label="Create task"]')!;
    expect(submit.disabled).toBe(true);
    act(() => { container.querySelector('textarea')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true })); });
    expect(mockIssuesApi.create).not.toHaveBeenCalled();
    selectWorktree("isolated_workspace");
    await flush();
    expect(submit.disabled).toBe(false);
    act(() => submit.click());
    await waitForAssertion(() => expect(mockIssuesApi.create).toHaveBeenCalled());
    expect(mockIssuesApi.create.mock.calls[0][1]).toMatchObject({ executionWorkspacePreference: "isolated_workspace" });
    act(() => root.unmount());
  });


  it("restores a description-only draft", async () => {
    localStorage.setItem("paperclip:issue-draft:user-1", JSON.stringify({
      title: "", description: "Keep the request without a title", status: "todo", priority: "medium",
      assigneeValue: "", reviewerValue: "", approverValue: "", projectId: "",
      assigneeModelOverride: "", assigneeThinkingEffort: "", assigneeChrome: false,
    }));
    const { root } = renderDialog(container);
    await flush();
    await waitForAssertion(() => {
      expect((container.querySelector('textarea[aria-label="Describe a task…"]') as HTMLTextAreaElement).value).toBe("Keep the request without a title");
    });
    const submit = Array.from(container.querySelectorAll("button")).find(button => button.getAttribute("aria-label") === "Create task")!;
    expect(submit.hasAttribute("disabled")).toBe(false);
    await act(async () => root.unmount());
  });

  it("creates a task from its description without requiring a title", async () => {
    const { root } = renderDialog(container);
    await flush();
    const submit = Array.from(container.querySelectorAll("button")).find(button => button.getAttribute("aria-label") === "Create task")!;
    expect(submit.hasAttribute("disabled")).toBe(true);
    await typeTextareaValue(container.querySelector('textarea[aria-label="Describe a task…"]')!, "Investigate the sign-in redirect and fix it");
    await vi.waitFor(() => expect(submit.hasAttribute("disabled")).toBe(false));
    await act(async () => { submit.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await flush();
    expect(mockIssuesApi.create).toHaveBeenCalledWith("company-1", expect.objectContaining({ description: "Investigate the sign-in redirect and fix it" }));
    expect(mockIssuesApi.create.mock.calls[0][1]).not.toHaveProperty("title");
    await act(async () => root.unmount());
  });

  it.each(["Corrected task title", ""])("lets users edit or clear an inherited title (%s)", async (nextTitle) => {
    dialogState.newIssueDefaults = { title: "Suggested title", description: "Investigate the redirect" };
    const { root } = renderDialog(container);
    await flush();
    const titleInput = container.querySelector<HTMLInputElement>('input[aria-label="Task title"]')!;
    expect(titleInput.value).toBe("Suggested title");
    await typeTextareaValue(titleInput, nextTitle);
    expect(container.querySelector('input[aria-label="Task title"]')).toBe(titleInput);
    const submit = container.querySelector<HTMLButtonElement>('[aria-label="Create task"]')!;
    await act(async () => submit.click());
    await flush();
    const payload = mockIssuesApi.create.mock.calls[0][1];
    expect(payload.description).toBe("Investigate the redirect");
    if (nextTitle) expect(payload.title).toBe(nextTitle);
    else expect(payload).not.toHaveProperty("title");
    await act(async () => root.unmount());
  });

  it("keeps a typed request when project data arrives after editing starts", async () => {
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

    dialogState.newIssueDefaults = { title: "Typed issue" };
    const { root } = renderDialog(container);
    await flush();

    const descriptionInput = container.querySelector('textarea[aria-label="Describe a task…"]') as HTMLTextAreaElement | null;
    expect(descriptionInput).not.toBeNull();

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
      .find((button) => button.getAttribute("aria-label") === "Create task");
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

  it("shows the create-task loading state only in the submit button", async () => {
    mockIssuesApi.create.mockReturnValue(new Promise(() => undefined));
    dialogState.newIssueDefaults = { title: "Pending task" };

    const { root } = renderDialog(container);
    await flush();

    const submitButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.getAttribute("aria-label") === "Create task");
    expect(submitButton).not.toBeUndefined();

    await act(async () => {
      submitButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(submitButton?.querySelector(".animate-spin")).not.toBeNull();
    expect(submitButton?.getAttribute("aria-busy")).toBe("true");
    expect(container.textContent).not.toContain("Creating issue");

    act(() => root.unmount());
  });

  it("creates separate tasks with the same title and confirms each with a link", async () => {
    dialogState.newIssueDefaults = { title: "Connect Circleback through Composio" };
    const { root, queryClient } = renderDialog(container);
    await flush();
    const submit = () => Array.from(container.querySelectorAll("button"))
      .find((button) => button.getAttribute("aria-label") === "Create task")!;

    act(() => submit().click());
    await waitForAssertion(() => expect(dialogState.closeNewIssue).toHaveBeenCalledTimes(1));
    const firstPayload = mockIssuesApi.create.mock.calls[0][1];
    expect(firstPayload).toMatchObject({
      title: "Connect Circleback through Composio",
      allowDuplicate: true,
      idempotencyKey: expect.any(String),
    });
    expect(toastState.pushToast).toHaveBeenCalledWith({
      title: "Created PAP-2",
      tone: "success",
      action: { label: "Open PAP-2", href: "/PAP/issues/PAP-2" },
    });

    dialogState.newIssueOpen = false;
    act(() => root.render(<QueryClientProvider client={queryClient}><NewIssueDialog /></QueryClientProvider>));
    dialogState.newIssueOpen = true;
    act(() => root.render(<QueryClientProvider client={queryClient}><NewIssueDialog /></QueryClientProvider>));
    await flush();
    act(() => submit().click());
    await waitForAssertion(() => expect(dialogState.closeNewIssue).toHaveBeenCalledTimes(2));
    const secondPayload = mockIssuesApi.create.mock.calls[1][1];
    expect(secondPayload.title).toBe(firstPayload.title);
    expect(secondPayload.allowDuplicate).toBe(true);
    expect(secondPayload.idempotencyKey).not.toBe(firstPayload.idempotencyKey);
    act(() => root.unmount());
  });

  it("creates a task on plain HTTP when randomUUID is unavailable", async () => {
    const originalCrypto = globalThis.crypto;
    vi.stubGlobal("crypto", { getRandomValues: originalCrypto.getRandomValues.bind(originalCrypto) });
    try {
      dialogState.newIssueDefaults = { title: "LAN preview task" };
      const { root } = renderDialog(container);
      await flush();
      act(() => Array.from(container.querySelectorAll("button"))
        .find(button => button.getAttribute("aria-label") === "Create task")!.click());
      await waitForAssertion(() => expect(dialogState.closeNewIssue).toHaveBeenCalledTimes(1));
      expect(mockIssuesApi.create.mock.calls[0][1].idempotencyKey)
        .toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      act(() => root.unmount());
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each([undefined, false, true])("navigates after creation only when navigateOnCreate is true (%s)", async (navigateOnCreate) => {
    dialogState.newIssueDefaults = { title: "Connect Circleback through Composio", navigateOnCreate };
    const { root } = renderDialog(container);
    await flush();
    const submit = Array.from(container.querySelectorAll("button"))
      .find((button) => button.getAttribute("aria-label") === "Create task")!;
    act(() => submit.click());
    await waitForAssertion(() => expect(dialogState.closeNewIssue).toHaveBeenCalledTimes(1));
    expect(mockIssuesApi.create.mock.calls[0][1]).not.toHaveProperty("navigateOnCreate");
    if (navigateOnCreate) {
      expect(navigateMock).toHaveBeenCalledExactlyOnceWith("/PAP/issues/PAP-2");
      expect(navigateMock.mock.invocationCallOrder[0]).toBeGreaterThan(dialogState.closeNewIssue.mock.invocationCallOrder[0]);
    } else {
      expect(navigateMock).not.toHaveBeenCalled();
    }
    act(() => root.unmount());
  });

  it("navigates to the returned task ID when it has no identifier", async () => {
    dialogState.newIssueDefaults = { title: "Connect Circleback through Composio", navigateOnCreate: true };
    mockIssuesApi.create.mockResolvedValue({ id: "created-task", companyId: "company-1", identifier: null });
    const { root } = renderDialog(container);
    await flush();
    act(() => Array.from(container.querySelectorAll("button"))
      .find((button) => button.getAttribute("aria-label") === "Create task")!.click());
    await waitForAssertion(() => expect(navigateMock).toHaveBeenCalledExactlyOnceWith("/PAP/issues/created-task"));
    act(() => root.unmount());
  });

  it("reuses a create request key after a failure until the submitted draft changes", async () => {
    dialogState.newIssueDefaults = { title: "Connect Circleback through Composio", navigateOnCreate: true };
    mockIssuesApi.create.mockRejectedValue(new Error("Request failed"));
    const { root } = renderDialog(container);
    await flush();
    const submit = () => Array.from(container.querySelectorAll("button"))
      .find((button) => button.getAttribute("aria-label") === "Create task")!;

    act(() => submit().click());
    await waitForAssertion(() => expect(container.textContent).toContain("Request failed"));
    const firstPayload = mockIssuesApi.create.mock.calls[0][1];
    expect(dialogState.closeNewIssue).not.toHaveBeenCalled();
    expect(toastState.pushToast).not.toHaveBeenCalled();
    expect(navigateMock).not.toHaveBeenCalled();

    act(() => submit().click());
    await waitForAssertion(() => expect(mockIssuesApi.create).toHaveBeenCalledTimes(2));
    await flush();
    expect(mockIssuesApi.create.mock.calls[1][1].idempotencyKey).toBe(firstPayload.idempotencyKey);

    await typeTextareaValue(container.querySelector<HTMLInputElement>('input[aria-label="Task title"]')!, "Connect another app");
    act(() => submit().click());
    await waitForAssertion(() => expect(mockIssuesApi.create).toHaveBeenCalledTimes(3));
    expect(mockIssuesApi.create.mock.calls[2][1].idempotencyKey).not.toBe(firstPayload.idempotencyKey);
    act(() => root.unmount());
  });

  it("keeps a create that hit an outage and resends it with the same key", async () => {
    const { ApiError } = await import("../api/client");
    dialogState.newIssueDefaults = { title: "Created during a deploy" };
    mockIssuesApi.create
      .mockRejectedValueOnce(new ApiError("Unavailable", 503, { error: "tenant_app_unavailable" }))
      .mockResolvedValue({ id: "issue-created", identifier: "PAP-9", companyId: "company-1", projectId: null });
    const { root } = renderDialog(container);
    await flush();
    const button = (label: string) => Array.from(container.querySelectorAll("button"))
      .find((item) => item.getAttribute("aria-label") === label || item.textContent === label)!;

    act(() => button("Create task").click());
    await waitForAssertion(() => expect(container.textContent).toContain("Sending when reconnected…"));
    expect(container.textContent).not.toContain("tenant_app_unavailable");
    expect(localStorage.getItem("paperclip:issue-draft:pending-create:user-1")).toContain(
      mockIssuesApi.create.mock.calls[0][1].idempotencyKey,
    );

    // The waiting request is what gets created, so later edits are locked out.
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Task title"]')?.disabled).toBe(true);

    act(() => button("Resend now").click());
    await waitForAssertion(() => expect(mockIssuesApi.create).toHaveBeenCalledTimes(2));
    expect(mockIssuesApi.create.mock.calls[1][1].idempotencyKey).toBe(mockIssuesApi.create.mock.calls[0][1].idempotencyKey);
    await waitForAssertion(() => expect(dialogState.closeNewIssue).toHaveBeenCalled());
    expect(localStorage.getItem("paperclip:issue-draft:pending-create:user-1")).toBeNull();
    act(() => root.unmount());
  });

  it("shows why a resent create was rejected", async () => {
    const { ApiError } = await import("../api/client");
    dialogState.newIssueDefaults = { title: "Rejected on resend" };
    mockIssuesApi.create
      .mockRejectedValueOnce(new ApiError("Unavailable", 503, { error: "tenant_app_unavailable" }))
      .mockRejectedValueOnce(new ApiError("Project is archived", 422, { error: "Project is archived" }));
    const { root } = renderDialog(container);
    await flush();
    const button = (label: string) => Array.from(container.querySelectorAll("button"))
      .find((item) => item.getAttribute("aria-label") === label || item.textContent === label)!;

    act(() => button("Create task").click());
    await waitForAssertion(() => expect(container.textContent).toContain("Sending when reconnected…"));
    act(() => button("Resend now").click());
    await waitForAssertion(() => expect(container.querySelector('[role="alert"]')?.textContent).toContain("Project is archived"));
    expect(container.textContent).not.toContain("Sending when reconnected…");
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Task title"]')?.disabled).toBe(false);
    act(() => root.unmount());
  });

  it("never creates a restored task without the files it was submitted with", async () => {
    dialogState.newIssueDefaults = { title: "Has files" };
    localStorage.setItem("paperclip:issue-draft:pending-create:user-1", JSON.stringify({
      version: 1,
      key: "paperclip:issue-draft:pending-create:user-1",
      idempotencyKey: "create-key-123",
      createdAt: Date.now(),
      payload: {
        fingerprint: "{}",
        data: { companyId: "company-1", title: "Has files" },
        stagedFileNames: ["spec.pdf"],
      },
    }));
    const { root } = renderDialog(container);
    await flush();

    await waitForAssertion(() => expect(container.querySelector('[role="alert"]')?.textContent).toContain("spec.pdf"));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Attach it again");
    await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="Create task"]')!.click(); });
    await flush();
    expect(mockIssuesApi.create).not.toHaveBeenCalled();
    expect(localStorage.getItem("paperclip:issue-draft:pending-create:user-1")).toBeNull();
    // The original key outlives the rejection, so it survives another reload.
    expect(localStorage.getItem("paperclip:issue-draft:create-awaiting-files:user-1")).toContain("create-key-123");
    act(() => root.unmount());

    const reloaded = renderDialog(container);
    await flush();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("spec.pdf");
    expect(localStorage.getItem("paperclip:issue-draft:create-awaiting-files:user-1")).toContain("create-key-123");
    expect(mockIssuesApi.create).not.toHaveBeenCalled();
    act(() => reloaded.root.unmount());
  });

  it.each([false, true])("keeps restored create payload immutable when files are reattached (changed title: %s)", async changed => {
    mockIssuesApi.create.mockResolvedValue({ id: "issue-1", identifier: "PAP-1", companyId: "company-1" });
    mockIssuesApi.uploadAttachment.mockResolvedValue({});
    dialogState.newIssueDefaults = { title: "Has files" };
    const spec = new File(["a"], "spec.pdf", { lastModified: 1 });
    const notes = new File(["bb"], "notes.pdf", { lastModified: 2 });
    localStorage.setItem("paperclip:issue-draft:pending-create:user-1", JSON.stringify({
      version: 1,
      key: "paperclip:issue-draft:pending-create:user-1",
      idempotencyKey: "create-key-123",
      createdAt: Date.now(),
      payload: {
        fingerprint: JSON.stringify({ stagedFiles: ["attachment::spec.pdf:1:1", "attachment::notes.pdf:2:2"] }),
        data: { companyId: "company-1", title: "Has files" },
        stagedFileNames: ["spec.pdf", "notes.pdf"],
      },
    }));
    const { root } = renderDialog(container);
    await flush();
    await waitForAssertion(() => expect(container.querySelector('[role="alert"]')?.textContent).toContain("spec.pdf"));

    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, "files", { configurable: true, value: [notes, spec] });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();
    if (changed) await typeTextareaValue(container.querySelector<HTMLInputElement>('input[aria-label="Task title"]')!, "Changed after restore");
    const send = container.querySelector<HTMLButtonElement>('[aria-label="Create task"]')!;
    await act(async () => { send.click(); });
    await flush();
    if (changed) {
      expect(mockIssuesApi.create).not.toHaveBeenCalled();
      expect(container.textContent).toContain("original fields");
    } else {
      await waitForAssertion(() => expect(mockIssuesApi.create).toHaveBeenCalledTimes(1));
      expect(mockIssuesApi.create.mock.calls[0][1].idempotencyKey).toBe("create-key-123");
      expect(mockIssuesApi.create.mock.calls[0][1].title).toBe("Has files");
    }
    act(() => root.unmount());
  });

  it("drops an account's restored create and staged files when the account changes", async () => {
    dialogState.newIssueDefaults = { title: "Account A saved task" };
    const file = new File(["a"], "spec.pdf", { lastModified: 1 });
    const original = JSON.stringify({ version: 1, key: "paperclip:issue-draft:create-awaiting-files:user-1", idempotencyKey: "account-a-create-key", createdAt: Date.now(), payload: { fingerprint: JSON.stringify({ stagedFiles: ["attachment::spec.pdf:1:1"] }), data: { companyId: "company-1", title: "Account A saved task" }, stagedFileNames: ["spec.pdf"] } });
    localStorage.setItem("paperclip:issue-draft:create-awaiting-files:user-1", original);
    const { root, queryClient } = renderDialog(container);
    try {
      await waitForAssertion(() => expect(container.textContent).toContain("spec.pdf"));
      const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
      Object.defineProperty(input, "files", { configurable: true, value: [file] });
      await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); }); await flush();
      mockAuthApi.getSession.mockResolvedValue({ user: { id: "user-2" } });
      queryClient.setQueryData(queryKeys.auth.session, { user: { id: "user-2" } });
      await waitForAssertion(() => expect(container.querySelector<HTMLInputElement>('input[aria-label="Task title"]')?.value ?? "").toBe(""));
      expect(container.textContent).not.toContain("spec.pdf");
      expect(localStorage.getItem("paperclip:issue-draft:create-awaiting-files:user-1")).toBe(original);
      await typeTextareaValue(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Describe a task…"]')!, "Account B fresh task");
      mockIssuesApi.create.mockResolvedValue({ id: "task-b", identifier: "PAP-2", companyId: "company-1" });
      await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Create task"]')!.click());
      await waitForAssertion(() => expect(mockIssuesApi.create).toHaveBeenCalledTimes(1));
      expect(mockIssuesApi.create.mock.calls[0][1].description).toBe("Account B fresh task");
      expect(mockIssuesApi.create.mock.calls[0][1].idempotencyKey).not.toBe("account-a-create-key");
      expect(mockIssuesApi.uploadAttachment).not.toHaveBeenCalled();
    } finally { act(() => root.unmount()); queryClient.clear(); }
  });

  it.each([false, true])("retains a restored task backup after the debounce (session known=%s)", async (sessionKnown) => {
    if (!sessionKnown) mockAuthApi.getSession.mockReturnValue(new Promise(() => {}));
    localStorage.setItem("paperclip:issue-draft:user-1", JSON.stringify({
      title: "", description: "Keep this restored backup", status: "todo", priority: "",
      assigneeValue: "", reviewerValue: "", approverValue: "", watchdogAgentId: "", watchdogInstructions: "",
      projectId: "", projectWorkspaceId: "", assigneeModelLane: "primary", assigneeModelOverride: "",
      assigneeThinkingEffort: "", assigneeChrome: false, executionWorkspaceMode: "shared_workspace",
      selectedExecutionWorkspaceId: "", workMode: "standard", isPrivate: false, composerSettings: null,
    }));
    const { root, queryClient } = renderDialog(container);
    try {
      await flush();
      if (!sessionKnown) queryClient.setQueryData(queryKeys.auth.session, { user: { id: "user-1" } });
      await waitForAssertion(() => expect(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Describe a task…"]')?.value).toBe("Keep this restored backup"));
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 850)); });
      expect(JSON.parse(localStorage.getItem("paperclip:issue-draft:user-1") ?? "null")?.description).toBe("Keep this restored backup");
      dialogState.newIssueOpen = false;
      act(() => root.render(<QueryClientProvider client={queryClient}><NewIssueDialog /></QueryClientProvider>));
      await flush();
      dialogState.newIssueOpen = true;
      act(() => root.render(<QueryClientProvider client={queryClient}><NewIssueDialog /></QueryClientProvider>));
      await flush();
      expect(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Describe a task…"]')?.value).toBe("Keep this restored backup");
    } finally { act(() => root.unmount()); queryClient.clear(); }
  });

  it.each([false, true])("keeps erased task text erased after reopening (session known=%s)", async (sessionKnown) => {
    if (!sessionKnown) mockAuthApi.getSession.mockReturnValue(new Promise(() => {}));
    localStorage.setItem("paperclip:issue-draft:user-1", JSON.stringify({ title: "", description: "Older saved text" }));
    const { root, queryClient } = renderDialog(container);
    try {
      await flush();
      const editor = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Describe a task…"]')!;
      await typeTextareaValue(editor, "Erase this task text");
      await typeTextareaValue(editor, "");
      if (!sessionKnown) queryClient.setQueryData(queryKeys.auth.session, { user: { id: "user-1" } });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 850)); });
      await waitForAssertion(() => expect(localStorage.getItem("paperclip:issue-draft:user-1")).toBeNull());
      dialogState.newIssueOpen = false;
      act(() => root.render(<QueryClientProvider client={queryClient}><NewIssueDialog /></QueryClientProvider>));
      await flush();
      dialogState.newIssueOpen = true;
      act(() => root.render(<QueryClientProvider client={queryClient}><NewIssueDialog /></QueryClientProvider>));
      await flush();
      expect(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Describe a task…"]')?.value).toBe("");
      expect(container.textContent).not.toContain("Erase this task text");
    } finally { act(() => root.unmount()); queryClient.clear(); }
  });

  it.each([false, true])("keeps task typing through the first session lookup (storage unavailable=%s)", async (unavailable) => {
    mockAuthApi.getSession.mockReturnValue(new Promise(() => {}));
    const { root, queryClient } = renderDialog(container);
    let storage: ReturnType<typeof vi.spyOn> | undefined;
    try {
      await flush();
      await typeTextareaValue(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Describe a task…"]')!, "Typed before account lookup");
      if (unavailable) storage = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Storage unavailable"); });
      queryClient.setQueryData(queryKeys.auth.session, { user: { id: "user-1" } });
      await flush(); await flush();
      expect(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Describe a task…"]')?.value).toBe("Typed before account lookup");
      if (!unavailable) expect(localStorage.getItem("paperclip:issue-draft:user-1")).toContain("Typed before account lookup");
      expect(mockIssuesApi.create).not.toHaveBeenCalled();
    } finally { storage?.mockRestore(); act(() => root.unmount()); queryClient.clear(); }
  });

  it.each(["create", "upload"] as const)("stops old staged work after an account change during %s", async (during) => {
    dialogState.newIssueDefaults = { title: "Account A in-flight task" };
    let finish!: (value: unknown) => void;
    const waiting = new Promise(resolve => { finish = resolve; });
    const created = { id: "task-a", identifier: "PAP-1", companyId: "company-1" };
    mockIssuesApi.create.mockImplementation(() => during === "create" ? waiting : Promise.resolve(created));
    mockIssuesApi.uploadAttachment.mockImplementation(() => during === "upload" ? waiting : Promise.resolve({}));
    const { root, queryClient } = renderDialog(container);
    try {
      await flush(); await flush();
      const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
      Object.defineProperty(input, "files", { configurable: true, value: [new File(["a"], "first.pdf"), new File(["b"], "second.pdf")] });
      await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); }); await flush();
      await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="Create task"]')!.click(); });
      await waitForAssertion(() => expect(mockIssuesApi.create).toHaveBeenCalledTimes(1));
      if (during === "upload") await waitForAssertion(() => expect(mockIssuesApi.uploadAttachment).toHaveBeenCalledTimes(1));
      const key = mockIssuesApi.create.mock.calls[0][1].idempotencyKey;
      mockAuthApi.getSession.mockResolvedValue({ user: { id: "user-2" } });
      queryClient.setQueryData(queryKeys.auth.session, { user: { id: "user-2" } });
      await flush(); await flush();
      finish(during === "create" ? created : {});
      await waitForAssertion(() => {
        const mutation = queryClient.getMutationCache().getAll().find(item => (item.state.variables as { idempotencyKey?: string } | undefined)?.idempotencyKey === key);
        expect(mutation?.state.status).toMatch(/^(success|error)$/);
      });
      expect(mockIssuesApi.uploadAttachment).toHaveBeenCalledTimes(during === "create" ? 0 : 1);
      expect(dialogState.closeNewIssue).not.toHaveBeenCalled();
      expect(localStorage.getItem("paperclip:issue-draft:pending-create:user-1")).toContain(key);
      expect(container.textContent).not.toContain("Account A in-flight task");
    } finally { act(() => root.unmount()); queryClient.clear(); }
  });

  it("restores original document keys when colliding document names are reattached in reverse", async () => {
    dialogState.newIssueDefaults = { title: "Has documents" };
    mockIssuesApi.create.mockResolvedValue({ id: "issue-1", identifier: "PAP-1", companyId: "company-1" });
    mockIssuesApi.upsertDocument.mockResolvedValue({});
    const markdown = new File(["a"], "notes.md", { type: "text/markdown", lastModified: 1 });
    const text = new File(["bb"], "notes.txt", { type: "text/plain", lastModified: 2 });
    localStorage.setItem("paperclip:issue-draft:create-awaiting-files:user-1", JSON.stringify({ version: 1, key: "paperclip:issue-draft:create-awaiting-files:user-1", idempotencyKey: "original-doc-create-key", createdAt: Date.now(), payload: { fingerprint: JSON.stringify({ stagedFiles: ["document:notes:notes.md:1:1", "document:notes-2:notes.txt:2:2"] }), data: { companyId: "company-1", title: "Has documents" }, stagedFileNames: ["notes.md", "notes.txt"] } }));
    const { root } = renderDialog(container);
    try {
      await waitForAssertion(() => expect(container.textContent).toContain("notes.md"));
      const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
      Object.defineProperty(input, "files", { configurable: true, value: [text, markdown] });
      await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); }); await flush();
      await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Create task"]')!.click());
      await waitForAssertion(() => expect(mockIssuesApi.create).toHaveBeenCalledTimes(1));
      expect(mockIssuesApi.create.mock.calls[0][1].idempotencyKey).toBe("original-doc-create-key");
      await waitForAssertion(() => expect(mockIssuesApi.upsertDocument).toHaveBeenCalledTimes(2));
      expect(mockIssuesApi.upsertDocument).toHaveBeenCalledWith("issue-1", "notes", expect.objectContaining({ body: "a" }));
      expect(mockIssuesApi.upsertDocument).toHaveBeenCalledWith("issue-1", "notes-2", expect.objectContaining({ body: "bb" }));
    } finally { act(() => root.unmount()); }
  });

  it("restores a saved subtask's parent and goal when opened from the normal New Task action", async () => {
    dialogState.newIssueDefaults = {};
    mockIssuesApi.create.mockResolvedValue({ id: "issue-1", identifier: "PAP-1", companyId: "company-1" });
    mockIssuesApi.uploadAttachment.mockResolvedValue({});
    mockIssuesApi.get.mockResolvedValue({ id: "parent-1", identifier: "PAP-2", title: "Parent", isPrivate: false });
    localStorage.setItem("paperclip:issue-draft:user-1", JSON.stringify({ title: "Saved subtask", description: "", status: "todo", priority: "", projectId: "", assigneeValue: "" }));
    localStorage.setItem("paperclip:issue-draft:create-awaiting-files:user-1", JSON.stringify({
      version: 1, key: "paperclip:issue-draft:create-awaiting-files:user-1", idempotencyKey: "subtask-key-123", createdAt: Date.now(),
      payload: { fingerprint: JSON.stringify({ stagedFiles: ["attachment::spec.pdf:1:1"] }),
        data: { companyId: "company-1", title: "Saved subtask", parentId: "parent-1", goalId: "goal-1" }, stagedFileNames: ["spec.pdf"] },
    }));
    const { root } = renderDialog(container);
    await flush();
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, "files", { configurable: true, value: [new File(["a"], "spec.pdf", { lastModified: 1 })] });
    await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
    await flush();
    await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="Create sub-task"]')!.click(); });
    await flush();
    expect(mockIssuesApi.create).toHaveBeenCalledTimes(1);
    expect(mockIssuesApi.create.mock.calls[0]?.[1]).toMatchObject({ idempotencyKey: "subtask-key-123", title: "Saved subtask", parentId: "parent-1", goalId: "goal-1" });
    act(() => root.unmount());
  });

  it("submits Chinese, Japanese, and Hindi issue text without normalization", async () => {
    const title = "验证中文任务";
    const description = [
      "请用中文回复。",
      "日本語: 次の手順を書いてください。",
      "हिन्दी: कृपया स्थिति बताएं।",
    ].join("\n");

    dialogState.newIssueDefaults = { title };
    const { root } = renderDialog(container);
    await flush();

    const descriptionInput = container.querySelector('textarea[aria-label="Describe a task…"]') as HTMLTextAreaElement | null;
    expect(descriptionInput).not.toBeNull();

    await typeTextareaValue(descriptionInput!, description);

    const submitButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.getAttribute("aria-label") === "Create task");
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

    const titleInput = container.querySelector('textarea[aria-label="Describe a task…"]') as HTMLTextAreaElement | null;
    expect(titleInput).not.toBeNull();
    await typeTextareaValue(titleInput!, "Plan this first");

    const planningButton = container.querySelector('[data-testid="composer-add-plan"]');
    expect(planningButton).not.toBeNull();
    await act(async () => {
      planningButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    const submitButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.getAttribute("aria-label") === "Create task");
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
        description: "Plan this first",
        workMode: "planning",
      }),
    );

    act(() => root.unmount());
  });

  it("submits ask work mode when ask is selected", async () => {
    const { root } = renderDialog(container);
    await flush();

    const titleInput = container.querySelector('textarea[aria-label="Describe a task…"]') as HTMLTextAreaElement | null;
    expect(titleInput).not.toBeNull();
    await typeTextareaValue(titleInput!, "Answer this first");

    const askButton = container.querySelector('[data-testid="composer-add-ask"]');
    expect(askButton).not.toBeNull();
    await act(async () => {
      askButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    const submitButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.getAttribute("aria-label") === "Create task");
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
        description: "Answer this first",
        workMode: "ask",
      }),
    );

    act(() => root.unmount());
  });

  it("cycles work modes with cmd-period", async () => {
    const { root } = renderDialog(container);
    await flush();

    const modeChip = () => container.querySelector("[data-testid=task-chat-composer-mode]");
    expect(modeChip()).toBeNull();

    await act(async () => {
      container.querySelector(".paperclip-task-chat-composer")?.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        code: "",
        key: ".",
        metaKey: true,
      }));
    });
    expect(modeChip()?.getAttribute("data-pending-work-mode")).toBe("planning");
    expect(modeChip()?.textContent).toContain("Plan mode");

    await act(async () => {
      container.querySelector(".paperclip-task-chat-composer")?.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        code: "Period",
        key: ".",
        metaKey: true,
      }));
    });
    expect(modeChip()?.getAttribute("data-pending-work-mode")).toBe("ask");
    expect(modeChip()?.textContent).toContain("Ask mode");

    await act(async () => {
      container.querySelector(".paperclip-task-chat-composer")?.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        code: "Period",
        key: ".",
        metaKey: true,
      }));
    });
    expect(modeChip()).toBeNull();

    act(() => root.unmount());
  });

  it("cycles work modes when iOS reports cmd-period as Escape", async () => {
    const { root } = renderDialog(container);
    await flush();

    const modeChip = () => container.querySelector("[data-testid=task-chat-composer-mode]");
    expect(modeChip()).toBeNull();
    expect(dialogContentState.onEscapeKeyDown).not.toBeNull();

    const commandPeriodAsEscape = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Escape",
      metaKey: true,
    });
    await act(async () => {
      dialogContentState.onEscapeKeyDown?.(commandPeriodAsEscape);
    });

    expect(commandPeriodAsEscape.defaultPrevented).toBe(true);
    expect(modeChip()?.getAttribute("data-pending-work-mode")).toBe("planning");
    expect(dialogState.closeNewIssue).not.toHaveBeenCalled();

    const plainEscape = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Escape",
    });
    await act(async () => {
      dialogContentState.onEscapeKeyDown?.(plainEscape);
    });

    expect(plainEscape.defaultPrevented).toBe(false);
    expect(modeChip()?.getAttribute("data-pending-work-mode")).toBe("planning");

    const controlEscape = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      key: "Escape",
    });
    await act(async () => {
      dialogContentState.onEscapeKeyDown?.(controlEscape);
    });

    expect(controlEscape.defaultPrevented).toBe(false);
    expect(modeChip()?.getAttribute("data-pending-work-mode")).toBe("planning");

    act(() => root.unmount());
  });

  it("cycles work modes with ctrl-period", async () => {
    const { root } = renderDialog(container);
    await flush();

    const modeChip = () => container.querySelector("[data-testid=task-chat-composer-mode]");
    expect(modeChip()).toBeNull();

    await act(async () => {
      container.querySelector(".paperclip-task-chat-composer")?.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        code: "Period",
        key: ".",
        ctrlKey: true,
      }));
    });
    expect(modeChip()?.getAttribute("data-pending-work-mode")).toBe("planning");

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
      .find((button) => button.getAttribute("aria-label") === "Create sub-task");
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
      typeof element.className === "string" && element.className.includes("max-h-(--new-issue-dialog-height)"),
    );
    expect(dialogContent?.className).toContain("h-(--new-issue-dialog-height)");
    expect(dialogContent?.className).toContain("overflow-hidden");

    const descriptionInput = container.querySelector('textarea[aria-label="Describe a task…"]');
    const bodyScrollRegion = Array.from(container.querySelectorAll("div")).find((element) =>
      typeof element.className === "string" && element.className.includes("overscroll-contain"),
    );
    expect(bodyScrollRegion?.className).toContain("min-h-0");
    expect(bodyScrollRegion?.className).toContain("overflow-y-auto");
    expect(bodyScrollRegion?.contains(descriptionInput ?? null)).toBe(true);

    act(() => root.unmount());
  });

  it("tracks the mobile visual viewport and keeps the focused editor visible above the keyboard", async () => {
    const visualViewport = new EventTarget() as EventTarget & {
      height: number;
      offsetTop: number;
    };
    visualViewport.height = 844;
    visualViewport.offsetTop = 0;
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: visualViewport,
    });
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: 844,
    });

    const { root } = renderDialog(container);
    await flush();

    const dialogContent = Array.from(container.querySelectorAll<HTMLDivElement>("div")).find((element) =>
      element.className.includes("max-h-(--new-issue-dialog-height)"),
    );
    const descriptionInput = container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Describe a task…"]',
    );
    const scrollIntoView = vi.fn();
    Object.defineProperty(descriptionInput!, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    descriptionInput?.focus();

    expect(dialogContent?.style.top).toBe("");
    expect(dialogContent?.style.maxHeight).toBe("");
    expect(dialogContent?.style.translate).toBe("");

    visualViewport.height = 420;
    visualViewport.offsetTop = 24;
    await act(async () => {
      visualViewport.dispatchEvent(new Event("resize"));
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });

    expect(dialogContent?.style.getPropertyValue("--new-issue-visual-viewport-height")).toBe("420px");
    expect(dialogContent?.style.getPropertyValue("--new-issue-dialog-top")).toBe(
      "var(--new-issue-dialog-top-gap)",
    );
    expect(dialogContent?.style.getPropertyValue("--new-issue-dialog-height")).toBe(
      "calc(var(--new-issue-visual-viewport-height) - var(--new-issue-dialog-top-gap) - var(--new-issue-dialog-bottom-gap))",
    );
    expect(dialogContent?.style.top).toBe("var(--new-issue-dialog-top)");
    expect(dialogContent?.style.maxHeight).toBe("var(--new-issue-dialog-height)");
    expect(dialogContent?.style.translate).toBe("var(--pct-neg-50)");
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });

    act(() => root.unmount());
  });

  it("ignores transient invalid visual viewport measurements and keeps the last valid layout", async () => {
    const visualViewport = new EventTarget() as EventTarget & {
      height: number;
      offsetTop: number;
    };
    visualViewport.height = 0;
    visualViewport.offsetTop = 0;
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: visualViewport,
    });
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: 844,
    });

    const { root } = renderDialog(container);
    await flush();

    const dialogContent = Array.from(container.querySelectorAll<HTMLDivElement>("div")).find((element) =>
      element.className.includes("max-h-(--new-issue-dialog-height)"),
    );
    expect(dialogContent?.style.getPropertyValue("--new-issue-visual-viewport-height")).toBe("");
    expect(dialogContent?.style.top).toBe("");
    expect(dialogContent?.style.maxHeight).toBe("");
    expect(dialogContent?.style.translate).toBe("");

    visualViewport.height = 420;
    visualViewport.offsetTop = 24;
    await act(async () => {
      visualViewport.dispatchEvent(new Event("resize"));
    });

    expect(dialogContent?.style.getPropertyValue("--new-issue-visual-viewport-height")).toBe("420px");
    expect(dialogContent?.style.top).toBe("var(--new-issue-dialog-top)");
    expect(dialogContent?.style.maxHeight).toBe("var(--new-issue-dialog-height)");

    visualViewport.height = 0;
    visualViewport.offsetTop = Number.NaN;
    await act(async () => {
      visualViewport.dispatchEvent(new Event("resize"));
    });

    expect(dialogContent?.style.getPropertyValue("--new-issue-visual-viewport-height")).toBe("420px");
    expect(dialogContent?.style.top).toBe("var(--new-issue-dialog-top)");
    expect(dialogContent?.style.maxHeight).toBe("var(--new-issue-dialog-height)");

    act(() => root.unmount());
  });

  it("hides the priority chip and mobile priority option (PAP-411)", async () => {
    const { root } = renderDialog(container);
    await flush();

    // PAP-411: priority UI is hidden behind SHOW_TASK_PRIORITY_UI (off). Neither the
    // desktop priority chip nor the mobile overflow priority option should render.
    const priorityChip = container.querySelector('[data-testid="new-issue-priority-chip"]');
    expect(priorityChip).toBeNull();

    const highPriorityOption = container.querySelector('[data-testid="new-issue-more-priority-high"]');
    expect(highPriorityOption).toBeNull();

    act(() => root.unmount());
  });

  it("still submits the default priority when the priority UI is hidden (PAP-411)", async () => {
    dialogState.newIssueDefaults = {
      title: "Priority default persists",
    };

    const { root } = renderDialog(container);
    await flush();

    const submitButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.getAttribute("aria-label") === "Create task");
    expect(submitButton).not.toBeUndefined();
    await vi.waitFor(() => {
      expect(submitButton?.hasAttribute("disabled")).toBe(false);
    });

    await act(async () => {
      submitButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    // PAP-411: the priority control is hidden, but the data-model default must survive.
    expect(mockIssuesApi.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        title: "Priority default persists",
        priority: "medium",
      }),
    );

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



  it("submits the configured watchdog from a restored draft", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({
      enableIsolatedWorkspaces: false,
    });
    localStorage.setItem(
      "paperclip:issue-draft:user-1",
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


    const submitButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.getAttribute("aria-label") === "Create task");
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

  it("retains a failed creation draft and allows retry through the composer", async () => {
    mockIssuesApi.create.mockRejectedValueOnce(new Error("Service unavailable"));
    dialogState.newIssueDefaults = { description: "Keep this request for retry" };
    const { root } = renderDialog(container);
    await flush();
    const send = container.querySelector<HTMLButtonElement>('[aria-label="Create task"]')!;
    await act(async () => { send.click(); });
    await waitForAssertion(() => expect(container.querySelector('[role="alert"]')?.textContent).toContain("Service unavailable"));
    expect(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Describe a task…"]')?.value).toBe("Keep this request for retry");
    expect(dialogState.closeNewIssue).not.toHaveBeenCalled();
    await act(async () => { send.click(); });
    await waitForAssertion(() => expect(dialogState.closeNewIssue).toHaveBeenCalledOnce());
    expect(mockIssuesApi.create).toHaveBeenCalledTimes(2);
    act(() => root.unmount());
  });

  it("restores shared model, effort, and fast settings into the created task", async () => {
    mockAgentsApi.list.mockResolvedValue([{ id: "agent-1", name: "Coder", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} }]);
    localStorage.setItem("paperclip:issue-draft:user-1", JSON.stringify({
      title: "", description: "Use the saved run settings", status: "todo", priority: "medium",
      assigneeValue: "agent:agent-1", projectId: "", workMode: "planning",
      composerSettings: { model: "gpt-6-astra", effort: "ultra", fast: true },
    }));
    const { root } = renderDialog(container);
    await waitForAssertion(() => expect(container.textContent).toContain("Coder"));
    await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="Create task"]')!.click(); });
    await waitForAssertion(() => expect(mockIssuesApi.create).toHaveBeenCalledWith("company-1", expect.objectContaining({
      assigneeAgentId: "agent-1", workMode: "planning",
      assigneeAdapterOverrides: { adapterConfig: { model: "gpt-6-astra", modelReasoningEffort: "ultra", fastMode: true } },
    })));
    act(() => root.unmount());
  });

  describe("work-mode labels", () => {
    function workModeOption(value: string) {
      return container.querySelector(`[data-testid="composer-add-${value === "planning" ? "plan" : value}"]`);
    }

    it("uses the shared composer mode labels", async () => {
      const { root } = renderDialog(container);
      await waitForAssertion(() => {
        expect(container.querySelector("[data-testid=task-chat-composer-add]")).not.toBeNull();
      });

      expect(container.querySelector("[data-testid=task-chat-composer-add]")).not.toBeNull();
      expect(workModeOption("ask")?.textContent).toContain("Ask mode");
      expect(workModeOption("planning")?.textContent).toContain("Plan mode");


      act(() => root.unmount());
    });
  });

});

describe("addStagedFilesToIssue", () => {
  beforeEach(() => {
    vi.stubGlobal("crypto", webcrypto);
    localStorage.clear();
    mockIssuesApi.uploadAttachment.mockReset();
  });

  afterEach(() => vi.unstubAllGlobals());

  it("keeps a confirmed upload receipt when ownership changes before the next file", async () => {
    const files = ["one", "two"].map((name, index) => ({ id: name, kind: "attachment" as const, file: new File([name], `${name}.pdf`, { lastModified: index + 1 }) }));
    let owned = true;
    const assertCurrentOwner = () => { if (!owned) throw new Error("Account changed"); };
    mockIssuesApi.uploadAttachment.mockResolvedValue({}).mockImplementationOnce(async () => { owned = false; return {}; });
    const input = { companyId: "company-1", issueId: "task-1", stagedFiles: files, idempotencyKey: "original-upload-request", assertCurrentOwner };
    await expect(addStagedFilesToIssue(input)).rejects.toThrow("Account changed");
    expect(mockIssuesApi.uploadAttachment).toHaveBeenCalledTimes(1);
    owned = true;
    await expect(addStagedFilesToIssue(input)).resolves.toEqual([]);
    expect(mockIssuesApi.uploadAttachment.mock.calls.map(call => call[2].name)).toEqual(["one.pdf", "two.pdf"]);
  });

  it("uploads distinct files with the same metadata instead of treating one as a receipt", async () => {
    const stagedFiles = ["a", "b"].map((body, index) => ({
      id: `staged-${index}`,
      kind: "attachment" as const,
      file: new File([body], "report.txt", { lastModified: 123 }),
    }));
    mockIssuesApi.uploadAttachment.mockResolvedValue({});
    expect(await addStagedFilesToIssue({ companyId: "company-1", issueId: "issue-1", idempotencyKey: "metadata-collision", stagedFiles })).toEqual([]);
    expect(mockIssuesApi.uploadAttachment).toHaveBeenCalledTimes(2);
    expect(mockIssuesApi.uploadAttachment.mock.calls[0]?.[2]).toBe(stagedFiles[0]!.file);
    expect(mockIssuesApi.uploadAttachment.mock.calls[1]?.[2]).toBe(stagedFiles[1]!.file);
  });

  it("still uploads files when browser hashing is unavailable", async () => {
    vi.stubGlobal("crypto", {});
    const stagedFiles = ["a", "b"].map((body, index) => ({
      id: `staged-${index}`, kind: "attachment" as const,
      file: new File([body], "report.txt", { lastModified: 123 }),
    }));
    mockIssuesApi.uploadAttachment.mockResolvedValue({});
    expect(await addStagedFilesToIssue({ companyId: "company-1", issueId: "issue-1", idempotencyKey: "hashing-unavailable", stagedFiles })).toEqual([]);
    expect(mockIssuesApi.uploadAttachment).toHaveBeenCalledTimes(2);
  });

  it("never adds a file twice when a create replays after a reload mid-upload", async () => {
    const spec = { id: "staged-1", kind: "attachment" as const, file: new File(["a"], "spec.pdf", { lastModified: 1 }) };
    const notes = { id: "staged-2", kind: "attachment" as const, file: new File(["bb"], "notes.txt", { lastModified: 2 }) };
    mockIssuesApi.uploadAttachment.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error("Upload interrupted"));
    const target = { companyId: "company-1", issueId: "issue-1", idempotencyKey: "create-key-123" };
    expect(await addStagedFilesToIssue({ ...target, stagedFiles: [spec, notes] })).toEqual(["notes.txt"]);

    // Reattached after a reload: new staging ids, the same files, the same key.
    mockIssuesApi.uploadAttachment.mockResolvedValue({});
    expect(await addStagedFilesToIssue({
      ...target,
      stagedFiles: [{ ...spec, id: "staged-3" }, { ...notes, id: "staged-4" }],
    })).toEqual([]);
    expect(mockIssuesApi.uploadAttachment.mock.calls.map((call) => (call[2] as File).name)).toEqual([
      "spec.pdf",
      "notes.txt",
      "notes.txt",
    ]);
  });
});
