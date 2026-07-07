// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Agent, Issue, IssueAttachment, IssueComment, IssueTreeControlPreview, IssueTreeHold, IssueWorkProduct } from "@paperclipai/shared";
import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from "react";
import { NavigationType } from "react-router-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  canBoardResolveRecoveryAction,
  IssueDetail,
  shouldScrollIssueDetailToTopOnNavigation,
} from "./IssueDetail";
import { queryKeys } from "../lib/queryKeys";
import { createIssueDetailLocationState } from "../lib/issueDetailBreadcrumb";

const mockIssuesApi = vi.hoisted(() => ({
  get: vi.fn(),
  list: vi.fn(),
  listAcceptedPlanDecompositions: vi.fn(),
  listComments: vi.fn(),
  listAttachments: vi.fn(),
  listWorkProducts: vi.fn(),
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
  getExperimental: vi.fn(),
}));

const mockNavigate = vi.hoisted(() => vi.fn());
const mockLocation = vi.hoisted(() => ({
  pathname: "/issues/PAP-1",
  search: "",
  hash: "",
  state: null as unknown,
}));
const mockOpenPanel = vi.hoisted(() => vi.fn());
const mockClosePanel = vi.hoisted(() => vi.fn());
const mockSetBreadcrumbs = vi.hoisted(() => vi.fn());
const mockSetMobileToolbar = vi.hoisted(() => vi.fn());
const mockPushToast = vi.hoisted(() => vi.fn());
const mockIssuesListRender = vi.hoisted(() => vi.fn());
const mockIssueChatThreadRender = vi.hoisted(() => vi.fn());
const mockImageGalleryRender = vi.hoisted(() => vi.fn());
const mockIssueWorkspaceCardRender = vi.hoisted(() => vi.fn());

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

(globalThis as any).ResizeObserver = (globalThis as any).ResizeObserver ?? ResizeObserverStub;

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
    <a href={to} {...props}>{children}</a>
  ),
  useLocation: () => mockLocation,
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
    runFinalizationActions?: readonly {
      id: string;
      label: string;
      onSelect: (runId: string) => Promise<void> | void;
    }[];
    footer?: ReactNode;
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
        {props.runFinalizationActions?.map((action) => (
          <button
            key={action.id}
            type="button"
            onClick={() => void action.onSelect("run-active-1")}
          >
            {action.label}
          </button>
        ))}
        {props.footer}
      </div>
    );
  },
}));

vi.mock("../components/IssueDocumentsSection", () => ({
  IssueDocumentsSection: () => <div>Documents</div>,
}));

vi.mock("../components/MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
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
  IssueWorkspaceCard: (props: { onBrowseFiles?: () => void; onOpenFileByPath?: () => void }) => {
    mockIssueWorkspaceCardRender(props);
    return <div>Workspace</div>;
  },
}));

vi.mock("../components/ImageGalleryModal", () => ({
  ImageGalleryModal: (props: { items: IssueAttachment[]; initialIndex: number; open: boolean }) => {
    mockImageGalleryRender(props);
    return null;
  },
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
  Identity: ({ name, shape }: { name: string; shape?: string }) => <span data-shape={shape ?? "circle"}>{name}</span>,
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
  SheetDescription: ({ children }: { children?: ReactNode }) => <p>{children}</p>,
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

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

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

function createIssueComment(overrides: Partial<IssueComment> = {}): IssueComment {
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

function createAttachment(overrides: Partial<IssueAttachment> & { id: string }): IssueAttachment {
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
    downloadPath: overrides.downloadPath ?? `/api/attachments/${id}/content?download=1`,
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
  const { id, attachmentId, contentType, originalFilename, ...workProductOverrides } = overrides;
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
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      text: async () => "# Attachment preview",
    } as Response);

    mockIssuesApi.list.mockResolvedValue([]);
    mockIssuesApi.listComments.mockResolvedValue([]);
    mockIssuesApi.listAttachments.mockResolvedValue([]);
    mockIssuesApi.listWorkProducts.mockResolvedValue([]);
    mockIssuesApi.listFeedbackVotes.mockResolvedValue([]);
    mockIssuesApi.markRead.mockResolvedValue({ id: "issue-1", lastReadAt: new Date().toISOString() });
    mockIssuesApi.archiveFromInbox.mockResolvedValue({ id: "issue-1", archivedAt: new Date() });
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
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({
      enableIssuePlanDecompositions: false,
      enableExperimentalFileViewer: false,
      enableExternalObjects: false,
    });
    mockIssuesApi.listAcceptedPlanDecompositions.mockResolvedValue([]);
    mockIssuesListRender.mockClear();
    mockIssueChatThreadRender.mockClear();
    mockImageGalleryRender.mockClear();
    mockIssueWorkspaceCardRender.mockClear();
    mockNavigate.mockClear();
    mockLocation.pathname = "/issues/PAP-1";
    mockLocation.search = "";
    mockLocation.hash = "";
    mockLocation.state = null;
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
    expect(
      consoleErrorSpy.mock.calls.some((call: unknown[]) =>
        String(call[0]).includes("React has detected a change in the order of Hooks"),
      ),
    ).toBe(false);
  });

  it("removes an inbox-origin archived issue from cached inbox variants before navigating back", async () => {
    const issue = createIssue({ id: "issue-1", identifier: "PAP-1", title: "Archive me from detail" });
    const otherIssue = createIssue({ id: "issue-2", identifier: "PAP-2", title: "Keep me in inbox" });
    const archiveRequest = createDeferred<{ id: string; archivedAt: Date }>();
    mockLocation.state = createIssueDetailLocationState("Inbox", "/inbox/mine", "inbox");
    mockIssuesApi.get.mockResolvedValue(issue);
    mockIssuesApi.archiveFromInbox.mockReturnValue(archiveRequest.promise);

    const mineKey = [
      ...queryKeys.issues.listMineByMe("company-1"),
      "with-routine-executions",
      "live-descendant-summary",
    ] as const;
    const touchedKey = [
      ...queryKeys.issues.listTouchedByMe("company-1"),
      "with-routine-executions",
      "live-descendant-summary",
    ] as const;
    const unreadKey = queryKeys.issues.listUnreadTouchedByMe("company-1");
    queryClient.setQueryData<Issue[]>(mineKey, [issue, otherIssue]);
    queryClient.setQueryData<Issue[]>(touchedKey, [issue, otherIssue]);
    queryClient.setQueryData<Issue[]>(unreadKey, [issue, otherIssue]);

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <IssueDetail />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    const archiveButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Archive from inbox"]',
    );
    expect(archiveButton).not.toBeNull();

    await act(async () => {
      archiveButton!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    await waitForAssertion(() => {
      expect(queryClient.getQueryData<Issue[]>(mineKey)?.map((item) => item.id)).toEqual(["issue-2"]);
      expect(queryClient.getQueryData<Issue[]>(touchedKey)?.map((item) => item.id)).toEqual(["issue-2"]);
      expect(queryClient.getQueryData<Issue[]>(unreadKey)?.map((item) => item.id)).toEqual(["issue-2"]);
      expect(mockNavigate).not.toHaveBeenCalled();
    });

    await act(async () => {
      archiveRequest.resolve({ id: "issue-1", archivedAt: new Date() });
    });
    await flushReact();

    expect(mockNavigate).toHaveBeenCalledWith("/inbox/mine", { replace: true });
    expect(mockPushToast).toHaveBeenCalledWith({ title: "Task archived from inbox", tone: "success" });
  });

  it("shows assignee and originating avatars in the issue header metadata", async () => {
    mockIssuesApi.get.mockResolvedValue(createIssue({
      assigneeAgentId: "agent-1",
      projectId: "project-1",
      createdByUserId: "user-1",
    }));
    mockAgentsApi.list.mockResolvedValue([createAgent({ name: "CodexCoder" })]);
    mockProjectsApi.list.mockResolvedValue([{ id: "project-1", name: "Core Product", color: "#2563eb" }]);
    mockAccessApi.listUserDirectory.mockResolvedValue({
      users: [
        {
          principalId: "user-1",
          status: "active",
          user: { id: "user-1", name: "Dotta", email: "dotta@example.com", image: null },
        },
      ],
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
      const avatarStack = container.querySelector('[data-testid="issue-attribution-avatar-stack"]');
      const assigneeAvatar = container.querySelector('[data-testid="issue-assignee-avatar"]');
      const originatingAvatar = container.querySelector('[data-testid="issue-originating-avatar"]');

      expect(container.textContent).toContain("Core Product");
      expect(avatarStack).toBeTruthy();
      expect(assigneeAvatar?.getAttribute("aria-label")).toBe("Assignee: CodexCoder");
      expect(originatingAvatar?.getAttribute("aria-label")).toBe("Originating: Dotta");
      expect(assigneeAvatar?.getAttribute("title")).toBeNull();
      expect(originatingAvatar?.getAttribute("title")).toBeNull();
      expect(avatarStack?.textContent).not.toContain("Assignee");
      expect(avatarStack?.textContent).not.toContain("Originating");
      expect(avatarStack?.textContent).not.toContain("CodexCoder");
      expect(avatarStack?.textContent).not.toContain("Dotta");
    });

    const pointerEvent = window.PointerEvent ?? MouseEvent;
    const assigneeAvatar = container.querySelector('[data-testid="issue-assignee-avatar"]');
    const originatingAvatar = container.querySelector('[data-testid="issue-originating-avatar"]');

    await act(async () => {
      assigneeAvatar?.dispatchEvent(new pointerEvent("pointermove", { bubbles: true }));
    });
    await waitForAssertion(() => {
      const tooltip = document.body.querySelector('[data-testid="issue-assignee-tooltip"]');
      expect(tooltip?.textContent).toContain("Assignee");
      expect(tooltip?.textContent).toContain("CodexCoder");
    });

    await act(async () => {
      originatingAvatar?.dispatchEvent(new pointerEvent("pointermove", { bubbles: true }));
    });
    await waitForAssertion(() => {
      const tooltip = document.body.querySelector('[data-testid="issue-originating-tooltip"]');
      expect(tooltip?.textContent).toContain("Originating");
      expect(tooltip?.textContent).toContain("Dotta");
    });
  });

  it("attributes an agent-created issue to the transitive responsible user with a via affordance", async () => {
    mockIssuesApi.get.mockResolvedValue(createIssue({
      assigneeAgentId: "agent-1",
      createdByAgentId: "agent-1",
      createdByUserId: null,
      responsibleUserId: "user-1",
    }));
    mockAgentsApi.list.mockResolvedValue([createAgent({ name: "CodexCoder" })]);
    mockAccessApi.listUserDirectory.mockResolvedValue({
      users: [
        {
          principalId: "user-1",
          status: "active",
          user: { id: "user-1", name: "Dotta", email: "dotta@example.com", image: null },
        },
      ],
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
      const originatingAvatar = container.querySelector('[data-testid="issue-originating-avatar"]');
      expect(originatingAvatar?.getAttribute("aria-label")).toBe("Originating: Dotta · via CodexCoder");
    });

    const pointerEvent = window.PointerEvent ?? MouseEvent;
    const originatingAvatar = container.querySelector('[data-testid="issue-originating-avatar"]');
    await act(async () => {
      originatingAvatar?.dispatchEvent(new pointerEvent("pointermove", { bubbles: true }));
    });
    await waitForAssertion(() => {
      const tooltip = document.body.querySelector('[data-testid="issue-originating-tooltip"]');
      expect(tooltip?.textContent).toContain("Dotta");
      expect(tooltip?.textContent).toContain("via CodexCoder");
    });
  });

  it("does not mark the wake comment for the current live run as queued when active-run cache is stale", async () => {
    mockIssuesApi.get.mockResolvedValue(createIssue({
      status: "in_progress",
      executionRunId: "run-stale",
    }));
    mockIssuesApi.listComments.mockResolvedValue([
      createIssueComment({
        id: "comment-fresh",
        createdAt: new Date("2026-04-21T00:00:05.000Z"),
        updatedAt: new Date("2026-04-21T00:00:05.000Z"),
      }),
    ]);
    mockHeartbeatsApi.activeRunForIssue.mockResolvedValue({
      id: "run-stale",
      status: "running",
      invocationSource: "issue",
      triggerDetail: null,
      contextCommentId: null,
      contextWakeCommentId: null,
      startedAt: "2026-04-21T00:00:00.000Z",
      finishedAt: null,
      createdAt: "2026-04-21T00:00:00.000Z",
      agentId: "agent-1",
      agentName: "Coder",
      adapterType: "codex_local",
      issueId: "issue-1",
    });
    mockHeartbeatsApi.liveRunsForIssue.mockResolvedValue([
      {
        id: "run-current",
        status: "running",
        invocationSource: "issue",
        triggerDetail: null,
        contextCommentId: "comment-fresh",
        contextWakeCommentId: "comment-fresh",
        startedAt: "2026-04-21T00:00:01.000Z",
        finishedAt: null,
        createdAt: "2026-04-21T00:00:01.000Z",
        agentId: "agent-1",
        agentName: "Coder",
        adapterType: "codex_local",
        issueId: "issue-1",
      },
    ]);

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <IssueDetail />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    const props = mockIssueChatThreadRender.mock.calls.at(-1)?.[0] as { comments?: Array<{ id: string; queueState?: string }> };
    const freshComment = props.comments?.find((comment) => comment.id === "comment-fresh");
    expect(freshComment?.queueState).toBeUndefined();
  });

  it("does not optimistically queue a fresh comment from an unlocked stale active-run cache", async () => {
    const postedComment = createDeferred<IssueComment>();
    mockIssuesApi.get.mockResolvedValue(createIssue({
      status: "todo",
      executionRunId: null,
    }));
    mockIssuesApi.addComment.mockReturnValue(postedComment.promise);
    queryClient.setQueryData(queryKeys.issues.activeRun("PAP-1"), {
      id: "run-stale",
      status: "running",
      invocationSource: "issue",
      triggerDetail: null,
      contextCommentId: null,
      contextWakeCommentId: null,
      startedAt: "2026-04-21T00:00:00.000Z",
      finishedAt: null,
      createdAt: "2026-04-21T00:00:00.000Z",
      agentId: "agent-1",
      agentName: "Coder",
      adapterType: "codex_local",
      issueId: "issue-1",
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

    const props = mockIssueChatThreadRender.mock.calls.at(-1)?.[0] as {
      onAdd: (body: string) => Promise<void>;
      comments?: Array<{ body: string; clientStatus?: string; queueState?: string }>;
    };
    await act(async () => {
      void props.onAdd("Fresh comment");
      await Promise.resolve();
    });
    await flushReact();

    const nextProps = mockIssueChatThreadRender.mock.calls.at(-1)?.[0] as {
      comments?: Array<{ body: string; clientStatus?: string; queueState?: string }>;
    };
    const optimisticComment = nextProps.comments?.find((comment) => comment.body === "Fresh comment");
    expect(optimisticComment).toMatchObject({ clientStatus: "pending" });
    expect(optimisticComment?.queueState).toBeUndefined();

    await act(async () => {
      postedComment.resolve(createIssueComment({ body: "Fresh comment" }));
    });
    await flushReact();
  });

  it("hides the plan decomposition panel by default", async () => {
    mockIssuesApi.get.mockResolvedValue(createIssue());

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <IssueDetail />
        </QueryClientProvider>,
      );
    });

    await flushReact();
    await flushReact();

    expect(container.textContent).not.toContain("Plan decomposition");
    expect(mockIssuesApi.listAcceptedPlanDecompositions).not.toHaveBeenCalled();
  });

  it("hides file viewer entry points by default", async () => {
    mockIssuesApi.get.mockResolvedValue(createIssue());

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <IssueDetail />
        </QueryClientProvider>,
      );
    });

    await flushReact();
    await flushReact();

    expect(container.querySelector('[aria-label="Open file in this issue"]')).toBeNull();
    const latestWorkspaceProps = mockIssueWorkspaceCardRender.mock.calls.at(-1)?.[0];
    expect(latestWorkspaceProps?.onBrowseFiles).toBeUndefined();
    expect(latestWorkspaceProps?.onOpenFileByPath).toBeUndefined();
  });

  it("shows file viewer entry points when the experimental flag is enabled", async () => {
    mockIssuesApi.get.mockResolvedValue(createIssue());
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({
      enableIssuePlanDecompositions: false,
      enableExperimentalFileViewer: true,
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

    expect(container.querySelector('[aria-label="Open file in this issue"]')).not.toBeNull();
    const latestWorkspaceProps = mockIssueWorkspaceCardRender.mock.calls.at(-1)?.[0];
    expect(latestWorkspaceProps?.onBrowseFiles).toEqual(expect.any(Function));
    expect(latestWorkspaceProps?.onOpenFileByPath).toEqual(expect.any(Function));
  });

  it("shows the plan decomposition panel when the experimental flag is enabled", async () => {
    mockIssuesApi.get.mockResolvedValue(createIssue());
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({
      enableIssuePlanDecompositions: true,
      enableExperimentalFileViewer: false,
    });
    mockIssuesApi.listAcceptedPlanDecompositions.mockResolvedValue([
      {
        id: "decomp-1",
        companyId: "company-1",
        sourceIssueId: "issue-1",
        acceptedPlanRevisionId: "plan-rev-1",
        acceptedPlanRevisionNumber: 2,
        acceptedInteractionId: null,
        status: "completed",
        requestFingerprint: "fingerprint-1",
        requestedChildCount: 2,
        childIssueIds: ["issue-2", "issue-3"],
        childIssues: [
          {
            id: "issue-2",
            identifier: "PAP-2",
            title: "First child issue",
            status: "todo",
            priority: "medium",
            assigneeAgentId: null,
            assigneeUserId: null,
          },
        ],
        ownerAgentId: null,
        ownerUserId: null,
        ownerRunId: null,
        completedAt: "2026-05-28T06:00:00.000Z",
        createdAt: "2026-05-28T05:50:00.000Z",
        updatedAt: "2026-05-28T06:00:00.000Z",
      },
    ]);

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <IssueDetail />
        </QueryClientProvider>,
      );
    });

    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("Plan decomposition");
    expect(container.textContent).toContain("Plan revision 2");
    expect(container.textContent).toContain("2 of 2 child tasks created");
    expect(container.textContent).toContain("First child issue");
    expect(mockIssuesApi.listAcceptedPlanDecompositions).toHaveBeenCalledWith("issue-1");
  });

  it("renders sibling previous and next navigation at the chat footer", async () => {
    const issue = createIssue({
      id: "issue-2",
      identifier: "PAP-2",
      issueNumber: 2,
      parentId: "parent-1",
      title: "Current sibling",
      createdAt: new Date("2026-04-02T00:00:00.000Z"),
    });
    const previous = createIssue({
      id: "issue-1",
      identifier: "PAP-1",
      issueNumber: 1,
      parentId: "parent-1",
      title: "Previous sibling",
      status: "done",
      createdAt: new Date("2026-04-01T00:00:00.000Z"),
    });
    const next = createIssue({
      id: "issue-3",
      identifier: "PAP-3",
      issueNumber: 3,
      parentId: "parent-1",
      title: "Next sibling",
      blockedBy: [{ id: "issue-2" }] as Issue["blockedBy"],
      createdAt: new Date("2026-04-03T00:00:00.000Z"),
    });

    mockIssuesApi.get.mockResolvedValue(issue);
    mockIssuesApi.list.mockImplementation((_companyId, filters?: { descendantOf?: string; parentId?: string }) => {
      if (filters?.parentId === "parent-1") return Promise.resolve([next, previous, issue]);
      return Promise.resolve([]);
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

    expect(mockIssuesApi.list).toHaveBeenCalledWith("company-1", {
      parentId: "parent-1",
      includeBlockedBy: true,
    });
    expect(container.querySelector('a[aria-label="Previous sub-task: PAP-1 - Previous sibling"]')).toBeTruthy();
    expect(container.querySelector('a[aria-label="Next sub-task: PAP-3 - Next sibling"]')).toBeTruthy();
    expect(container.textContent).toContain("Previous");
    expect(container.textContent).toContain("Previous sibling");
    expect(container.textContent).toContain("Next");
    expect(container.textContent).toContain("Next sibling");
    expect(mockIssueChatThreadRender.mock.calls.at(-1)?.[0].footer).toBeTruthy();
  });

  it("uses the first child issue as next navigation for parent issues without a sibling next", async () => {
    const parent = createIssue({
      id: "issue-parent",
      identifier: "PAP-10",
      issueNumber: 10,
      parentId: null,
      title: "Plan parent",
      createdAt: new Date("2026-04-01T00:00:00.000Z"),
    });
    const firstChild = createIssue({
      id: "issue-child-1",
      identifier: "PAP-11",
      issueNumber: 11,
      parentId: "issue-parent",
      title: "First child",
      createdAt: new Date("2026-04-02T00:00:00.000Z"),
    });
    const secondChild = createIssue({
      id: "issue-child-2",
      identifier: "PAP-12",
      issueNumber: 12,
      parentId: "issue-parent",
      title: "Second child",
      blockedBy: [{ id: "issue-child-1" }] as Issue["blockedBy"],
      createdAt: new Date("2026-04-03T00:00:00.000Z"),
    });

    mockIssuesApi.get.mockResolvedValue(parent);
    mockIssuesApi.list.mockImplementation((_companyId, filters?: { descendantOf?: string; parentId?: string }) => {
      if (filters?.descendantOf === "issue-parent") return Promise.resolve([secondChild, firstChild]);
      return Promise.resolve([]);
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

    expect(mockIssuesApi.list).toHaveBeenCalledWith("company-1", {
      descendantOf: "issue-parent",
      includeBlockedBy: true,
    });
    expect(container.querySelector('a[aria-label="Next sub-task: PAP-11 - First child"]')).toBeTruthy();
    expect(container.textContent).toContain("Next");
    expect(container.textContent).toContain("First child");
    expect(mockIssueChatThreadRender.mock.calls.at(-1)?.[0].footer).toBeTruthy();
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

    const moreButton = container.querySelector('button[aria-label="More task actions"]') as HTMLButtonElement | null;
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

    const moreButton = container.querySelector('button[aria-label="More task actions"]') as HTMLButtonElement | null;
    expect(moreButton).toBeTruthy();
    await act(async () => {
      moreButton!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await flushReact();

    const pauseMenuButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.trim() === "Pause work...");
    expect(pauseMenuButton).toBeTruthy();
  });

  it("routes live-run finalization actions through run cancellation before issue status update", async () => {
    mockIssuesApi.get.mockResolvedValue(createIssue({
      status: "in_progress",
      assigneeAgentId: "agent-1",
      executionRunId: "run-active-1",
    }));
    mockIssuesApi.update.mockImplementation((_id, data) =>
      Promise.resolve(createIssue({
        status: data.status as Issue["status"],
        assigneeAgentId: "agent-1",
      })),
    );
    mockHeartbeatsApi.cancel.mockResolvedValue(undefined);
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

    const stopAndDoneButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.trim() === "Stop and done");
    expect(stopAndDoneButton).toBeTruthy();

    await act(async () => {
      stopAndDoneButton!.click();
    });
    await flushReact();

    expect(mockHeartbeatsApi.cancel).toHaveBeenCalledWith("run-active-1");
    expect(mockIssuesApi.update).toHaveBeenCalledWith("PAP-1", { status: "done" });
    expect(mockHeartbeatsApi.cancel.mock.invocationCallOrder[0])
      .toBeLessThan(mockIssuesApi.update.mock.invocationCallOrder[0]);

    const stopAndCancelButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.trim() === "Stop and cancel");
    expect(stopAndCancelButton).toBeTruthy();

    await act(async () => {
      stopAndCancelButton!.click();
    });
    await flushReact();

    expect(mockIssuesApi.update).toHaveBeenLastCalledWith("PAP-1", { status: "cancelled" });
    expect(mockHeartbeatsApi.cancel).toHaveBeenCalledTimes(2);
    expect(mockHeartbeatsApi.cancel.mock.invocationCallOrder[1])
      .toBeLessThan(mockIssuesApi.update.mock.invocationCallOrder[1]);
  });

  it("reports partial success when run finalization stops the run but task status update fails", async () => {
    mockIssuesApi.get.mockResolvedValue(createIssue({
      status: "in_progress",
      assigneeAgentId: "agent-1",
      executionRunId: "run-active-1",
    }));
    mockIssuesApi.update.mockRejectedValue(new Error("Status write failed"));
    mockHeartbeatsApi.cancel.mockResolvedValue(undefined);
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

    const stopAndDoneButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.trim() === "Stop and done");
    expect(stopAndDoneButton).toBeTruthy();

    await act(async () => {
      stopAndDoneButton!.click();
    });
    await flushReact();

    expect(mockHeartbeatsApi.cancel).toHaveBeenCalledWith("run-active-1");
    expect(mockPushToast).toHaveBeenCalledWith(expect.objectContaining({
      title: "Run stopped; task update failed",
      body: "Run was stopped, but updating the task failed: Status write failed",
      tone: "error",
    }));
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
    expect(container.textContent).toContain("Plan mode");
  });

  it("passes ask work mode to the issue chat thread and renders the ask badge", async () => {
    mockIssuesApi.get.mockResolvedValue(createIssue({ workMode: "ask" }));
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <IssueDetail />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    expect(mockIssueChatThreadRender.mock.calls.at(-1)?.[0]).toMatchObject({
      issueWorkMode: "ask",
    });
    expect(container.textContent).toContain("Ask mode");
  });

  it("falls back to execCommand when copying the task from an insecure context", async () => {
    const clipboardWrite = vi.fn(async () => {
      throw new Error("Clipboard API blocked");
    });
    const execCommand = vi.fn(() => true);
    const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    const originalExecCommand = Object.getOwnPropertyDescriptor(document, "execCommand");
    const originalSecureContext = Object.getOwnPropertyDescriptor(window, "isSecureContext");
    Object.defineProperty(window, "isSecureContext", {
      configurable: true,
      value: false,
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: clipboardWrite },
    });
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: execCommand,
    });
    mockIssuesApi.get.mockResolvedValue(createIssue({
      identifier: "PAP-1",
      title: "Copy me",
      description: "Task body",
    }));

    try {
      await act(async () => {
        root.render(
          <QueryClientProvider client={queryClient}>
            <IssueDetail />
          </QueryClientProvider>,
        );
      });
      await flushReact();

      const copyButton = Array.from(container.querySelectorAll("button"))
        .find((button) => button.getAttribute("title") === "Copy task as markdown");
      expect(copyButton).toBeTruthy();

      await act(async () => {
        copyButton!.click();
        await Promise.resolve();
      });

      expect(clipboardWrite).not.toHaveBeenCalled();
      expect(execCommand).toHaveBeenCalledWith("copy");
      expect(mockPushToast).toHaveBeenCalledWith(expect.objectContaining({
        title: "Copied to clipboard",
        tone: "success",
      }));
    } finally {
      if (originalClipboard) {
        Object.defineProperty(navigator, "clipboard", originalClipboard);
      } else {
        // @ts-expect-error test cleanup for optional browser API
        delete navigator.clipboard;
      }
      if (originalExecCommand) {
        Object.defineProperty(document, "execCommand", originalExecCommand);
      } else {
        // @ts-expect-error test cleanup for optional browser API
        delete document.execCommand;
      }
      if (originalSecureContext) {
        Object.defineProperty(window, "isSecureContext", originalSecureContext);
      } else {
        // @ts-expect-error test cleanup for optional browser API
        delete window.isSecureContext;
      }
    }
  });

  it("renders the graduated task thread without the chat flag", async () => {
    mockIssuesApi.get.mockResolvedValue(createIssue());

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <IssueDetail />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    expect(container.querySelector('[data-testid="issue-chat-thread"]')).not.toBeNull();
    expect(mockIssueChatThreadRender).toHaveBeenCalled();
  });

  it("uses graduated Plan mode chip copy", async () => {
    mockIssuesApi.get.mockResolvedValue(createIssue({ workMode: "planning" }));

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <IssueDetail />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    expect(container.textContent).toContain("Plan mode");
    expect(container.textContent).not.toContain("Planning");
  });

  it("passes @task mention options to the thread by default", async () => {
    const mentionPoolIssue = {
      ...createIssue(),
      id: "issue-mention-1",
      identifier: "PAP-9",
      title: "Mentionable task",
    };
    mockIssuesApi.list.mockImplementation(
      (_companyId: string, filters?: { sortField?: string }) =>
        Promise.resolve(filters?.sortField === "updated" ? [mentionPoolIssue] : []),
    );
    mockIssuesApi.get.mockResolvedValue(createIssue());

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
      expect(mockIssueChatThreadRender.mock.calls.at(-1)?.[0].mentions).toEqual(
        expect.arrayContaining([expect.objectContaining({ kind: "issue", issueIdentifier: "PAP-9" })]),
      );
    });
    expect(mockIssuesApi.list).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({ sortField: "updated" }),
    );
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
      lastChatThreadProps?.onWorkModeChange?.("ask");
    });
    await flushReact();

    expect(mockIssuesApi.update).toHaveBeenCalledWith(issue.identifier, { workMode: "ask" });
    expect(localStorage.getItem("paperclip:issue-comment-draft:issue-1")).toBe("Draft follow-up message");
    expect(container.textContent).toContain("planning-notes.txt");
    localStorage.removeItem("paperclip:issue-comment-draft:issue-1");
  });

  it("hides attachments backing promoted outputs while keeping filtered markdown artifacts visible", async () => {
    const issue = createIssue();
    const videoAttachment = createAttachment({
      id: "11111111-1111-4111-8111-111111111111",
      contentType: "video/mp4",
      originalFilename: "demo.mp4",
    });
    const imageAttachment = createAttachment({
      id: "33333333-3333-4333-8333-333333333333",
      contentType: "image/png",
      originalFilename: "screenshot.png",
    });
    const markdownAttachment = createAttachment({
      id: "22222222-2222-4222-8222-222222222222",
      contentType: "text/markdown",
      originalFilename: "report.md",
    });
    mockIssuesApi.get.mockResolvedValue(issue);
    mockIssuesApi.listAttachments.mockResolvedValue([videoAttachment, imageAttachment, markdownAttachment]);
    mockIssuesApi.listWorkProducts.mockResolvedValue([
      createArtifactWorkProduct({
        id: "wp-video",
        attachmentId: videoAttachment.id,
        contentType: "video/mp4",
        originalFilename: "demo.mp4",
        isPrimary: true,
      }),
      createArtifactWorkProduct({
        id: "wp-image",
        attachmentId: imageAttachment.id,
        contentType: "image/png",
        originalFilename: "screenshot.png",
      }),
      createArtifactWorkProduct({
        id: "wp-markdown",
        attachmentId: markdownAttachment.id,
        contentType: "text/markdown",
        originalFilename: "report.md",
      }),
    ]);

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <IssueDetail />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("Output");
    expect(container.textContent).toContain("demo.mp4");
    expect(container.textContent).toContain("Attachments");
    expect(container.textContent).toContain("report.md");
    expect(container.textContent).toContain("Attachments1");
    expect(container.querySelectorAll("video")).toHaveLength(1);
    expect(mockImageGalleryRender.mock.calls.at(-1)?.[0].items.map((attachment: IssueAttachment) => attachment.id)).toEqual([
      videoAttachment.id,
      imageAttachment.id,
    ]);
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

    const moreButton = container.querySelector('button[aria-label="More task actions"]') as HTMLButtonElement | null;
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
    expect(container.textContent).toContain("Restore tasks cancelled by this subtree operation so work can resume.");
    expect(container.textContent).toContain("Cancelled child");

    const restoreApplyButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.trim() === "Restore 1 tasks");
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
      .find((button) => button.textContent?.trim() === "Cancel 24 tasks") as HTMLButtonElement | undefined;
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

describe("canBoardResolveRecoveryAction", () => {
  it("falls back to companyIds when memberships are not populated", () => {
    expect(
      canBoardResolveRecoveryAction("company-1", {
        companyIds: ["company-1"],
        memberships: [],
        isInstanceAdmin: false,
        source: "session",
        keyId: null,
        user: null,
        userId: "user-1",
      }),
    ).toBe(true);
  });

  it("uses populated memberships as the authoritative board access source", () => {
    expect(
      canBoardResolveRecoveryAction("company-1", {
        companyIds: ["company-1"],
        memberships: [
          {
            companyId: "company-1",
            membershipRole: "viewer",
            status: "active",
          },
        ],
        isInstanceAdmin: false,
        source: "session",
        keyId: null,
        user: null,
        userId: "user-1",
      }),
    ).toBe(false);
  });
});

describe("shouldScrollIssueDetailToTopOnNavigation", () => {
  it("does not scroll when only URL search params changed for the same issue", () => {
    expect(shouldScrollIssueDetailToTopOnNavigation({
      previousIssueId: "PAP-10306",
      nextIssueId: "PAP-10306",
      navigationType: NavigationType.Push,
    })).toBe(false);
  });

  it("scrolls on forward navigation to a different issue", () => {
    expect(shouldScrollIssueDetailToTopOnNavigation({
      previousIssueId: "PAP-1",
      nextIssueId: "PAP-2",
      navigationType: NavigationType.Push,
    })).toBe(true);
  });

  it("does not scroll on browser back or forward restoration", () => {
    expect(shouldScrollIssueDetailToTopOnNavigation({
      previousIssueId: "PAP-1",
      nextIssueId: "PAP-2",
      navigationType: NavigationType.Pop,
    })).toBe(false);
  });
});
