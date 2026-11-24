import { TaskChatPausedTakeover, type TaskComposerPause } from "../components/task-chat/TaskChatPausedTakeover";
// @vitest-environment jsdom

import { LEGACY_WITHHELD_RUN_COMMENT } from "@/lib/run-answer-visibility";
import type { Breadcrumb } from "../context/BreadcrumbContext";

import { DispositionRecoveryNotice, type DispositionRecoverySnapshot } from "../components/DispositionRecoveryNotice";
import { RichWorkProductCard } from "../components/task-chat/RichWorkProductCard";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  Agent,
  Issue,
  IssueAttachment,
  IssueComment,
  IssueRecentComments,
  IssueQueuedCommentQueue,
  RequestConfirmationInteraction,
  IssueTreeControlPreview,
  IssueTreeHold,
  IssueWorkProduct,
  Project,
} from "@paperclipai/shared";
import { ONBOARDING_FIRST_TASK_ORIGIN_KIND } from "@paperclipai/shared";
import type {
  AnchorHTMLAttributes,
  ButtonHTMLAttributes,
  ReactElement,
  ReactNode,
} from "react";
import { NavigationType } from "react-router-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  canBoardManageRuntime,
  canBoardResolveRecoveryAction,
  IssueDetail,
  TaskDetailSurface,
  readRecoveryReconcileWorkspaceId,
  shouldScrollIssueDetailToTopOnNavigation,
} from "./IssueDetail";
import { queryKeys } from "../lib/queryKeys";
import { loadDraft, saveDraft, loadDraftSubmission, saveDraftSubmission } from "../lib/composer-draft";
import { TaskCancellationProvider } from "../context/TaskCancellationContext";
import { prefetchIssueDetailForNavigation } from "../lib/issueDetailCache";
import { markCachedSession } from "../lib/cached-session";
import { startPersistedQueryCache } from "../lib/persisted-query-cache";
import { clearLocalInboxArchive, filterLocalInboxArchivedIssues, getLocalInboxArchiveIssueIds } from "../lib/inboxArchiveCache";
import { taskPluginPanelActivationKey } from "@/hooks/useTaskPluginPanels";
import {
  armIssueDetailInboxQuickArchive,
  createIssueDetailLocationState,
  readIssueDetailBreadcrumb,
  rememberIssueDetailLocationState,
} from "../lib/issueDetailBreadcrumb";
import { getRecentTasksStorageKey, readRecentTasks, recordRecentTask } from "../lib/recent-tasks";
import { getLastProjectId, trackRecentProject } from "../lib/recent-projects";
import { ApiError } from "../api/client";
import type { issuesApi } from "../api/issues";

// These page fixtures exercise Classic task behavior. Preference identity and
// persistence have their own hook tests; keep their readiness explicit here.
const coordinatorPreference = vi.hoisted(() => ({ enabled: false, loaded: true }));
const inlineEditorFixture = vi.hoisted(() => ({ real: false }));
// Reads deferred until the page settles start at once in these tests.
vi.mock("@/hooks/usePageSettled", () => ({ usePageSettled: () => true, PAGE_SETTLED_MAX_WAIT_MS: 0 }));
vi.mock("../hooks/useCoordinatorWorkspaceEnabled", () => ({
  useCoordinatorWorkspaceEnabled: () => coordinatorPreference,
}));

const mockGrokBotApi = vi.hoisted(() => ({ stop: vi.fn().mockResolvedValue({ stopped: true }) }));
vi.mock("../api/grokBot", () => ({ grokBotApi: mockGrokBotApi }));

const mockIssuesApi = vi.hoisted(() => ({
  get: vi.fn(),
  getCore: vi.fn(),
  getComment: vi.fn(),
  recentComments: vi.fn(),
  list: vi.fn(),
  listAll: vi.fn(),
  listAcceptedPlanDecompositions: vi.fn(),
  listComments: vi.fn(),
  listAttachments: vi.fn(),
  listWorkProducts: vi.fn(),
  checkMonitorNow: vi.fn(),
  listFeedbackVotes: vi.fn(),
  listInteractions: vi.fn(),
  getQueuedComments: vi.fn(),
  interruptQueuedComments: vi.fn(),
  editQueuedComment: vi.fn(),
  reorderQueuedComments: vi.fn(),
  steerQueuedComment: vi.fn(),
  discardQueuedComment: vi.fn(),
  markRead: vi.fn(),
  update: vi.fn(),
  resolveRecoveryAction: vi.fn(),
  recoveryActions: vi.fn(),
  recoverWorkspace: vi.fn(),
  retryTask: vi.fn(),
  previewTreeControl: vi.fn(),
  getTreeControlState: vi.fn(),
  listTreeHolds: vi.fn(),
  createTreeHold: vi.fn(),
  releaseTreeHold: vi.fn(),
  archiveFromInbox: vi.fn(),
  unarchiveFromInbox: vi.fn(),
  addComment: vi.fn(),
  cancelComment: vi.fn(),
  deleteComment: vi.fn(),
  upsertFeedbackVote: vi.fn(),
  uploadAttachment: vi.fn(),
  deleteAttachment: vi.fn(),
  upsertDocument: vi.fn(),
  getDocument: vi.fn(),
  acceptInteraction: vi.fn(),
  rejectInteraction: vi.fn(),
}));

const mockActivityApi = vi.hoisted(() => ({
  forIssue: vi.fn(),
  recentForIssue: vi.fn(),
  inputFactsForIssue: vi.fn(),
  runsForIssue: vi.fn(),
  runsByIdsForIssue: vi.fn(),
  recentRunsForIssue: vi.fn(),
}));

const mockHeartbeatsApi = vi.hoisted(() => ({
  get: vi.fn(),
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

const mockDecisionsApi = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
}));

const mockInstanceSettingsApi = vi.hoisted(() => ({
  getGeneral: vi.fn(),
  getExperimental: vi.fn(),
}));

const mockNavigate = vi.hoisted(() => vi.fn());
const mockLocation = vi.hoisted(() => ({
  key: "task-entry",
  pathname: "/issues/PAP-1",
  search: "",
  hash: "",
  state: null as unknown,
}));
const mockOpenPanel = vi.hoisted(() => vi.fn());
const mockClosePanel = vi.hoisted(() => vi.fn());
const mockSetPanelVisible = vi.hoisted(() => vi.fn());
const mockRequestPanelMaximize = vi.hoisted(() => vi.fn());
const mockClearPanelMaximizeRequest = vi.hoisted(() => vi.fn());
const mockPanelState = vi.hoisted(() => ({ panelVisible: true }));
const mockRouteParams = vi.hoisted(() => ({
  issueId: "PAP-1",
  companyPrefix: "PAP",
}));
const mockSidebarState = vi.hoisted(() => ({ isMobile: false }));
const mockIssuePropertiesRender = vi.hoisted(() => vi.fn());
const mockTaskSidePanelRender = vi.hoisted(() => vi.fn());
const mockTaskPluginPanels = vi.hoisted(() => ({ panels: [] as import("@/hooks/useTaskPluginPanels").TaskPluginPanel[], isLoading: false }));
vi.mock("@/hooks/useTaskPluginPanels", async importOriginal => ({
  ...await importOriginal<typeof import("@/hooks/useTaskPluginPanels")>(),
  useTaskPluginPanels: () => mockTaskPluginPanels,
}));
const mockSetBreadcrumbs = vi.hoisted(() => vi.fn());
const mockSetBreadcrumbToolbar = vi.hoisted(() => vi.fn());
const mockSetBreadcrumbPanelControl = vi.hoisted(() => vi.fn());
const mockSetMobileToolbar = vi.hoisted(() => vi.fn());
const mockPushToast = vi.hoisted(() => vi.fn());
const mockIssuesListRender = vi.hoisted(() => vi.fn());
const mockIssueChatThreadRender = vi.hoisted(() => vi.fn());
const mockImageGalleryRender = vi.hoisted(() => vi.fn());
const mockIssueWorkspaceCardRender = vi.hoisted(() => vi.fn());
const DIRECT_ADAPTER_TYPES = [
  "codex_local",
  "claude_local",
  "opencode_local",
  "process",
  "http",
  "custom_plugin",
] as const;

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

(globalThis as any).ResizeObserver =
  (globalThis as any).ResizeObserver ?? ResizeObserverStub;

vi.mock("../api/issues", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/issues")>();
  // Keep composed API operations real while replacing their request methods.
  // This also exercises the current-revision check used by both queue surfaces.
  return { ...actual, issuesApi: Object.assign(actual.issuesApi, mockIssuesApi) };
});

vi.mock("../api/email", () => ({
  emailApi: { thread: vi.fn().mockResolvedValue(null) },
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

vi.mock("../api/decisions", () => ({
  decisionsApi: mockDecisionsApi,
}));

vi.mock("../api/instanceSettings", () => ({
  instanceSettingsApi: mockInstanceSettingsApi,
}));

vi.mock("@/lib/router", () => ({
  Link: ({
    children,
    to,
    state: _state,
    issuePrefetch: _issuePrefetch,
    issueQuicklookSide: _issueQuicklookSide,
    issueQuicklookAlign: _issueQuicklookAlign,
    ...props
  }: {
    children?: ReactNode;
    to: string;
    state?: unknown;
    issuePrefetch?: unknown;
    issueQuicklookSide?: unknown;
    issueQuicklookAlign?: unknown;
  } & AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
  useLocation: () => mockLocation,
  useNavigate: () => mockNavigate,
  useNavigationType: () => "PUSH",
  useParams: () => ({ ...mockRouteParams }),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    companies: [
      {
        id: "company-1",
        name: "Paperclip",
        issuePrefix: "PAP",
        status: "active",
      },
    ],
    selectedCompanyId: "company-1",
    selectedCompany: {
      id: "company-1",
      name: "Paperclip",
      issuePrefix: "PAP",
      status: "active",
    },
    selectionSource: "manual",
    loading: false,
    error: null,
    setSelectedCompanyId: vi.fn(),
    reloadCompanies: vi.fn(),
    createCompany: vi.fn(),
  }),
}));

const mockOpenNewIssue = vi.hoisted(() => vi.fn());
const mockOpenNewProject = vi.hoisted(() => vi.fn());
const mockOpenNewGoal = vi.hoisted(() => vi.fn());

vi.mock("../context/DialogContext", () => ({
  useDialog: () => ({
    openNewIssue: mockOpenNewIssue,
  }),
  useDialogActions: () => ({
    openNewIssue: mockOpenNewIssue,
    openNewProject: mockOpenNewProject,
    openNewGoal: mockOpenNewGoal,
  }),
}));

vi.mock("../context/PanelContext", () => ({
  usePanel: () => ({
    openPanel: mockOpenPanel,
    closePanel: mockClosePanel,
    panelVisible: mockPanelState.panelVisible,
    setPanelVisible: mockSetPanelVisible,
    requestPanelMaximize: mockRequestPanelMaximize,
    clearPanelMaximizeRequest: mockClearPanelMaximizeRequest,
  }),
}));

vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => mockSidebarState,
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({
    setBreadcrumbs: mockSetBreadcrumbs,
    setBreadcrumbToolbar: mockSetBreadcrumbToolbar,
    setBreadcrumbPanelControl: mockSetBreadcrumbPanelControl,
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

vi.mock("../components/InlineEditor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../components/InlineEditor")>();
  return {
    InlineEditor: (props: Parameters<typeof actual.InlineEditor>[0]) => inlineEditorFixture.real
      ? <actual.InlineEditor {...props} />
      : <div>{props.value || props.placeholder}</div>,
  };
});

vi.mock("../components/IssueChatThread", () => ({
  IssueChatThread: (props: {
    onWorkModeChange?: (workMode: string) => void;
    issueWorkMode?: string;
    comments?: Array<{
      body: string;
      clientStatus?: string;
      queueState?: string;
      queueTargetRunId?: string | null;
    }>;
    onAdd?: (body: string) => Promise<void>;
    onInterruptQueued?: (runId: string) => Promise<void>;
    onStopRun?: (runId: string) => Promise<void>;
    stopRunLabel?: string;
    stoppingRunLabel?: string;
    runFinalizationActions?: readonly {
      id: string;
      label: string;
      onSelect: (runId: string) => Promise<void> | void;
    }[];
    composerPause?: TaskComposerPause | null;
    footer?: ReactNode;
  }) => {
    mockIssueChatThreadRender(props);
    return (
      <div data-testid="issue-chat-thread">
        Chat thread
        {props.onStopRun ? (
          <button
            type="button"
            onClick={() => void props.onStopRun?.("run-active-1")}
          >
            {props.stopRunLabel ?? "Stop run"}
          </button>
        ) : null}
        {props.runFinalizationActions?.map((action) => (
          <button
            key={action.id}
            type="button"
            onClick={() => void action.onSelect("run-active-1")}
          >
            {action.label}
          </button>
        ))}
        {props.composerPause ? <TaskChatPausedTakeover {...props.composerPause} /> : null}
        {props.footer}
      </div>
    );
  },
}));

// The task chat thread pulls in the MarkdownEditor composer, whose @mdxeditor
// dependency cannot load under jsdom's CSSOM. The stub keeps the suite
// unit-scoped but still renders the threadHeader JSX (the issue header row
// lives inside the thread) so header controls stay testable, records its props
// on the shared thread-render spy, and exposes the same run-control buttons as
// the IssueChatThread stub above.
vi.mock("../components/TaskChatThread", () => ({
  TaskChatThread: (props: {
    comments?: Array<{ metadata?: { recovery?: DispositionRecoverySnapshot } | null }>;
    workProducts?: IssueWorkProduct[];
    threadHeader?: ReactNode;
    onStopRun?: (runId: string) => Promise<void>;
    stopRunLabel?: string;
    onTryAgainNoLiveExecutionPath?: () => Promise<void> | void;
    onRejectInteraction?: (
      interaction: RequestConfirmationInteraction,
      reason?: string,
    ) => Promise<void>;
    runFinalizationActions?: readonly {
      id: string;
      label: string;
      onSelect: (runId: string) => Promise<void> | void;
    }[];
    composerPause?: TaskComposerPause | null;
    footer?: ReactNode;
  }) => {
    mockIssueChatThreadRender(props);
    return (
      <div data-testid="task-chat-thread">
        {props.threadHeader}
        Task chat thread
        {props.comments?.map((comment, index) => comment.metadata?.recovery ? <DispositionRecoveryNotice key={index} snapshot={comment.metadata.recovery} /> : null)}
        {props.workProducts?.map((workProduct) => (
          <RichWorkProductCard
            key={workProduct.id}
            workProduct={workProduct}
            href={workProduct.url}
          />
        ))}
        {props.onStopRun ? (
          <button
            type="button"
            onClick={() => void props.onStopRun?.("run-active-1")}
          >
            {props.stopRunLabel ?? "Stop run"}
          </button>
        ) : null}
        {props.onTryAgainNoLiveExecutionPath ? (
          <button
            type="button"
            data-testid="mock-no-live-path-try-again"
            onClick={() => void props.onTryAgainNoLiveExecutionPath?.()}
          >
            Try again
          </button>
        ) : null}
        {props.runFinalizationActions?.map((action) => (
          <button
            key={action.id}
            type="button"
            onClick={() => void action.onSelect("run-active-1")}
          >
            {action.label}
          </button>
        ))}
        {props.composerPause ? <TaskChatPausedTakeover {...props.composerPause} /> : null}
        {props.footer}
      </div>
    );
  },
}));

vi.mock("../components/IssueDocumentsSection", () => ({
  IssueDocumentsSection: () => <div>Documents</div>,
}));

vi.mock("../components/MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock("../components/IssuesList", () => ({
  IssuesList: (props: { issueBadgeById?: Map<string, string> }) => {
    mockIssuesListRender(props);
    return (
      <div>
        Sub-issues
        {Array.from(props.issueBadgeById?.entries() ?? []).map(
          ([issueId, label]) => (
            <span key={issueId}>
              {issueId}:{label}
            </span>
          ),
        )}
      </div>
    );
  },
}));

vi.mock("../components/IssueProperties", () => ({
  IssueProperties: (props: unknown) => {
    mockIssuePropertiesRender(props);
    return <div>Properties</div>;
  },
}));

vi.mock("../components/task-side-panel", () => ({
  TaskSidePanel: (props: unknown) => {
    mockTaskSidePanelRender(props);
    return <div>Task side panel</div>;
  },
}));

vi.mock("../components/IssueRunLedger", () => ({
  IssueRunLedger: () => <div>Runs</div>,
}));

vi.mock("../components/IssueWorkspaceCard", () => ({
  IssueWorkspaceCard: (props: {
    onBrowseFiles?: () => void;
    onOpenFileByPath?: () => void;
  }) => {
    mockIssueWorkspaceCardRender(props);
    return <div>Workspace</div>;
  },
}));

vi.mock("../components/ImageGalleryModal", () => ({
  ImageGalleryModal: (props: {
    items: IssueAttachment[];
    initialIndex: number;
    open: boolean;
  }) => {
    mockImageGalleryRender(props);
    return null;
  },
}));

vi.mock("../components/ScrollToBottom", () => ({
  ScrollToBottom: () => null,
}));

vi.mock("../components/StatusIcon", () => ({
  StatusIcon: ({
    status,
    blockerAttention,
    onChange,
  }: {
    status: string;
    blockerAttention?: Issue["blockerAttention"];
    onChange?: (status: string) => void;
  }) =>
    onChange ? (
      <button
        type="button"
        aria-label={`Change status (current: ${status})`}
        data-status-icon-state={blockerAttention?.state}
        onClick={() => onChange("done")}
      >
        {status}
      </button>
    ) : (
      <span data-status-icon-state={blockerAttention?.state}>{status}</span>
    ),
}));

vi.mock("../components/PriorityIcon", () => ({
  PriorityIcon: ({
    priority,
    onChange,
  }: {
    priority: string;
    onChange?: (priority: string) => void;
  }) =>
    onChange ? (
      <button
        type="button"
        aria-label={`Change priority (current: ${priority})`}
        onClick={() => onChange("high")}
      >
        {priority}
      </button>
    ) : (
      <span>{priority}</span>
    ),
}));

vi.mock("../components/ApprovalCard", () => ({
  ApprovalCard: () => <div>Approval</div>,
}));

vi.mock("../components/Identity", () => ({
  deriveInitials: (name: string) => name.slice(0, 2),
  Identity: ({ name, shape }: { name: string; shape?: string }) => (
    <span data-shape={shape ?? "circle"}>{name}</span>
  ),
}));

vi.mock("@/components/ui/button", () => ({
  buttonVariants: () => "",
  Button: ({
    children,
    disabled,
    onClick,
    type = "button",
    variant: _variant,
    size: _size,
    asChild: _asChild,
    ...props
  }: ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: string;
    size?: string;
    asChild?: boolean;
  }) => (
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
  PopoverContent: ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children, open }: { children?: ReactNode; open?: boolean }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({
    children,
    className,
  }: {
    children?: ReactNode;
    className?: string;
  }) => (
    <div data-slot="dialog-content" className={className}>
      {children}
    </div>
  ),
  DialogDescription: ({
    children,
    className,
  }: {
    children?: ReactNode;
    className?: string;
  }) => <p className={className}>{children}</p>,
  DialogFooter: ({
    children,
    className,
  }: {
    children?: ReactNode;
    className?: string;
  }) => <div className={className}>{children}</div>,
  DialogHeader: ({
    children,
    className,
  }: {
    children?: ReactNode;
    className?: string;
  }) => <div className={className}>{children}</div>,
  DialogTitle: ({
    children,
    className,
  }: {
    children?: ReactNode;
    className?: string;
  }) => <h2 className={className}>{children}</h2>,
}));

vi.mock("@/components/ui/sheet", () => ({
  Sheet: ({ children, open }: { children?: ReactNode; open?: boolean }) =>
    open ? <div>{children}</div> : null,
  SheetContent: ({
    children,
    className,
    "data-testid": testId,
  }: {
    children?: ReactNode;
    className?: string;
    "data-testid"?: string;
  }) => (
    <div data-slot="sheet-content" className={className} data-testid={testId}>
      {children}
      <button type="button" data-slot="sheet-close">
        Close
      </button>
    </div>
  ),
  SheetHeader: ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  ),
  SheetDescription: ({ children }: { children?: ReactNode }) => (
    <p>{children}</p>
  ),
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
  TabsContent: ({
    children,
    className,
    "data-testid": testId,
  }: {
    children?: ReactNode;
    className?: string;
    "data-testid"?: string;
  }) => (
    <div className={className} data-testid={testId}>
      {children}
    </div>
  ),
  TabsList: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  TabsTrigger: ({ children }: { children?: ReactNode }) => (
    <button type="button">{children}</button>
  ),
}));

vi.mock("@/components/ui/textarea", () => ({
  Textarea: (props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) => (
    <textarea {...props} />
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

function createTooltipRoot(container: Element): Root {
  const root = createRoot(container);
  return {
    render(children) {
      root.render(<TooltipProvider>{children}</TooltipProvider>);
    },
    unmount() {
      root.unmount();
    },
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
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

function createIssueComment(
  overrides: Partial<IssueComment> = {},
): IssueComment {
  return {
    id: "comment-1",
    companyId: "company-1",
    issueId: "issue-1",
    authorType: "user",
    authorAgentId: null,
    authorUserId: "user-1",
    body: "Fresh comment",
    presentation: null,
    metadata: null,
    createdAt: new Date("2026-04-21T00:00:05.000Z"),
    updatedAt: new Date("2026-04-21T00:00:05.000Z"),
    ...overrides,
  };
}

function createQueuedCommentQueue(
  overrides: Partial<IssueQueuedCommentQueue> = {},
): IssueQueuedCommentQueue {
  const comment = createIssueComment({
    id: "queued-comment-1",
    body: "Queued through the handoff",
  });
  return {
    issueId: "issue-1",
    queueId: "wake-queue-1",
    state: "deferred",
    targetRunId: "run-active-1",
    revision: "queue-revision-1",
    protocol: "paperclip_runner_v1",
    steeringDisposition: "available",
    entries: [{ comment, position: 0, canEdit: true, canDiscard: true }],
    ...overrides,
  };
}

function createAttachment(
  overrides: Partial<IssueAttachment> & { id: string },
): IssueAttachment {
  const { id, ...attachmentOverrides } = overrides;
  return {
    id,
    companyId: "company-1",
    issueId: "issue-1",
    issueCommentId: null,
    assetId: `asset-${id}`,
    provider: "local_disk",
    objectKey: `attachments/${id}`,
    contentType: overrides.contentType ?? "application/octet-stream",
    byteSize: overrides.byteSize ?? 4096,
    sha256: "sha256",
    originalFilename: overrides.originalFilename ?? null,
    createdByAgentId: null,
    createdByUserId: null,
    createdAt: new Date("2026-04-21T00:00:00.000Z"),
    updatedAt: new Date("2026-04-21T00:00:00.000Z"),
    contentPath: overrides.contentPath ?? `/api/attachments/${id}/content`,
    openPath: overrides.openPath ?? `/api/attachments/${id}/content`,
    downloadPath:
      overrides.downloadPath ?? `/api/attachments/${id}/content?download=1`,
    ...attachmentOverrides,
  };
}

function createArtifactWorkProduct(
  overrides: Partial<IssueWorkProduct> & {
    id: string;
    attachmentId: string;
    contentType: string;
    originalFilename: string;
  },
): IssueWorkProduct {
  const {
    id,
    attachmentId,
    contentType,
    originalFilename,
    ...workProductOverrides
  } = overrides;
  const contentPath = `/api/attachments/${attachmentId}/content`;
  return {
    id,
    companyId: "company-1",
    projectId: null,
    issueId: "issue-1",
    executionWorkspaceId: null,
    runtimeServiceId: null,
    type: "artifact",
    provider: "paperclip",
    externalId: null,
    title: overrides.title ?? originalFilename,
    url: null,
    status: "active",
    reviewState: "none",
    isPrimary: false,
    healthStatus: "unknown",
    summary: null,
    metadata: {
      attachmentId,
      contentType,
      byteSize: 4096,
      contentPath,
      openPath: contentPath,
      downloadPath: `${contentPath}?download=1`,
      originalFilename,
    },
    createdByRunId: null,
    createdAt: new Date("2026-04-21T00:00:00.000Z"),
    updatedAt: new Date("2026-04-21T00:00:00.000Z"),
    ...workProductOverrides,
  } as IssueWorkProduct;
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

function createPauseHold(
  overrides: Partial<IssueTreeHold> = {},
): IssueTreeHold {
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

  function renderIssueView(children: ReactNode = <IssueDetail />) {
    root.render(
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>,
    );
  }

  beforeEach(() => {
    Object.assign(coordinatorPreference, { enabled: false, loaded: true });
    inlineEditorFixture.real = false;
    mockTaskPluginPanels.panels = []; mockTaskPluginPanels.isLoading = false;
    localStorage.clear();
    sessionStorage.clear();
    mockPanelState.panelVisible = true;
    mockSidebarState.isMobile = false;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createTooltipRoot(container);
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    queryClient.setQueryData(["issues", "history-expanded", "PAP-1"], true);
    mockIssuesApi.getCore.mockImplementation((id) => mockIssuesApi.get(id));
    mockIssuesApi.recentComments.mockResolvedValue({ comments: [], latestCommentId: null, hasMore: false });
    mockActivityApi.recentRunsForIssue.mockResolvedValue([]);
    mockActivityApi.runsByIdsForIssue.mockResolvedValue([]);
    mockActivityApi.recentForIssue.mockResolvedValue([]);
    mockActivityApi.inputFactsForIssue.mockResolvedValue([]);
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      text: async () => "# Attachment preview",
    } as Response);

    mockIssuesApi.list.mockResolvedValue([]);
    mockIssuesApi.listAll.mockImplementation((...args) => mockIssuesApi.list(...args));
    mockIssuesApi.listComments.mockResolvedValue([]);
    mockIssuesApi.listAttachments.mockResolvedValue([]);
    mockIssuesApi.listWorkProducts.mockResolvedValue([]);
    mockIssuesApi.recoveryActions.mockReset();
    mockIssuesApi.recoverWorkspace.mockReset();
    mockIssuesApi.retryTask.mockReset();
    mockIssuesApi.checkMonitorNow.mockReset();
    mockIssuesApi.listFeedbackVotes.mockResolvedValue([]);
    mockIssuesApi.listInteractions.mockResolvedValue([]);
    mockIssuesApi.getQueuedComments.mockResolvedValue(
      createQueuedCommentQueue({
        queueId: null,
        state: null,
        targetRunId: null,
        entries: [],
      }),
    );
    mockIssuesApi.interruptQueuedComments.mockReset().mockResolvedValue(createQueuedCommentQueue());
    mockIssuesApi.editQueuedComment.mockResolvedValue(
      createQueuedCommentQueue(),
    );
    mockIssuesApi.reorderQueuedComments.mockResolvedValue(
      createQueuedCommentQueue(),
    );
    mockIssuesApi.steerQueuedComment.mockResolvedValue(
      createQueuedCommentQueue(),
    );
    mockIssuesApi.discardQueuedComment.mockResolvedValue(
      createQueuedCommentQueue({ entries: [] }),
    );
    mockIssuesApi.markRead.mockResolvedValue({
      id: "issue-1",
      lastReadAt: new Date().toISOString(),
    });
    mockIssuesApi.archiveFromInbox.mockResolvedValue({
      id: "issue-1",
      archivedAt: new Date(),
    });
    mockIssuesApi.unarchiveFromInbox.mockResolvedValue({ ok: true });
    mockIssuesApi.getTreeControlState.mockResolvedValue({
      activePauseHold: null,
    });
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
    mockDecisionsApi.list.mockResolvedValue([]);
    mockInstanceSettingsApi.getGeneral.mockResolvedValue({
      feedbackDataSharingPreference: "prompt",
    });
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({
      enableIssuePlanDecompositions: false,
      enableExperimentalFileViewer: false,
      enableExternalObjects: false,
      enableStreamlinedUi: true,
    });
    mockIssuesApi.listAcceptedPlanDecompositions.mockResolvedValue([]);
    mockIssuesApi.getDocument.mockResolvedValue(null);
    mockOpenPanel.mockClear();
    mockClosePanel.mockClear();
    mockSetPanelVisible.mockClear();
    mockRequestPanelMaximize.mockClear();
    mockClearPanelMaximizeRequest.mockClear();
    mockSetBreadcrumbPanelControl.mockClear();
    mockSetMobileToolbar.mockClear();
    mockIssuePropertiesRender.mockClear();
    mockTaskSidePanelRender.mockClear();
    mockIssuesListRender.mockClear();
    mockIssueChatThreadRender.mockClear();
    mockImageGalleryRender.mockClear();
    mockIssueWorkspaceCardRender.mockClear();
    mockNavigate.mockClear();
    mockOpenNewIssue.mockClear();
    mockOpenNewProject.mockClear();
    mockOpenNewGoal.mockClear();
    mockPushToast.mockClear();
    mockLocation.pathname = "/issues/PAP-1";
    mockLocation.search = "";
    mockLocation.hash = "";
    mockLocation.state = null;
    mockRouteParams.issueId = "PAP-1";
    mockRouteParams.companyPrefix = "PAP";
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await act(async () => {
      root.unmount();
    });
    queryClient.clear();
    container.remove();
    document.body.innerHTML = "";
    localStorage.clear();
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it("isolates additional conversation drafts and preserves the legacy default through first send", async () => {
    mockAuthApi.getSession.mockResolvedValue({ user: { id: "user-1" } });
    queryClient.setQueryData(queryKeys.auth.session, { user: { id: "user-1" } });
    const agent = createAgent();
    const first = createIssue({ id: "chat-first", conversationAgentId: agent.id, conversationUserId: "user-1", conversationDefault: false });
    const second = createIssue({ ...first, id: "chat-second" });
    const show = async (issue: Issue | null) => {
      mockIssuesApi.get.mockResolvedValue(issue);
      await act(async () => renderIssueView(<TaskDetailSurface conversation={{ agent, issue, ensureIssue: async () => issue! }} />));
      await flushReact();
      return mockIssueChatThreadRender.mock.calls.at(-1)![0].draftKey as string;
    };
    const firstKey = await show(first);
    saveDraft(firstKey, "Unfinished first chat");
    saveDraftSubmission(firstKey, { attemptId: "61f746ee-430c-4699-a74b-b439904f14f1", reviewed: false });
    const secondKey = await show(second);
    expect(loadDraft(secondKey)).toBe("");
    expect(loadDraftSubmission(secondKey)).toBeNull();
    saveDraft(secondKey, "Unfinished second chat");
    expect(await show(first)).toBe(firstKey);
    expect(loadDraft(firstKey)).toBe("Unfinished first chat");
    expect(loadDraftSubmission(firstKey)?.attemptId).toBe("61f746ee-430c-4699-a74b-b439904f14f1");
    expect(loadDraft(secondKey)).toBe("Unfinished second chat");
    const legacyKey = `paperclip:agent-chat-draft:${first.companyId}:user-1:${agent.id}`;
    saveDraft(legacyKey, "Existing default draft");
    expect(await show(null)).toBe(legacyKey);
    expect(loadDraft(legacyKey)).toBe("Existing default draft");
    const defaultChat = createIssue({ ...first, id: "default-chat", conversationDefault: true });
    expect(await show(defaultChat)).toBe(legacyKey);
    expect(await show({ ...defaultChat, conversationDefault: undefined })).toBe(legacyKey);
    expect(loadDraft(legacyKey)).toBe("Existing default draft");
  });

  it.each([
    { status: "succeeded", answered: true, disclosed: false },
    { status: "succeeded", answered: false, disclosed: true },
    { status: "failed", answered: true, disclosed: true },
    { status: "succeeded", answered: true, disclosed: true, body: LEGACY_WITHHELD_RUN_COMMENT },
  ])("discloses an omitted $status run only when its answer is not visible (answered: $answered)", async ({ status, answered, disclosed, body = "Earlier answer" }) => {
    queryClient.setQueryData(["issues", "history-expanded", "PAP-1"], false);
    mockIssuesApi.get.mockResolvedValue(createIssue());
    const latest = { runId: "latest", status: "succeeded", agentId: "agent-1", createdAt: new Date().toISOString() };
    const older = { ...latest, runId: "older", status };
    const answer = createIssueComment({ id: "answer", authorType: "agent", authorAgentId: "agent-1", authorUserId: null,
      body, createdByRunId: answered ? "older" : "unrelated" });
    mockIssuesApi.recentComments.mockResolvedValue({ comments: [answer], latestCommentId: answer.id, hasMore: false });
    mockActivityApi.recentRunsForIssue.mockResolvedValue([latest, older]);
    await act(async () => renderIssueView());
    await waitForAssertion(() => {
      const props = mockIssueChatThreadRender.mock.calls.at(-1)?.[0];
      expect(props?.linkedRuns).toMatchObject([latest]);
      expect(props?.comments).toMatchObject([{ id: "answer" }]);
      expect(Boolean(props?.historyControl)).toBe(disclosed);
    });
  });

  it.each([
    { coordinator: false, mobile: false }, { coordinator: false, mobile: true },
    { coordinator: true, mobile: false }, { coordinator: true, mobile: true },
  ])("keeps dismissed plugin panes closed (coordinator=$coordinator, mobile=$mobile)", async ({ coordinator, mobile }) => {
    coordinatorPreference.enabled = coordinator;
    mockAuthApi.getSession.mockResolvedValue({ session: { userId: "user-1" }, user: { id: "user-1" } });
    const task = createIssue();
    mockIssuesApi.get.mockResolvedValue(task);
    const manual = { entityId: "agent-1", runId: "run-1", autoOpen: false,
      slot: { pluginKey: "example.view", id: "screen", displayName: "Live view" } } as import("@/hooks/useTaskPluginPanels").TaskPluginPanel;
    mockTaskPluginPanels.panels = [manual];
    await act(async () => { renderIssueView(); });
    await waitForAssertion(() => expect(mockOpenPanel).toHaveBeenCalled());
    const props = mockOpenPanel.mock.calls.at(-1)![0]?.props.children?.props as {
      accountScope: string; dismissedPluginPanelKeys: Set<string>;
    };
    props.dismissedPluginPanelKeys.add(taskPluginPanelActivationKey(manual, props.accountScope, task));
    mockPanelState.panelVisible = false;
    mockSidebarState.isMobile = mobile;
    mockTaskPluginPanels.panels = [{ ...manual, autoOpen: true }];
    mockSetPanelVisible.mockClear();
    await act(async () => { renderIssueView(); }); await flushReact();
    expect(mockSetPanelVisible).not.toHaveBeenCalledWith(true);
    expect(container.querySelector('[data-testid="mobile-task-side-panel"]')).toBeNull();
    mockTaskPluginPanels.panels = [{ ...manual, runId: "run-2", autoOpen: true }];
    await act(async () => { renderIssueView(); }); await flushReact();
    expect(mockSetPanelVisible).toHaveBeenCalledWith(true);
    if (mobile) expect(container.querySelector('[data-testid="mobile-task-side-panel"]')).not.toBeNull();
  });

  it.each([
    ["issue-1", "#document-plan&revision=saved-revision"],
    ["PAP-2", "#document-plan&revision=saved-revision&documentIssue=PAP-2"],
  ])("opens the saved plan from %s in the current agent chat", async (sourceTask, hash) => {
    const pathname = "/PAP/chats/codex";
    mockLocation.pathname = pathname;
    mockPanelState.panelVisible = false;
    coordinatorPreference.enabled = true;
    const agent = createAgent();
    const issue = createIssue({ conversationAgentId: agent.id, conversationUserId: "user-1" });
    mockIssuesApi.get.mockResolvedValue(issue);
    const conversation = { agent, issue, ensureIssue: async () => issue };
    const renderChat = () => renderIssueView(<TaskDetailSurface conversation={conversation} />);
    await act(async () => renderChat());
    await waitForAssertion(() => expect(mockOpenPanel).toHaveBeenCalled());

    const link = document.createElement("a");
    link.href = `/PAP/issues/${sourceTask}#document-plan&revision=saved-revision`;
    link.dataset.sidebarDocumentLink = "true";
    container.appendChild(link);
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    link.addEventListener("click", (click) => click.preventDefault(), { once: true });
    await act(async () => { link.dispatchEvent(event); });
    expect(mockNavigate).toHaveBeenCalledWith(`${pathname}${hash}`, {
      preventScrollReset: true,
      state: { taskDocumentScrollEntry: { key: "task-entry", hash: "", pathname } },
    });

    mockLocation.hash = hash;
    await act(async () => renderChat());
    await waitForAssertion(() => {
      expect(mockSetPanelVisible).toHaveBeenCalledWith(true);
      expect(mockOpenPanel.mock.calls.at(-1)?.[0]?.props.children.props).toMatchObject({
        documentDeepLink: { documentKey: "plan", tab: "document" },
        showDocumentSourceTask: true,
      });
    });
    expect(mockLocation.pathname).toBe(pathname);
  });

  it.each(([
    ["history", "before"],
    ["history", "after"],
    ["live", "before"],
    ["live", "after"],
  ] as const).flatMap(([source, order]) =>
    (["same-run", "previous-run", "queued", "adopted"] as const).map(queueTarget => [source, order, queueTarget] as const),
  ))("retires a consumed follow-up from %s when its post resolves %s delivery with a %s snapshot", async (receiptSource, postOrder, queueTarget) => {
    const postedComment = createDeferred<IssueComment>();
    const delivered = createIssueComment({ id: "delivered", body: "Use this direction" });
    const waiting = createIssueComment({ id: "still-waiting", body: "Keep this queued" });
    const run = {
      id: queueTarget === "same-run" ? "run-native" : "run-original", runtimeMode: "native" as const, status: "running",
      invocationSource: "issue", triggerDetail: null,
      contextCommentId: null, contextWakeCommentId: null,
      startedAt: "2026-04-21T00:00:01.000Z", finishedAt: null,
      createdAt: "2026-04-21T00:00:01.000Z", agentId: "agent-1",
      agentName: "Runner", adapterType: "paperclip_runner", issueId: "issue-1",
    };
    mockIssuesApi.get.mockResolvedValue(createIssue({ status: "in_progress", executionRunId: run.id }));
    mockAgentsApi.list.mockResolvedValue([createAgent({ adapterType: "paperclip_runner" })]);
    mockHeartbeatsApi.activeRunForIssue.mockResolvedValue(run);
    mockHeartbeatsApi.liveRunsForIssue.mockResolvedValue([run]);
    mockIssuesApi.addComment.mockReturnValue(postedComment.promise);
    await act(async () => renderIssueView());
    await flushReact();

    type Props = {
      onAdd: (body: string) => Promise<void>;
      comments: Array<Record<string, unknown>>;
      queuedCommentQueue: IssueQueuedCommentQueue | null;
    };
    const props = () => mockIssueChatThreadRender.mock.calls.at(-1)![0] as Props;
    await act(async () => { void props().onAdd(delivered.body); });
    await waitForAssertion(() => {
      expect(props().queuedCommentQueue?.entries[0]?.comment.body).toBe(delivered.body);
    });
    if (postOrder === "before") {
      await act(async () => postedComment.resolve(delivered));
      await flushReact();
    }

    const staleQueue = createQueuedCommentQueue({
      state: queueTarget === "queued" ? "queued" : "deferred",
      targetRunId: queueTarget === "queued" ? null : run.id,
      entries: [delivered, waiting].map((comment, position) => ({
        comment, position, canEdit: true, canDiscard: true,
      })),
    });
    mockIssuesApi.listComments.mockResolvedValue([delivered, waiting]);
    mockIssuesApi.getQueuedComments.mockResolvedValue(staleQueue);
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.issues.comments("PAP-1") });
      queryClient.setQueryData(queryKeys.issues.queuedComments("issue-1"), staleQueue);
      if (receiptSource === "history") {
        queryClient.setQueryData(queryKeys.issues.runs("PAP-1"), [{
          ...run, runId: "run-native",
          wakeupRequestId: queueTarget === "adopted" ? "other-wake" : staleQueue.queueId,
          queuedCommentSourceWakeIds: queueTarget === "adopted" ? [staleQueue.queueId] : null,
          wakeCommentIds: [delivered.id],
          contextIssueId: "issue-1", logBytes: 1,
        }]);
      } else {
        const consumingRun = {
          ...run, id: "run-native",
          wakeupRequestId: queueTarget === "adopted" ? "other-wake" : staleQueue.queueId,
          queuedCommentSourceWakeIds: queueTarget === "adopted" ? [staleQueue.queueId] : null,
          contextCommentId: delivered.id, contextWakeCommentId: delivered.id,
        };
        mockHeartbeatsApi.liveRunsForIssue.mockResolvedValue([consumingRun]);
        mockHeartbeatsApi.activeRunForIssue.mockResolvedValue(consumingRun);
        queryClient.setQueryData(queryKeys.issues.liveRuns("PAP-1"), [consumingRun]);
        queryClient.setQueryData(queryKeys.issues.activeRun("PAP-1"), consumingRun);
      }
    });
    if (postOrder === "after") {
      await act(async () => postedComment.resolve(delivered));
    }
    await waitForAssertion(() => {
      expect(props().queuedCommentQueue?.entries.map(entry => entry.comment.id)).toEqual([waiting.id]);
      const comment = props().comments.find(comment => comment.id === delivered.id);
      expect(comment).toMatchObject({ consumedByRunId: "run-native" });
      expect(comment?.queueState).toBeUndefined();
      expect(comment?.clientStatus).toBeUndefined();
      expect(props().comments.filter(comment => comment.body === delivered.body)).toHaveLength(1);
    });
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.issues.queuedComments("issue-1") });
    });
    expect(props().queuedCommentQueue?.entries.map(entry => entry.comment.id)).toEqual([waiting.id]);
  });

  it.each([
    ["success", true], ["failure", true], ["success", false], ["failure", false],
  ] as const)("optimistically promotes the interrupt queue with no toast on %s (history loaded: %s)", async (outcome, historyLoaded) => {
    const queue = createQueuedCommentQueue({ protocol: "legacy", steeringDisposition: "unsupported" });
    queue.entries.push({ ...queue.entries[0], position: 1, comment: createIssueComment({ id: "queued-comment-2", body: "Second direction" }) });
    mockIssuesApi.get.mockResolvedValue(createIssue({ status: "in_progress", assigneeAgentId: "agent-1", executionRunId: "run-active-1" }));
    mockAgentsApi.list.mockResolvedValue([createAgent({ adapterType: "codex_local" })]);
    mockIssuesApi.listComments.mockResolvedValue(historyLoaded ? queue.entries.map(entry => entry.comment) : []);
    mockIssuesApi.getQueuedComments.mockResolvedValue(queue);
    mockHeartbeatsApi.activeRunForIssue.mockResolvedValue({
      id: "run-active-1", runtimeMode: "legacy", status: "running", invocationSource: "issue",
      startedAt: "2026-04-21T00:00:00.000Z", finishedAt: null, createdAt: "2026-04-21T00:00:00.000Z",
      agentId: "agent-1", agentName: "Coder", adapterType: "codex_local", issueId: "issue-1",
    });
    const delivery = createDeferred<IssueQueuedCommentQueue>();
    mockIssuesApi.interruptQueuedComments.mockReturnValue(delivery.promise);
    await act(async () => { renderIssueView(); });
    type Props = { onInterruptQueued: (runId: string | null) => Promise<void>; queuedCommentQueue: IssueQueuedCommentQueue | null; comments: Array<{ id: string; queueState?: string; conversationAnchorAt?: string }> };
    let props!: Props;
    await waitForAssertion(() => {
      props = mockIssueChatThreadRender.mock.calls.at(-1)?.[0] as Props;
      expect(props.queuedCommentQueue?.entries).toHaveLength(2);
    });
    let pending!: Promise<unknown>;
    await act(async () => { pending = props.onInterruptQueued("run-active-1").catch(error => error); });
    const whilePending = mockIssueChatThreadRender.mock.calls.at(-1)?.[0] as Props;
    expect(whilePending.queuedCommentQueue).toBeNull();
    for (const entry of queue.entries) expect(whilePending.comments).toContainEqual(expect.objectContaining({
      id: entry.comment.id, queueState: undefined, conversationAnchorAt: expect.any(String),
    }));
    expect(mockPushToast).not.toHaveBeenCalled();
    await act(async () => {
      if (outcome === "failure") delivery.reject(new Error("Connection lost"));
      else delivery.resolve(createQueuedCommentQueue({ entries: [] }));
      await pending;
    });
    await waitForAssertion(() => {
      const final = mockIssueChatThreadRender.mock.calls.at(-1)?.[0] as Props;
      if (outcome === "failure") expect(final.queuedCommentQueue?.entries).toHaveLength(2);
      else expect(final.queuedCommentQueue).toBeNull();
    });
    expect(mockPushToast).not.toHaveBeenCalled();
  });

});

