// @vitest-environment jsdom

import type { ComponentProps, ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import type {
  ExecutionWorkspace,
  IssueExecutionPolicy,
  IssueExecutionState,
  IssueLabel,
  Project,
  WorkspaceRuntimeService,
} from "@paperclipai/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Issue, IssueDocument } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IssueProperties } from "./IssueProperties";
import { queryKeys } from "../lib/queryKeys";

const mockAgentsApi = vi.hoisted(() => ({
  list: vi.fn(),
  adapterModels: vi.fn(),
}));

const mockProjectsApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockExecutionWorkspacesApi = vi.hoisted(() => ({
  list: vi.fn(),
  controlRuntimeCommands: vi.fn(),
}));

const mockIssuesApi = vi.hoisted(() => ({
  list: vi.fn(),
  getDocument: vi.fn(),
  listAcceptedPlanDecompositions: vi.fn(),
  listAttachments: vi.fn(),
  listDocuments: vi.fn(),
  listWorkProducts: vi.fn(),
  listInteractions: vi.fn(),
  listLabels: vi.fn(),
  createLabel: vi.fn(),
  upsertWatchdog: vi.fn(),
  deleteWatchdog: vi.fn(),
  unarchiveFromInbox: vi.fn(),
}));

const mockAuthApi = vi.hoisted(() => ({
  getSession: vi.fn(),
}));

const mockAccessApi = vi.hoisted(() => ({
  listUserDirectory: vi.fn(),
}));

const mockInstanceSettingsApi = vi.hoisted(() => ({
  getExperimental: vi.fn(),
}));

const mockSidebarState = vi.hoisted(() => ({
  isMobile: false,
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
  }),
}));

vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => mockSidebarState,
}));

vi.mock("../api/agents", () => ({
  agentsApi: mockAgentsApi,
}));

vi.mock("../api/projects", () => ({
  projectsApi: mockProjectsApi,
}));

vi.mock("../api/execution-workspaces", () => ({
  executionWorkspacesApi: mockExecutionWorkspacesApi,
}));

vi.mock("../api/issues", () => ({
  issuesApi: mockIssuesApi,
}));

vi.mock("../api/auth", () => ({
  authApi: mockAuthApi,
}));

vi.mock("../api/access", () => ({
  accessApi: mockAccessApi,
}));

vi.mock("../api/instanceSettings", () => ({
  instanceSettingsApi: mockInstanceSettingsApi,
}));

vi.mock("../context/ToastContext", () => ({
  useToastActions: () => ({ pushToast: vi.fn() }),
}));

vi.mock("../hooks/useProjectOrder", () => ({
  useProjectOrder: ({ projects }: { projects: unknown[] }) => ({
    orderedProjects: projects,
  }),
}));

vi.mock("../lib/recent-assignees", () => ({
  getRecentAssigneeIds: () => [],
  getRecentAssigneeSelectionIds: () => [],
  sortAgentsByRecency: (agents: unknown[]) => agents,
  trackRecentAssignee: vi.fn(),
  trackRecentAssigneeUser: vi.fn(),
}));

vi.mock("../lib/assignees", () => ({
  formatAssigneeUserLabel: (userId: string | null | undefined, currentUserId?: string | null, userLabelMap?: Map<string, string>) => {
    if (!userId) return null;
    return userLabelMap?.get(userId) ?? (userId === currentUserId ? "You" : "User");
  },
  formatUserLabel: (userId: string | null | undefined, userLabelMap?: Map<string, string>) => {
    if (!userId) return null;
    return userLabelMap?.get(userId) ?? "User";
  },
}));

vi.mock("./StatusIcon", () => ({
  StatusIcon: ({ status, blockerAttention }: { status: string; blockerAttention?: Issue["blockerAttention"] }) => (
    <span data-status-icon-state={blockerAttention?.state}>{status}</span>
  ),
}));

vi.mock("./PriorityIcon", () => ({
  PriorityIcon: ({ priority }: { priority: string }) => <span>{priority}</span>,
}));

vi.mock("./Identity", () => ({
  Identity: ({ name, shape }: { name: string; shape?: string }) => <span data-shape={shape ?? "circle"}>{name}</span>,
}));

vi.mock("./AgentIconPicker", () => ({
  AgentIcon: () => null,
}));

vi.mock("@/lib/router", () => ({
  Link: ({
    children,
    to,
    state: _state,
    disableIssueQuicklook: _disableIssueQuicklook,
    issuePrefetch: _issuePrefetch,
    ...props
  }: { children: ReactNode; to: string; state?: unknown; disableIssueQuicklook?: boolean; issuePrefetch?: unknown } & ComponentProps<"a">) => <a href={to} {...props}>{children}</a>,
  useCaseHref: () => (caseId: string) => `/cases/${caseId}`,
  useLocation: () => ({ hash: "", pathname: "/", search: "", state: null, key: "test" }),
}));

vi.mock("@/components/ui/separator", () => ({
  Separator: () => <hr />,
}));

vi.mock("@/components/MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/IssueDocumentAnnotations", () => ({
  DocumentAnnotationsCountChip: ({ docKey }: { docKey: string }) => <span data-doc-key={docKey} />,
  IssueDocumentAnnotations: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

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

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/**
 * Finds the trigger button for a property row by its (sentence-case) label.
 * `PropertyRow` exposes a stable label hook so layout utility changes do not
 * affect tests that need to find the corresponding value slot.
 */
function findRowTrigger(container: HTMLElement, label: string): HTMLButtonElement | undefined {
  const labelSpan = container.querySelector(`[data-property-label="${label}"]`);
  const row = labelSpan?.closest('[data-property-row="true"]');
  return (row?.querySelector("button") as HTMLButtonElement | null) ?? undefined;
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

function createIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    companyId: "company-1",
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: "Parent issue",
    description: null,
    status: "todo",
    priority: "medium",
    reviewPolicy: null,
    assigneeAgentId: null,
    assigneeUserId: null,
    responsibleUserId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    createdByAgentId: null,
    createdByUserId: "user-1",
    issueNumber: 1,
    identifier: "PAP-1",
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    labels: [],
    labelIds: [],
    blockedBy: [],
    blocks: [],
    createdAt: new Date("2026-04-06T12:00:00.000Z"),
    updatedAt: new Date("2026-04-06T12:05:00.000Z"),
    ...overrides,
    workMode: overrides.workMode ?? "standard",
  };
}

function createLabel(overrides: Partial<IssueLabel> = {}): IssueLabel {
  return {
    id: "label-1",
    companyId: "company-1",
    name: "Bug",
    color: "#ef4444",
    createdAt: new Date("2026-04-06T12:00:00.000Z"),
    updatedAt: new Date("2026-04-06T12:00:00.000Z"),
    ...overrides,
  };
}

function createRuntimeService(overrides: Partial<WorkspaceRuntimeService> = {}): WorkspaceRuntimeService {
  return {
    id: "service-1",
    companyId: "company-1",
    projectId: "project-1",
    projectWorkspaceId: "workspace-main",
    executionWorkspaceId: "workspace-1",
    issueId: "issue-1",
    scopeType: "execution_workspace",
    scopeId: "workspace-1",
    serviceName: "web",
    status: "running",
    lifecycle: "shared",
    reuseKey: null,
    command: "pnpm dev",
    cwd: "/tmp/paperclip",
    port: 62475,
    url: "http://127.0.0.1:62475",
    provider: "local_process",
    providerRef: null,
    ownerAgentId: null,
    startedByRunId: null,
    lastUsedAt: new Date("2026-04-06T12:03:00.000Z"),
    startedAt: new Date("2026-04-06T12:02:00.000Z"),
    stoppedAt: null,
    stopPolicy: null,
    healthStatus: "healthy",
    createdAt: new Date("2026-04-06T12:02:00.000Z"),
    updatedAt: new Date("2026-04-06T12:03:00.000Z"),
    ...overrides,
  };
}

function createExecutionWorkspace(overrides: Partial<ExecutionWorkspace> = {}): ExecutionWorkspace {
  return {
    id: "workspace-1",
    companyId: "company-1",
    projectId: "project-1",
    projectWorkspaceId: "workspace-main",
    sourceIssueId: "issue-1",
    mode: "isolated_workspace",
    strategyType: "git_worktree",
    name: "PAP-1 workspace",
    status: "active",
    deliveryState: "unknown",
    cwd: "/tmp/paperclip/PAP-1",
    repoUrl: null,
    baseRef: "master",
    branchName: "pap-1-workspace",
    providerType: "git_worktree",
    providerRef: "/tmp/paperclip/PAP-1",
    derivedFromExecutionWorkspaceId: null,
    lastUsedAt: new Date("2026-04-06T12:04:00.000Z"),
    openedAt: new Date("2026-04-06T12:01:00.000Z"),
    closedAt: null,
    cleanupEligibleAt: null,
    cleanupReason: null,
    config: null,
    metadata: null,
    runtimeServices: [createRuntimeService()],
    createdAt: new Date("2026-04-06T12:01:00.000Z"),
    updatedAt: new Date("2026-04-06T12:04:00.000Z"),
    ...overrides,
  };
}

function createProject(overrides: Partial<Project> = {}): Project {
  const primaryWorkspace = {
    id: "workspace-main",
    companyId: "company-1",
    projectId: "project-1",
    name: "Main",
    sourceType: "local_path" as const,
    cwd: "/tmp/paperclip",
    repoUrl: null,
    repoRef: null,
    defaultRef: "master",
    visibility: "default" as const,
    setupCommand: null,
    cleanupCommand: null,
    remoteProvider: null,
    remoteWorkspaceRef: null,
    sharedWorkspaceKey: null,
    metadata: null,
    runtimeConfig: null,
    isPrimary: true,
    runtimeServices: [],
    createdAt: new Date("2026-04-06T12:00:00.000Z"),
    updatedAt: new Date("2026-04-06T12:00:00.000Z"),
  };
  return {
    id: "project-1",
    companyId: "company-1",
    urlKey: "project-1",
    goalId: null,
    goalIds: [],
    goals: [],
    name: "Project",
    description: null,
    status: "in_progress",
    leadAgentId: null,
    targetDate: null,
    color: "#6366f1",
    icon: null,
    env: null,
    pauseReason: null,
    pausedAt: null,
    executionWorkspacePolicy: null,
    codebase: {
      workspaceId: "workspace-main",
      repoUrl: null,
      repoRef: null,
      defaultRef: "master",
      repoName: null,
      localFolder: "/tmp/paperclip",
      managedFolder: "/tmp/paperclip",
      effectiveLocalFolder: "/tmp/paperclip",
      origin: "local_folder",
    },
    workspaces: [primaryWorkspace],
    primaryWorkspace,
    archivedAt: null,
    createdAt: new Date("2026-04-06T12:00:00.000Z"),
    updatedAt: new Date("2026-04-06T12:00:00.000Z"),
    ...overrides,
  };
}

function createExecutionPolicy(overrides: Partial<IssueExecutionPolicy> = {}): IssueExecutionPolicy {
  return {
    mode: "normal",
    commentRequired: true,
    stages: [],
    ...overrides,
  };
}

function createExecutionState(overrides: Partial<IssueExecutionState> = {}): IssueExecutionState {
  return {
    status: "changes_requested",
    currentStageId: "stage-1",
    currentStageIndex: 0,
    currentStageType: "review",
    currentParticipant: { type: "agent", agentId: "agent-1", userId: null },
    returnAssignee: { type: "agent", agentId: "agent-2", userId: null },
    reviewRequest: null,
    completedStageIds: [],
    lastDecisionId: null,
    lastDecisionOutcome: "changes_requested",
    ...overrides,
  };
}

function renderPropertiesWithQueryClient(container: HTMLDivElement, props: ComponentProps<typeof IssueProperties>) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
  const root = createRoot(container);
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <IssueProperties {...props} />
      </QueryClientProvider>,
    );
  });
  return { root, queryClient };
}

function renderProperties(container: HTMLDivElement, props: ComponentProps<typeof IssueProperties>) {
  const { root } = renderPropertiesWithQueryClient(container, props);
  return root;
}

describe("IssueProperties", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    mockSidebarState.isMobile = false;
    container = document.createElement("div");
    document.body.appendChild(container);
    mockAgentsApi.list.mockResolvedValue([]);
    mockAgentsApi.adapterModels.mockResolvedValue([]);
    mockProjectsApi.list.mockResolvedValue([]);
    mockExecutionWorkspacesApi.list.mockResolvedValue([]);
    mockExecutionWorkspacesApi.controlRuntimeCommands.mockReset();
    mockIssuesApi.list.mockResolvedValue([]);
    mockIssuesApi.getDocument.mockResolvedValue(null);
    mockIssuesApi.listAcceptedPlanDecompositions.mockResolvedValue([]);
    mockIssuesApi.listAttachments.mockResolvedValue([]);
    mockIssuesApi.listDocuments.mockResolvedValue([]);
    mockIssuesApi.listWorkProducts.mockResolvedValue([]);
    mockIssuesApi.listInteractions.mockResolvedValue([]);
    mockIssuesApi.listLabels.mockResolvedValue([]);
    mockIssuesApi.createLabel.mockResolvedValue(createLabel({
      id: "label-new",
      name: "New label",
      color: "#6366f1",
    }));
    mockIssuesApi.upsertWatchdog.mockResolvedValue({});
    mockIssuesApi.deleteWatchdog.mockResolvedValue({ ok: true });
    mockIssuesApi.unarchiveFromInbox.mockResolvedValue({ ok: true });
    mockAuthApi.getSession.mockResolvedValue({ user: { id: "user-1" } });
    mockAccessApi.listUserDirectory.mockResolvedValue({
      users: [
        {
          principalId: "user-1",
          status: "active",
          user: { id: "user-1", name: "Riley Board", email: "riley@example.com", image: null },
        },
        {
          principalId: "user-2",
          status: "active",
          user: { id: "user-2", name: "Morgan Product", email: "morgan@example.com", image: null },
        },
      ],
    });
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({
      enableTaskWatchdogs: false,
      enableStreamlinedUi: true,
    });
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("marks the task-detail property typography and section rhythm", () => {
    const root = renderProperties(container, {
      issue: createIssue(),
      childIssues: [],
      onUpdate: vi.fn(),
      inline: true,
    });

    const surface = container.querySelector(".task-detail-properties");
    expect(surface).not.toBeNull();
    expect(surface?.classList).toContain("pl-4");
    expect(surface?.querySelectorAll('[data-property-section="true"]').length).toBeGreaterThan(1);
    expect(surface?.querySelector('[data-property-value="true"]')).not.toBeNull();
    expect(surface?.querySelector('[data-property-section="true"] > div')?.classList)
      .toContain("text-muted-foreground/70");
    const projectLabel = surface?.querySelector('[data-property-label="Project"]');
    const labelsLabel = surface?.querySelector('[data-property-label="Labels"]');
    if (!projectLabel || !labelsLabel) throw new Error("Expected Project and Labels rows");
    expect(projectLabel.compareDocumentPosition(labelsLabel) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy();

    act(() => root.unmount());
  });

  it("stacks property chips vertically and aligns each label with the first chip", async () => {
    const blockedBy = Array.from({ length: 3 }, (_, index) => ({
      id: `blocker-${index + 1}`,
      identifier: `BLOCK-${index + 1}`,
      title: `Blocker ${index + 1}`,
      status: "todo",
      priority: "medium",
      assigneeAgentId: null,
      assigneeUserId: null,
    })) as NonNullable<Issue["blockedBy"]>;
    const blocks = Array.from({ length: 3 }, (_, index) => ({
      id: `blocked-${index + 1}`,
      identifier: `BLOCKED-${index + 1}`,
      title: `Blocked task ${index + 1}`,
      status: "todo",
      priority: "medium",
      assigneeAgentId: null,
      assigneeUserId: null,
    })) as NonNullable<Issue["blocks"]>;
    const labels = Array.from({ length: 3 }, (_, index) => createLabel({
      id: `label-${index + 1}`,
      name: `Label ${index + 1}`,
    }));
    const childIssues = Array.from({ length: 3 }, (_, index) => createIssue({
      id: `child-${index + 1}`,
      identifier: `SUB-${index + 1}`,
      title: `Subtask ${index + 1}`,
    }));
    const root = renderProperties(container, {
      issue: createIssue({
        blockedBy,
        blocks,
        labels,
        labelIds: labels.map((label) => label.id),
      }),
      childIssues,
      onUpdate: vi.fn(),
      sidePanelContentOnly: true,
    });
    await flush();

    for (const label of ["Labels", "Blocked by", "Blocking", "Subtasks"]) {
      const labelNode = container.querySelector(`[data-property-label="${label}"]`);
      const row = labelNode?.closest('[data-property-row="true"]');
      const value = row?.querySelector('[data-property-value="true"]');
      expect(row?.classList).toContain("items-start");
      expect(labelNode?.classList).toContain("mt-0.5");
      expect(value?.classList).toContain("flex-col");
      expect(value?.classList).toContain("items-start");
    }

    for (const label of ["Labels", "Blocked by", "Subtasks"]) {
      const trigger = findRowTrigger(container, label);
      const chipStack = trigger?.querySelector("div");
      expect(chipStack?.classList).toContain("flex-col");
      expect(chipStack?.classList).toContain("items-start");
    }

    const blockingValue = container
      .querySelector('[data-property-label="Blocking"]')
      ?.closest('[data-property-row="true"]')
      ?.querySelector('[data-property-value="true"] > div');
    expect(blockingValue?.classList).toContain("flex-col");

    act(() => root.unmount());
  });

  it("renders the lone Properties header as the active filled tab", async () => {
    const headerSlot = document.createElement("div");
    headerSlot.id = "properties-pane-header-slot";
    document.body.appendChild(headerSlot);

    const root = renderProperties(container, {
      issue: createIssue(),
      childIssues: [],
      onUpdate: vi.fn(),
    });
    await flush();

    const tab = headerSlot.querySelector<HTMLButtonElement>('[role="tab"]');
    expect(tab?.textContent).toBe("Properties");
    expect(tab?.getAttribute("aria-selected")).toBe("true");
    expect(tab?.classList).toContain("bg-muted");
    expect(tab?.classList).toContain("px-3");
    expect(tab?.classList).toContain("inline-flex");

    act(() => root.unmount());
  });

  it("uses the same filled active-tab treatment in a multi-tab pane header", async () => {
    const headerSlot = document.createElement("div");
    headerSlot.id = "properties-pane-header-slot";
    document.body.appendChild(headerSlot);

    const root = renderProperties(container, {
      issue: createIssue(),
      childIssues: [createIssue({ id: "child-1", identifier: "PAP-2", title: "Child task" })],
      onUpdate: vi.fn(),
    });
    await flush();

    const tabs = Array.from(headerSlot.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    const propertiesTab = tabs.find((tab) => tab.textContent === "Properties");
    const subtasksTab = tabs.find((tab) => tab.textContent?.includes("Subtasks"));
    const tabItems = Array.from(headerSlot.querySelectorAll<HTMLElement>('[data-slot="task-detail-pane-tab"]'));
    const tabDividers = Array.from(headerSlot.querySelectorAll<HTMLElement>('[data-slot="task-detail-pane-tab-divider"]'));
    const subtasksLabel = subtasksTab?.querySelector<HTMLElement>('[title="Subtasks"]');
    const subtasksCount = Array.from(subtasksTab?.querySelectorAll<HTMLElement>("span") ?? [])
      .find((span) => span.textContent === "1");
    const closeSubtasks = headerSlot.querySelector<HTMLButtonElement>('[aria-label="Close Subtasks tab"]');
    const openClosedTab = headerSlot.querySelector<HTMLButtonElement>('[aria-label="Open closed sidebar tab"]');

    expect(propertiesTab?.getAttribute("data-state")).toBe("active");
    expect(subtasksTab?.getAttribute("data-state")).toBe("inactive");
    expect(tabItems).toHaveLength(2);
    expect(tabDividers).toHaveLength(1);
    expect(tabDividers[0]?.classList).toContain("h-4");
    expect(propertiesTab?.classList).toContain("mx-1.5");
    expect(propertiesTab?.classList).toContain("px-3");
    expect(subtasksTab?.classList).toContain("px-3");
    expect(subtasksTab?.classList).toContain("hover:bg-accent/50");
    expect(subtasksLabel?.classList).toContain("task-detail-pane-tab-label");
    expect(subtasksLabel?.classList).toContain("flex-1");
    expect(subtasksLabel?.classList).toContain("overflow-hidden");
    expect(subtasksLabel?.classList).toContain("whitespace-nowrap");
    expect(subtasksCount?.classList).toContain("group-hover/pane-tab:opacity-0");
    expect(closeSubtasks?.classList).toContain("opacity-0");
    expect(closeSubtasks?.classList).toContain("right-2.5");
    expect(closeSubtasks?.classList).toContain("group-hover/pane-tab:opacity-100");
    expect(openClosedTab?.classList).toContain("size-6");
    expect(openClosedTab?.classList).not.toContain("ml-1");
    expect(openClosedTab?.disabled).toBe(true);
    for (const tab of tabs) {
      expect(tab.classList).toContain("task-detail-pane-tab");
      expect(tab.classList).toContain("h-7");
      expect(tab.classList).toContain("rounded-md");
    }

    await act(async () => {
      subtasksTab?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    });

    expect(propertiesTab?.getAttribute("data-state")).toBe("inactive");
    expect(subtasksTab?.getAttribute("data-state")).toBe("active");

    await act(async () => closeSubtasks?.click());
    expect(headerSlot.querySelector('[role="tab"][data-state="active"]')?.textContent).toBe("Properties");
    expect(headerSlot.textContent).not.toContain("Subtasks");
    expect(openClosedTab?.disabled).toBe(false);

    await act(async () => {
      openClosedTab?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
      openClosedTab?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
    let reopenSubtasks: HTMLElement | undefined;
    await waitForAssertion(() => {
      reopenSubtasks = Array.from(document.body.querySelectorAll<HTMLElement>('[role="menuitem"]'))
        .find((item) => item.textContent === "Subtasks");
      expect(reopenSubtasks).not.toBeUndefined();
    });

    await act(async () => {
      reopenSubtasks?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
      reopenSubtasks?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
    expect(headerSlot.querySelector('[role="tab"][data-state="active"]')?.textContent).toContain("Subtasks");

    act(() => root.unmount());
  });

  it("restores master's production property styling when Streamlined UI is off", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({
      enableTaskWatchdogs: false,
      enableStreamlinedUi: false,
      enableClassicTaskInterface: false,
    });

    const root = renderProperties(container, {
      issue: createIssue(),
      childIssues: [],
      onUpdate: vi.fn(),
      inline: true,
    });
    await waitForAssertion(() => {
      expect(container.querySelector(".task-detail-properties")).toBeNull();
      expect(container.querySelector('[role="tab"]')).toBeNull();
    });
    expect(container.textContent).toContain("Status");
    expect(container.textContent).toContain("Triage");

    act(() => root.unmount());
  });

  it("restores master's plain Properties pane header when Streamlined UI is off", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({
      enableTaskWatchdogs: false,
      enableStreamlinedUi: false,
      enableClassicTaskInterface: false,
    });
    const headerSlot = document.createElement("div");
    headerSlot.id = "properties-pane-header-slot";
    document.body.appendChild(headerSlot);

    const root = renderProperties(container, {
      issue: createIssue(),
      childIssues: [],
      onUpdate: vi.fn(),
    });
    await waitForAssertion(() => {
      expect(headerSlot.textContent).toBe("Properties");
      expect(headerSlot.querySelector('[role="tab"]')).toBeNull();
      expect(container.querySelector(".task-detail-properties")).toBeNull();
    });

    act(() => root.unmount());
  });

  it("does not show a Plan tab for a planning-mode issue without a plan document", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({
      enableClassicTaskInterface: false,
    });
    const root = renderProperties(container, {
      issue: createIssue({ workMode: "planning" }),
      childIssues: [],
      onUpdate: vi.fn(),
      inline: true,
    });

    await waitForAssertion(() => {
      expect(Array.from(container.querySelectorAll("button")).some((button) => button.textContent === "Plan")).toBe(false);
      expect(container.textContent).not.toContain("This task is in plan mode but no plan document has been written yet.");
    });

    act(() => root.unmount());
  });

  it("overrides a previously selected pane tab for a document deep link", async () => {
    const planDocument = {
      id: "document-plan",
      companyId: "company-1",
      issueId: "issue-1",
      key: "plan",
      title: "Plan",
      format: "markdown",
      body: "Plan body",
      latestRevisionId: "revision-plan",
      latestRevisionNumber: 1,
      createdByAgentId: null,
      createdByUserId: null,
      updatedByAgentId: null,
      updatedByUserId: null,
      lockedAt: null,
      lockedByAgentId: null,
      lockedByUserId: null,
      createdAt: new Date("2026-08-01T00:00:00.000Z"),
      updatedAt: new Date("2026-08-01T00:00:00.000Z"),
    } satisfies IssueDocument;
    const artifactDocument = {
      ...planDocument,
      id: "document-evidence",
      key: "qa-evidence",
      title: "QA evidence",
      body: "Evidence body",
      latestRevisionId: "revision-evidence",
    } satisfies IssueDocument;
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({
      enableClassicTaskInterface: false,
    });
    mockIssuesApi.getDocument.mockResolvedValue(planDocument);
    mockIssuesApi.listDocuments.mockResolvedValue([planDocument, artifactDocument]);
    Element.prototype.scrollIntoView = vi.fn();

    const props = {
      issue: createIssue(),
      childIssues: [],
      onUpdate: vi.fn(),
      inline: true,
    } satisfies ComponentProps<typeof IssueProperties>;
    const { root, queryClient } = renderPropertiesWithQueryClient(container, props);
    await waitForAssertion(() => {
      const planTab = Array.from(container.querySelectorAll("button"))
        .find((button) => button.textContent === "Plan");
      expect(planTab?.getAttribute("data-state")).toBe("active");
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <IssueProperties
            {...props}
            documentDeepLink={{ tab: "artifacts", documentKey: "qa-evidence", requestId: 1 }}
          />
        </QueryClientProvider>,
      );
    });

    await waitForAssertion(() => {
      const artifactsTab = Array.from(container.querySelectorAll("button"))
        .find((button) => button.textContent === "Artifacts");
      expect(artifactsTab?.getAttribute("data-state")).toBe("active");
      expect(container.querySelector('button[aria-expanded="true"]')).not.toBeNull();
    });
    act(() => root.unmount());
  });

  it("hides the Priority property row while priority UI is off (PAP-411)", async () => {
    const root = renderProperties(container, {
      issue: createIssue({ priority: "high" }),
      childIssues: [],
      onUpdate: vi.fn(),
      inline: true,
    });
    await flush();

    await waitForAssertion(() => {
      // The Triage section still renders the Status row...
      expect(container.querySelector('[data-property-label="Status"]')).not.toBeNull();
      // ...but the Priority row is gated behind SHOW_TASK_PRIORITY_UI (off).
      expect(container.querySelector('[data-property-label="Priority"]')).toBeNull();
    });

    act(() => root.unmount());
  });

  it("shows assignee and originating without responsible wording", async () => {
    mockAgentsApi.list.mockResolvedValue([{ id: "agent-1", name: "CodexCoder", status: "active", adapterType: "codex_local" }]);
    const root = renderProperties(container, {
      issue: createIssue({
        assigneeAgentId: "agent-1",
        createdByUserId: "user-1",
        responsibleUserId: "user-2",
      }),
      childIssues: [],
      onUpdate: vi.fn(),
      inline: true,
    });
    await flush();

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Assignee");
      expect(container.textContent).toContain("CodexCoder");
      expect(container.textContent).toContain("Originating");
      expect(container.textContent).toContain("Riley Board");
      expect(container.textContent).not.toContain("Morgan Product");
      expect(container.textContent).not.toContain("Responsible");
      expect(container.textContent).not.toContain("Kicked off by");
      expect(container.textContent).not.toContain("Created by");
      expect(container.querySelector('[data-shape="square"]')?.textContent).toContain("CodexCoder");
    });

    act(() => root.unmount());
  });

  it("shows originating without merged responsible wording when responsible is derived from the creator", async () => {
    const root = renderProperties(container, {
      issue: createIssue({
        createdByUserId: "user-1",
        responsibleUserId: null,
      }),
      childIssues: [],
      onUpdate: vi.fn(),
      inline: true,
    });
    await flush();

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Originating");
      expect(container.textContent).toContain("Riley Board");
      expect(container.textContent).not.toContain("Kicked off by");
      expect(container.textContent).not.toContain("Kicked off by · responsible");
      expect(container.textContent).not.toContain("(auto)");
      expect(container.textContent).not.toContain("Created by");
    });

    act(() => root.unmount());
  });

  it("shows originating agent without responsible wording", async () => {
    mockAgentsApi.list.mockResolvedValue([{ id: "agent-1", name: "CodexCoder", status: "active", adapterType: "codex_local" }]);
    const root = renderProperties(container, {
      issue: createIssue({
        createdByAgentId: "agent-1",
        createdByUserId: null,
        responsibleUserId: null,
      }),
      childIssues: [],
      onUpdate: vi.fn(),
      inline: true,
    });
    await flush();

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Originating");
      expect(container.textContent).toContain("CodexCoder");
      expect(container.textContent).toContain("Assignee");
      expect(container.textContent).toContain("Unassigned");
      expect(container.textContent).not.toContain("Responsible");
      expect(container.textContent).not.toContain("Kicked off by");
      expect(container.querySelector('[data-shape="square"]')?.textContent).toContain("CodexCoder");
    });

    act(() => root.unmount());
  });

  it("attributes an agent-created issue to the transitive responsible user with a via affordance", async () => {
    mockAgentsApi.list.mockResolvedValue([{ id: "agent-1", name: "CodexCoder", status: "active", adapterType: "codex_local" }]);
    const root = renderProperties(container, {
      issue: createIssue({
        createdByAgentId: "agent-1",
        createdByUserId: null,
        responsibleUserId: "user-2",
      }),
      childIssues: [],
      onUpdate: vi.fn(),
      inline: true,
    });
    await flush();

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Originating");
      expect(container.textContent).toContain("Morgan Product");
      expect(container.textContent).toContain("via CodexCoder");
      expect(container.textContent).not.toContain("Responsible");
      expect(container.textContent).not.toContain("Kicked off by");
    });

    act(() => root.unmount());
  });

  it("shows originating responsible user for a routine execution with no creator", async () => {
    const root = renderProperties(container, {
      issue: createIssue({
        createdByAgentId: null,
        createdByUserId: null,
        responsibleUserId: "user-2",
      }),
      childIssues: [],
      onUpdate: vi.fn(),
      inline: true,
    });
    await flush();

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Originating");
      expect(container.textContent).toContain("Morgan Product");
      expect(container.textContent).not.toContain("via ");
    });

    act(() => root.unmount());
  });

  it("groups the assignee picker and gates a live-run reassign behind an interrupt confirm", async () => {
    const minimalAgent = (id: string, name: string) =>
      ({
        id,
        name,
        role: "",
        title: null,
        icon: null,
        status: "active",
        orgChainHealth: { status: "ok" },
      } as unknown as Parameters<typeof mockAgentsApi.list.mockResolvedValue>[0][number]);
    mockAgentsApi.list.mockResolvedValue([minimalAgent("agent-1", "ClaudeCoder"), minimalAgent("agent-2", "QA")]);
    const onUpdate = vi.fn();
    const root = renderProperties(container, {
      issue: createIssue({ assigneeAgentId: "agent-1" }),
      childIssues: [],
      onUpdate,
      inline: true,
      hasActiveRun: true,
    });
    await flush();

    // Wait for the agents query to resolve so the current assignee renders.
    let trigger: HTMLButtonElement | undefined;
    await waitForAssertion(() => {
      trigger = Array.from(container.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("ClaudeCoder"),
      );
      expect(trigger).toBeTruthy();
    });
    await act(async () => {
      trigger!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    // Live-run banner + grouped section headers are present.
    expect(container.querySelector("[data-testid='assignee-running-banner']")?.textContent).toContain(
      "ClaudeCoder is running",
    );
    expect(container.textContent).toContain("Agents");
    expect(container.textContent).toContain("Board users");

    // Picking a different agent mid-run stages a confirm rather than applying.
    const qaOption = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "QA",
    );
    expect(qaOption).toBeTruthy();
    await act(async () => {
      qaOption!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
    expect(container.querySelector("[data-testid='interrupt-assign-confirm']")).not.toBeNull();
    expect(onUpdate).not.toHaveBeenCalled();

    // Confirming applies the reassignment.
    const confirmBtn = container.querySelector<HTMLButtonElement>(
      "[data-testid='interrupt-assign-confirm-action']",
    )!;
    await act(async () => {
      confirmBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
    expect(onUpdate).toHaveBeenCalledWith({ assigneeAgentId: "agent-2", assigneeUserId: null });

    act(() => root.unmount());
  });

  it("filters the no-assignee option with assignee search", async () => {
    mockAgentsApi.list.mockResolvedValue([
      {
        id: "agent-1",
        name: "ClaudeCoder",
        role: "",
        title: null,
        icon: null,
        status: "active",
        orgChainHealth: { status: "ok" },
      } as unknown as Parameters<typeof mockAgentsApi.list.mockResolvedValue>[0][number],
    ]);
    const root = renderProperties(container, {
      issue: createIssue(),
      childIssues: [],
      onUpdate: vi.fn(),
    });
    await flush();

    const searchInput = container.querySelector(
      'input[placeholder="Search assignees..."]',
    ) as HTMLInputElement | null;
    expect(searchInput).not.toBeNull();

    await act(async () => {
      const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      nativeSetter?.call(searchInput, "no");
      searchInput!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flush();

    expect(container.textContent).toContain("No assignee");
    expect(container.textContent).not.toContain("No matches.");

    await act(async () => {
      const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      nativeSetter?.call(searchInput, "zzzz");
      searchInput!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flush();

    expect(container.textContent).not.toContain("No assignee");
    expect(container.textContent).toContain("No matches.");

    act(() => root.unmount());
  });

  it("exposes the add-subtask action from the relationships picker", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({
      enableClassicTaskInterface: true,
    });
    const onAddSubIssue = vi.fn();
    const root = renderProperties(container, {
      issue: createIssue(),
      childIssues: [],
      onAddSubIssue,
      onUpdate: vi.fn(),
    });
    await waitForAssertion(() => {
      expect(container.textContent).toContain("Add subtask");
    });

    expect(container.textContent).toContain("Subtasks");

    const addButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Add subtask"));
    expect(addButton).not.toBeUndefined();

    await act(async () => {
      addButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onAddSubIssue).toHaveBeenCalledTimes(1);

    act(() => root.unmount());
  });

  it("gives sub-tasks a dedicated chat-shell panel tab", async () => {
    const onAddSubIssue = vi.fn();
    const root = renderProperties(container, {
      issue: createIssue(),
      childIssues: [createIssue({ id: "child-2", identifier: "PAP-2", title: "Panel child" })],
      onAddSubIssue,
      onUpdate: vi.fn(),
      inline: true,
    });
    await flush();

    const subtasksTab = Array.from(container.querySelectorAll<HTMLButtonElement>('button[role="tab"]'))
      .find((button) => button.textContent?.includes("Subtasks"));
    expect(subtasksTab).not.toBeUndefined();
    await act(async () => {
      subtasksTab!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    });
    expect(container.textContent).toContain("Panel child");
    expect(container.textContent).toContain("0 of 1 complete");
    expect(container.textContent).toContain("Next action");
    expect(container.querySelector('[data-slot="task-row"]')).not.toBeNull();
    const addButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Add subtask"));
    await act(async () => addButton!.click());
    expect(onAddSubIssue).toHaveBeenCalledOnce();

    act(() => root.unmount());
  });

  it("always shows watchdog setup controls", async () => {
    const root = renderProperties(container, {
      issue: createIssue(),
      childIssues: [],
      onUpdate: vi.fn(),
      inline: true,
    });
    await flush();

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Watchdog");
      // Empty watchdog uses the uniform muted "None" empty state (ux-spec §6).
      expect(findRowTrigger(container, "Watchdog")?.textContent).toContain("None");
    });

    act(() => root.unmount());
  });

  it("passes blocker attention to the sidebar status icon", async () => {
    const root = renderProperties(container, {
      issue: createIssue({
        status: "blocked",
        blockerAttention: {
          state: "covered",
          reason: "active_child",
          unresolvedBlockerCount: 1,
          coveredBlockerCount: 1,
          stalledBlockerCount: 0,
          attentionBlockerCount: 0,
          sampleBlockerIdentifier: "PAP-2",
          sampleStalledBlockerIdentifier: null,
        },
      }),
      childIssues: [],
      onUpdate: vi.fn(),
    });
    await flush();

    expect(container.querySelector('[data-status-icon-state="covered"]')?.textContent).toBe("blocked");

    act(() => root.unmount());
  });

  it("edits blockers from the blocked-by relationship flyout", async () => {
    const onUpdate = vi.fn();
    mockIssuesApi.list.mockResolvedValue([
      createIssue({ id: "issue-3", identifier: "PAP-3", title: "New blocker", status: "todo" }),
    ]);

    const root = renderProperties(container, {
      issue: createIssue({
        blockedBy: [
          {
            id: "issue-2",
            identifier: "PAP-2",
            title: "Existing blocker",
            status: "in_progress",
            priority: "medium",
            assigneeAgentId: null,
            assigneeUserId: null,
          },
        ],
      }),
      childIssues: [],
      onUpdate,
      inline: true,
    });
    await flush();

    const blockerTrigger = findRowTrigger(container, "Blocked by");
    expect(blockerTrigger?.textContent).toContain("PAP-2");
    expect(container.textContent).not.toContain("Add blocker");
    expect(container.querySelector('input[placeholder="Search tasks..."]')).toBeNull();

    await act(async () => {
      blockerTrigger!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(container.querySelector('input[placeholder="Search tasks..."]')).not.toBeNull();

    const candidateButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("PAP-3 New blocker"));
    expect(candidateButton).not.toBeUndefined();

    await act(async () => {
      candidateButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onUpdate).toHaveBeenCalledWith({ blockedByIssueIds: ["issue-2", "issue-3"] });

    act(() => root.unmount());
  });

  it("searches all company issues when adding a blocker", async () => {
    const onUpdate = vi.fn();
    const loadedIssue = createIssue({ id: "issue-3", identifier: "PAP-3", title: "Loaded issue", status: "todo" });
    const remoteIssue = createIssue({ id: "issue-99", identifier: "PAP-99", title: "Remote blocker", status: "in_progress" });
    mockIssuesApi.list.mockImplementation((_companyId: string, filters?: { q?: string; limit?: number }) => {
      if (filters?.q === "remote") return Promise.resolve([remoteIssue]);
      return Promise.resolve([loadedIssue]);
    });

    const root = renderProperties(container, {
      issue: createIssue(),
      childIssues: [],
      onUpdate,
      inline: true,
    });
    await flush();

    const blockerTrigger = findRowTrigger(container, "Blocked by");
    expect(blockerTrigger).not.toBeUndefined();

    await act(async () => {
      blockerTrigger!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    const searchInput = container.querySelector('input[aria-label="Search tasks to add as blockers"]') as HTMLInputElement | null;
    expect(searchInput).not.toBeNull();

    await act(async () => {
      const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      nativeSetter?.call(searchInput, "remote");
      searchInput!.dispatchEvent(new Event("input", { bubbles: true }));
    });

    await waitForAssertion(() => {
      expect(mockIssuesApi.list).toHaveBeenCalledWith("company-1", { q: "remote", limit: 50 });
      expect(container.textContent).toContain("PAP-99 Remote blocker");
      expect(container.textContent).not.toContain("PAP-3 Loaded issue");
    });

    const candidateButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("PAP-99 Remote blocker"));
    expect(candidateButton).not.toBeUndefined();

    await act(async () => {
      candidateButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onUpdate).toHaveBeenCalledWith({ blockedByIssueIds: ["issue-99"] });

    act(() => root.unmount());
  });

  it("removes a blocked-by issue by toggling it in the relationship flyout", async () => {
    const onUpdate = vi.fn();
    const root = renderProperties(container, {
      issue: createIssue({
        blockedBy: [
          {
            id: "issue-2",
            identifier: "PAP-2",
            title: "Existing blocker",
            status: "in_progress",
            priority: "medium",
            assigneeAgentId: null,
            assigneeUserId: null,
          },
          {
            id: "issue-4",
            identifier: "PAP-4",
            title: "Keep blocker",
            status: "todo",
            priority: "medium",
            assigneeAgentId: null,
            assigneeUserId: null,
          },
        ],
      }),
      childIssues: [],
      onUpdate,
      inline: true,
    });
    await flush();

    const blockerTrigger = findRowTrigger(container, "Blocked by");
    expect(blockerTrigger).not.toBeUndefined();

    await act(async () => {
      blockerTrigger!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    const selectedBlocker = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("PAP-2 Existing blocker"));
    expect(selectedBlocker).not.toBeUndefined();

    await act(async () => {
      selectedBlocker!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onUpdate).toHaveBeenCalledWith({ blockedByIssueIds: ["issue-4"] });

    act(() => root.unmount());
  });

  it("uses the same blocked-by relationship picker on mobile", async () => {
    mockSidebarState.isMobile = true;
    const onUpdate = vi.fn();
    const root = renderProperties(container, {
      issue: createIssue({
        blockedBy: [
          {
            id: "issue-2",
            identifier: "PAP-2",
            title: "Existing blocker",
            status: "in_progress",
            priority: "medium",
            assigneeAgentId: null,
            assigneeUserId: null,
          },
          {
            id: "issue-4",
            identifier: "PAP-4",
            title: "Keep blocker",
            status: "todo",
            priority: "medium",
            assigneeAgentId: null,
            assigneeUserId: null,
          },
        ],
      }),
      childIssues: [],
      onUpdate,
      inline: true,
    });
    await flush();

    const blockerTrigger = findRowTrigger(container, "Blocked by");
    expect(blockerTrigger?.textContent).toContain("PAP-2");

    await act(async () => {
      blockerTrigger!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    const selectedBlocker = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("PAP-2 Existing blocker"));
    expect(selectedBlocker).not.toBeUndefined();

    await act(async () => {
      selectedBlocker!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onUpdate).toHaveBeenCalledWith({ blockedByIssueIds: ["issue-4"] });

    act(() => root.unmount());
  });

  it("summarizes long blocked-by and subtask relationships in their picker triggers", async () => {
    const blockedBy = Array.from({ length: 7 }, (_, index) => ({
      id: `blocker-${index + 1}`,
      identifier: `BLOCK-${index + 1}`,
      title: `Blocker ${index + 1}`,
      status: "todo",
      priority: "medium",
      assigneeAgentId: null,
      assigneeUserId: null,
    })) as NonNullable<Issue["blockedBy"]>;
    const childIssues = Array.from({ length: 7 }, (_, index) => createIssue({
      id: `child-${index + 1}`,
      identifier: `SUB-${index + 1}`,
      title: `Sub-task ${index + 1}`,
    }));
    const root = renderProperties(container, {
      issue: createIssue({ blockedBy }),
      childIssues,
      onUpdate: vi.fn(),
      inline: true,
    });
    await flush();

    const blockedByTrigger = findRowTrigger(container, "Blocked by");
    expect(blockedByTrigger?.textContent).toContain("BLOCK-1");
    expect(blockedByTrigger?.textContent).toContain("BLOCK-2");
    expect(blockedByTrigger?.textContent).toContain("+5 more");
    expect(blockedByTrigger?.textContent).not.toContain("BLOCK-7");

    const subtasksTrigger = findRowTrigger(container, "Subtasks");
    expect(subtasksTrigger?.textContent).toContain("SUB-1");
    expect(subtasksTrigger?.textContent).toContain("SUB-2");
    expect(subtasksTrigger?.textContent).toContain("+5 more");
    expect(subtasksTrigger?.textContent).not.toContain("SUB-7");

    await act(async () => {
      blockedByTrigger!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(container.textContent).toContain("BLOCK-7");

    await act(async () => {
      blockedByTrigger!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
    await act(async () => {
      subtasksTrigger!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(container.textContent).toContain("SUB-7");

    act(() => root.unmount());
  });

  it("collapses long blocking and related task lists until the more button is clicked", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({
      enableTaskWatchdogs: false,
      enableClassicTaskInterface: true,
    });
    const blocking = Array.from({ length: 7 }, (_, index) => ({
      id: `blocking-${index + 1}`,
      identifier: `BLOCKING-${index + 1}`,
      title: `Blocking issue ${index + 1}`,
      status: "todo",
      priority: "medium",
      assigneeAgentId: null,
      assigneeUserId: null,
    })) as NonNullable<Issue["blocks"]>;
    const relatedIssues = Array.from({ length: 7 }, (_, index) => ({
      id: `related-${index + 1}`,
      identifier: `RELATED-${index + 1}`,
      title: `Related issue ${index + 1}`,
      status: "todo" as const,
      priority: "medium" as const,
      assigneeAgentId: null,
      assigneeUserId: null,
    }));
    const root = renderProperties(container, {
      issue: createIssue({
        blocks: blocking,
        relatedWork: {
          outbound: relatedIssues.map((issue) => ({
            issue,
            mentionCount: 1,
            sources: [{ kind: "description", sourceRecordId: null, label: "description", matchedText: issue.identifier }],
          })),
          inbound: [],
        },
      }),
      childIssues: [],
      onUpdate: vi.fn(),
      inline: true,
    });
    await flush();

    await waitForAssertion(() => {
      expect(container.textContent).toContain("RELATED-5");
    });
    expect(container.textContent).toContain("BLOCKING-5");
    expect(container.textContent).not.toContain("BLOCKING-6");
    expect(container.textContent).not.toContain("RELATED-6");
    expect(
      Array.from(container.querySelectorAll("button")).filter((button) =>
        button.textContent?.trim() === "Show 2 more",
      ),
    ).toHaveLength(2);

    const expandBlocking = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.trim() === "Show 2 more",
    );
    expect(expandBlocking).not.toBeUndefined();
    await act(async () => {
      expandBlocking!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.textContent).toContain("BLOCKING-6");
    expect(container.textContent).toContain("BLOCKING-7");
    expect(container.textContent).not.toContain("RELATED-6");

    const expandRelated = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.trim() === "Show 2 more",
    );
    expect(expandRelated).not.toBeUndefined();
    await act(async () => {
      expandRelated!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.textContent).toContain("RELATED-6");
    expect(container.textContent).toContain("RELATED-7");

    act(() => root.unmount());
  });

  it("collapses long external URL rows until the more button is clicked", async () => {
    const externalObjects = Array.from({ length: 7 }, (_, index) => ({
      mentionCount: 1,
      sourceLabels: ["Description"],
      pill: {
        providerKey: "url" as const,
        objectType: "link" as const,
        displayKey: null,
        iconKey: null,
        statusCategory: "unknown" as const,
        statusIconKey: null,
        statusLabel: null,
        liveness: "unknown" as const,
        displayTitle: `https://example.com/reference-${index + 1}`,
        url: `https://example.com/reference-${index + 1}`,
      },
      group: {
        object: null,
        mentions: [],
        mentionCount: 1,
        sourceLabels: ["Description"],
      },
    }));
    const root = renderProperties(container, {
      issue: createIssue(),
      childIssues: [],
      onUpdate: vi.fn(),
      inline: true,
      externalObjects,
    });
    await flush();

    expect(container.textContent).toContain("reference-5");
    expect(container.textContent).not.toContain("reference-6");
    expect(container.textContent).toContain("References");
    const expandUrls = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.trim() === "Show 2 more",
    );
    expect(expandUrls).not.toBeUndefined();

    await act(async () => {
      expandUrls!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.textContent).toContain("reference-6");
    expect(container.textContent).toContain("reference-7");
    expect(container.textContent).toContain("Show less");

    act(() => root.unmount());
  });

  it("updates the blocked-by relationship summary when the issue changes", async () => {
    const blockedBy = Array.from({ length: 7 }, (_, index) => ({
      id: `blocker-${index + 1}`,
      identifier: `BLOCK-${index + 1}`,
      title: `Blocker ${index + 1}`,
      status: "todo",
      priority: "medium",
      assigneeAgentId: null,
      assigneeUserId: null,
    })) as NonNullable<Issue["blockedBy"]>;
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });
    const root = createRoot(container);

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <IssueProperties
            issue={createIssue({ id: "issue-a", blockedBy })}
            childIssues={[]}
            onUpdate={vi.fn()}
            inline
          />
        </QueryClientProvider>,
      );
    });
    await flush();

    expect(findRowTrigger(container, "Blocked by")?.textContent).toContain("BLOCK-1");
    expect(findRowTrigger(container, "Blocked by")?.textContent).toContain("+5 more");

    const nextBlockedBy = [{
      id: "next-blocker",
      identifier: "NEXT-1",
      title: "Next blocker",
      status: "todo" as const,
      priority: "medium" as const,
      assigneeAgentId: null,
      assigneeUserId: null,
    }];

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <IssueProperties
            issue={createIssue({ id: "issue-b", blockedBy: nextBlockedBy })}
            childIssues={[]}
            onUpdate={vi.fn()}
            inline
          />
        </QueryClientProvider>,
      );
    });
    await flush();

    expect(findRowTrigger(container, "Blocked by")?.textContent).toContain("NEXT-1");
    expect(findRowTrigger(container, "Blocked by")?.textContent).not.toContain("BLOCK-1");
    expect(findRowTrigger(container, "Blocked by")?.textContent).not.toContain("more");

    act(() => root.unmount());
  });

  it("keeps the current archived project visible in the project property", async () => {
    mockProjectsApi.list.mockResolvedValue([
      createProject({
        id: "archived-project",
        name: "Archived Project",
        archivedAt: new Date("2026-04-08T00:00:00.000Z"),
      }),
    ]);

    const root = renderProperties(container, {
      issue: createIssue({ projectId: "archived-project" }),
      childIssues: [],
      onUpdate: vi.fn(),
      inline: true,
    });
    await flush();

    expect(mockProjectsApi.list).toHaveBeenCalledWith("company-1", { includeArchived: true });
    await waitForAssertion(() => {
      expect(findRowTrigger(container, "Project")?.textContent).toContain("Archived Project");
    });

    act(() => root.unmount());
  });

  it("uses the configured project color and icon in the project property", async () => {
    mockProjectsApi.list.mockResolvedValue([
      createProject({
        name: "Configured Project",
        color: "#0ea5e9",
        icon: "rocket",
      }),
    ]);

    const root = renderProperties(container, {
      issue: createIssue({ projectId: "project-1" }),
      childIssues: [],
      onUpdate: vi.fn(),
      sidePanelContentOnly: true,
    });
    await waitForAssertion(() => {
      expect(findRowTrigger(container, "Project")?.textContent).toContain("Configured Project");
    });

    const projectTrigger = findRowTrigger(container, "Project");
    const projectTile = projectTrigger?.querySelector<HTMLElement>('span.inline-flex[aria-hidden="true"]');
    expect(projectTile?.style.backgroundColor).toBe("rgb(14, 165, 233)");
    expect(projectTile?.querySelector("svg")?.classList).toContain("lucide-rocket");

    act(() => root.unmount());
  });

  it("shows a green service link above the workspace row for a live non-main workspace", async () => {
    mockProjectsApi.list.mockResolvedValue([createProject()]);
    const serviceUrl = "http://127.0.0.1:62475";
    const updatedWorkspace = createExecutionWorkspace({
      mode: "isolated_workspace",
      runtimeServices: [createRuntimeService({ url: serviceUrl, status: "stopped", stoppedAt: new Date("2026-04-06T12:06:00.000Z") })],
    });
    mockExecutionWorkspacesApi.controlRuntimeCommands.mockResolvedValue({
      workspace: updatedWorkspace,
      operation: {},
    });
    const root = renderProperties(container, {
      issue: createIssue({
        projectId: "project-1",
        projectWorkspaceId: "workspace-main",
        executionWorkspaceId: "workspace-1",
        currentExecutionWorkspace: createExecutionWorkspace({
          mode: "isolated_workspace",
          config: {
            environmentId: null,
            provisionCommand: null,
            teardownCommand: null,
            cleanupCommand: null,
            desiredState: null,
            workspaceRuntime: {
              services: [{ name: "web", command: "pnpm dev" }],
            },
          },
          runtimeServices: [createRuntimeService({ url: serviceUrl, status: "running", configIndex: 0 })],
        }),
      }),
      childIssues: [],
      onUpdate: vi.fn(),
    });
    await flush();

    const serviceLink = container.querySelector(`a[href="${serviceUrl}"]`);
    expect(serviceLink).not.toBeNull();
    expect(serviceLink?.className).toContain("sm:self-start");
    expect(serviceLink?.className).not.toContain("sm:self-end");
    expect((container.textContent ?? "").indexOf("Workspace")).toBeLessThan(
      (container.textContent ?? "").indexOf("Service"),
    );
    const stopButton = container.querySelector<HTMLButtonElement>('button[aria-label="Stop"]');
    expect(stopButton).not.toBeUndefined();
    expect(stopButton?.getAttribute("data-size")).toBe("icon-xs");
    expect(stopButton?.getAttribute("data-variant")).toBe("outline");

    await act(async () => {
      stopButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(mockExecutionWorkspacesApi.controlRuntimeCommands).toHaveBeenCalledWith(
      "workspace-1",
      "stop",
      expect.objectContaining({ action: "stop", runtimeServiceId: "service-1" }),
    );
    expect(container.textContent).toContain("Workspace service stopped.");

    act(() => root.unmount());
  });

  it("shows full date and time for issue metadata timestamps", async () => {
    const root = renderProperties(container, {
      issue: createIssue({
        createdAt: new Date(2026, 3, 6, 12, 34),
        startedAt: new Date(2026, 3, 6, 12, 35),
        completedAt: new Date(2026, 3, 6, 12, 36),
      }),
      childIssues: [],
      onUpdate: vi.fn(),
    });
    await flush();

    expect(container.textContent).toMatch(/CreatedApr 6, 2026, \d{1,2}:34 (AM|PM)/);
    expect(container.textContent).toMatch(/StartedApr 6, 2026, \d{1,2}:35 (AM|PM)/);
    expect(container.textContent).toMatch(/CompletedApr 6, 2026, \d{1,2}:36 (AM|PM)/);

    for (const label of ["Started", "Completed", "Created"]) {
      const labelNode = container.querySelector(`[data-property-label="${label}"]`);
      const value = labelNode?.parentElement?.querySelector<HTMLElement>('[data-property-value="true"] > span');
      expect(value?.classList).toContain("min-w-0");
      expect(value?.classList).toContain("truncate");
      expect(value?.classList).toContain("whitespace-nowrap");
      expect(value?.title).toBe(value?.textContent);
    }

    act(() => root.unmount());
  });

  it("shows only the workspace detail link for non-default workspaces", async () => {
    mockProjectsApi.list.mockResolvedValue([createProject()]);
    const root = renderProperties(container, {
      issue: createIssue({
        projectId: "project-1",
        projectWorkspaceId: "workspace-main",
        executionWorkspaceId: "workspace-1",
        currentExecutionWorkspace: createExecutionWorkspace({
          mode: "isolated_workspace",
        }),
      }),
      childIssues: [],
      onUpdate: vi.fn(),
    });
    await flush();
    await flush();

    const workspaceLink = Array.from(container.querySelectorAll("a")).find(
      (link) => link.textContent?.trim() === "View workspace",
    );
    expect(container.textContent).not.toContain("View workspace tasks");
    expect(workspaceLink).not.toBeUndefined();
    expect(workspaceLink?.getAttribute("href")).toBe("/execution-workspaces/workspace-1");

    act(() => root.unmount());
  });

  it("copies branch and folder values with visible feedback", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const root = renderProperties(container, {
      issue: createIssue({
        executionWorkspaceId: "workspace-1",
        currentExecutionWorkspace: createExecutionWorkspace({
          branchName: "pap-1-workspace",
          cwd: "/tmp/paperclip/PAP-1",
        }),
      }),
      childIssues: [],
      onUpdate: vi.fn(),
    });
    await flush();
    await flush();

    const branchCopyButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Copy pap-1-workspace to clipboard"]',
    );
    const folderCopyButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Copy /tmp/paperclip/PAP-1 to clipboard"]',
    );
    expect(branchCopyButton).not.toBeNull();
    expect(folderCopyButton?.querySelector('[data-middle-truncate="true"]')?.textContent)
      .toBe("/tmp/paperclip/PAP-1");
    expect(folderCopyButton?.title).toBe("/tmp/paperclip/PAP-1");

    await act(async () => {
      branchCopyButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(writeText).toHaveBeenCalledWith("pap-1-workspace");
    expect(container.textContent).toContain("Copied");

    act(() => root.unmount());
  });

  it("does not show a service link for the main shared workspace", async () => {
    mockProjectsApi.list.mockResolvedValue([createProject()]);
    const serviceUrl = "http://127.0.0.1:62475";
    const root = renderProperties(container, {
      issue: createIssue({
        projectId: "project-1",
        projectWorkspaceId: "workspace-main",
        executionWorkspaceId: "workspace-1",
        currentExecutionWorkspace: createExecutionWorkspace({
          mode: "shared_workspace",
          projectWorkspaceId: "workspace-main",
          runtimeServices: [createRuntimeService({ url: serviceUrl, status: "running" })],
        }),
      }),
      childIssues: [],
      onUpdate: vi.fn(),
    });
    await flush();

    expect(container.querySelector(`a[href="${serviceUrl}"]`)).toBeNull();
    expect(container.textContent).not.toContain("View workspace tasks");
    expect(Array.from(container.querySelectorAll("a")).some(
      (link) => link.textContent?.trim() === "View workspace",
    )).toBe(false);

    act(() => root.unmount());
  });

  it("separates referenced tasks from tasks that mention this task", async () => {
    const root = renderProperties(container, {
      issue: createIssue({
        relatedWork: {
          outbound: [
            {
              issue: {
                id: "issue-22",
                identifier: "PAP-22",
                title: "Related task",
                status: "todo",
                priority: "medium",
                assigneeAgentId: null,
                assigneeUserId: null,
              },
              mentionCount: 1,
              sources: [{ kind: "description", sourceRecordId: null, label: "description", matchedText: "PAP-22" }],
            },
          ],
          inbound: [
            {
              issue: {
                id: "issue-23",
                identifier: "PAP-23",
                title: "Mentions this task",
                status: "in_progress",
                priority: "medium",
                assigneeAgentId: null,
                assigneeUserId: null,
              },
              mentionCount: 1,
              sources: [{ kind: "description", sourceRecordId: null, label: "description", matchedText: "PAP-1" }],
            },
          ],
        },
      }),
      childIssues: [],
      onUpdate: vi.fn(),
      inline: true,
    });
    await flush();

    expect(container.textContent).not.toContain("Task ids");
    expect(container.textContent).not.toContain("Related tasks");
    const referencesTab = Array.from(container.querySelectorAll<HTMLButtonElement>('button[role="tab"]'))
      .find((button) => button.textContent === "References");
    await act(async () => {
      referencesTab!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    });
    expect(container.textContent).toContain("Referenced");
    expect(container.textContent).toContain("PAP-22");
    expect(container.textContent).toContain("Mentioned in");
    expect(container.textContent).toContain("PAP-23");

    act(() => root.unmount());
  });

  it("hides related task references already covered by blockers, blocking, and sub-issues", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({
      enableTaskWatchdogs: false,
      enableClassicTaskInterface: true,
    });
    const root = renderProperties(container, {
      issue: createIssue({
        blockedBy: [
          {
            id: "issue-22",
            identifier: "PAP-22",
            title: "Blocker",
            status: "todo",
            priority: "medium",
            assigneeAgentId: null,
            assigneeUserId: null,
          },
        ],
        blocks: [
          {
            id: "issue-33",
            identifier: "PAP-33",
            title: "Blocked issue",
            status: "todo",
            priority: "medium",
            assigneeAgentId: null,
            assigneeUserId: null,
          },
        ],
        relatedWork: {
          outbound: [
            {
              issue: {
                id: "issue-22",
                identifier: "PAP-22",
                title: "Blocker",
                status: "todo",
                priority: "medium",
                assigneeAgentId: null,
                assigneeUserId: null,
              },
              mentionCount: 1,
              sources: [{ kind: "description", sourceRecordId: null, label: "description", matchedText: "PAP-22" }],
            },
            {
              issue: {
                id: "issue-33",
                identifier: "PAP-33",
                title: "Blocked issue",
                status: "todo",
                priority: "medium",
                assigneeAgentId: null,
                assigneeUserId: null,
              },
              mentionCount: 1,
              sources: [{ kind: "description", sourceRecordId: null, label: "description", matchedText: "PAP-33" }],
            },
            {
              issue: {
                id: "child-44",
                identifier: "PAP-44",
                title: "Child issue",
                status: "todo",
                priority: "medium",
                assigneeAgentId: null,
                assigneeUserId: null,
              },
              mentionCount: 1,
              sources: [{ kind: "description", sourceRecordId: null, label: "description", matchedText: "PAP-44" }],
            },
          ],
          inbound: [],
        },
      }),
      childIssues: [
        createIssue({
          id: "child-44",
          identifier: "PAP-44",
          title: "Child issue",
        }),
      ],
      onUpdate: vi.fn(),
    });
    await flush();

    await waitForAssertion(() => {
      expect(container.textContent).not.toContain("Referenced");
    });

    act(() => root.unmount());
  });

  it("opens the label picker from its relationship value without a redundant add button", async () => {
    const root = renderProperties(container, {
      issue: createIssue({
        labels: [{ id: "label-1", companyId: "company-1", name: "Bug", color: "#ef4444", createdAt: new Date("2026-04-06T12:00:00.000Z"), updatedAt: new Date("2026-04-06T12:00:00.000Z") }],
        labelIds: ["label-1"],
      }),
      childIssues: [],
      onUpdate: vi.fn(),
      inline: true,
    });
    await flush();

    expect(container.querySelector('button[aria-label="Add label"]')).toBeNull();
    expect(container.querySelector('input[placeholder="Search labels..."]')).toBeNull();
    const labelsTrigger = findRowTrigger(container, "Labels");
    expect(labelsTrigger?.textContent).toContain("Bug");
    const labelChip = labelsTrigger?.querySelector<HTMLElement>('[title="Bug"]');
    expect(labelChip?.classList).toContain("border-0");
    expect(labelChip?.style.borderColor).toBe("");
    expect(labelChip?.style.color).not.toBe("");

    await act(async () => {
      labelsTrigger!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(container.querySelector('input[placeholder="Search labels..."]')).not.toBeNull();
    expect(container.querySelector('button[title="Delete Bug"]')).toBeNull();

    act(() => root.unmount());
  });

  it("shows selected labels from labelIds even before the issue labels relation refreshes", async () => {
    mockIssuesApi.listLabels.mockResolvedValue([createLabel()]);

    const root = renderProperties(container, {
      issue: createIssue({
        labels: [],
        labelIds: ["label-1"],
      }),
      childIssues: [],
      onUpdate: vi.fn(),
      inline: true,
    });
    await flush();
    await flush();

    expect(container.textContent).toContain("Bug");
    expect(container.textContent).not.toContain("No labels");

    act(() => root.unmount());
  });

  it("hides model options when the issue uses the responsible default", async () => {
    mockAgentsApi.list.mockResolvedValue([
      {
        id: "agent-1",
        name: "Senior Product Engineer",
        role: "engineer",
        title: null,
        status: "active",
        adapterType: "codex_local",
        icon: null,
      },
    ]);

    const root = renderProperties(container, {
      issue: createIssue({
        assigneeAgentId: "agent-1",
        assigneeAdapterOverrides: null,
      }),
      childIssues: [],
      onUpdate: vi.fn(),
    });
    await flush();

    expect(container.textContent).not.toContain("Model lane");
    expect(container.textContent).not.toContain("Codex options");

    act(() => root.unmount());
  });

  it("edits existing custom assignee model options from the properties pane", async () => {
    const onUpdate = vi.fn();
    mockAgentsApi.list.mockResolvedValue([
      {
        id: "agent-1",
        name: "Senior Product Engineer",
        role: "engineer",
        title: null,
        status: "active",
        adapterType: "codex_local",
        icon: null,
      },
    ]);
    mockAgentsApi.adapterModels.mockResolvedValue([
      { id: "gpt-5.5", label: "GPT-5.5" },
      { id: "gpt-5.4", label: "GPT-5.4" },
    ]);

    const root = renderProperties(container, {
      issue: createIssue({
        assigneeAgentId: "agent-1",
        assigneeAdapterOverrides: {
          adapterConfig: {
            model: "gpt-5.4",
            modelReasoningEffort: "high",
          },
        },
      }),
      childIssues: [],
      onUpdate,
    });
    await flush();
    await flush();

    expect(container.textContent).toContain("Override · gpt-5.4 · high");
    expect(container.textContent).toContain("Model lane");

    // Wait for the adapter-models query to resolve so the model options render.
    let modelButton: HTMLButtonElement | undefined;
    await waitForAssertion(() => {
      modelButton = Array.from(container.querySelectorAll("button"))
        .find((button) => button.textContent?.includes("GPT-5.5"));
      expect(modelButton).not.toBeUndefined();
    });

    await act(async () => {
      modelButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onUpdate).toHaveBeenCalledWith({
      assigneeAdapterOverrides: {
        adapterConfig: {
          model: "gpt-5.5",
          modelReasoningEffort: "high",
        },
      },
    });

    act(() => root.unmount());
  });

  it("clears existing assignee adapter overrides from the properties pane", async () => {
    const onUpdate = vi.fn();
    mockAgentsApi.list.mockResolvedValue([
      {
        id: "agent-1",
        name: "Senior Product Engineer",
        role: "engineer",
        title: null,
        status: "active",
        adapterType: "codex_local",
        icon: null,
      },
    ]);

    const root = renderProperties(container, {
      issue: createIssue({
        assigneeAgentId: "agent-1",
        assigneeAdapterOverrides: {
          adapterConfig: {
            model: "gpt-5.4",
          },
        },
      }),
      childIssues: [],
      onUpdate,
    });
    await flush();

    // The trailing "clear" X was removed (ux-spec: one trailing-action style).
    // Clearing now happens by selecting the "Primary" model lane inside the picker.
    const optionsTrigger = findRowTrigger(container, "Model");
    expect(optionsTrigger).toBeTruthy();
    await act(async () => {
      optionsTrigger!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    const primaryLane = Array.from(container.querySelectorAll('button[role="radio"]'))
      .find((button) => button.textContent?.trim() === "Primary");
    expect(primaryLane).not.toBeUndefined();

    await act(async () => {
      primaryLane!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onUpdate).toHaveBeenCalledWith({ assigneeAdapterOverrides: null });

    act(() => root.unmount());
  });

  it("shows a checkmark on selected labels in the picker", async () => {
    mockIssuesApi.listLabels.mockResolvedValue([
      createLabel(),
      createLabel({ id: "label-2", name: "Feature", color: "#22c55e" }),
    ]);

    const root = renderProperties(container, {
      issue: createIssue({
        labels: [createLabel()],
        labelIds: ["label-1"],
      }),
      childIssues: [],
      onUpdate: vi.fn(),
      inline: true,
    });
    await flush();

    const labelsTrigger = findRowTrigger(container, "Labels");
    expect(labelsTrigger?.textContent).toContain("Bug");
    await act(async () => {
      labelsTrigger!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    const labelButtons = Array.from(container.querySelectorAll("button"))
      .filter((button) => button.textContent?.includes("Bug") || button.textContent?.includes("Feature"));
    const bugButton = labelButtons.find((button) => button.textContent?.includes("Bug") && button.querySelector("svg"));
    const featureButton = labelButtons.find((button) => button.textContent?.includes("Feature"));
    expect(bugButton).not.toBeUndefined();
    expect(featureButton?.querySelector("svg")).toBeNull();

    act(() => root.unmount());
  });

  it("allows setting and clearing a parent issue from the properties pane", async () => {
    const onUpdate = vi.fn();
    mockIssuesApi.list.mockResolvedValue([
      createIssue({ id: "issue-2", identifier: "PAP-2", title: "Candidate parent", status: "in_progress" }),
    ]);

    const root = renderProperties(container, {
      issue: createIssue(),
      childIssues: [],
      onUpdate,
      inline: true,
    });
    await flush();

    // Empty parent now uses the uniform muted "None" empty state (ux-spec §6).
    const parentTrigger = findRowTrigger(container, "Parent");
    expect(parentTrigger?.textContent).toContain("None");

    await act(async () => {
      parentTrigger!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    const candidateButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("PAP-2 Candidate parent"));
    expect(candidateButton).not.toBeUndefined();

    await act(async () => {
      candidateButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onUpdate).toHaveBeenCalledWith({ parentId: "issue-2" });

    onUpdate.mockClear();
    const rerenderedIssue = createIssue({
      parentId: "issue-2",
      ancestors: [
        {
          id: "issue-2",
          identifier: "PAP-2",
          title: "Candidate parent",
          description: null,
          status: "in_progress",
          priority: "medium",
          assigneeAgentId: null,
          assigneeUserId: null,
          projectId: null,
          goalId: null,
          project: null,
          goal: null,
        },
      ],
    });

    act(() => root.unmount());

    const rerenderedRoot = renderProperties(container, {
      issue: rerenderedIssue,
      childIssues: [],
      onUpdate,
      inline: true,
    });
    await flush();

    const selectedParentTrigger = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("PAP-2 Candidate parent"));
    expect(selectedParentTrigger).not.toBeUndefined();
    const parentLink = container.querySelector('a[href="/issues/PAP-2"]');
    expect(parentLink).not.toBeNull();
    expect(selectedParentTrigger!.contains(parentLink)).toBe(false);

    await act(async () => {
      selectedParentTrigger!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    const clearParentButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("No parent"));
    expect(clearParentButton).not.toBeUndefined();

    await act(async () => {
      clearParentButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onUpdate).toHaveBeenCalledWith({ parentId: null });

    act(() => rerenderedRoot.unmount());
  });

  it("searches the server for parent candidates so a lower-priority match past the default page stays selectable", async () => {
    const onUpdate = vi.fn();
    // The default list is priority-first and caps at 500 rows, so a low-priority
    // match past that cap never enters the client list. Model that gap: the default
    // page returns only a high-priority candidate, and the server search with `q`
    // returns the low-priority match that the default page hides.
    const defaultPageCandidate = createIssue({
      id: "issue-2",
      identifier: "PAP-2",
      title: "High priority candidate",
      status: "in_progress",
      priority: "high",
    });
    const lowPriorityMatch = createIssue({
      id: "issue-900",
      identifier: "PAP-900",
      title: "Low priority needle",
      status: "todo",
      priority: "low",
    });
    mockIssuesApi.list.mockImplementation((_companyId: string, filters?: { q?: string; limit?: number }) => {
      if (filters?.q === "needle") return Promise.resolve([lowPriorityMatch]);
      return Promise.resolve([defaultPageCandidate]);
    });

    const root = renderProperties(container, {
      issue: createIssue(),
      childIssues: [],
      onUpdate,
      inline: true,
    });
    await flush();

    const parentTrigger = findRowTrigger(container, "Parent");
    expect(parentTrigger).not.toBeUndefined();
    await act(async () => {
      parentTrigger!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    // With an empty search the picker shows the default page. The low-priority match is absent.
    await waitForAssertion(() => {
      expect(container.textContent).toContain("PAP-2 High priority candidate");
    });
    expect(container.textContent).not.toContain("PAP-900 Low priority needle");

    const searchInput = container.querySelector('input[placeholder="Search tasks..."]') as HTMLInputElement | null;
    expect(searchInput).not.toBeNull();

    await act(async () => {
      const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      nativeSetter?.call(searchInput, "needle");
      searchInput!.dispatchEvent(new Event("input", { bubbles: true }));
    });

    // The typed text re-queries the server with `q`, and the low-priority match now appears.
    await waitForAssertion(() => {
      expect(mockIssuesApi.list).toHaveBeenCalledWith("company-1", { q: "needle", limit: 50 });
      expect(container.textContent).toContain("PAP-900 Low priority needle");
      expect(container.textContent).not.toContain("PAP-2 High priority candidate");
    });

    const candidateButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("PAP-900 Low priority needle"));
    expect(candidateButton).not.toBeUndefined();

    await act(async () => {
      candidateButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onUpdate).toHaveBeenCalledWith({ parentId: "issue-900" });

    act(() => root.unmount());
  });

  it("shows a run review action after reviewers are configured and starts execution explicitly when clicked", async () => {
    const onUpdate = vi.fn();
    const root = renderProperties(container, {
      issue: createIssue({
        executionPolicy: createExecutionPolicy({
          stages: [
            {
              id: "review-stage",
              type: "review",
              approvalsNeeded: 1,
              participants: [{ id: "participant-1", type: "agent", agentId: "agent-1", userId: null }],
            },
          ],
        }),
      }),
      childIssues: [],
      onUpdate,
    });
    await flush();

    const runReviewButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Run review now"));
    expect(runReviewButton).not.toBeUndefined();

    await act(async () => {
      runReviewButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onUpdate).toHaveBeenCalledWith({ status: "in_review" });

    act(() => root.unmount());
  });

  it("shows a run approval action when approval is the next runnable stage", async () => {
    const root = renderProperties(container, {
      issue: createIssue({
        executionPolicy: createExecutionPolicy({
          stages: [
            {
              id: "approval-stage",
              type: "approval",
              approvalsNeeded: 1,
              participants: [{ id: "participant-2", type: "user", agentId: null, userId: "user-1" }],
            },
          ],
        }),
      }),
      childIssues: [],
      onUpdate: vi.fn(),
    });
    await flush();

    expect(container.textContent).toContain("Run approval now");
    expect(container.textContent).not.toContain("Run review now");

    act(() => root.unmount());
  });

  it("keeps the run review action available after changes are requested", async () => {
    const root = renderProperties(container, {
      issue: createIssue({
        status: "in_progress",
        executionPolicy: createExecutionPolicy({
          stages: [
            {
              id: "review-stage",
              type: "review",
              approvalsNeeded: 1,
              participants: [{ id: "participant-1", type: "agent", agentId: "agent-1", userId: null }],
            },
          ],
        }),
        executionState: createExecutionState(),
      }),
      childIssues: [],
      onUpdate: vi.fn(),
    });
    await flush();

    expect(container.textContent).toContain("Run review now");

    act(() => root.unmount());
  });

  it("hides the run action while an execution stage is already pending", async () => {
    const root = renderProperties(container, {
      issue: createIssue({
        status: "in_review",
        executionPolicy: createExecutionPolicy({
          stages: [
            {
              id: "review-stage",
              type: "review",
              approvalsNeeded: 1,
              participants: [{ id: "participant-1", type: "agent", agentId: "agent-1", userId: null }],
            },
          ],
        }),
        executionState: createExecutionState({
          status: "pending",
          currentStageType: "review",
          lastDecisionOutcome: null,
        }),
      }),
      childIssues: [],
      onUpdate: vi.fn(),
    });
    await flush();

    expect(container.textContent).not.toContain("Run review now");
    expect(container.textContent).not.toContain("Run approval now");

    act(() => root.unmount());
  });

  it("renders monitor controls and clears an existing monitor", async () => {
    const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(new Date("2026-04-11T10:00:00.000Z").getTime());
    const onUpdate = vi.fn();
    const root = renderProperties(container, {
      issue: createIssue({
        status: "in_progress",
        assigneeAgentId: "agent-1",
        executionPolicy: createExecutionPolicy({
          monitor: {
            nextCheckAt: "2026-04-11T12:30:00.000Z",
            notes: "Check deployment",
            scheduledBy: "board",
          },
        }),
        executionState: createExecutionState({
          status: "idle",
          currentStageId: null,
          currentStageIndex: null,
          currentStageType: null,
          currentParticipant: null,
          returnAssignee: null,
          lastDecisionOutcome: null,
          monitor: {
            status: "scheduled",
            nextCheckAt: "2026-04-11T12:30:00.000Z",
            lastTriggeredAt: null,
            attemptCount: 0,
            notes: "Check deployment",
            scheduledBy: "board",
            clearedAt: null,
            clearReason: null,
          },
        }),
      }),
      childIssues: [],
      onUpdate,
      inline: true,
    });
    await flush();

    expect(container.textContent).toContain("Monitor");
    expect(container.textContent).toContain("In 2h 30m");
    expect(container.querySelector('input[type="datetime-local"]')).toBeNull();
    expect(container.querySelector('input[placeholder="What should the agent re-check?"]')).toBeNull();

    const monitorTrigger = container.querySelector('[data-testid="monitor-row-trigger"]')?.closest("button");
    expect(monitorTrigger).not.toBeUndefined();

    await act(async () => {
      monitorTrigger!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    const inputs = Array.from(container.querySelectorAll("input"));
    const datetimeInput = inputs.find((input) => input.getAttribute("type") === "datetime-local");
    const textInput = inputs.find((input) => input.getAttribute("placeholder") === "What should the agent re-check?");
    const clearButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Clear"));

    expect(datetimeInput).toBeTruthy();
    expect(textInput).toBeTruthy();
    expect(clearButton).toBeTruthy();
    expect(datetimeInput!.value).toBeTruthy();
    expect(textInput!.value).toBe("Check deployment");

    act(() => {
      clearButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onUpdate).toHaveBeenCalledWith({
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [],
      },
    });

    act(() => root.unmount());
    dateNowSpy.mockRestore();
  });

  it("renders scheduled, retrying, due, overdue, cleared, and empty monitor row states", async () => {
    // Anchored to a fixed *local* time, not a fixed UTC instant. The row renders
    // these in the machine's timezone and labels them "Today" only while they
    // share a local calendar day with `now`. Pinned to UTC, the pair straddles
    // local midnight from UTC+8 to UTC+9:30 — the label becomes a date and every
    // assertion below fails for a reason that has nothing to do with row states.
    // Anchoring locally keeps them on one day everywhere, which also makes the
    // rendered clock identical in every timezone, so the times below can stay
    // exact rather than being relaxed to a pattern.
    const NOW = new Date(2026, 6, 17, 13, 56, 0, 0);
    const at = (minutesFromNow: number) =>
      new Date(NOW.getTime() + minutesFromNow * 60_000).toISOString();
    const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(NOW.getTime());
    const baseMonitorState = {
      status: "scheduled" as const,
      nextCheckAt: at(132),
      lastTriggeredAt: null,
      attemptCount: 1,
      notes: "Verify deployment",
      scheduledBy: "board" as const,
      clearedAt: null,
      clearReason: null,
    };
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const root = createRoot(container);
    const monitorRowText = () => container.querySelector('[data-testid="monitor-row-trigger"]')?.textContent;
    const renderMonitor = (issue: Issue) => {
      act(() => {
        root.render(
          <QueryClientProvider client={queryClient}>
            <IssueProperties issue={issue} childIssues={[]} onUpdate={vi.fn()} inline />
          </QueryClientProvider>,
        );
      });
    };

    renderMonitor(createIssue({
      executionPolicy: createExecutionPolicy({ monitor: { ...baseMonitorState, serviceName: "vercel-deploy" } }),
      executionState: createExecutionState({ monitor: baseMonitorState }),
      monitorAttemptCount: 1,
    }));
    await flush();
    expect(monitorRowText()).toContain("In 2h 12m");
    // The hour is rendered in the machine's timezone, so it is not pinned here:
    // this instant is 4:08 PM at UTC and 9:08 AM at UTC-7. What the row states
    // are actually about — the countdown and the attempt suffix — is asserted
    // exactly, and the countdown above is timezone-independent already.
    expect(monitorRowText()).toContain("Today, 4:08 PM · Attempt 1");

    renderMonitor(createIssue({
      executionPolicy: createExecutionPolicy({ monitor: { ...baseMonitorState, nextCheckAt: at(252) } }),
      executionState: createExecutionState({ monitor: { ...baseMonitorState, nextCheckAt: at(132) } }),
      monitorNextCheckAt: new Date(at(192)),
    }));
    await flush();
    expect(monitorRowText()).toContain("In 2h 12m");
    expect(monitorRowText()).toContain("Today, 4:08 PM");

    renderMonitor(createIssue({
      executionPolicy: createExecutionPolicy({ monitor: { ...baseMonitorState, serviceName: "vercel-deploy" } }),
      executionState: createExecutionState({ monitor: { ...baseMonitorState, attemptCount: 3 } }),
      monitorAttemptCount: 3,
    }));
    await flush();
    expect(monitorRowText()).toContain("Attempt 3");

    renderMonitor(createIssue({
      executionPolicy: createExecutionPolicy({ monitor: { ...baseMonitorState, nextCheckAt: at(0) } }),
      executionState: createExecutionState({ monitor: { ...baseMonitorState, nextCheckAt: at(0) } }),
    }));
    await flush();
    expect(monitorRowText()).toContain("Due now");
    expect(monitorRowText()).toContain("checking momentarily…");

    renderMonitor(createIssue({
      executionPolicy: createExecutionPolicy({ monitor: { ...baseMonitorState, nextCheckAt: at(-18) } }),
      executionState: createExecutionState({ monitor: { ...baseMonitorState, nextCheckAt: at(-18) } }),
    }));
    await flush();
    expect(monitorRowText()).toContain("Overdue by 18m");
    expect(monitorRowText()).toContain("Today, 1:38 PM · fires on next tick");

    renderMonitor(createIssue({
      executionPolicy: createExecutionPolicy(),
      executionState: createExecutionState({ monitor: {
        ...baseMonitorState,
        status: "cleared",
        nextCheckAt: null,
        lastTriggeredAt: at(-120),
        attemptCount: 2,
        clearedAt: at(-116),
        clearReason: "manual",
      } }),
      monitorAttemptCount: 2,
      monitorLastTriggeredAt: new Date(at(-120)),
    }));
    await flush();
    expect(monitorRowText()).toContain("Cleared");
    expect(monitorRowText()).toContain("last checked 2h ago · after attempt 2");

    renderMonitor(createIssue());
    await flush();
    expect(monitorRowText()).toContain("None");

    act(() => root.unmount());
    dateNowSpy.mockRestore();
  });

  const watchdogAgent = {
    id: "agent-1",
    name: "ClaudeCoder",
    role: "",
    title: null,
    icon: null,
    status: "active",
    orgChainHealth: { status: "ok" },
  } as unknown as Parameters<typeof mockAgentsApi.list.mockResolvedValue>[0][number];

  function createWatchdogSummary(overrides: Record<string, unknown> = {}) {
    return {
      id: "watchdog-1",
      companyId: "company-1",
      issueId: "issue-1",
      watchdogAgentId: "agent-1",
      instructions: "Keep the tree moving.",
      status: "active",
      watchdogIssueId: null,
      lastObservedFingerprint: null,
      lastReviewedFingerprint: null,
      lastTriggeredAt: null,
      lastCompletedAt: null,
      triggerCount: 0,
      createdAt: new Date("2026-04-06T12:00:00.000Z"),
      updatedAt: new Date("2026-04-06T12:00:00.000Z"),
      ...overrides,
    } as unknown as NonNullable<Issue["watchdog"]>;
  }

  it("shows the empty watchdog state and saves a new watchdog via the API", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({
    });
    mockAgentsApi.list.mockResolvedValue([watchdogAgent]);
    const onUpdate = vi.fn();
    const root = renderProperties(container, {
      issue: createIssue({ watchdog: null }),
      childIssues: [],
      onUpdate,
      inline: true,
    });
    await flush();

    let trigger: HTMLButtonElement | undefined;
    await waitForAssertion(() => {
      expect(container.textContent).toContain("Watchdog");
      trigger = findRowTrigger(container, "Watchdog");
      expect(trigger).toBeTruthy();
    });

    await act(async () => {
      trigger!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    // Choose the agent through the inline selector, then save.
    let agentOption: HTMLElement | undefined;
    await waitForAssertion(() => {
      agentOption = Array.from(container.querySelectorAll("button, [role='option']"))
        .find((node) => node.textContent?.includes("ClaudeCoder")) as HTMLElement | undefined;
      expect(agentOption).toBeTruthy();
    });
    // Open the selector if the option is not yet visible, then click it.
    await act(async () => {
      agentOption!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    const instructions = Array.from(container.querySelectorAll("textarea"))
      .find((node) => node.getAttribute("placeholder")?.includes("watchdog"));
    expect(instructions).toBeTruthy();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(instructions!, "Watch the deploy");
      instructions!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flush();

    const saveButton = Array.from(container.querySelectorAll("button"))
      .find((button) => /Set watchdog|Update/.test(button.textContent ?? "") && button.closest("[class*='space-y']"));
    const finalSave = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent === "Set watchdog" && button !== trigger) ?? saveButton;
    expect(finalSave).toBeTruthy();
    await act(async () => {
      finalSave!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(mockIssuesApi.upsertWatchdog).toHaveBeenCalledWith(
      "issue-1",
      expect.objectContaining({ agentId: "agent-1" }),
    );

    act(() => root.unmount());
  });

  it("updates cached issue detail when saving a watchdog", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({
    });
    mockAgentsApi.list.mockResolvedValue([watchdogAgent]);
    const savedWatchdog = createWatchdogSummary({
      instructions: "Watch the deploy",
    });
    mockIssuesApi.upsertWatchdog.mockResolvedValueOnce(savedWatchdog);
    const issue = createIssue({ watchdog: null });
    const { root, queryClient } = renderPropertiesWithQueryClient(container, {
      issue,
      childIssues: [],
      onUpdate: vi.fn(),
      inline: true,
    });
    queryClient.setQueryData(queryKeys.issues.detail(issue.id), issue);
    await flush();

    let trigger: HTMLButtonElement | undefined;
    await waitForAssertion(() => {
      trigger = findRowTrigger(container, "Watchdog");
      expect(trigger).toBeTruthy();
    });

    await act(async () => {
      trigger!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    let agentOption: HTMLElement | undefined;
    await waitForAssertion(() => {
      agentOption = Array.from(container.querySelectorAll("button, [role='option']"))
        .find((node) => node.textContent?.includes("ClaudeCoder")) as HTMLElement | undefined;
      expect(agentOption).toBeTruthy();
    });
    await act(async () => {
      agentOption!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    const finalSave = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent === "Set watchdog" && button !== trigger);
    expect(finalSave).toBeTruthy();
    await act(async () => {
      finalSave!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(queryClient.getQueryData<Issue>(queryKeys.issues.detail(issue.id))?.watchdog)
      .toEqual(savedWatchdog);

    act(() => root.unmount());
  });

  it("renders an existing watchdog and removes it via the API", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({
    });
    mockAgentsApi.list.mockResolvedValue([watchdogAgent]);
    const onUpdate = vi.fn();
    const issue = createIssue({ watchdog: createWatchdogSummary() });
    const { root, queryClient } = renderPropertiesWithQueryClient(container, {
      issue,
      childIssues: [],
      onUpdate,
      inline: true,
    });
    queryClient.setQueryData(queryKeys.issues.detail(issue.id), issue);
    await flush();

    await waitForAssertion(() => {
      expect(container.textContent).toContain("ClaudeCoder");
    });

    const trigger = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("ClaudeCoder"));
    await act(async () => {
      trigger!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    const removeButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Remove"));
    expect(removeButton).toBeTruthy();
    await act(async () => {
      removeButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(mockIssuesApi.deleteWatchdog).toHaveBeenCalledWith("issue-1");
    expect(queryClient.getQueryData<Issue>(queryKeys.issues.detail(issue.id))?.watchdog)
      .toBeNull();

    act(() => root.unmount());
  });

  it("truncates the watchdog instructions one-line summary in the properties value column", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({
    });
    mockAgentsApi.list.mockResolvedValue([watchdogAgent]);
    const instructions = "get greptile to stop re-reviewing the same task unless a fresh code change lands";
    const root = renderProperties(container, {
      issue: createIssue({
        watchdog: createWatchdogSummary({ instructions }),
      }),
      childIssues: [],
      onUpdate: vi.fn(),
      inline: true,
    });
    await flush();

    // ux-spec: watchdog row shows agent + a truncated one-line summary; the
    // full instructions live in the popover (surfaced here via the row title).
    let instructionNode: HTMLSpanElement | undefined;
    await waitForAssertion(() => {
      instructionNode = Array.from(container.querySelectorAll("span"))
        .find((node) =>
          node.textContent?.includes("get greptile")
          && node.className.includes("text-muted-foreground")
          && !node.className.includes("inline-flex")
        ) as HTMLSpanElement | undefined;
      expect(instructionNode).toBeTruthy();
    });

    expect(instructionNode!.className).toContain("truncate");
    expect(instructionNode!.className).not.toContain("whitespace-normal");
    expect(instructionNode!.className).not.toContain("break-words");

    const watchdogTrigger = findRowTrigger(container, "Watchdog");
    expect(watchdogTrigger?.querySelector("[title]")?.getAttribute("title")).toBe(instructions);

    act(() => root.unmount());
  });

  it("links to the generated watchdog task when one exists", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({
    });
    mockAgentsApi.list.mockResolvedValue([watchdogAgent]);
    const root = renderProperties(container, {
      issue: createIssue({ watchdog: createWatchdogSummary({ watchdogIssueId: "issue-wd" }) }),
      childIssues: [
        createIssue({
          id: "issue-wd",
          identifier: "PAP-42",
          title: "Watchdog: Parent issue",
          originKind: "task_watchdog",
        }),
      ],
      onUpdate: vi.fn(),
      inline: true,
    });
    await flush();

    // The link is now an icon-only "open task" affordance (ux-spec: one
    // trailing-action style), so we assert on href + accessible label.
    await waitForAssertion(() => {
      const link = Array.from(container.querySelectorAll("a"))
        .find((anchor) => anchor.getAttribute("href") === "/issues/issue-wd");
      expect(link).toBeTruthy();
      expect(link!.getAttribute("aria-label")).toBe("Open watchdog task");
    });

    act(() => root.unmount());
  });

  it("renders each external object as its own properties row using display metadata", async () => {
    const root = renderProperties(container, {
      issue: createIssue(),
      childIssues: [],
      onUpdate: vi.fn(),
      inline: true,
      externalObjects: [
        {
          mentionCount: 2,
          sourceLabels: ["Description"],
          pill: {
            providerKey: "github",
            objectType: "pull_request",
            displayKey: null,
            iconKey: "github",
            statusCategory: "succeeded",
            statusIconKey: null,
            statusLabel: "Merged",
            liveness: "fresh",
            displayTitle: "acme/web#241: Add rich object presentation metadata",
            url: "https://github.com/acme/web/pull/241",
          },
          group: {
            object: null,
            mentions: [],
            mentionCount: 2,
            sourceLabels: ["Description"],
          },
        },
        {
          mentionCount: 1,
          sourceLabels: ["Comment"],
          pill: {
            providerKey: "github",
            objectType: "issue",
            displayKey: "Github Issue",
            iconKey: "github",
            statusCategory: "open",
            statusIconKey: "circle-dot",
            statusLabel: "Open",
            liveness: "fresh",
            displayTitle: "acme/web#12: Follow-up",
            url: "https://github.com/acme/web/issues/12",
          },
          group: {
            object: null,
            mentions: [],
            mentionCount: 1,
            sourceLabels: ["Comment"],
          },
        },
        {
          mentionCount: 1,
          sourceLabels: ["Comment"],
          pill: {
            providerKey: "url",
            objectType: "link",
            displayKey: null,
            iconKey: null,
            statusCategory: "unknown",
            statusIconKey: null,
            statusLabel: null,
            liveness: "unknown",
            displayTitle: "https://example.com/release-notes",
            url: "https://example.com/release-notes",
          },
          group: {
            object: null,
            mentions: [],
            mentionCount: 1,
            sourceLabels: ["Comment"],
          },
        },
        {
          mentionCount: 1,
          sourceLabels: ["Comment"],
          pill: {
            providerKey: "github",
            objectType: "pull_request",
            displayKey: "Github PR",
            iconKey: "github",
            statusCategory: "unknown",
            statusIconKey: null,
            statusLabel: null,
            liveness: "unknown",
            displayTitle: "acme/web#242",
            url: "https://github.com/acme/web/pull/242",
          },
          group: {
            object: null,
            mentions: [],
            mentionCount: 1,
            sourceLabels: ["Comment"],
          },
        },
      ],
    });
    await flush();

    expect(container.textContent).toContain("Github PR");
    expect(container.textContent).not.toContain("Github Pull Request");
    expect(container.textContent).not.toContain("×2");
    expect(container.textContent).toContain("Github Issue");
    expect(container.textContent).toContain("URL");
    expect(container.textContent).not.toContain("URL link");
    expect(container.textContent).toContain("PR 241 - Merged");
    expect(container.textContent).toContain("Merged");
    expect(container.textContent).toContain("Open");
    expect(container.textContent).not.toContain("External objects");
    const label = Array.from(container.querySelectorAll("span"))
      .find((span) => span.textContent === "Github PR");
    expect(label?.querySelector("svg")).toBeTruthy();
    const pullRequestLink = Array.from(container.querySelectorAll("a"))
      .find((anchor) => anchor.getAttribute("href") === "https://github.com/acme/web/pull/241");
    expect(pullRequestLink?.textContent).toContain("PR 241 - Merged");
    expect(pullRequestLink?.textContent).not.toContain("acme/web#241");
    expect(pullRequestLink?.textContent).not.toContain("Github PR");
    expect(pullRequestLink?.querySelectorAll("svg")).toHaveLength(1);
    expect(pullRequestLink?.className).not.toContain("paperclip-mention-chip");
    expect(pullRequestLink?.className).not.toContain("rounded-full");
    expect(pullRequestLink?.className).not.toContain("border");
    const unrefreshedPullRequestLink = Array.from(container.querySelectorAll("a"))
      .find((anchor) => anchor.getAttribute("href") === "https://github.com/acme/web/pull/242");
    expect(unrefreshedPullRequestLink?.textContent).toContain("PR 242 - Not yet refreshed");
    expect(unrefreshedPullRequestLink?.textContent).not.toContain("Not yet resolved");

    act(() => root.unmount());
  });

  it("shows agent-archive attribution and unarchive only in the properties pane", async () => {
    mockAgentsApi.list.mockResolvedValue([
      { id: "agent-9", name: "Gardener", status: "active", adapterType: "codex_local", icon: null },
    ]);
    const root = renderProperties(container, {
      issue: createIssue({
        archivedAt: new Date("2026-04-06T12:10:00.000Z"),
        archivedByActorType: "agent",
        archivedByAgentId: "agent-9",
        archivedByRunId: "run-1",
      }),
      childIssues: [],
      onUpdate: vi.fn(),
      inline: true,
    });
    await flush();

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Archived");
      // The value shows just the agent name (the row label already says
      // "Archived"), giving the name the full column width at 320px.
      expect(container.textContent).toContain("Gardener");
      const unarchive = Array.from(container.querySelectorAll("button"))
        .find((button) => button.textContent?.includes("Unarchive"));
      expect(unarchive).toBeTruthy();
    });

    // The tooltip must carry the full "Archived by <name> · <time>" phrasing so
    // the attribution is recoverable if a long name truncates at the 320px pane
    // width (PAP-14182 review fix).
    const attribution = Array.from(container.querySelectorAll("span"))
      .find((span) => span.getAttribute("title")?.startsWith("Archived by Gardener"));
    expect(attribution).toBeTruthy();

    const unarchiveButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Unarchive"))!;
    await act(async () => {
      unarchiveButton.click();
    });
    await flush();
    expect(mockIssuesApi.unarchiveFromInbox).toHaveBeenCalledWith("issue-1");

    act(() => root.unmount());
  });

  it("surfaces unarchive failures inline", async () => {
    mockAgentsApi.list.mockResolvedValue([
      { id: "agent-9", name: "Gardener", status: "active", adapterType: "codex_local", icon: null },
    ]);
    mockIssuesApi.unarchiveFromInbox.mockRejectedValue(new Error("Archive policy denied"));
    const root = renderProperties(container, {
      issue: createIssue({
        archivedAt: new Date("2026-04-06T12:10:00.000Z"),
        archivedByActorType: "agent",
        archivedByAgentId: "agent-9",
        archivedByRunId: "run-1",
      }),
      childIssues: [],
      onUpdate: vi.fn(),
      inline: true,
    });
    await flush();

    let unarchiveButton: HTMLButtonElement | undefined;
    await waitForAssertion(() => {
      unarchiveButton = Array.from(container.querySelectorAll("button"))
        .find((button) => button.textContent?.includes("Unarchive"));
      expect(unarchiveButton).toBeTruthy();
    });
    await act(async () => {
      unarchiveButton!.click();
    });
    await flush();

    await waitForAssertion(() => {
      expect(container.querySelector('[role="alert"]')?.textContent).toContain("Archive policy denied");
    });

    act(() => root.unmount());
  });

  it("does not render archive attribution for user (manual) archives", async () => {
    const root = renderProperties(container, {
      issue: createIssue({
        archivedAt: new Date("2026-04-06T12:10:00.000Z"),
        archivedByActorType: "user",
        archivedByAgentId: null,
      }),
      childIssues: [],
      onUpdate: vi.fn(),
      inline: true,
    });
    await flush();

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Updated");
    });
    expect(container.textContent).not.toContain("Archived by");
    expect(
      Array.from(container.querySelectorAll("button")).some((button) => button.textContent?.includes("Unarchive")),
    ).toBe(false);

    act(() => root.unmount());
  });
  // PAP-16506 P4: only an agent sets `reviewPolicy`, so the panel shows it and
  // never offers a control. The default — a NULL column, meaning anyone with
  // write access can approve — is what every issue already does, so it shows
  // nothing at all rather than a row reading "Anyone" or "None".
  const findApprovalsRow = () =>
    container.querySelector('[data-property-label="Approvals"]')?.closest('[data-property-row="true"]') ?? null;

  it("shows no approvals row on an issue that has never set a policy", async () => {
    const root = renderProperties(container, {
      issue: createIssue({ reviewPolicy: null }),
      childIssues: [],
      onUpdate: vi.fn(),
      inline: true,
    });
    await flush();

    expect(findApprovalsRow()).toBeNull();
    expect(container.textContent).not.toContain("Review policy");

    act(() => root.unmount());
  });

  it("shows no approvals row when the policy is the explicit default", async () => {
    const root = renderProperties(container, {
      issue: createIssue({ reviewPolicy: "anyone" }),
      childIssues: [],
      onUpdate: vi.fn(),
      inline: true,
    });
    await flush();

    expect(findApprovalsRow()).toBeNull();

    act(() => root.unmount());
  });

  it("badges an opt-in constraint read-only, with no control to change it", async () => {
    const onUpdate = vi.fn();
    const root = renderProperties(container, {
      issue: createIssue({ reviewPolicy: "human_only" }),
      childIssues: [],
      onUpdate,
      inline: true,
    });
    await flush();

    const row = findApprovalsRow();
    expect(row?.textContent).toContain("Human only");
    // Read-only: the row is a chip, not a picker — nothing here can PATCH.
    expect(row?.querySelector("button")).toBeNull();
    expect(onUpdate).not.toHaveBeenCalled();

    act(() => root.unmount());
  });

  it("badges a not_creator policy as 'Anyone else'", async () => {
    const root = renderProperties(container, {
      issue: createIssue({ reviewPolicy: "not_creator" }),
      childIssues: [],
      onUpdate: vi.fn(),
      inline: true,
    });
    await flush();

    expect(findApprovalsRow()?.textContent).toContain("Anyone else");

    act(() => root.unmount());
  });

  it("hides the execution workspace picker without an enabled project policy", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableIsolatedWorkspaces: true });
    mockProjectsApi.list.mockResolvedValue([createProject({ executionWorkspacePolicy: null })]);
    const root = renderProperties(container, {
      issue: createIssue({ projectId: "project-1" }),
      childIssues: [],
      onUpdate: vi.fn(),
      inline: true,
    });

    await flush();

    expect(container.querySelector('[data-property-label="Execution"]')).toBeNull();
    expect(mockExecutionWorkspacesApi.list).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  it("shows the workspace picker with no bound workspace", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableIsolatedWorkspaces: true });
    mockProjectsApi.list.mockResolvedValue([createProject({
      executionWorkspacePolicy: { enabled: true, defaultMode: "isolated_workspace" },
    })]);
    const root = renderProperties(container, {
      issue: createIssue({ projectId: "project-1" }),
      childIssues: [],
      onUpdate: vi.fn(),
      inline: true,
    });

    await waitForAssertion(() => {
      expect(findRowTrigger(container, "Execution")?.textContent).toBe("Default");
    });

    act(() => root.unmount());
  });

  it("saves the exact isolated-workspace payload", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableIsolatedWorkspaces: true });
    mockProjectsApi.list.mockResolvedValue([createProject({
      executionWorkspacePolicy: { enabled: true, defaultMode: "shared_workspace" },
    })]);
    const onUpdate = vi.fn();
    const root = renderProperties(container, {
      issue: createIssue({ projectId: "project-1" }),
      childIssues: [],
      onUpdate,
      inline: true,
    });

    await waitForAssertion(() => expect(findRowTrigger(container, "Execution")).toBeDefined());
    act(() => findRowTrigger(container, "Execution")!.click());
    const isolatedOption = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("New isolated workspace"));
    act(() => isolatedOption!.click());

    expect(onUpdate).toHaveBeenCalledWith({
      executionWorkspacePreference: "isolated_workspace",
      executionWorkspaceId: null,
      executionWorkspaceSettings: {
        mode: "isolated_workspace",
        environmentId: null,
      },
    });
    act(() => root.unmount());
  });

  it("searches reusable workspaces and saves the selected workspace", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableIsolatedWorkspaces: true });
    mockProjectsApi.list.mockResolvedValue([createProject({
      executionWorkspacePolicy: { enabled: true, defaultMode: "shared_workspace" },
    })]);
    const alphaWorkspace = createExecutionWorkspace({
      id: "workspace-alpha",
      name: "Alpha workspace",
      cwd: "/tmp/paperclip/alpha",
      branchName: "alpha-branch",
      lastUsedAt: new Date(),
    });
    const betaWorkspace = createExecutionWorkspace({
      id: "workspace-beta",
      name: "Beta workspace",
      cwd: "/tmp/paperclip/beta",
      branchName: "beta-branch",
      lastUsedAt: new Date(),
    });
    mockExecutionWorkspacesApi.list.mockResolvedValue([alphaWorkspace, betaWorkspace]);
    const onUpdate = vi.fn();
    const root = renderProperties(container, {
      issue: createIssue({ projectId: "project-1", projectWorkspaceId: "workspace-main" }),
      childIssues: [],
      onUpdate,
      inline: true,
    });

    await waitForAssertion(() => expect(findRowTrigger(container, "Execution")).toBeDefined());
    act(() => findRowTrigger(container, "Execution")!.click());
    const reuseOption = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Reuse existing workspace"));
    act(() => reuseOption!.click());

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Recent");
      expect(container.textContent).toContain("Alpha workspace");
      expect(container.textContent).toContain("Beta workspace");
    });
    expect(mockExecutionWorkspacesApi.list).toHaveBeenCalledWith("company-1", {
      projectId: "project-1",
      projectWorkspaceId: "workspace-main",
      reuseEligible: true,
    });

    const search = container.querySelector('input[aria-label="Search reusable workspaces"]') as HTMLInputElement;
    await act(async () => {
      const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      nativeSetter?.call(search, "Beta");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(container.textContent).not.toContain("Alpha workspace");
    expect(container.textContent).toContain("Beta workspace");

    const betaOption = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Beta workspace"));
    act(() => betaOption!.click());
    expect(onUpdate).toHaveBeenCalledWith({
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceId: "workspace-beta",
      executionWorkspaceSettings: {
        mode: "isolated_workspace",
        environmentId: null,
      },
    });

    act(() => root.unmount());
  });
});
