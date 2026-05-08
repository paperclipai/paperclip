// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Agent, Issue, IssueTreeControlPreview, IssueTreeHold } from "@paperclipai/shared";
import { act, type ButtonHTMLAttributes, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IssueDetail } from "./IssueDetail";

const mockIssuesApi = vi.hoisted(() => ({
  get: vi.fn(),
  list: vi.fn(),
  listComments: vi.fn(),
  listAttachments: vi.fn(),
  listFeedbackVotes: vi.fn(),
  markRead: vi.fn(),
  update: vi.fn(),
  previewTreeControl: vi.fn(),
  getTreeControlState: vi.fn(),
  listTreeHolds: vi.fn(),
  createTreeHold: vi.fn(),
  releaseTreeHold: vi.fn(),
  archiveFromInbox: vi.fn(),
  addComment: vi.fn(),
  cancelComment: vi.fn(),
  upsertFeedbackVote: vi.fn(),
  uploadAttachment: vi.fn(),
  deleteAttachment: vi.fn(),
  upsertDocument: vi.fn(),
}));

const mockActivityApi = vi.hoisted(() => ({
  forIssue: vi.fn(),
  runsForIssue: vi.fn(),
}));

const mockHeartbeatsApi = vi.hoisted(() => ({
  liveRunsForIssue: vi.fn(),
  activeRunForIssue: vi.fn(),
  cancel: vi.fn(),
}));

const mockAgentsApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockAccessApi = vi.hoisted(() => ({
  getCurrentBoardAccess: vi.fn(),
  listUserDirectory: vi.fn(),
}));

const mockAuthApi = vi.hoisted(() => ({
  getSession: vi.fn(),
}));

const mockProjectsApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockInstanceSettingsApi = vi.hoisted(() => ({
  getGeneral: vi.fn(),
}));

const mockNavigate = vi.hoisted(() => vi.fn());
const mockOpenPanel = vi.hoisted(() => vi.fn());
const mockClosePanel = vi.hoisted(() => vi.fn());
const mockSetBreadcrumbs = vi.hoisted(() => vi.fn());
const mockSetMobileToolbar = vi.hoisted(() => vi.fn());
const mockPushToast = vi.hoisted(() => vi.fn());
const mockIssuesListRender = vi.hoisted(() => vi.fn());
const mockIssueChatThreadRender = vi.hoisted(() => vi.fn());

vi.mock("../api/issues", () => ({
  issuesApi: mockIssuesApi,
}));

vi.mock("../api/activity", () => ({
  activityApi: mockActivityApi,
}));

vi.mock("../api/heartbeats", () => ({
  heartbeatsApi: mockHeartbeatsApi,
}));

vi.mock("../api/approvals", () => ({
  approvalsApi: {
    approve: vi.fn(),
    reject: vi.fn(),
  },
}));

vi.mock("../api/agents", () => ({
  agentsApi: mockAgentsApi,
}));

vi.mock("../api/access", () => ({
  accessApi: mockAccessApi,
}));

vi.mock("../api/auth", () => ({
  authApi: mockAuthApi,
}));

vi.mock("../api/projects", () => ({
  projectsApi: mockProjectsApi,
}));

vi.mock("../api/instanceSettings", () => ({
  instanceSettingsApi: mockInstanceSettingsApi,
}));

vi.mock("@/lib/router", () => ({
  Link: ({ children, to }: { children?: ReactNode; to: string }) => <a href={to}>{children}</a>,
  useLocation: () => ({ pathname: "/issues/PAP-1", search: "", hash: "", state: null }),
  useNavigate: () => mockNavigate,
  useNavigationType: () => "PUSH",
  useParams: () => ({ issueId: "PAP-1" }),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    companies: [{ id: "company-1", name: "Paperclip", issuePrefix: "PAP", status: "active" }],
    selectedCompanyId: "company-1",
    selectedCompany: { id: "company-1", name: "Paperclip", issuePrefix: "PAP", status: "active" },
    selectionSource: "manual",
    loading: false,
    error: null,
    setSelectedCompanyId: vi.fn(),
    reloadCompanies: vi.fn(),
    createCompany: vi.fn(),
  }),
}));

vi.mock("../context/DialogContext", () => ({
  useDialog: () => ({
    openNewIssue: vi.fn(),
  }),
  useDialogActions: () => ({
    openNewIssue: vi.fn(),
  }),
}));

vi.mock("../context/PanelContext", () => ({
  usePanel: () => ({
    openPanel: mockOpenPanel,
    closePanel: mockClosePanel,
    panelVisible: true,
    setPanelVisible: vi.fn(),
  }),
}));

vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => ({
    isMobile: false,
  }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({
    setBreadcrumbs: mockSetBreadcrumbs,
    setMobileToolbar: mockSetMobileToolbar,
  }),
}));

vi.mock("../context/ToastContext", () => ({
  useToastActions: () => ({
    pushToast: mockPushToast,
  }),
}));

vi.mock("../hooks/useProjectOrder", () => ({
  useProjectOrder: ({ projects }: { projects: unknown[] }) => ({
    orderedProjects: projects,
  }),
}));

vi.mock("@/plugins/slots", () => ({
  PluginSlotMount: () => null,
  PluginSlotOutlet: () => null,
  usePluginSlots: () => ({ slots: [], isLoading: false, errorMessage: null }),
}));

vi.mock("@/plugins/launchers", () => ({
  PluginLauncherOutlet: () => null,
}));

vi.mock("../components/InlineEditor", () => ({
  InlineEditor: ({ value, placeholder }: { value?: string; placeholder?: string }) => (
    <div>{value || placeholder}</div>
  ),
}));

vi.mock("../components/IssueChatThread", () => ({
  IssueChatThread: (props: {
    onWorkModeChange?: (workMode: string) => void;
    issueWorkMode?: string;
    onStopRun?: (runId: string) => Promise<void>;
    stopRunLabel?: string;
    stoppingRunLabel?: string;
  }) => {
    mockIssueChatThreadRender(props);
    return (
      <div data-testid="issue-chat-thread">
        Chat thread
        {props.onStopRun ? (
          <button type="button" onClick={() => void props.onStopRun?.("run-active-1")}>
            {props.stopRunLabel ?? "Stop run"}
          </button>
        ) : null}
      </div>
    );
  },
}));

vi.mock("../components/IssueDocumentsSection", () => ({
  IssueDocumentsSection: () => <div>Documents</div>,
}));

vi.mock("../components/IssuesList", () => ({
  IssuesList: (props: { issueBadgeById?: Map<string, string> }) => {
    mockIssuesListRender(props);
    return (
      <div>
        Sub-issues
        {Array.from(props.issueBadgeById?.entries() ?? []).map(([issueId, label]) => (
          <span key={issueId}>{issueId}:{label}</span>
        ))}
      </div>
    );
  },
}));

vi.mock("../components/IssueProperties", () => ({
  IssueProperties: () => <div>Properties</div>,
}));

vi.mock("../components/IssueRunLedger", () => ({
  IssueRunLedger: () => <div>Runs</div>,
}));

vi.mock("../components/IssueWorkspaceCard", () => ({
  IssueWorkspaceCard: () => <div>Workspace</div>,
}));

vi.mock("../components/ImageGalleryModal", () => ({
  ImageGalleryModal: () => null,
}));

vi.mock("../components/ScrollToBottom", () => ({
  ScrollToBottom: () => null,
}));

vi.mock("../components/StatusIcon", () => ({
  StatusIcon: ({ status, blockerAttention }: { status: string; blockerAttention?: Issue["blockerAttention"] }) => (
    <span data-status-icon-state={blockerAttention?.state}>{status}</span>
  ),
}));

vi.mock("../components/PriorityIcon", () => ({
  PriorityIcon: ({ priority }: { priority: string }) => <span>{priority}</span>,
}));

vi.mock("../components/ApprovalCard", () => ({
  ApprovalCard: () => <div>Approval</div>,
}));

vi.mock("../components/Identity", () => ({
  Identity: () => <span>Identity</span>,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    disabled,
    onClick,
    type = "button",
    variant: _variant,
    size: _size,
    asChild: _asChild,
    ...props
  }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string; asChild?: boolean }) => (
    <button {...props} type={type} disabled={disabled} onClick={onClick}>
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/separator", () => ({
  Separator: () => <hr />,
}));

vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children?: ReactNode }) => <>{children}</>,
  PopoverTrigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children, open }: { children?: ReactNode; open?: boolean }) => (open ? <div>{children}</div> : null),
  DialogContent: ({ children, className }: { children?: ReactNode; className?: string }) => (
    <div data-slot="dialog-content" className={className}>{children}</div>
  ),
  DialogDescription: ({ children, className }: { children?: ReactNode; className?: string }) => <p className={className}>{children}</p>,
  DialogFooter: ({ children, className }: { children?: ReactNode; className?: string }) => <div className={className}>{children}</div>,
  DialogHeader: ({ children, className }: { children?: ReactNode; className?: string }) => <div className={className}>{children}</div>,
  DialogTitle: ({ children, className }: { children?: ReactNode; className?: string }) => <h2 className={className}>{children}</h2>,
}));

vi.mock("@/components/ui/sheet", () => ({
  Sheet: ({ children, open }: { children?: ReactNode; open?: boolean }) => (open ? <div>{children}</div> : null),
  SheetContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  SheetHeader: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  SheetTitle: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>,
}));

vi.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/ui/skeleton", () => ({
  Skeleton: () => <div data-testid="skeleton" />,
}));

vi.mock("@/components/ui/tabs", () => ({
  Tabs: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  TabsContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  TabsList: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  TabsTrigger: ({ children }: { children?: ReactNode }) => <button type="button">{children}</button>,
}));

vi.mock("@/components/ui/textarea", () => ({
  Textarea: (props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...props} />,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

function createIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    companyId: "company-1",
    projectId: null,
    projectWorkspaceId: null,
    goalId: "goal-1",
    parentId: null,
    title: "Issue detail smoke",
    description: "Loads after the initial pending query.",
    status: "todo",
    priority: "medium",
    assigneeAgentId: null,
    assigneeUserId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    currentExecutionWorkspace: null,
    createdByAgentId: null,
    createdByUserId: null,
    identifier: "PAP-1",
    issueNumber: 1,
    originKind: "manual",
    originId: null,
    originRunId: null,
    originFingerprint: "default",
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionPolicy: null,
    executionState: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    createdAt: new Date("2026-04-21T00:00:00.000Z"),
    updatedAt: new Date("2026-04-21T00:00:00.000Z"),
    labels: [],
    labelIds: [],
    ancestors: [],
    documentSummaries: [],
    ...overrides,
  } as Issue;
}

function createAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent-1",
    companyId: "company-1",
    name: "CodexCoder",
    urlKey: "codexcoder",
    role: "engineer",
    title: "Software Engineer",
    icon: "code",
    status: "active",
    reportsTo: null,
    capabilities: null,
    adapterType: "codex_local",
    adapterConfig: {},
    runtimeConfig: {},
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    permissions: { canCreateAgents: false },
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: new Date("2026-04-21T00:00:00.000Z"),
    updatedAt: new Date("2026-04-21T00:00:00.000Z"),
    ...overrides,
  };
}

function createPauseHold(overrides: Partial<IssueTreeHold> = {}): IssueTreeHold {
  const now = new Date("2026-04-21T00:00:00.000Z");
  return {
    id: "hold-1",
    companyId: "company-1",
    rootIssueId: "issue-1",
    mode: "pause",
    status: "active",
    reason: null,
    releasePolicy: { strategy: "manual", note: "full_pause" },
    createdByActorType: "user",
    createdByAgentId: null,
    createdByUserId: "user-1",
    createdByRunId: null,
    releasedAt: null,
    releasedByActorType: null,
    releasedByAgentId: null,
    releasedByUserId: null,
    releasedByRunId: null,
    releaseReason: null,
    releaseMetadata: null,
    createdAt: now,
    updatedAt: now,
    members: [
      {
        id: "hold-member-root",
        companyId: "company-1",
        holdId: "hold-1",
        issueId: "issue-1",
        parentIssueId: null,
        depth: 0,
        issueIdentifier: "PAP-1",
        issueTitle: "Issue detail smoke",
        issueStatus: "todo",
        assigneeAgentId: null,
        assigneeUserId: null,
        activeRunId: null,
        activeRunStatus: null,
        skipped: false,
        skipReason: null,
        createdAt: now,
      },
      {
        id: "hold-member-child",
        companyId: "company-1",
        holdId: "hold-1",
        issueId: "child-1",
        parentIssueId: "issue-1",
        depth: 1,
        issueIdentifier: "PAP-2",
        issueTitle: "Held child",
        issueStatus: "todo",
        assigneeAgentId: null,
        assigneeUserId: null,
        activeRunId: null,
        activeRunStatus: null,
        skipped: false,
        skipReason: null,
        createdAt: now,
      },
    ],
    ...overrides,
  };
}

function createResumePreview(): IssueTreeControlPreview {
  return {
    companyId: "company-1",
    rootIssueId: "issue-1",
    mode: "resume",
    generatedAt: new Date("2026-04-21T00:00:00.000Z"),
    releasePolicy: { strategy: "manual" },
    totals: {
      totalIssues: 2,
      affectedIssues: 2,
      skippedIssues: 0,
      activeRuns: 0,
      queuedRuns: 0,
      affectedAgents: 1,
    },
    countsByStatus: { todo: 2 },
    issues: [
      {
        id: "issue-1",
        identifier: "PAP-1",
        title: "Issue detail smoke",
        status: "todo",
        parentId: null,
        depth: 0,
        assigneeAgentId: "agent-1",
        assigneeUserId: null,
        activeRun: null,
        activeHoldIds: ["hold-1"],
        action: "resume",
        skipped: false,
        skipReason: null,
      },
      {
        id: "child-1",
        identifier: "PAP-2",
        title: "Held child",
        status: "todo",
        parentId: "issue-1",
        depth: 1,
        assigneeAgentId: "agent-1",
        assigneeUserId: null,
        activeRun: null,
        activeHoldIds: ["hold-1"],
        action: "resume",
        skipped: false,
        skipReason: null,
      },
    ],
    skippedIssues: [],
    activeRuns: [],
    affectedAgents: [{ agentId: "agent-1", issueCount: 2, activeRunCount: 0 }],
    warnings: [],
  };
}

function createPausePreview(): IssueTreeControlPreview {
  return {
    companyId: "company-1",
    rootIssueId: "issue-1",
    mode: "pause",
    generatedAt: new Date("2026-04-21T00:00:00.000Z"),
    releasePolicy: { strategy: "manual" },
    totals: {
      totalIssues: 3,
      affectedIssues: 2,
      skippedIssues: 1,
      activeRuns: 1,
      queuedRuns: 0,
      affectedAgents: 0,
    },
    countsByStatus: { todo: 2 },
    issues: [
      {
        id: "issue-1",
        identifier: "PAP-1",
        title: "Issue detail smoke",
        status: "todo",
        parentId: null,
        depth: 0,
        assigneeAgentId: null,
        assigneeUserId: null,
        activeRun: null,
        activeHoldIds: [],
        action: "pause",
        skipped: false,
        skipReason: null,
      },
      {
        id: "child-1",
        identifier: "PAP-2",
        title: "Paused child",
        status: "in_review",
        parentId: "issue-1",
        depth: 1,
        assigneeAgentId: null,
        assigneeUserId: null,
        activeRun: null,
        activeHoldIds: [],
        action: "pause",
        skipped: false,
        skipReason: null,
      },
      {
        id: "child-2",
        identifier: "PAP-3",
        title: "Completed child",
        status: "done",
        parentId: "issue-1",
        depth: 1,
        assigneeAgentId: null,
        assigneeUserId: null,
        activeRun: null,
        activeHoldIds: [],
        action: "pause",
        skipped: true,
        skipReason: "terminal_status",
      },
    ],
    skippedIssues: [
      {
        id: "child-2",
        identifier: "PAP-3",
        title: "Completed child",
        status: "done",
        parentId: "issue-1",
        depth: 1,
        assigneeAgentId: null,
        assigneeUserId: null,
        activeRun: null,
        activeHoldIds: [],
        action: "pause",
        skipped: true,
        skipReason: "terminal_status",
      },
    ],
    activeRuns: [],
    affectedAgents: [],
    warnings: [],
  };
}

function createRestorePreview(): IssueTreeControlPreview {
  return {
    companyId: "company-1",
    rootIssueId: "issue-1",
    mode: "restore",
    generatedAt: new Date("2026-04-21T00:00:00.000Z"),
    releasePolicy: { strategy: "manual" },
    totals: {
      totalIssues: 2,
      affectedIssues: 1,
      skippedIssues: 1,
      activeRuns: 0,
      queuedRuns: 0,
      affectedAgents: 1,
    },
    countsByStatus: { todo: 1, cancelled: 1 },
    issues: [
      {
        id: "issue-1",
        identifier: "PAP-1",
        title: "Issue detail smoke",
        status: "todo",
        parentId: null,
        depth: 0,
        assigneeAgentId: null,
        assigneeUserId: null,
        activeRun: null,
        activeHoldIds: [],
        action: "restore",
        skipped: true,
        skipReason: "not_cancelled",
      },
      {
        id: "child-1",
        identifier: "PAP-2",
        title: "Cancelled child",
        status: "cancelled",
        parentId: "issue-1",
        depth: 1,
        assigneeAgentId: "agent-1",
        assigneeUserId: null,
        activeRun: null,
        activeHoldIds: ["cancel-hold-1"],
        action: "restore",
        skipped: false,
        skipReason: null,
      },
    ],
    skippedIssues: [
      {
        id: "issue-1",
        identifier: "PAP-1",
        title: "Issue detail smoke",
        status: "todo",
        parentId: null,
        depth: 0,
        assigneeAgentId: null,
        assigneeUserId: null,
        activeRun: null,
        activeHoldIds: [],
        action: "restore",
        skipped: true,
        skipReason: "not_cancelled",
      },
    ],
    activeRuns: [],
    affectedAgents: [{ agentId: "agent-1", issueCount: 1, activeRunCount: 0 }],
    warnings: [],
  };
}

function createCancelPreview(issueCount = 8): IssueTreeControlPreview {
  const issues = Array.from({ length: issueCount }, (_, index) => ({
    id: index === 0 ? "issue-1" : `child-${index}`,
    identifier: index === 0 ? "PAP-1" : `PAP-${index + 1}`,
    title: index === 0 ? "Issue detail smoke" : `Cancellable child ${index}`,
    status: "todo" as const,
    parentId: index === 0 ? null : "issue-1",
    depth: index === 0 ? 0 : 1,
    assigneeAgentId: null,
    assigneeUserId: null,
    activeRun: null,
    activeHoldIds: [],
    action: "cancel" as const,
    skipped: false,
    skipReason: null,
  }));

  return {
    companyId: "company-1",
    rootIssueId: "issue-1",
    mode: "cancel",
    generatedAt: new Date("2026-04-21T00:00:00.000Z"),
    releasePolicy: { strategy: "manual" },
    totals: {
      totalIssues: issueCount,
      affectedIssues: issueCount,
      skippedIssues: 0,
      activeRuns: 0,
      queuedRuns: 0,
      affectedAgents: 0,
    },
    countsByStatus: { todo: issueCount },
    issues,
    skippedIssues: [],
    activeRuns: [],
    affectedAgents: [],
    warnings: [],
  };
}

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
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
      await flushReact();
    }
  }
  throw lastError;
}

describe("IssueDetail", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(window, "scrollTo").mockImplementation(() => {});

    mockIssuesApi.list.mockResolvedValue([]);
    mockIssuesApi.listComments.mockResolvedValue([]);
    mockIssuesApi.listAttachments.mockResolvedValue([]);
    mockIssuesApi.listFeedbackVotes.mockResolvedValue([]);
    mockIssuesApi.markRead.mockResolvedValue({ id: "issue-1", lastReadAt: new Date().toISOString() });
    mockIssuesApi.getTreeControlState.mockResolvedValue({ activePauseHold: null });
    mockIssuesApi.listTreeHolds.mockResolvedValue([]);
    mockActivityApi.forIssue.mockResolvedValue([]);
    mockActivityApi.runsForIssue.mockResolvedValue([]);
    mockHeartbeatsApi.liveRunsForIssue.mockResolvedValue([]);
    mockHeartbeatsApi.activeRunForIssue.mockResolvedValue(null);
    mockAgentsApi.list.mockResolvedValue([]);
    mockAccessApi.getCurrentBoardAccess.mockResolvedValue({
      companyIds: ["company-1"],
      isInstanceAdmin: true,
      source: "session",
      keyId: null,
      user: null,
      userId: null,
    });
    mockAccessApi.listUserDirectory.mockResolvedValue({ users: [] });
    mockAuthApi.getSession.mockResolvedValue({ session: null, user: null });
    mockProjectsApi.list.mockResolvedValue([]);
    mockInstanceSettingsApi.getGeneral.mockResolvedValue({
      keyboardShortcuts: false,
      feedbackDataSharingPreference: "prompt",
    });
    mockIssuesListRender.mockClear();
    mockIssueChatThreadRender.mockClear();
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    queryClient.clear();
    container.remove();
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("loads from the pending state into issue detail without changing hook order", async () => {
    const issueRequest = createDeferred<Issue>();
    mockIssuesApi.get.mockReturnValueOnce(issueRequest.promise);

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <IssueDetail />
        </QueryClientProvider>,
      );
    });

    issueRequest.resolve(createIssue());
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("Issue detail smoke");
    expect(container.textContent).toContain("Chat thread");
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it("passes blocker attention to the issue detail header status icon", async () => {
    mockIssuesApi.get.mockResolvedValue(createIssue({
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
    }));

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <IssueDetail />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    expect(container.querySelector('[data-status-icon-state="covered"]')?.textContent).toBe("blocked");
  });

  it("refreshes subtree pause state after resuming a hold", async () => {
    const childIssue = createIssue({
      id: "child-1",
      parentId: "issue-1",
      identifier: "PAP-2",
      issueNumber: 2,
      title: "Held child",
    });
    const activeHold = createPauseHold();
    const releasedHold = createPauseHold({
      status: "released",
      releasedAt: new Date("2026-04-21T00:01:00.000Z"),
      releasedByActorType: "user",
      releasedByUserId: "user-1",
      releaseReason: "Ready to continue",
      updatedAt: new Date("2026-04-21T00:01:00.000Z"),
    });
    let activePauseHoldState: null | {
      holdId: string;
      rootIssueId: string;
      issueId: string;
      isRoot: boolean;
      mode: "pause";
      reason: string | null;
      releasePolicy: { strategy: "manual" | "after_active_runs_finish"; note?: string | null } | null;
    } = {
      holdId: "hold-1",
      rootIssueId: "issue-1",
      issueId: "issue-1",
      isRoot: true,
      mode: "pause",
      reason: null,
      releasePolicy: { strategy: "manual", note: "full_pause" },
    };

    mockIssuesApi.get.mockResolvedValue(createIssue());
    mockIssuesApi.list.mockImplementation((_companyId, filters?: { descendantOf?: string }) =>
      Promise.resolve(filters?.descendantOf === "issue-1" ? [childIssue] : []),
    );
    mockIssuesApi.getTreeControlState.mockImplementation(() =>
      Promise.resolve({ activePauseHold: activePauseHoldState }),
    );
    mockIssuesApi.listTreeHolds.mockResolvedValue([activeHold]);
    mockIssuesApi.previewTreeControl.mockResolvedValue(createResumePreview());
    mockAgentsApi.list.mockResolvedValue([createAgent()]);
    mockIssuesApi.releaseTreeHold.mockImplementation(() => {
      activePauseHoldState = null;
      return Promise.resolve(releasedHold);
    });
    mockAuthApi.getSession.mockResolvedValue({
      session: { userId: "user-1" },
      user: { id: "user-1" },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <IssueDetail />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Subtree pause is active.");
      expect(mockIssuesListRender.mock.calls.at(-1)?.[0].issueBadgeById.get("child-1")).toBe("Paused");
      expect(mockIssuesListRender.mock.calls.at(-1)?.[0].showProgressSummary).toBe(true);
    });

    const resumeButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.trim() === "Resume subtree");
    expect(resumeButton).toBeTruthy();

    await act(async () => {
      resumeButton!.click();
    });
    await flushReact();

    const applyResumeButton = Array.from(container.querySelectorAll("button"))
      .filter((button) => button.textContent?.trim() === "Resume subtree")
      .at(-1);
    expect(applyResumeButton).toBeTruthy();
    expect(container.textContent).toContain("CodexCoder");

    await act(async () => {
      applyResumeButton!.click();
    });
    await flushReact();
    await flushReact();

    expect(mockIssuesApi.releaseTreeHold).toHaveBeenCalledWith("PAP-1", "hold-1", {
      reason: null,
      metadata: { wakeAgents: true },
    });
    expect(mockIssuesApi.getTreeControlState.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(mockPushToast).toHaveBeenCalledWith(expect.objectContaining({
      title: "Subtree resumed",
      body: "Ready to continue",
    }));
    await waitForAssertion(() => {
      expect(container.textContent).not.toContain("Subtree pause is active.");
      expect(mockIssuesListRender.mock.calls.at(-1)?.[0].issueBadgeById.has("child-1")).toBe(false);
    });
  });

  it("uses simplified full-subtree pause controls", async () => {
    const childIssue = createIssue({
      id: "child-1",
      parentId: "issue-1",
      identifier: "PAP-2",
      issueNumber: 2,
      title: "Paused child",
    });
    const pausePreview = createPausePreview();
    const pauseHold = createPauseHold({
      id: "pause-hold-1",
      mode: "pause",
      reason: null,
      releasePolicy: { strategy: "manual", note: "full_pause" },
      members: [],
    });

    mockIssuesApi.get.mockResolvedValue(createIssue());
    mockIssuesApi.list.mockImplementation((_companyId, filters?: { descendantOf?: string }) =>
      Promise.resolve(filters?.descendantOf === "issue-1" ? [childIssue] : []),
    );
    mockIssuesApi.previewTreeControl.mockResolvedValue(pausePreview);
    mockIssuesApi.createTreeHold.mockResolvedValue({ hold: pauseHold, preview: pausePreview });
    mockAuthApi.getSession.mockResolvedValue({
      session: { userId: "user-1" },
      user: { id: "user-1" },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <IssueDetail />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    const moreButton = container.querySelector('button[aria-label="More issue actions"]') as HTMLButtonElement | null;
    expect(moreButton).toBeTruthy();

    await act(async () => {
      moreButton!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await flushReact();

    const pauseMenuButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.trim() === "Pause subtree...");
    expect(pauseMenuButton).toBeTruthy();

    await act(async () => {
      pauseMenuButton!.click();
    });
    await flushReact();
    await flushReact();

    expect(mockIssuesApi.previewTreeControl).toHaveBeenCalledWith("PAP-1", {
      mode: "pause",
      releasePolicy: { strategy: "manual" },
    });
    expect(container.textContent).not.toContain("Pause mode");
    expect(container.textContent).not.toContain("Release policy");
    expect(container.textContent).not.toContain("Status breakdown");
    expect(container.textContent).not.toContain("Active runs cancelled");
    expect(container.textContent).toContain("Paused child");
    expect(container.textContent).toContain("Completed child");
    expect(container.textContent).toContain("Complete");

    const pauseApplyButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.trim() === "Pause and stop work");
    expect(pauseApplyButton).toBeTruthy();

    await act(async () => {
      pauseApplyButton!.click();
    });
    await flushReact();

    expect(mockIssuesApi.createTreeHold).toHaveBeenCalledWith("PAP-1", {
      mode: "pause",
      reason: null,
      releasePolicy: { strategy: "manual", note: "full_pause" },
    });
  });

  it("exposes leaf pause controls and routes issue active-run stop through Pause work", async () => {
    const pausePreview = createPausePreview();
    pausePreview.totals = {
      ...pausePreview.totals,
      totalIssues: 1,
      affectedIssues: 1,
      skippedIssues: 0,
      activeRuns: 1,
    };
    pausePreview.issues = [pausePreview.issues[0]!];
    pausePreview.skippedIssues = [];
    const pauseHold = createPauseHold({
      id: "leaf-pause-hold-1",
      mode: "pause",
      reason: "Paused from active run controls.",
      releasePolicy: { strategy: "manual", note: "leaf_pause" },
      members: [],
    });

    mockIssuesApi.get.mockResolvedValue(createIssue({
      status: "in_progress",
      assigneeAgentId: "agent-1",
      executionRunId: "run-active-1",
    }));
    mockIssuesApi.previewTreeControl.mockResolvedValue(pausePreview);
    mockIssuesApi.createTreeHold.mockResolvedValue({ hold: pauseHold, preview: pausePreview });
    mockAgentsApi.list.mockResolvedValue([createAgent()]);
    mockAuthApi.getSession.mockResolvedValue({
      session: { userId: "user-1" },
      user: { id: "user-1" },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <IssueDetail />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    expect(mockIssueChatThreadRender.mock.calls.at(-1)?.[0]).toMatchObject({
      stopRunLabel: "Pause work",
      stoppingRunLabel: "Pausing...",
      issueWorkMode: "standard",
    });

    const chatPauseButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.trim() === "Pause work");
    expect(chatPauseButton).toBeTruthy();

    await act(async () => {
      chatPauseButton!.click();
    });
    await flushReact();

    expect(mockIssuesApi.createTreeHold).toHaveBeenCalledWith("PAP-1", {
      mode: "pause",
      reason: "Paused from active run controls.",
      releasePolicy: { strategy: "manual", note: "leaf_pause" },
      metadata: { source: "issue_active_run_control", runId: "run-active-1" },
    });

    const moreButton = container.querySelector('button[aria-label="More issue actions"]') as HTMLButtonElement | null;
    expect(moreButton).toBeTruthy();
    await act(async () => {
      moreButton!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await flushReact();

    const pauseMenuButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.trim() === "Pause work...");
    expect(pauseMenuButton).toBeTruthy();
  });

  it("passes planning work mode to the issue chat thread", async () => {
    mockIssuesApi.get.mockResolvedValue(createIssue({ workMode: "planning" }));
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <IssueDetail />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    expect(mockIssueChatThreadRender.mock.calls.at(-1)?.[0]).toMatchObject({
      issueWorkMode: "planning",
    });
    expect(container.textContent).toContain("Planning");
  });

  it("forwards composer work mode changes to the issues API", async () => {
    const issue = createIssue();
    mockIssuesApi.get.mockResolvedValue(issue);
    mockIssuesApi.listAttachments.mockResolvedValue([
      {
        id: "attachment-1",
        issueId: issue.id,
        issueCommentId: null,
        originalFilename: "planning-notes.txt",
        contentPath: "/attachments/planning-notes.txt",
        contentType: "text/plain",
        byteSize: 4096,
        uploadedByUserId: null,
        uploadedAt: new Date("2026-04-21T00:02:00.000Z"),
      },
    ]);
    localStorage.setItem("paperclip:issue-comment-draft:issue-1", "Draft follow-up message");
    mockIssuesApi.update.mockResolvedValue(createIssue({ workMode: "planning" }));

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <IssueDetail />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    const lastChatThreadProps = mockIssueChatThreadRender.mock.calls.at(-1)?.[0];
    expect(lastChatThreadProps?.issueWorkMode).toBe("standard");
    expect(typeof lastChatThreadProps?.onWorkModeChange).toBe("function");

    await act(async () => {
      lastChatThreadProps?.onWorkModeChange?.("planning");
    });
    await flushReact();

    expect(mockIssuesApi.update).toHaveBeenCalledWith(issue.identifier, { workMode: "planning" });
    expect(localStorage.getItem("paperclip:issue-comment-draft:issue-1")).toBe("Draft follow-up message");
    expect(container.textContent).toContain("planning-notes.txt");
    localStorage.removeItem("paperclip:issue-comment-draft:issue-1");
  });

  it("renders Paused by board distinctly and defaults leaf resume to wake the assignee", async () => {
    const activeHold = createPauseHold();
    const releasedHold = createPauseHold({
      status: "released",
      releasedAt: new Date("2026-04-21T00:01:00.000Z"),
      releasedByActorType: "user",
      releasedByUserId: "user-1",
      releaseReason: "Ready to continue",
      updatedAt: new Date("2026-04-21T00:01:00.000Z"),
    });

    mockIssuesApi.get.mockResolvedValue(createIssue({
      status: "in_review",
      assigneeAgentId: "agent-1",
    }));
    mockIssuesApi.getTreeControlState.mockResolvedValue({
      activePauseHold: {
        holdId: "hold-1",
        rootIssueId: "issue-1",
        issueId: "issue-1",
        isRoot: true,
        mode: "pause",
        reason: null,
        releasePolicy: { strategy: "manual", note: "leaf_pause" },
      },
    });
    mockIssuesApi.listTreeHolds.mockResolvedValue([activeHold]);
    mockIssuesApi.previewTreeControl.mockResolvedValue(createResumePreview());
    mockIssuesApi.releaseTreeHold.mockResolvedValue(releasedHold);
    mockAgentsApi.list.mockResolvedValue([createAgent()]);
    mockAuthApi.getSession.mockResolvedValue({
      session: { userId: "user-1" },
      user: { id: "user-1" },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <IssueDetail />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Paused by board.");
      expect(container.textContent).toContain("in_review");
      expect(container.textContent).not.toContain("Subtree pause is active.");
    });

    const resumeButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.trim() === "Resume work");
    expect(resumeButton).toBeTruthy();

    await act(async () => {
      resumeButton!.click();
    });
    await flushReact();
    await flushReact();

    const wakeCheckbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
    expect(wakeCheckbox?.checked).toBe(true);

    const applyResumeButton = Array.from(container.querySelectorAll("button"))
      .filter((button) => button.textContent?.trim() === "Resume work")
      .at(-1);
    expect(applyResumeButton).toBeTruthy();

    await act(async () => {
      applyResumeButton!.click();
    });
    await flushReact();

    expect(mockIssuesApi.releaseTreeHold).toHaveBeenCalledWith("PAP-1", "hold-1", {
      reason: null,
      metadata: { wakeAgents: true },
    });
  });

  it("exposes restore subtree from the issue actions menu", async () => {
    const childIssue = createIssue({
      id: "child-1",
      parentId: "issue-1",
      identifier: "PAP-2",
      issueNumber: 2,
      title: "Cancelled child",
      status: "cancelled",
      assigneeAgentId: "agent-1",
    });
    const cancelHold = createPauseHold({
      id: "cancel-hold-1",
      mode: "cancel",
      reason: "bad plan",
      members: [],
    });
    const restorePreview = createRestorePreview();
    const restoreHold = createPauseHold({
      id: "restore-hold-1",
      mode: "restore",
      status: "released",
      reason: null,
      releaseReason: "Restore operation applied",
      releasedAt: new Date("2026-04-21T00:02:00.000Z"),
      members: [],
    });

    mockIssuesApi.get.mockResolvedValue(createIssue());
    mockIssuesApi.list.mockImplementation((_companyId, filters?: { descendantOf?: string }) =>
      Promise.resolve(filters?.descendantOf === "issue-1" ? [childIssue] : []),
    );
    mockIssuesApi.listTreeHolds.mockImplementation((_issueId, filters?: { mode?: string }) =>
      Promise.resolve(filters?.mode === "cancel" ? [cancelHold] : []),
    );
    mockIssuesApi.previewTreeControl.mockResolvedValue(restorePreview);
    mockIssuesApi.createTreeHold.mockResolvedValue({ hold: restoreHold, preview: restorePreview });
    mockAuthApi.getSession.mockResolvedValue({
      session: { userId: "user-1" },
      user: { id: "user-1" },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <IssueDetail />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    const moreButton = container.querySelector('button[aria-label="More issue actions"]') as HTMLButtonElement | null;
    expect(moreButton).toBeTruthy();

    await act(async () => {
      moreButton!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await flushReact();

    const restoreMenuButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.trim() === "Restore subtree...");
    expect(restoreMenuButton).toBeTruthy();

    await act(async () => {
      restoreMenuButton!.click();
    });
    await flushReact();
    await flushReact();

    expect(mockIssuesApi.previewTreeControl).toHaveBeenCalledWith("PAP-1", {
      mode: "restore",
      releasePolicy: { strategy: "manual" },
    });
    expect(container.textContent).toContain("Restore issues cancelled by this subtree operation so work can resume.");
    expect(container.textContent).toContain("Cancelled child");

    const restoreApplyButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.trim() === "Restore 1 issues");
    expect(restoreApplyButton).toBeTruthy();

    await act(async () => {
      restoreApplyButton!.click();
    });
    await flushReact();

    expect(mockIssuesApi.createTreeHold).toHaveBeenCalledWith("PAP-1", {
      mode: "restore",
      reason: null,
      releasePolicy: { strategy: "manual" },
      metadata: { wakeAgents: false },
    });
  });

  it("bounds the subtree control dialog with an internal scroll body", async () => {
    const childIssue = createIssue({
      id: "child-1",
      parentId: "issue-1",
      identifier: "PAP-2",
      issueNumber: 2,
      title: "Cancellable child",
    });

    mockIssuesApi.get.mockResolvedValue(createIssue());
    mockIssuesApi.list.mockImplementation((_companyId, filters?: { descendantOf?: string }) =>
      Promise.resolve(filters?.descendantOf === "issue-1" ? [childIssue] : []),
    );
    mockIssuesApi.previewTreeControl.mockResolvedValue(createCancelPreview(24));
    mockAuthApi.getSession.mockResolvedValue({
      session: { userId: "user-1" },
      user: { id: "user-1" },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <IssueDetail />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    const cancelMenuButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.trim() === "Cancel subtree...");
    expect(cancelMenuButton).toBeTruthy();

    await act(async () => {
      cancelMenuButton!.click();
    });
    await flushReact();
    await flushReact();

    expect(mockIssuesApi.previewTreeControl).toHaveBeenCalledWith("PAP-1", {
      mode: "cancel",
      releasePolicy: { strategy: "manual" },
    });

    const dialogContent = container.querySelector('[data-slot="dialog-content"]') as HTMLDivElement | null;
    expect(dialogContent).toBeTruthy();
    expect(dialogContent!.className).toContain("max-h-[calc(100dvh-2rem)]");
    expect(dialogContent!.className).toContain("overflow-hidden");
    expect(dialogContent!.className).toContain("flex-col");

    const bodyScrollRegion = Array.from(dialogContent!.querySelectorAll("div"))
      .find((element) =>
        typeof element.className === "string"
        && element.className.includes("overflow-y-auto")
        && element.textContent?.includes("Reason (optional)"),
      );
    expect(bodyScrollRegion?.className).toContain("min-h-0");
    expect(bodyScrollRegion?.className).toContain("overscroll-contain");

    const cancelApplyButton = Array.from(dialogContent!.querySelectorAll("button"))
      .find((button) => button.textContent?.trim() === "Cancel 24 issues") as HTMLButtonElement | undefined;
    expect(cancelApplyButton).toBeTruthy();
    expect(cancelApplyButton!.disabled).toBe(true);

    const confirmationCheckbox = dialogContent!.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
    expect(confirmationCheckbox).toBeTruthy();
    await act(async () => {
      confirmationCheckbox!.click();
    });
    await flushReact();
    expect(cancelApplyButton!.disabled).toBe(false);

    const footer = Array.from(dialogContent!.querySelectorAll("div"))
      .find((element) =>
        typeof element.className === "string"
        && element.className.includes("border-t")
        && element.textContent?.includes("Close"),
      );
    expect(footer?.className).toContain("bg-background");
  });
});
