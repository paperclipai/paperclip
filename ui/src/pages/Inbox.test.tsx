// @vitest-environment jsdom

import { CoordinatorPresentation } from "../components/coordinator/CoordinatorPresentation";
import { queryKeys } from "../lib/queryKeys";
import { mineRevealSourcesQueryKey, type MineRevealSources } from "../lib/inbox-mine-reveal-sources";
import type { ComponentProps } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Approval, CompactIssue, HeartbeatRun, InboxMineSnapshot, Issue } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompanyJoinRequest } from "../api/access";
import { ApiError } from "../api/client";
import { shouldRetryRequest } from "../lib/query-client";
import {
  clearLocalInboxArchive,
  getLocalInboxArchiveIssueIds,
} from "../lib/inboxArchiveCache";
import { taskCollectionPreferencesStorageKey } from "../lib/task-collection-preferences";

const routerMock = vi.hoisted(() => ({
  location: { pathname: "/", search: "", hash: "" },
  navigate: vi.fn(),
}));
const companyState = vi.hoisted(() => ({ selectedCompanyId: "company-1" as string | null }));

const externalObjectMocks = vi.hoisted(() => ({
  summaries: new Map(),
  error: null as Error | null,
  retry: vi.fn(),
}));

const apiMocks = vi.hoisted(() => ({
  approvalsList: vi.fn(),
  joinRequestsList: vi.fn(),
  userDirectoryList: vi.fn(),
  authSession: vi.fn(),
  dashboardSummary: vi.fn(),
  executionWorkspaceSummaries: vi.fn(),
  issuesList: vi.fn(),
  inboxMine: vi.fn(),
  issuesCount: vi.fn(),
  issueLabels: vi.fn(),
  retryTask: vi.fn(),
  archiveFromInbox: vi.fn(),
  unarchiveFromInbox: vi.fn(),
  agentsList: vi.fn(),
  heartbeatRunsList: vi.fn(),
  liveRunsForCompany: vi.fn(),
  experimentalSettings: vi.fn(),
  projectsList: vi.fn(),
}));

vi.mock("../api/approvals", () => ({
  approvalsApi: { list: apiMocks.approvalsList },
}));

vi.mock("../api/access", async () => {
  const actual = await vi.importActual<typeof import("../api/access")>("../api/access");
  return {
    ...actual,
    accessApi: {
      listJoinRequests: apiMocks.joinRequestsList,
      listUserDirectory: apiMocks.userDirectoryList,
    },
  };
});

vi.mock("../api/auth", () => ({
  authApi: { getSession: apiMocks.authSession },
}));

vi.mock("../api/dashboard", () => ({
  dashboardApi: { summary: apiMocks.dashboardSummary },
}));

vi.mock("../api/execution-workspaces", () => ({
  executionWorkspacesApi: {
    listSummariesByIds: (companyId: string, ids: readonly string[]) =>
      apiMocks.executionWorkspaceSummaries(companyId, { ids }),
  },
}));

vi.mock("../api/issues", () => ({
  issuesApi: {
    list: apiMocks.issuesList,
    listCompact: apiMocks.issuesList,
    inboxMine: apiMocks.inboxMine,
    count: apiMocks.issuesCount,
    listLabels: apiMocks.issueLabels,
    retryTask: apiMocks.retryTask,
    markRead: vi.fn(),
    markUnread: vi.fn(),
    archiveFromInbox: apiMocks.archiveFromInbox,
    unarchiveFromInbox: apiMocks.unarchiveFromInbox,
  },
}));

vi.mock("../api/agents", () => ({
  agentsApi: { list: apiMocks.agentsList },
}));

vi.mock("../api/heartbeats", () => ({
  heartbeatsApi: {
    list: apiMocks.heartbeatRunsList,
    liveRunsForCompany: apiMocks.liveRunsForCompany,
  },
}));

vi.mock("../api/instanceSettings", () => ({
  instanceSettingsApi: { getExperimental: apiMocks.experimentalSettings },
}));

vi.mock("../api/projects", () => ({
  projectsApi: { list: apiMocks.projectsList },
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => companyState,
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

const toastMocks = vi.hoisted(() => ({ pushToast: vi.fn() }));

vi.mock("../context/ToastContext", () => ({
  useToastActions: () => ({ pushToast: toastMocks.pushToast }),
}));

vi.mock("../context/DialogContext", () => ({
  useDialogActions: () => ({ openNewIssue: vi.fn() }),
}));

vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => ({ isMobile: false }),
}));

const workspaceIdScan = vi.hoisted(() => ({ calls: 0, limit: Number.POSITIVE_INFINITY }));

vi.mock("../lib/inbox", async () => {
  const actual = await vi.importActual<typeof import("../lib/inbox")>("../lib/inbox");
  return {
    ...actual,
    collectReferencedExecutionWorkspaceIds: (...lists: Array<ReadonlyArray<Pick<Issue, "executionWorkspaceId">>>) => {
      workspaceIdScan.calls += 1;
      if (workspaceIdScan.calls > workspaceIdScan.limit) throw new Error("Workspace id scan ran on an unchanged render");
      return actual.collectReferencedExecutionWorkspaceIds(...lists);
    },
  };
});

vi.mock("../hooks/useInboxBadge", () => {
  // Stable values, as the real hook's query data is between renders.
  const dismissals = { dismissedAtByKey: new Map(), dismiss: vi.fn(), dismissals: [], hasServerData: true, isLoading: false, error: null };
  return {
    useDismissedInboxAlerts: () => ({ dismissed: new Set(), dismiss: vi.fn() }),
    useInboxDismissals: () => dismissals,
    useReadInboxItems: () => ({
      readItems: new Set(),
      markRead: vi.fn(),
      markUnread: vi.fn(),
    }),
  };
});

vi.mock("../hooks/useIssueExternalObjects", () => ({
  useIssueExternalObjectSummaries: () => ({
    summaries: externalObjectMocks.summaries,
    isLoading: false,
    isReady: !externalObjectMocks.error,
    error: externalObjectMocks.error,
    refetch: externalObjectMocks.retry,
  }),
}));

import {
  FailedRunInboxRow,
  Inbox,
  InboxGroupHeader,
  InboxIssueMetaLeading,
  InboxIssueTrailingColumns,
  formatJoinRequestInboxLabel,
} from "./Inbox";

vi.mock("@/lib/router", () => ({
  Link: ({ children, className, to, ...props }: ComponentProps<"a"> & { to?: string }) => (
    <a className={className} href={to} {...props}>{children}</a>
  ),
  useLocation: () => routerMock.location,
  useNavigate: () => routerMock.navigate,
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

// jsdom doesn't implement scrollIntoView; the inbox calls it from a passive effect.
if (typeof Element !== "undefined" && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

type InboxIssueFixture = Issue & CompactIssue;

function createIssue(overrides: Partial<Issue> = {}): InboxIssueFixture {
  return {
    id: "issue-1",
    identifier: "PAP-904",
    companyId: "company-1",
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: "Inbox item",
    description: null,
    status: "todo",
    priority: "medium",
    reviewPolicy: null,
    assigneeAgentId: null,
    assigneeUserId: null,
    responsibleUserId: null,
    createdByAgentId: null,
    createdByUserId: null,
    issueNumber: 904,
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    createdAt: new Date("2026-03-11T00:00:00.000Z"),
    updatedAt: new Date("2026-03-11T00:00:00.000Z"),
    labels: [],
    labelIds: [],
    myLastTouchAt: null,
    lastExternalCommentAt: null,
    lastActivityAt: new Date("2026-03-11T00:00:00.000Z"),
    isUnreadForMe: false,
    ...overrides,
    workMode: overrides.workMode ?? "standard",
    activeRecoveryAction: overrides.activeRecoveryAction ?? null,
    successfulRunHandoff: overrides.successfulRunHandoff ?? null,
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

function createJoinRequest(
  overrides: Partial<CompanyJoinRequest> = {},
): CompanyJoinRequest {
  return {
    id: "join-1",
    inviteId: "invite-1",
    companyId: "company-1",
    requestType: "human",
    status: "pending_approval",
    requestIp: "127.0.0.1",
    requestingUserId: "user-1",
    requestEmailSnapshot: "joiner@example.com",
    agentName: null,
    adapterType: null,
    capabilities: null,
    agentDefaultsPayload: null,
    claimSecretExpiresAt: null,
    claimSecretConsumedAt: null,
    createdAgentId: null,
    approvedByUserId: null,
    approvedAt: null,
    rejectedByUserId: null,
    rejectedAt: null,
    createdAt: new Date("2026-03-11T00:00:00.000Z"),
    updatedAt: new Date("2026-03-11T00:00:00.000Z"),
    requesterUser: {
      id: "user-1",
      name: "Jordan Example",
      email: "joiner@example.com",
      image: null,
    },
    approvedByUser: null,
    rejectedByUser: null,
    invite: null,
    ...overrides,
  };
}

function createApproval(overrides: Partial<Approval> = {}): Approval {
  return {
    id: "approval-1",
    companyId: "company-1",
    type: "hire_agent",
    requestedByAgentId: null,
    requestedByUserId: "local-board",
    status: "pending",
    payload: { name: "New teammate" },
    decisionNote: null,
    decidedByUserId: null,
    decidedAt: null,
    createdAt: new Date("2026-03-11T00:00:00.000Z"),
    updatedAt: new Date("2026-03-11T00:00:00.000Z"),
    ...overrides,
  };
}

function createFailedRun(overrides: Partial<HeartbeatRun> = {}): HeartbeatRun {
  return {
    id: "run-1",
    issueId: null,
    scopeKind: "company",
    companyId: "company-1",
    agentId: "agent-1",
    responsibleUserId: null,
    invocationSource: "assignment",
    triggerDetail: null,
    status: "failed",
    error: "boom",
    wakeupRequestId: null,
    exitCode: null,
    signal: null,
    usageJson: null,
    resultJson: null,
    sessionIdBefore: null,
    sessionIdAfter: null,
    logStore: null,
    logRef: null,
    logBytes: null,
    logSha256: null,
    logCompressed: false,
    stdoutExcerpt: null,
    stderrExcerpt: null,
    errorCode: null,
    externalRunId: null,
    processPid: null,
    processGroupId: null,
    processStartedAt: null,
    lastOutputAt: null,
    lastOutputSeq: 0,
    lastOutputStream: null,
    lastOutputBytes: null,
    retryOfRunId: null,
    processLossRetryCount: 0,
    livenessState: null,
    livenessReason: null,
    continuationAttempt: 0,
    lastUsefulActionAt: null,
    nextAction: null,
    contextSnapshot: null,
    startedAt: new Date("2026-03-11T00:00:00.000Z"),
    finishedAt: new Date("2026-03-11T00:01:00.000Z"),
    createdAt: new Date("2026-03-11T00:00:00.000Z"),
    updatedAt: new Date("2026-03-11T00:01:00.000Z"),
    ...overrides,
  };
}

let mineFixture: InboxMineSnapshot;

function createMineSnapshot(overrides: Partial<InboxMineSnapshot> = {}): InboxMineSnapshot {
  return { userId: "local-board", issues: [], contextIssues: [], failureRuns: [], failureIssueIds: [], ...overrides };
}

// Mine's API response is a complete server-owned snapshot. These fixture helpers
// also populate the independent legacy/Recent readers without calling them from
// the aggregate mock, so request-budget assertions observe actual client reads.
function setIssueRows(rows: InboxIssueFixture[]) {
  apiMocks.issuesList.mockResolvedValue(rows);
  mineFixture = { ...mineFixture, issues: rows };
}

function setFailureRuns(runs: HeartbeatRun[]) {
  apiMocks.heartbeatRunsList.mockResolvedValue(runs);
  mineFixture = { ...mineFixture, failureRuns: runs };
}

function resetInboxApiMocks() {
  companyState.selectedCompanyId = "company-1";
  for (const mock of Object.values(apiMocks)) mock.mockReset();
  mineFixture = createMineSnapshot();
  apiMocks.inboxMine.mockImplementation(async () => mineFixture);
  externalObjectMocks.summaries.clear();
  externalObjectMocks.error = null;
  externalObjectMocks.retry.mockReset();
  routerMock.location.pathname = "/";
  routerMock.location.search = "";
  routerMock.location.hash = "";
  routerMock.navigate.mockReset();
  apiMocks.approvalsList.mockResolvedValue([]);
  apiMocks.joinRequestsList.mockResolvedValue([]);
  apiMocks.userDirectoryList.mockResolvedValue({ users: [] });
  apiMocks.authSession.mockResolvedValue({
    user: { id: "local-board" },
    session: { userId: "local-board" },
  });
  apiMocks.dashboardSummary.mockResolvedValue({
    agents: { error: 0 },
    costs: { monthBudgetCents: 0, monthUtilizationPercent: 0 },
  });
  apiMocks.executionWorkspaceSummaries.mockResolvedValue([]);
  setIssueRows([]);
  apiMocks.issuesCount.mockResolvedValue({ count: 0 });
  apiMocks.issueLabels.mockResolvedValue([]);
  apiMocks.retryTask.mockReset().mockResolvedValue({ accepted: true, requestId: "retry-intent", presentation: null });
  apiMocks.archiveFromInbox.mockResolvedValue({ id: "issue-1", archivedAt: new Date() });
  apiMocks.unarchiveFromInbox.mockResolvedValue({ id: "issue-1", archivedAt: new Date() });
  apiMocks.agentsList.mockResolvedValue([]);
  setFailureRuns([]);
  apiMocks.liveRunsForCompany.mockResolvedValue([]);
  apiMocks.experimentalSettings.mockResolvedValue({
    enableIsolatedWorkspaces: false,
    enableStreamlinedUi: true,
  });
  apiMocks.projectsList.mockResolvedValue([]);
}

describe("Inbox toolbar", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    localStorage.clear();
    resetInboxApiMocks();
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    for (const issueId of getLocalInboxArchiveIssueIds("company-1")) {
      clearLocalInboxArchive("company-1", issueId);
    }
    container.remove();
  });

  it.each([
    { tab: "mine", userId: "user-1", visible: ["own-failure"], hidden: ["other-failure", "unowned-failure"] },
    { tab: "mine", userId: "user-2", visible: ["other-failure"], hidden: ["own-failure", "unowned-failure"] },
    { tab: "mine", userId: "local-board", visible: ["unowned-failure"], hidden: ["own-failure", "other-failure"] },
    { tab: "mine", userId: null, visible: [], hidden: ["own-failure", "other-failure", "unowned-failure"] },
    { tab: "all", userId: "user-1", visible: ["own-failure", "other-failure", "unowned-failure"], hidden: [] },
  ].flatMap((scenario) => [true, false].map((streamlined) => ({ ...scenario, streamlined }))))(
    "scopes failed runs on $tab for $userId (streamlined=$streamlined)",
    async ({ tab, userId, visible, hidden, streamlined }) => {
      apiMocks.experimentalSettings.mockResolvedValue({ enableIsolatedWorkspaces: false, enableStreamlinedUi: streamlined });
      routerMock.location.pathname = `/inbox/${tab}`;
      apiMocks.authSession.mockResolvedValue(userId ? { user: { id: userId }, session: { userId } } : null);
      mineFixture.userId = userId ?? "local-board";
      setFailureRuns([
        createFailedRun({ id: "own-failure", agentId: "agent-1", responsibleUserId: "user-1" }),
        createFailedRun({ id: "other-failure", agentId: "agent-2", responsibleUserId: "user-2", status: "timed_out" }),
        createFailedRun({ id: "unowned-failure", agentId: "agent-3" }),
      ]);
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: 0 } },
      });
      const root = createRoot(container);
      try {
        await act(async () => {
          root.render(<QueryClientProvider client={queryClient}><Inbox /></QueryClientProvider>);
        });
        await vi.waitFor(() => {
          if (tab === "mine" && userId) expect(apiMocks.inboxMine).toHaveBeenCalledOnce();
          if (tab !== "mine") expect(apiMocks.heartbeatRunsList).toHaveBeenCalled();
          expect(queryClient.isFetching()).toBe(0);
          if (tab === "mine" && !userId) {
            expect(apiMocks.inboxMine).not.toHaveBeenCalled();
            expect(container.querySelector('[aria-label="Loading tasks"]')).toBeNull();
          }
          for (const id of visible) expect(container.querySelector(`a[href$="/runs/${id}"]`)).not.toBeNull();
          for (const id of hidden) expect(container.querySelector(`a[href$="/runs/${id}"]`)).toBeNull();
        });
      } finally {
        act(() => root.unmount());
        queryClient.clear();
      }
    },
  );

  it("restores the legacy toolbar and issue-row presentation when Streamlined UI is off", async () => {
    routerMock.location.pathname = "/inbox/mine";
    apiMocks.experimentalSettings.mockResolvedValue({
      enableIsolatedWorkspaces: false,
      enableStreamlinedUi: false,
    });
    setIssueRows([
      createIssue({ id: "legacy-row", identifier: "PAP-1904", title: "Legacy inbox task" }),
    ]);
    localStorage.setItem(
      taskCollectionPreferencesStorageKey({ companyId: "company-1", collectionKey: "inbox" }),
      JSON.stringify({
        version: 1,
        companyId: "company-1",
        collectionKey: "inbox",
        viewState: {},
        columns: [],
      }),
    );

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 0, gcTime: 0 } },
    });
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Inbox />
        </QueryClientProvider>,
      );
    });
    await vi.waitFor(() => expect(container.textContent).toContain("Legacy inbox task"));

    expect(container.querySelector('[data-slot="collection-toolbar"]')).toBeNull();
    expect(container.querySelector('[role="toolbar"][aria-label="Inbox controls"]')).toBeNull();
    expect(container.textContent).toContain("Mine");
    expect(container.querySelector('[data-slot="task-row"]')).toBeNull();
    const issueLink = container.querySelector('[data-inbox-issue-link]');
    // Production reads the legacy Inbox column key and must ignore the
    // Streamlined collection envelope above when the experiment is disabled.
    expect(issueLink?.parentElement?.textContent).toContain("PAP-1904");

    act(() => root.unmount());
  });

  it("does not render external-object summaries in inbox rows", async () => {
    routerMock.location.pathname = "/inbox/mine";
    const issue = createIssue({ title: "Inbox row without external object column" });
    setIssueRows([issue]);
    externalObjectMocks.summaries.set(issue.id, {
      total: 1,
      highestSeverity: "failed",
      byStatusCategory: { failed: 1 },
      objects: [],
    });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 0, gcTime: 0 } },
    });
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Inbox />
        </QueryClientProvider>,
      );
    });
    await vi.waitFor(() => {
      expect(container.textContent).toContain(issue.title);
    });

    expect(container.querySelector('[aria-label^="External objects:"]')).toBeNull();

    act(() => root.unmount());
  });

  it("keeps archive hover actions and swipe targets on every unread non-task Mine row", async () => {
    routerMock.location.pathname = "/inbox/mine";
    localStorage.setItem("paperclip:inbox:group-by", "none");
    apiMocks.approvalsList.mockResolvedValue([createApproval()]);
    setFailureRuns([createFailedRun()]);
    apiMocks.joinRequestsList.mockResolvedValue([createJoinRequest()]);

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 0, gcTime: 0 } },
    });
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Inbox />
        </QueryClientProvider>,
      );
    });
    await vi.waitFor(() => {
      expect(container.textContent).toContain("Hire Agent: New teammate");
      expect(container.textContent).toContain("Failed run");
      expect(container.textContent).toContain("Jordan Example");
    });

    const rowFor = (text: string) =>
      [...container.querySelectorAll("[data-inbox-item]")]
        .find((row) => row.textContent?.includes(text));

    for (const text of ["Hire Agent: New teammate", "Failed run", "Jordan Example"]) {
      const row = rowFor(text);
      expect(row, `missing inbox row for ${text}`).toBeDefined();
      expect(row?.querySelector('button[aria-label="Mark as read"]')).not.toBeNull();
      const archiveButton = row?.querySelector<HTMLButtonElement>('button[aria-label="Archive"]');
      expect(archiveButton).not.toBeNull();
      expect(archiveButton?.className).toContain("opacity-0");
      expect(archiveButton?.className).toContain("group-hover:opacity-100");
      expect(row?.querySelector("[data-inbox-row-surface]")).not.toBeNull();
    }

    const approvalRow = rowFor("Hire Agent: New teammate");
    const approvalActions = [...(approvalRow?.querySelectorAll("button") ?? [])]
      .filter((button) => button.textContent === "Approve" || button.textContent === "Reject");
    expect(approvalActions.length).toBeGreaterThanOrEqual(2);
    approvalActions.forEach((button) => {
      expect(button.className).toContain("h-8");
      expect(button.className).toContain("min-w-(--sz-64px)");
      expect(button.className).toContain("justify-center");
    });

    act(() => root.unmount());
  });

  it("restores folded and unfolded sub-tasks across remounts", async () => {
    routerMock.location.pathname = "/inbox/mine";
    const storageKey = "paperclip:inbox:collapsed-parents:company-1";
    localStorage.removeItem(storageKey);

    const parent = createIssue({
      id: "parent-issue",
      identifier: "PAP-1001",
      title: "Parent inbox task",
    });
    const child = createIssue({
      id: "child-issue",
      identifier: "PAP-1002",
      parentId: parent.id,
      title: "Nested inbox task",
    });
    const grandchild = createIssue({
      id: "grandchild-issue",
      identifier: "PAP-1003",
      parentId: child.id,
      title: "Deeply nested inbox task",
    });
    setIssueRows([parent, child, grandchild]);

    const mountInbox = async () => {
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false, staleTime: 0, gcTime: 0 } },
      });
      const root = createRoot(container);
      await act(async () => {
        root.render(
          <QueryClientProvider client={queryClient}>
            <Inbox />
          </QueryClientProvider>,
        );
      });
      await vi.waitFor(() => {
        expect(container.textContent).toContain(parent.title);
      });
      return root;
    };
    const parentToggle = () => {
      const parentRow = Array.from(container.querySelectorAll("[data-inbox-item]"))
        .find((row) => row.textContent?.includes(parent.title));
      return parentRow?.querySelector<HTMLButtonElement>('button[data-slot="icon-button"]') ?? null;
    };

    let root = await mountInbox();
    try {
      expect(container.textContent).toContain(child.title);
      expect(container.textContent).toContain(grandchild.title);
      const taskRowFor = (title: string) =>
        Array.from(container.querySelectorAll('[data-slot="task-row"]'))
          .find((row) => row.textContent?.includes(title));
      const childTaskRow = taskRowFor(child.title);
      const grandchildTaskRow = taskRowFor(grandchild.title);
      expect(childTaskRow?.querySelectorAll('[data-slot="task-row-tree-guide"]')).toHaveLength(1);
      expect(childTaskRow?.querySelector('button[aria-label="Collapse sub-tasks"]')).not.toBeNull();
      expect(grandchildTaskRow?.querySelectorAll('[data-slot="task-row-tree-guide"]')).toHaveLength(2);
      expect(grandchildTaskRow?.querySelector('[data-slot="task-row-disclosure-spacer"]')).not.toBeNull();

      await act(async () => {
        parentToggle()?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await vi.waitFor(() => {
        expect(container.textContent).not.toContain(child.title);
        expect(container.textContent).not.toContain(grandchild.title);
      });
      expect(JSON.parse(localStorage.getItem(storageKey) ?? "[]")).toEqual([parent.id]);

      act(() => root.unmount());
      root = await mountInbox();
      expect(container.textContent).not.toContain(child.title);

      await act(async () => {
        parentToggle()?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await vi.waitFor(() => {
        expect(container.textContent).toContain(child.title);
        expect(container.textContent).toContain(grandchild.title);
      });
      expect(JSON.parse(localStorage.getItem(storageKey) ?? "[]")).toEqual([]);

      act(() => root.unmount());
      root = await mountInbox();
      expect(container.textContent).toContain(child.title);
      expect(container.textContent).toContain(grandchild.title);
    } finally {
      localStorage.removeItem(storageKey);
      act(() => root.unmount());
    }
  });

  it("shows blocked toolbar controls on the Blocked tab", async () => {
    routerMock.location.pathname = "/inbox/blocked";
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 0, gcTime: 0 } },
    });
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Inbox />
        </QueryClientProvider>,
      );
    });

    expect(container.querySelector('input[placeholder="Search inbox…"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="inbox-blocked-tab-badge"]')).toBeNull();
    expect(container.querySelector('button[title="Filter"]')).not.toBeNull();
    expect(container.querySelector('button[title="Group"]')).not.toBeNull();
    expect(container.querySelector('button[title="Columns"]')).not.toBeNull();
    expect(container.querySelector('button[title="Sort"]')).not.toBeNull();
    expect(container.querySelector('button[title="Enable parent-child nesting"]')).toBeNull();
    expect(container.textContent).not.toContain("Mark all as read");

    act(() => {
      root.unmount();
    });
  });

  it("keeps Mine, Recent, Unread, Blocked, and All in the shared toolbar geometry", async () => {
    for (const tab of ["mine", "recent", "unread", "blocked", "all"] as const) {
      routerMock.location.pathname = `/inbox/${tab}`;
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false, staleTime: 0, gcTime: 0 } },
      });
      const root = createRoot(container);

      await act(async () => {
        root.render(
          <QueryClientProvider client={queryClient}>
            <Inbox />
          </QueryClientProvider>,
        );
      });

      const toolbar = container.querySelector('[data-slot="collection-toolbar"]');
      expect(toolbar?.getAttribute("aria-label")).toBe("Inbox controls");
      expect(toolbar?.querySelector('[data-slot="collection-toolbar-context"]')).not.toBeNull();
      expect(toolbar?.querySelector('[data-slot="collection-toolbar-search"] input[placeholder="Search inbox…"]')).not.toBeNull();
      expect(toolbar?.querySelector('[data-slot="collection-toolbar-controls"]')).not.toBeNull();
      expect(container.querySelectorAll('input[placeholder="Search inbox…"]')).toHaveLength(1);

      act(() => root.unmount());
      container.replaceChildren();
    }
  });

  it("explains that live-run filtering is different from active task statuses", async () => {
    routerMock.location.pathname = "/inbox/mine";
    localStorage.setItem("paperclip:inbox:filters:company-1", JSON.stringify({
      allCategoryFilter: "everything",
      allApprovalFilter: "all",
      issueFilters: { liveOnly: true },
    }));
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 0, gcTime: 0 } },
    });
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Inbox />
        </QueryClientProvider>,
      );
    });

    expect(container.querySelector('[data-testid="inbox-filter-scope-feedback"]')?.textContent)
      .toBe("Live runs only — tasks currently connected to an agent run.");
    const migrated = JSON.parse(
      localStorage.getItem("paperclip:task-collection:v1:company-1:inbox") ?? "null",
    ) as { companyId?: string; collectionKey?: string } | null;
    expect(migrated).toMatchObject({ companyId: "company-1", collectionKey: "inbox" });

    act(() => root.unmount());
  });

  it("groups ungrouped attention items by Today, Yesterday, and Earlier", async () => {
    routerMock.location.pathname = "/inbox/mine";
    const now = new Date();
    const localNoon = (daysAgo: number) =>
      new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo, 12, 0, 0);
    setIssueRows([
      createIssue({ id: "today", title: "Today task", lastActivityAt: localNoon(0) }),
      createIssue({ id: "yesterday", title: "Yesterday task", lastActivityAt: localNoon(1) }),
      createIssue({ id: "earlier", title: "Earlier task", lastActivityAt: localNoon(3) }),
    ]);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 0, gcTime: 0 } },
    });
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Inbox />
        </QueryClientProvider>,
      );
    });
    await vi.waitFor(() => expect(container.textContent).toContain("Earlier task"));

    const separators = [...container.querySelectorAll('[data-testid="inbox-date-group"]')];
    expect(separators.map((node) => node.textContent?.trim()))
      .toEqual(["Today", "Yesterday", "Earlier"]);
    expect(separators.every((separator) => (
      separator.querySelectorAll("[data-date-group-rule]").length === 2
    ))).toBe(true);
    expect(separators.every((separator) => (
      separator.querySelector("[data-date-group-label]")?.classList.contains("text-muted-foreground/70")
    ))).toBe(true);

    act(() => root.unmount());
  });

  it("honors the saved Columns option for hiding date group separators", async () => {
    routerMock.location.pathname = "/inbox/mine";
    localStorage.setItem(
      taskCollectionPreferencesStorageKey({
        companyId: "company-1",
        collectionKey: "inbox",
      }),
      JSON.stringify({
        version: 1,
        companyId: "company-1",
        collectionKey: "inbox",
        viewState: { showDateGroupSeparators: false },
        columns: ["status", "id", "updated"],
      }),
    );
    const now = new Date();
    const localNoon = (daysAgo: number) =>
      new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo, 12, 0, 0);
    setIssueRows([
      createIssue({ id: "today", title: "Today task", lastActivityAt: localNoon(0) }),
      createIssue({ id: "earlier", title: "Earlier task", lastActivityAt: localNoon(3) }),
    ]);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 0, gcTime: 0 } },
    });
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Inbox />
        </QueryClientProvider>,
      );
    });
    await vi.waitFor(() => expect(container.textContent).toContain("Earlier task"));

    expect(container.querySelector('[data-testid="inbox-date-group"]')).toBeNull();

    act(() => root.unmount());
  });

  it("shows the resolved isolated workspace name in canonical task metadata", async () => {
    routerMock.location.pathname = "/inbox/mine";
    localStorage.setItem("paperclip:inbox:issue-columns", JSON.stringify(["status", "id", "workspace", "updated"]));
    apiMocks.experimentalSettings.mockResolvedValue({ enableIsolatedWorkspaces: true });
    apiMocks.executionWorkspaceSummaries.mockResolvedValue([{
      id: "execution-workspace-1",
      name: "Workspace Aurora",
      mode: "isolated_workspace",
      projectWorkspaceId: "project-workspace-1",
    }]);
    apiMocks.projectsList.mockResolvedValue([{
      id: "project-1",
      name: "Launch",
      color: null,
      workspaces: [{ id: "project-workspace-1", name: "Main" }],
      executionWorkspacePolicy: { defaultProjectWorkspaceId: "project-workspace-1" },
      primaryWorkspace: null,
    }]);
    setIssueRows([createIssue({
      projectId: "project-1",
      executionWorkspaceId: "execution-workspace-1",
      title: "Workspace-aware task",
    })]);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 0, gcTime: 0 } },
    });
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Inbox />
        </QueryClientProvider>,
      );
    });
    // Workspace metadata resolves independently of the task list.
    await vi.waitFor(() => {
      expect(container.querySelector('[data-slot="task-row"]')?.textContent).toContain("Workspace Aurora");
    });
    // Only the workspaces the rows reference are read, never the company-wide list.
    expect(apiMocks.executionWorkspaceSummaries).toHaveBeenCalledWith("company-1", { ids: ["execution-workspace-1"] });

    const taskRow = container.querySelector('[data-slot="task-row"]');
    const identifier = taskRow?.querySelector('[data-slot="task-row-identifier"]');
    const timestamp = taskRow?.querySelector('[data-slot="task-row-timestamp"]');
    expect(taskRow?.textContent).toContain("Workspace Aurora");
    expect(identifier?.textContent).toBe("PAP-904");
    expect(timestamp).not.toBeNull();
    if (!identifier || !timestamp) throw new Error("Expected canonical identifier and timestamp columns");
    expect(identifier.compareDocumentPosition(timestamp) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);

    act(() => root.unmount());
  });

  it("scans a realistic Mine list for workspace ids once per data change, not per render", async () => {
    routerMock.location.pathname = "/inbox/mine";
    localStorage.setItem("paperclip:inbox:issue-columns", JSON.stringify(["status", "id", "updated"]));
    apiMocks.experimentalSettings.mockResolvedValue({ enableIsolatedWorkspaces: true });
    const base = new Date("2026-03-11T00:00:00.000Z").getTime();
    const issues = Array.from({ length: 100 }, (_, index) => createIssue({
      id: `issue-${index}`,
      identifier: `PAP-${5000 + index}`,
      title: `Scaled task ${index}`,
      executionWorkspaceId: `execution-workspace-${String(index).padStart(3, "0")}`,
      lastActivityAt: new Date(base - index * 1000),
    }));
    setIssueRows(issues);
    workspaceIdScan.calls = 0;
    workspaceIdScan.limit = Number.POSITIVE_INFINITY;
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(<QueryClientProvider client={queryClient}><Inbox /></QueryClientProvider>);
      });
      await vi.waitFor(() => expect(container.querySelectorAll('[data-slot="task-row"]').length).toBe(100));
      await vi.waitFor(() => expect(apiMocks.executionWorkspaceSummaries).toHaveBeenCalled());
      expect(apiMocks.executionWorkspaceSummaries).toHaveBeenCalledTimes(1);
      expect(apiMocks.executionWorkspaceSummaries.mock.calls[0]?.[1]).toEqual({
        ids: issues.map((issue) => issue.executionWorkspaceId),
      });

      // Keyboard navigation re-renders the page without changing its data.
      workspaceIdScan.limit = workspaceIdScan.calls;
      await act(async () => {
        for (let press = 0; press < 5; press += 1) {
          document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true }));
        }
      });
      expect(workspaceIdScan.calls).toBe(workspaceIdScan.limit);
      expect(apiMocks.executionWorkspaceSummaries).toHaveBeenCalledTimes(1);
    } finally {
      workspaceIdScan.limit = Number.POSITIVE_INFINITY;
      act(() => root.unmount());
    }
  });

  it("rows reveal while the workspace read is pending when no workspace column or grouping is active", async () => {
    routerMock.location.pathname = "/inbox/mine";
    localStorage.setItem("paperclip:inbox:issue-columns", JSON.stringify(["status", "id", "updated"]));
    localStorage.setItem("paperclip:inbox:group-by", "none");
    apiMocks.experimentalSettings.mockResolvedValue({ enableIsolatedWorkspaces: true });
    apiMocks.executionWorkspaceSummaries.mockReturnValue(new Promise(() => {}));
    setIssueRows([createIssue({
      executionWorkspaceId: "execution-workspace-1",
      title: "Row without workspace column",
    })]);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 0, gcTime: 0 } },
    });
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Inbox />
        </QueryClientProvider>,
      );
    });
    await vi.waitFor(() => {
      expect(container.querySelector('[data-slot="task-row"]')?.textContent).toContain("Row without workspace column");
    });
    expect(apiMocks.executionWorkspaceSummaries).toHaveBeenCalledWith("company-1", { ids: ["execution-workspace-1"] });

    act(() => root.unmount());
  });

  it("keeps a new view hidden while previous workspace summaries stand in for its ids", async () => {
    routerMock.location.pathname = "/inbox/mine";
    localStorage.setItem("paperclip:inbox:issue-columns", JSON.stringify(["status", "id", "workspace", "updated"]));
    apiMocks.experimentalSettings.mockResolvedValue({ enableIsolatedWorkspaces: true });
    mineFixture = { ...mineFixture, issues: [createIssue({ id: "issue-mine", identifier: "PAP-6001", title: "Mine view task", executionWorkspaceId: "execution-workspace-1" })] };
    apiMocks.issuesList.mockResolvedValue([
      createIssue({ id: "issue-recent", identifier: "PAP-6002", title: "Recent view task", executionWorkspaceId: "execution-workspace-2" }),
    ]);
    const summary = (id: string, name: string) => ({ id, name, mode: "isolated_workspace", projectWorkspaceId: null });
    let resolveSecond: () => void = () => {};
    apiMocks.executionWorkspaceSummaries.mockImplementation(async (_companyId: string, { ids }: { ids: string[] }) => {
      if (ids.includes("execution-workspace-2")) await new Promise<void>((resolve) => { resolveSecond = resolve; });
      return ids.map((id) => summary(id, id === "execution-workspace-1" ? "Workspace One" : "Workspace Two"));
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const root = createRoot(container);
    const render = () => root.render(<QueryClientProvider client={queryClient}><Inbox /></QueryClientProvider>);

    try {
      await act(async () => { render(); });
      await vi.waitFor(() => expect(container.querySelector('[data-slot="task-row"]')?.textContent).toContain("Workspace One"));

      routerMock.location.pathname = "/inbox/recent";
      await act(async () => { render(); });
      await vi.waitFor(() => {
        expect(apiMocks.executionWorkspaceSummaries.mock.calls.some(([, filters]) =>
          (filters as { ids: string[] }).ids.includes("execution-workspace-2"))).toBe(true);
      });
      expect(container.textContent).not.toContain("Recent view task");

      await act(async () => { resolveSecond(); });
      await vi.waitFor(() => {
        const recentRow = [...container.querySelectorAll('[data-slot="task-row"]')]
          .find((row) => row.textContent?.includes("Recent view task"));
        expect(recentRow?.textContent).toContain("Workspace Two");
      });
    } finally {
      act(() => root.unmount());
    }
  });

  it("reveals another company's rows that reference no workspaces after a workspace view loaded", async () => {
    routerMock.location.pathname = "/inbox/mine";
    localStorage.setItem("paperclip:inbox:issue-columns", JSON.stringify(["status", "id", "workspace", "updated"]));
    apiMocks.experimentalSettings.mockResolvedValue({ enableIsolatedWorkspaces: true });
    setIssueRows([createIssue({ id: "issue-first", identifier: "PAP-7001", title: "First company task", executionWorkspaceId: "execution-workspace-1" })]);
    apiMocks.executionWorkspaceSummaries.mockResolvedValue([
      { id: "execution-workspace-1", name: "Workspace One", mode: "isolated_workspace", projectWorkspaceId: null },
    ]);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const root = createRoot(container);
    const render = () => root.render(<QueryClientProvider client={queryClient}><Inbox /></QueryClientProvider>);

    try {
      await act(async () => { render(); });
      await vi.waitFor(() => expect(container.querySelector('[data-slot="task-row"]')?.textContent).toContain("Workspace One"));

      setIssueRows([createIssue({ id: "issue-second", identifier: "PAP-7002", title: "Second company task", companyId: "company-2" })]);
      companyState.selectedCompanyId = "company-2";
      await act(async () => { render(); });
      await vi.waitFor(() => expect(container.textContent).toContain("Second company task"));
      expect(container.textContent).not.toContain("Workspace One");
      expect(apiMocks.executionWorkspaceSummaries).toHaveBeenCalledTimes(1);
    } finally {
      act(() => root.unmount());
    }
  });

  it("keeps rows hidden until referenced workspaces load when the Workspace column is shown", async () => {
    routerMock.location.pathname = "/inbox/mine";
    localStorage.setItem("paperclip:inbox:issue-columns", JSON.stringify(["status", "id", "workspace", "updated"]));
    apiMocks.experimentalSettings.mockResolvedValue({ enableIsolatedWorkspaces: true });
    let resolveWorkspaces: (value: unknown) => void = () => {};
    apiMocks.executionWorkspaceSummaries.mockReturnValue(new Promise((resolve) => { resolveWorkspaces = resolve; }));
    setIssueRows([createIssue({
      executionWorkspaceId: "execution-workspace-1",
      title: "Row with workspace column",
    })]);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 0, gcTime: 0 } },
    });
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Inbox />
        </QueryClientProvider>,
      );
    });
    await vi.waitFor(() => {
      expect(apiMocks.executionWorkspaceSummaries).toHaveBeenCalledWith("company-1", { ids: ["execution-workspace-1"] });
    });
    expect(container.querySelector('[data-slot="task-row"]')).toBeNull();

    await act(async () => {
      resolveWorkspaces([{ id: "execution-workspace-1", name: "Workspace Borealis", mode: "isolated_workspace", projectWorkspaceId: null }]);
    });
    await vi.waitFor(() => {
      expect(container.querySelector('[data-slot="task-row"]')?.textContent).toContain("Workspace Borealis");
    });

    act(() => root.unmount());
  });

  it("hides workspace grouping when isolated workspaces are disabled", async () => {
    routerMock.location.pathname = "/inbox/mine";
    apiMocks.experimentalSettings.mockResolvedValue({ enableIsolatedWorkspaces: false });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 0, gcTime: 0 } },
    });
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Inbox />
        </QueryClientProvider>,
      );
    });

    const groupButton = container.querySelector<HTMLButtonElement>('button[title="Group"]');
    expect(groupButton).not.toBeNull();

    await act(async () => {
      groupButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const groupOptions = Array.from(document.body.querySelectorAll("button")).map((button) => button.textContent);
    expect(groupOptions).not.toContain("Workspace");

    act(() => {
      root.unmount();
    });
  });

  it("waits for the complete Mine bundle before revealing tasks or failed runs", async () => {
    routerMock.location.pathname = "/inbox/mine";
    const bundle = createDeferred<InboxMineSnapshot>();
    apiMocks.inboxMine.mockReturnValue(bundle.promise);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const root = createRoot(container);
    try {
      await act(() => root.render(<QueryClientProvider client={queryClient}><Inbox /></QueryClientProvider>));
      await vi.waitFor(() => expect(apiMocks.inboxMine).toHaveBeenCalledOnce());
      expect(container.querySelector('[aria-label="Loading tasks"]')).not.toBeNull();
      expect(container.querySelector('[data-inbox-item]')).toBeNull();
      expect(apiMocks.issuesList).not.toHaveBeenCalled();
      expect(apiMocks.heartbeatRunsList).not.toHaveBeenCalled();
      await act(() => bundle.resolve(createMineSnapshot({
        issues: [createIssue({ title: "Bundled task" })], failureRuns: [createFailedRun()],
      })));
      await vi.waitFor(() => {
        expect(container.textContent).toContain("Bundled task");
        expect(container.textContent).toContain("Failed run");
      });
      expect(container.querySelector('[aria-label="Loading tasks"]')).toBeNull();
    } finally { await act(() => root.unmount()); queryClient.clear(); }
  });

  it.each([true, false])("can select a company after a cold inbox mount (Streamlined UI=%s)", async streamlined => {
    companyState.selectedCompanyId = null;
    const settings = { enableStreamlinedUi: streamlined, enableIsolatedWorkspaces: false };
    apiMocks.experimentalSettings.mockResolvedValue(settings);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    queryClient.setQueryData(queryKeys.instance.experimentalSettings, settings);
    const root = createRoot(container);
    const render = () => root.render(<QueryClientProvider client={queryClient}><Inbox /></QueryClientProvider>);
    await act(render);
    await vi.waitFor(() => expect(container.textContent).toContain(streamlined ? "Select an organization" : "Select a company"));
    companyState.selectedCompanyId = "company-1";
    setIssueRows([createIssue({ title: "Cold company task" })]);
    await act(render);
    await vi.waitFor(() => expect(container.textContent).toContain("Cold company task"));
    act(() => root.unmount());
  });

  it("uses bundled parent and failure context without separate startup reads", async () => {
    routerMock.location.pathname = "/inbox/mine";
    const parent = createIssue({ id: "context-parent", title: "Bundled parent", listProjection: "index" });
    const task = createIssue({ id: "task", title: "Bundled child", parentId: parent.id, listProjection: "index" });
    const resolvedRun = createFailedRun({ id: "resolved-run", issueId: parent.id });
    const missingRun = createFailedRun({ id: "missing-run", issueId: "deleted-task", agentId: "missing-agent" });
    mineFixture = createMineSnapshot({
      issues: [task],
      contextIssues: [{ ...parent, listProjection: "rows", interruption: {
        intentId: "resolved-input", responsibility: "system", state: "resolved", nextRetryAt: null,
        canRetry: false, userAction: null, sourceRunIds: [resolvedRun.id], observedRunId: resolvedRun.id,
      } }],
      failureRuns: [resolvedRun, missingRun],
      failureIssueIds: [parent.id, "deleted-task"],
    });
    apiMocks.issuesList.mockImplementation((_company, filters) => Promise.resolve(
      filters.ids?.includes(task.id) ? [task] : [],
    ));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const root = createRoot(container);
    try {
      await act(() => root.render(<QueryClientProvider client={client}><Inbox /></QueryClientProvider>));
      await vi.waitFor(() => {
        expect(container.textContent).toContain(task.title);
        expect(container.querySelector('a[href="/issues/deleted-task"]')).not.toBeNull();
        expect(client.isFetching()).toBe(0);
      });
      expect(container.querySelectorAll("[data-inbox-item]")).toHaveLength(2);
      expect(apiMocks.inboxMine).toHaveBeenCalledOnce();
      expect(apiMocks.heartbeatRunsList).not.toHaveBeenCalled();
      // Post-reveal diagnostics may read the visible task, but neither a primary
      // index nor parent/failure context is fetched by the Mine client.
      for (const [, filters] of apiMocks.issuesList.mock.calls) {
        expect(filters).toMatchObject({ projection: "rows", ids: [task.id] });
      }
    } finally { await act(() => root.unmount()); client.clear(); }
  });

  it("rejects a Mine bundle stamped for another account before caching its rows or context", async () => {
    routerMock.location.pathname = "/inbox/mine";
    mineFixture = createMineSnapshot({ userId: "other-account", issues: [createIssue({ title: "Private other-account task" })] });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const root = createRoot(container);
    try {
      await act(() => root.render(<QueryClientProvider client={client}><Inbox /></QueryClientProvider>));
      await vi.waitFor(() => expect(container.textContent).toContain("Your account changed. Refresh the inbox."));
      expect(container.textContent).not.toContain("Private other-account task");
      expect(container.querySelector('[aria-label="Loading tasks"]')).toBeNull();
      expect(client.getQueryData([...queryKeys.issues.list("company-1"), "mine-context", "local-board"])).toBeUndefined();
      expect(apiMocks.issuesList).not.toHaveBeenCalled();
    } finally { await act(() => root.unmount()); client.clear(); }
  });

  it.each(["network", 429, 503] as const)("keeps cached Mine rows and their DOM nodes during a %s aggregate refresh failure", async status => {
    routerMock.location.pathname = "/inbox/mine";
    setIssueRows([createIssue({ title: "Cached readable task" })]);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const root = createRoot(container);
    try {
      await act(() => root.render(<QueryClientProvider client={client}><Inbox /></QueryClientProvider>));
      await vi.waitFor(() => expect(container.textContent).toContain("Cached readable task"));
      const row = container.querySelector("[data-inbox-item]");
      apiMocks.inboxMine.mockRejectedValue(status === "network" ? new TypeError("Failed to fetch") : new ApiError("Refresh unavailable", status, null));
      await act(async () => { await client.invalidateQueries({ queryKey: queryKeys.issues.listMineByMe("company-1") }); });
      expect(document.body.textContent).not.toContain("Some inbox items couldn’t load.");
      expect(container.querySelector("[data-inbox-item]")).toBe(row);
      expect(container.textContent).toContain("Cached readable task");
      expect(container.querySelector('[aria-label="Loading tasks"]')).toBeNull();
      expect(apiMocks.inboxMine).toHaveBeenCalledTimes(2);
    } finally { await act(() => root.unmount()); client.clear(); }
  });

  it.each([401, 403])("hides cached Mine rows after a %s access denial", async status => {
    routerMock.location.pathname = "/inbox/mine";
    setIssueRows([createIssue({ title: "Previously accessible private task" })]);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const root = createRoot(container);
    const message = `Company access denied (${status})`;
    try {
      await act(() => root.render(<QueryClientProvider client={client}><Inbox /></QueryClientProvider>));
      await vi.waitFor(() => expect(container.textContent).toContain("Previously accessible private task"));
      apiMocks.inboxMine.mockRejectedValue(new ApiError(message, status, null));
      await act(async () => { await client.invalidateQueries({ queryKey: queryKeys.issues.listMineByMe("company-1") }); });
      await vi.waitFor(() => expect(container.textContent).toContain(message));
      expect(container.textContent).not.toContain("Previously accessible private task");
      expect(container.querySelectorAll("[data-inbox-item]")).toHaveLength(0);
      expect(container.querySelector('[aria-label="Loading tasks"]')).toBeNull();
      expect(apiMocks.inboxMine).toHaveBeenCalledTimes(2);
      expect(apiMocks.inboxMine).toHaveBeenLastCalledWith("company-1", expect.anything());
    } finally { await act(() => root.unmount()); client.clear(); }
  });

  it("fails closed when a refresh returns another account's bundle despite cached Mine rows", async () => {
    routerMock.location.pathname = "/inbox/mine";
    setIssueRows([createIssue({ title: "Previous authenticated task" })]);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const root = createRoot(container);
    try {
      await act(() => root.render(<QueryClientProvider client={client}><Inbox /></QueryClientProvider>));
      await vi.waitFor(() => expect(container.textContent).toContain("Previous authenticated task"));
      apiMocks.inboxMine.mockResolvedValue(createMineSnapshot({
        userId: "another-account", issues: [createIssue({ title: "Another account secret" })],
      }));
      await act(async () => { await client.invalidateQueries({ queryKey: queryKeys.issues.listMineByMe("company-1") }); });
      await vi.waitFor(() => {
        expect(container.textContent).toContain("Your account changed. Refresh the inbox.");
        expect(apiMocks.authSession).toHaveBeenCalledTimes(2);
      });
      expect(container.textContent).not.toContain("Previous authenticated task");
      expect(container.textContent).not.toContain("Another account secret");
      expect(client.getQueryData<InboxMineSnapshot>([...queryKeys.issues.list("company-1"), "mine-context", "local-board"])?.userId).toBe("local-board");
    } finally { await act(() => root.unmount()); client.clear(); }
  });

  it("isolates an account switch from a late response for the previous account", async () => {
    routerMock.location.pathname = "/inbox/mine";
    const previous = createDeferred<InboxMineSnapshot>();
    const next = createDeferred<InboxMineSnapshot>();
    apiMocks.inboxMine.mockReturnValueOnce(previous.promise).mockReturnValueOnce(next.promise);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const root = createRoot(container);
    try {
      await act(() => root.render(<QueryClientProvider client={client}><Inbox /></QueryClientProvider>));
      await vi.waitFor(() => expect(apiMocks.inboxMine).toHaveBeenCalledOnce());
      await act(() => { client.setQueryData(queryKeys.auth.session, { user: { id: "next-account" }, session: { userId: "next-account" } }); });
      await vi.waitFor(() => expect(apiMocks.inboxMine).toHaveBeenCalledTimes(2));
      await act(() => next.resolve(createMineSnapshot({ userId: "next-account", issues: [createIssue({ title: "Next account task" })] })));
      await vi.waitFor(() => expect(container.textContent).toContain("Next account task"));
      await act(() => previous.resolve(createMineSnapshot({ issues: [createIssue({ title: "Previous account secret" })] })));
      await vi.waitFor(() => expect(client.isFetching()).toBe(0));
      expect(container.textContent).toContain("Next account task");
      expect(container.textContent).not.toContain("Previous account secret");
      expect(client.getQueryData<InboxMineSnapshot>([...queryKeys.issues.list("company-1"), "mine-context", "next-account"])?.userId).toBe("next-account");
    } finally { await act(() => root.unmount()); client.clear(); }
  });

  it("holds the initial reveal barrier for a new account in the same company", async () => {
    routerMock.location.pathname = "/inbox/mine";
    setIssueRows([createIssue({ title: "First account task" })]);
    const next = createDeferred<InboxMineSnapshot>();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const root = createRoot(container);
    try {
      await act(() => root.render(<QueryClientProvider client={client}><Inbox /></QueryClientProvider>));
      await vi.waitFor(() => expect(container.textContent).toContain("First account task"));
      apiMocks.inboxMine.mockReturnValue(next.promise);
      await act(() => { client.setQueryData(queryKeys.auth.session, { user: { id: "next-account" }, session: { userId: "next-account" } }); });
      await vi.waitFor(() => expect(apiMocks.inboxMine).toHaveBeenCalledTimes(2));
      expect(container.querySelector('[aria-label="Loading tasks"]')).not.toBeNull();
      expect(container.querySelectorAll("[data-inbox-item]")).toHaveLength(0);
      expect(container.textContent).not.toContain("First account task");
      expect(container.textContent).not.toContain("Inbox zero.");
      await act(() => next.resolve(createMineSnapshot({
        userId: "next-account", issues: [createIssue({ title: "Second account task" })],
      })));
      await vi.waitFor(() => expect(container.textContent).toContain("Second account task"));
      expect(container.querySelector('[aria-label="Loading tasks"]')).toBeNull();
    } finally { await act(() => root.unmount()); client.clear(); }
  });

  it("keeps aggregate context scoped to the selected company", async () => {
    routerMock.location.pathname = "/inbox/mine";
    apiMocks.inboxMine.mockImplementation(async companyId => createMineSnapshot({
      issues: [createIssue({ id: `task-${companyId}`, companyId, title: `Task for ${companyId}` })],
    }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const root = createRoot(container);
    const render = () => root.render(<QueryClientProvider client={client}><Inbox /></QueryClientProvider>);
    try {
      await act(render);
      await vi.waitFor(() => expect(container.textContent).toContain("Task for company-1"));
      companyState.selectedCompanyId = "company-2";
      await act(render);
      await vi.waitFor(() => expect(container.textContent).toContain("Task for company-2"));
      expect(container.textContent).not.toContain("Task for company-1");
      expect(apiMocks.inboxMine).toHaveBeenCalledWith("company-2", expect.objectContaining({ signal: expect.any(AbortSignal) }));
      expect(client.getQueryData<InboxMineSnapshot>([...queryKeys.issues.list("company-2"), "mine-context", "local-board"])?.issues[0]?.companyId).toBe("company-2");
    } finally { await act(() => root.unmount()); client.clear(); }
  });

  it("cannot reuse another account's private parent caption in a cached Mine fallback", async () => {
    routerMock.location.pathname = "/inbox/mine";
    localStorage.setItem("paperclip:inbox:nesting", "false");
    localStorage.setItem(taskCollectionPreferencesStorageKey({ companyId: "company-1", collectionKey: "inbox" }), JSON.stringify({
      version: 1, companyId: "company-1", collectionKey: "inbox", columns: ["parent"], viewState: {},
    }));
    const parent = createIssue({ id: "private-parent", title: "First account private caption", identifier: "PAP-SECRET", listProjection: "index" });
    const child = createIssue({ id: "shared-child", title: "Cached fallback child", parentId: parent.id, listProjection: "index" });
    const pendingParent = createDeferred<Issue[]>();
    const pendingBundle = createDeferred<InboxMineSnapshot>();
    let switched = false;
    apiMocks.inboxMine.mockRejectedValueOnce(new ApiError("tenant_app_unavailable", 503, null)).mockReturnValueOnce(pendingBundle.promise);
    apiMocks.issuesList.mockImplementation((_company, filters) => {
      if (filters.ids?.includes(parent.id)) return switched ? pendingParent.promise : Promise.resolve([parent]);
      return Promise.resolve([child]);
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
    client.setQueryData(queryKeys.auth.session, { user: { id: "local-board" }, session: { userId: "local-board" } });
    const sourceKey = (userId: string) => [...queryKeys.issues.listMineByMe("company-1"), "index", "with-routine-executions", "live-descendant-summary", 100, userId];
    client.setQueryData(sourceKey("local-board"), [child]);
    const root = createRoot(container);
    try {
      await act(() => root.render(<QueryClientProvider client={client}><Inbox /></QueryClientProvider>));
      await vi.waitFor(() => expect(container.querySelector(`[title="${parent.title}"]`)?.textContent).toBe(parent.identifier));
      switched = true;
      client.setQueryData(sourceKey("next-account"), [child]);
      await act(() => { client.setQueryData(queryKeys.auth.session, { user: { id: "next-account" }, session: { userId: "next-account" } }); });
      await vi.waitFor(() => expect(apiMocks.inboxMine).toHaveBeenCalledTimes(2));
      expect(apiMocks.issuesList.mock.calls.filter(([, filters]) => filters.ids?.includes(parent.id))).toHaveLength(1);
      expect(container.querySelector(`[title="${parent.title}"]`)).toBeNull();
      await act(() => pendingBundle.reject(new ApiError("tenant_app_unavailable", 503, null)));
      await vi.waitFor(() => expect(apiMocks.issuesList.mock.calls.filter(([, filters]) => filters.ids?.includes(parent.id))).toHaveLength(2));
      expect(container.querySelector(`[title="${parent.title}"]`)).toBeNull();
      expect(container.textContent).not.toContain(parent.identifier);
      await act(() => pendingParent.resolve([]));
      await vi.waitFor(() => expect(container.textContent).toContain(child.title));
      expect(container.querySelector(`[title="${parent.title}"]`)).toBeNull();
      expect(container.textContent).not.toContain(parent.identifier);
    } finally { await act(() => root.unmount()); client.clear(); }
  });

  it("cannot reuse another account's resolved rich state for a fallback failure", async () => {
    routerMock.location.pathname = "/inbox/recent";
    const task = createIssue({ id: "private-failure-task", title: "First account failure context", listProjection: "rows" });
    const failure = createFailedRun({ issueId: task.id });
    setFailureRuns([failure]);
    const pendingContext = createDeferred<Issue[]>();
    let switched = false;
    apiMocks.issuesList.mockImplementation((_company, filters) => {
      if (!filters.ids?.includes(task.id)) return Promise.resolve([]);
      return switched ? pendingContext.promise : Promise.resolve([{ ...task, interruption: {
        intentId: "private-resolved", responsibility: "system", state: "resolved", nextRetryAt: null,
        canRetry: false, userAction: null, sourceRunIds: [failure.id], observedRunId: failure.id,
      } }]);
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: 0 } } });
    const root = createRoot(container);
    try {
      await act(() => root.render(<QueryClientProvider client={client}><Inbox /></QueryClientProvider>));
      await vi.waitFor(() => expect(client.isFetching()).toBe(0));
      expect(container.querySelector(`a[href="/issues/${task.id}"]`)).toBeNull();
      switched = true;
      await act(() => { client.setQueryData(queryKeys.auth.session, { user: { id: "next-account" }, session: { userId: "next-account" } }); });
      await vi.waitFor(() => expect(apiMocks.issuesList.mock.calls.filter(([, filters]) => filters.ids?.includes(task.id))).toHaveLength(2));
      expect(container.textContent).not.toContain(task.title);
      await act(() => pendingContext.resolve([]));
      await vi.waitFor(() => expect(container.querySelector(`a[href="/issues/${task.id}"]`)).not.toBeNull());
      expect(container.textContent).not.toContain(task.title);
    } finally { await act(() => root.unmount()); client.clear(); }
  });

  it("loads only missing parent metadata before revealing Recent", async () => {
    routerMock.location.pathname = "/inbox/recent";
    localStorage.setItem(taskCollectionPreferencesStorageKey({ companyId: "company-1", collectionKey: "inbox" }), JSON.stringify({
      version: 1, companyId: "company-1", collectionKey: "inbox", columns: ["parent"], viewState: {},
    }));
    const loadedParent = createIssue({ id: "loaded-parent", title: "Loaded parent", listProjection: "index" });
    const missingParent = createIssue({ id: "missing-parent", title: "Missing parent", identifier: "PAP-2000", listProjection: "index" });
    const rows = [loadedParent,
      createIssue({ id: "child-a", parentId: loadedParent.id, title: "First child", listProjection: "index" }),
      createIssue({ id: "child-b", parentId: missingParent.id, title: "Second child", listProjection: "index" }),
    ];
    let releaseParent!: (rows: Issue[]) => void;
    const pendingParent = new Promise<Issue[]>(resolve => { releaseParent = resolve; });
    apiMocks.issuesList.mockImplementation((_company, filters) => {
      if (!filters.ids) return Promise.resolve(rows);
      if (filters.ids.includes(missingParent.id)) return pendingParent;
      return Promise.resolve(rows.filter(row => filters.ids.includes(row.id)));
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const root = createRoot(container);
    try {
      await act(() => root.render(<QueryClientProvider client={client}><Inbox /></QueryClientProvider>));
      await vi.waitFor(() => expect(apiMocks.issuesList.mock.calls.some(([, filters]) => filters.ids?.includes(missingParent.id))).toBe(true));
      expect(container.querySelectorAll("[data-inbox-item]")).toHaveLength(0);
      expect(apiMocks.issuesList).toHaveBeenCalledWith("company-1", expect.objectContaining({
        ids: [missingParent.id], projection: "index",
      }), expect.anything());
      await act(() => releaseParent([missingParent]));
      await vi.waitFor(() => expect(container.textContent).toContain("Second child"));
      // Rich visible-row reads still happen after reveal, but never include a
      // context-only parent or precede the structural metadata response.
      expect(apiMocks.issuesList.mock.calls.filter(([, filters]) => filters.ids?.includes(missingParent.id))).toHaveLength(1);
      expect(container.querySelectorAll("[data-inbox-item]")).toHaveLength(3);
      expect(container.querySelector(`[title="${missingParent.title}"]`)?.textContent).toBe(missingParent.identifier);
    } finally { await act(() => root.unmount()); client.clear(); }
  });

  it("discards old parent context when a refreshed index supplies the parent", async () => {
    routerMock.location.pathname = "/inbox/recent";
    localStorage.setItem("paperclip:inbox:nesting", "false");
    localStorage.setItem(taskCollectionPreferencesStorageKey({ companyId: "company-1", collectionKey: "inbox" }), JSON.stringify({
      version: 1, companyId: "company-1", collectionKey: "inbox", columns: ["parent"], viewState: {},
    }));
    const parent = createIssue({ id: "parent", title: "Old parent caption", identifier: "PAP-2000", listProjection: "index" });
    const child = createIssue({ id: "child", parentId: parent.id, title: "Readable child", listProjection: "index" });
    let source = [child];
    apiMocks.issuesList.mockImplementation((_company, filters) => !filters.ids
      ? Promise.resolve(source) : Promise.resolve(filters.ids.includes(parent.id) ? [parent] : [child]));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: 0 } } });
    const root = createRoot(container);
    try {
      await act(() => root.render(<QueryClientProvider client={client}><Inbox /></QueryClientProvider>));
      await vi.waitFor(() => expect(container.querySelector(`[title="${parent.title}"]`)?.textContent).toBe(parent.identifier));
      source = [{ ...parent, title: "Fresh indexed caption", identifier: "PAP-2001" }, child];
      await act(() => { client.setQueriesData({ predicate: query => query.queryKey.includes("live-descendant-summary") }, source); });
      await vi.waitFor(() => expect(container.querySelector('[title="Fresh indexed caption"]')?.textContent).toBe("PAP-2001"));
      expect(container.querySelector(`[title="${parent.title}"]`)).toBeNull();
      expect(apiMocks.issuesList.mock.calls.filter(([, filters]) => filters.projection === "index" && filters.ids?.includes(parent.id))).toHaveLength(1);
    } finally { await act(() => root.unmount()); client.clear(); }
  });

  it.each([true, false])("waits for failure context even when its parent is already indexed=%s", async (indexed) => {
    routerMock.location.pathname = "/inbox/recent";
    const parent = createIssue({ id: "parent", title: "Parent metadata", listProjection: "index" });
    const child = createIssue({ id: "child", parentId: parent.id, title: "Readable child", listProjection: "index" });
    const failure = createFailedRun({ issueId: parent.id, responsibleUserId: "local-board" });
    setFailureRuns([failure]);
    let releaseFailure!: (rows: Issue[]) => void;
    const pendingFailure = new Promise<Issue[]>(resolve => { releaseFailure = resolve; });
    apiMocks.issuesList.mockImplementation((_company, filters) => !filters.ids
      ? Promise.resolve(indexed ? [parent, child] : [child])
      : filters.ids.includes(parent.id) ? pendingFailure : Promise.resolve([child]));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const root = createRoot(container);
    try {
      await act(() => root.render(<QueryClientProvider client={client}><Inbox /></QueryClientProvider>));
      await vi.waitFor(() => expect(apiMocks.issuesList).toHaveBeenCalledWith("company-1", expect.objectContaining({
        ids: [parent.id], projection: "rows",
      }), expect.anything()));
      expect(container.querySelectorAll("[data-inbox-item]")).toHaveLength(0);
      expect(apiMocks.issuesList.mock.calls.filter(([, filters]) => filters.ids && filters.projection === "index")).toHaveLength(0);
      await act(() => releaseFailure([{ ...parent, interruption: {
        intentId: "saved-input", responsibility: "system", state: "resolved", nextRetryAt: null,
        canRetry: false, userAction: null, sourceRunIds: [failure.id], observedRunId: failure.id,
      } }]));
      await vi.waitFor(() => expect(container.textContent).toContain(child.title));
      expect(container.querySelectorAll("[data-inbox-item]")).toHaveLength(indexed ? 2 : 1);
    } finally { await act(() => root.unmount()); client.clear(); }
  });

  it.each([
    ["a replaced attempt", { accepted: false, stale: true, requestId: null }, "already replaced"],
    ["a held scheduled retry", { accepted: true, stale: false, requestId: "retry",
      scheduledRetry: { outcome: "gate_suppressed", message: "The company budget is paused." } }, "The company budget is paused."],
  ])("shows why an Inbox Retry did not start work for %s and does not open the task as if it did", async (_label, result, reason) => {
    routerMock.location.pathname = "/inbox/recent";
    const task = createIssue({ id: "task-1", title: "Failed task" });
    const failure = createFailedRun({ issueId: task.id, responsibleUserId: "local-board" });
    setFailureRuns([failure]);
    apiMocks.issuesList.mockResolvedValue([{ ...task, interruption: { intentId: "intent", responsibility: "system",
      state: "failed", nextRetryAt: null, canRetry: true, userAction: null, sourceRunIds: [failure.id], observedRunId: failure.id } }]);
    apiMocks.retryTask.mockResolvedValue({ ...result, presentation: null });
    toastMocks.pushToast.mockClear();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
    const root = createRoot(container);
    try {
      await act(() => root.render(<QueryClientProvider client={client}><Inbox /></QueryClientProvider>));
      const retry = await vi.waitFor(() => {
        const button = Array.from(container.querySelectorAll("button")).find(candidate => candidate.textContent === "Retry");
        expect(button).toBeTruthy();
        return button!;
      });
      await act(async () => retry.click());
      await vi.waitFor(() => expect(toastMocks.pushToast).toHaveBeenCalledWith(expect.objectContaining({
        tone: "error", body: expect.stringContaining(reason) })));
      expect(apiMocks.retryTask).toHaveBeenCalledWith(task.id, expect.objectContaining({ observedRunId: failure.id }));
      expect(routerMock.navigate).not.toHaveBeenCalled();
    } finally { await act(() => root.unmount()); client.clear(); }
  });

  it("upgrades cached parent metadata when the same task becomes a failure context", async () => {
    routerMock.location.pathname = "/inbox/recent";
    const parent = createIssue({ id: "parent", title: "Parent metadata", listProjection: "index" });
    const child = createIssue({ id: "child", parentId: parent.id, title: "Readable child", listProjection: "index" });
    const failure = createFailedRun({ issueId: parent.id, responsibleUserId: "local-board" });
    const resolved = { ...parent, listProjection: "rows" as const, interruption: {
      intentId: "saved-input", responsibility: "system" as const, state: "resolved" as const,
      nextRetryAt: null, canRetry: false, userAction: null, sourceRunIds: [failure.id], observedRunId: failure.id,
    } };
    let releaseFailure!: (rows: Issue[]) => void;
    const pendingFailure = new Promise<Issue[]>(resolve => { releaseFailure = resolve; });
    apiMocks.issuesList.mockImplementation((_company, filters) => {
      if (!filters.ids) return Promise.resolve([child]);
      if (filters.ids.includes(parent.id)) return filters.projection === "rows" ? pendingFailure : Promise.resolve([parent]);
      return Promise.resolve([child]);
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: 0 } } });
    const root = createRoot(container);
    try {
      await act(() => root.render(<QueryClientProvider client={client}><Inbox /></QueryClientProvider>));
      await vi.waitFor(() => expect(container.textContent).toContain(child.title));
      // The union of context IDs is unchanged when this parent becomes a failed
      // task. It must still fetch interruption state instead of reusing index.
      await act(() => { client.setQueriesData({ queryKey: queryKeys.heartbeats("company-1") }, [failure]); });
      await vi.waitFor(() => expect(apiMocks.issuesList).toHaveBeenCalledWith("company-1", expect.objectContaining({
        ids: [parent.id], projection: "rows",
      }), expect.anything()));
      expect(container.querySelectorAll("[data-inbox-item]")).toHaveLength(1);
      await act(() => releaseFailure([resolved]));
      await vi.waitFor(() => expect(client.isFetching()).toBe(0));
      expect(container.textContent).toContain(child.title);
      expect(container.querySelectorAll("[data-inbox-item]")).toHaveLength(1);
    } finally { await act(() => root.unmount()); client.clear(); }
  });

  it("reveals an empty view after leaving a Mine view with parent context", async () => {
    routerMock.location.pathname = "/inbox/mine";
    const parent = createIssue({ id: "parent", title: "Parent metadata", listProjection: "index" });
    const child = createIssue({ id: "child", parentId: parent.id, title: "Mine child", listProjection: "index" });
    mineFixture = createMineSnapshot({ issues: [child], contextIssues: [parent] });
    apiMocks.issuesList.mockImplementation((_company, filters) => Promise.resolve(filters.ids ? [parent] : []));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const root = createRoot(container);
    try {
      await act(() => root.render(<QueryClientProvider client={client}><Inbox tab="mine" /></QueryClientProvider>));
      await vi.waitFor(() => expect(container.textContent).toContain(child.title));
      routerMock.location.pathname = "/inbox/recent";
      await act(() => root.render(<QueryClientProvider client={client}><Inbox tab="recent" /></QueryClientProvider>));
      await vi.waitFor(() => expect(container.textContent).toContain("No recent inbox items."));
      expect(container.querySelector('[aria-label="Loading tasks"]')).toBeNull();
    } finally { await act(() => root.unmount()); client.clear(); }
  });

  it("waits for rich failure state when heartbeat data arrives after parent captions", async () => {
    routerMock.location.pathname = "/inbox/recent";
    const parent = createIssue({ id: "parent", title: "Parent metadata", listProjection: "index" });
    const child = createIssue({ id: "child", parentId: parent.id, title: "Mine child", listProjection: "index" });
    const failure = createFailedRun({ issueId: parent.id, responsibleUserId: "local-board" });
    let releaseRuns!: (rows: HeartbeatRun[]) => void;
    apiMocks.heartbeatRunsList.mockImplementation(() => new Promise(resolve => { releaseRuns = resolve; }));
    let releaseFailure!: (rows: Issue[]) => void;
    const pendingFailure = new Promise<Issue[]>(resolve => { releaseFailure = resolve; });
    apiMocks.issuesList.mockImplementation((_company, filters) => !filters.ids ? Promise.resolve([child])
      : filters.projection === "index" ? Promise.resolve([parent]) : filters.ids.includes(parent.id) ? pendingFailure : Promise.resolve([child]));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const root = createRoot(container);
    try {
      await act(() => root.render(<QueryClientProvider client={client}><Inbox /></QueryClientProvider>));
      await vi.waitFor(() => expect(client.isFetching()).toBe(1));
      expect(container.querySelectorAll("[data-inbox-item]")).toHaveLength(0);
      await act(() => releaseRuns([failure]));
      await vi.waitFor(() => expect(apiMocks.issuesList).toHaveBeenCalledWith("company-1", expect.objectContaining({
        ids: [parent.id], projection: "rows",
      }), expect.anything()));
      expect(container.querySelectorAll("[data-inbox-item]")).toHaveLength(0);
      await act(() => releaseFailure([{ ...parent, interruption: {
        intentId: "saved-input", responsibility: "system", state: "resolved", nextRetryAt: null,
        canRetry: false, userAction: null, sourceRunIds: [failure.id], observedRunId: failure.id,
      } }]));
      await vi.waitFor(() => expect(container.textContent).toContain(child.title));
      expect(container.querySelectorAll("[data-inbox-item]")).toHaveLength(1);
    } finally { await act(() => root.unmount()); client.clear(); }
  });

  it("keeps known missing-task failures visible while new failure context is pending", async () => {
    routerMock.location.pathname = "/inbox/recent";
    const child = createIssue({ title: "Readable task", listProjection: "index" });
    const first = createFailedRun({ id: "failure-a", issueId: "missing-a", agentId: "agent-a", responsibleUserId: "local-board" });
    const second = createFailedRun({ id: "failure-b", issueId: "missing-b", agentId: "agent-b", responsibleUserId: "local-board" });
    setFailureRuns([first]);
    let releaseFailures!: (rows: Issue[]) => void;
    const pendingFailures = new Promise<Issue[]>(resolve => { releaseFailures = resolve; });
    apiMocks.issuesList.mockImplementation((_company, filters) => !filters.ids ? Promise.resolve([child])
      : filters.ids.includes(second.issueId) ? pendingFailures : Promise.resolve([]));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const root = createRoot(container);
    try {
      await act(() => root.render(<QueryClientProvider client={client}><Inbox /></QueryClientProvider>));
      await vi.waitFor(() => expect(container.querySelector('a[href="/issues/missing-a"]')).not.toBeNull());
      const node = container.querySelector('a[href="/issues/missing-a"]');
      await act(() => { client.setQueriesData({ queryKey: queryKeys.heartbeats("company-1") }, [first, second]); });
      await vi.waitFor(() => expect(apiMocks.issuesList).toHaveBeenCalledWith("company-1", expect.objectContaining({
        ids: [first.issueId, second.issueId], projection: "rows",
      }), expect.anything()));
      expect(container.querySelector('a[href="/issues/missing-a"]')).toBe(node);
      expect(container.querySelector('a[href="/issues/missing-b"]')).toBeNull();
      expect(container.textContent).toContain(child.title);
      await act(() => releaseFailures([]));
      await vi.waitFor(() => expect(container.querySelector('a[href="/issues/missing-b"]')).not.toBeNull());
      expect(container.querySelectorAll("[data-inbox-item]")).toHaveLength(3);
    } finally { await act(() => root.unmount()); client.clear(); }
  });

  it("keeps more than 25 description-only matches in Mine with archive actions", async () => {
    routerMock.location.pathname = "/inbox/mine";
    const rows = Array.from({ length: 30 }, (_, index) => createIssue({ id: `source-${index}`, title: `Source task ${index}`, identifier: `PAP-${index}`, listProjection: "index" }));
    mineFixture = createMineSnapshot({ issues: rows });
    apiMocks.issuesList.mockImplementation((_company, filters) => Promise.resolve(filters.q && !filters.ids ? [] : rows));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const root = createRoot(container);
    await act(() => root.render(<QueryClientProvider client={queryClient}><Inbox /></QueryClientProvider>));
    await vi.waitFor(() => expect(container.querySelectorAll('[data-inbox-item]')).toHaveLength(30));
    await act(() => {
      const input = container.querySelector<HTMLInputElement>('input[type="search"]')!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "only-in-description");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await vi.waitFor(() => expect(apiMocks.issuesList).toHaveBeenCalledWith("company-1", expect.objectContaining({ q: "only-in-description", ids: expect.arrayContaining(rows.map((row) => row.id)), projection: "index", limit: 100 }), expect.anything()));
    await vi.waitFor(() => expect(container.querySelectorAll('[data-inbox-item]')).toHaveLength(30));
    expect(container.querySelectorAll('button[aria-label="Archive"]')).toHaveLength(30);
    expect(container.textContent).not.toContain("Other matching tasks");
    act(() => root.unmount());
  });

  it("keeps rows readable and offers retry when optional details fail", async () => {
    routerMock.location.pathname = "/inbox/mine";
    let failDetails = true;
    mineFixture = createMineSnapshot({ issues: [createIssue({ title: "Readable task" })] });
    apiMocks.issuesList.mockImplementation((_company, filters) => filters.projection === "rows" && failDetails
      ? Promise.reject(new Error("Details unavailable")) : Promise.resolve([createIssue({ title: "Readable task" })]));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const root = createRoot(container);
    await act(() => root.render(<QueryClientProvider client={queryClient}><Inbox /></QueryClientProvider>));
    await vi.waitFor(() => expect(document.body.textContent).toContain("Some task details couldn’t load."));
    expect(container.textContent).toContain("Readable task");
    failDetails = false;
    await act(() => Array.from(document.body.querySelectorAll('button')).find((button) => button.textContent === "Retry details")!.click());
    await vi.waitFor(() => expect(document.body.textContent).not.toContain("Some task details couldn’t load."));
    expect(container.textContent).toContain("Readable task");
    act(() => root.unmount());
  });

  it("refreshes diagnostics when a visible index row changes without changing its ID", async () => {
    routerMock.location.pathname = "/inbox/mine";
    const row = createIssue({ title: "Live task", listProjection: "index" });
    setIssueRows([row]);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const root = createRoot(container);
    await act(() => root.render(<QueryClientProvider client={queryClient}><Inbox /></QueryClientProvider>));
    const detailsReads = () => apiMocks.issuesList.mock.calls.filter(([, filters]) => filters.projection === "rows").length;
    await vi.waitFor(() => expect(detailsReads()).toBe(1));
    const updated = { ...row, updatedAt: new Date(new Date(row.updatedAt).getTime() + 1000) };
    setIssueRows([updated]);
    await act(() => {
      queryClient.setQueriesData({ predicate: (query) => query.queryKey.includes("index") }, [updated]);
    });
    await vi.waitFor(() => expect(detailsReads()).toBe(2));
    expect(container.textContent).toContain("Live task");
    act(() => root.unmount());
  });

  it.each(["approvalsList", "joinRequestsList", "failureError", "contextError"] as const)(
    "keeps available tasks visible when %s fails and during retry", async (source) => {
      routerMock.location.pathname = "/inbox/mine";
      setIssueRows([createIssue({ title: "Available task" })]);
      const bundled = source === "failureError" || source === "contextError";
      if (bundled) mineFixture = { ...mineFixture, [source]: { status: 403, message: "Optional source access denied" } };
      else apiMocks[source].mockRejectedValue(new Error("Optional source unavailable"));
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
      const root = createRoot(container);
      try {
        await act(() => root.render(<QueryClientProvider client={queryClient}><Inbox /></QueryClientProvider>));
        await vi.waitFor(() => expect(container.textContent).toContain("Available task"));
        expect(document.body.textContent).toContain("Some inbox items couldn’t load.");
        const row = container.querySelector("[data-inbox-item]");
        const retry = createDeferred<InboxMineSnapshot | []>();
        if (bundled) apiMocks.inboxMine.mockReturnValue(retry.promise);
        else apiMocks[source].mockReturnValue(retry.promise);
        await act(() => Array.from(document.body.querySelectorAll("button")).find(button => button.textContent === "Retry missing items")!.click());
        await vi.waitFor(() => expect(bundled ? apiMocks.inboxMine : apiMocks[source]).toHaveBeenCalledTimes(2));
        expect(container.querySelector("[data-inbox-item]")).toBe(row);
        expect(container.querySelector('[aria-label="Loading tasks"]')).toBeNull();
        await act(() => retry.resolve(bundled ? createMineSnapshot({ issues: mineFixture.issues }) : []));
        await vi.waitFor(() => expect(document.body.textContent).not.toContain("Some inbox items couldn’t load."));
        if (bundled) expect(apiMocks.heartbeatRunsList).not.toHaveBeenCalled();
      } finally { await act(() => root.unmount()); queryClient.clear(); }
    },
  );

  it.each([429, 503])("offers retry after an initial %s when the server remains reachable", async status => {
    routerMock.location.pathname = "/inbox/mine";
    apiMocks.inboxMine.mockRejectedValue(new ApiError("temporarily_unavailable", status, null));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const root = createRoot(container);
    try {
      await act(() => root.render(<QueryClientProvider client={client}><Inbox /></QueryClientProvider>));
      await vi.waitFor(() => expect(container.querySelector('[role="alert"]')).not.toBeNull());
      expect(container.querySelector('[aria-label="Loading tasks"]')).toBeNull();
      expect(container.textContent).not.toContain("temporarily_unavailable");
      apiMocks.inboxMine.mockResolvedValue(createMineSnapshot({ issues: [createIssue({ title: "Recovered task" })] }));
      await act(() => Array.from(container.querySelectorAll("button")).find(button => button.textContent === "Retry")!.click());
      await vi.waitFor(() => expect(container.textContent).toContain("Recovered task"));
      expect(container.querySelector('[role="alert"]')).toBeNull();
    } finally { await act(() => root.unmount()); client.clear(); }
  });

  it.each(["failureError", "contextError"] as const)("automatically recovers a transient %s without hiding loaded tasks", async source => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    routerMock.location.pathname = "/inbox/mine";
    setIssueRows([createIssue({ title: "Available task" })]);
    mineFixture = { ...mineFixture, [source]: { status: 503, message: "tenant_app_unavailable" } };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const root = createRoot(container);
    try {
      await act(() => root.render(<QueryClientProvider client={client}><Inbox /></QueryClientProvider>));
      await vi.waitFor(() => expect(container.textContent).toContain("Available task"));
      expect(document.body.textContent).not.toContain("Some inbox items couldn’t load.");
      expect(document.body.textContent).not.toContain("tenant_app_unavailable");
      const row = container.querySelector("[data-inbox-item]");
      apiMocks.inboxMine.mockResolvedValue(createMineSnapshot({ issues: mineFixture.issues }));
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
      await vi.waitFor(() => expect(apiMocks.inboxMine).toHaveBeenCalledTimes(2));
      expect(client.getQueryData<InboxMineSnapshot>([...queryKeys.issues.list("company-1"), "mine-context", "local-board"])?.[source]).toBeUndefined();
      expect(container.querySelector("[data-inbox-item]")).toBe(row);
      expect(container.textContent).toContain("Available task");
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
      expect(apiMocks.inboxMine).toHaveBeenCalledTimes(2);
    } finally { await act(() => root.unmount()); client.clear(); vi.useRealTimers(); }
  });

  it("shows an error and retry instead of an endless skeleton when a required external status filter fails", async () => {
    routerMock.location.pathname = "/inbox/mine";
    localStorage.setItem(taskCollectionPreferencesStorageKey({ companyId: "company-1", collectionKey: "inbox" }), JSON.stringify({
      version: 1, companyId: "company-1", collectionKey: "inbox", columns: [],
      viewState: { issueFilters: { externalObjectStatuses: ["failed"] } },
    }));
    apiMocks.experimentalSettings.mockResolvedValue({ enableStreamlinedUi: true, enableExternalObjects: true });
    setIssueRows([createIssue()]);
    externalObjectMocks.error = new Error("External statuses unavailable");
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const root = createRoot(container);
    await act(() => root.render(<QueryClientProvider client={queryClient}><Inbox /></QueryClientProvider>));
    await vi.waitFor(() => expect(container.textContent).toContain("External statuses unavailable"));
    expect(container.querySelector('[aria-label="Loading tasks"]')).toBeNull();
    await act(() => Array.from(container.querySelectorAll('button')).find((button) => button.textContent === "Retry")!.click());
    expect(externalObjectMocks.retry).toHaveBeenCalledOnce();
    act(() => root.unmount());
  });

  it("requests live descendant summaries for Recent issue rows", async () => {
    routerMock.location.pathname = "/inbox/recent";

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 0, gcTime: 0 } },
    });
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Inbox />
        </QueryClientProvider>,
      );
    });

    await vi.waitFor(() => expect(apiMocks.issuesList).toHaveBeenCalledTimes(1));
    expect(apiMocks.issuesList).toHaveBeenCalledWith("company-1", expect.objectContaining({
      touchedByUserId: "me", projection: "index",
      includeLiveDescendantSummary: true, limit: 100, sortField: "updated", sortDir: "desc",
    }));

    act(() => {
      root.unmount();
    });
  });

  it("paints row hover via CSS only, without moving React selection state", async () => {
    routerMock.location.pathname = "/inbox/mine";
    const issueA = createIssue({ id: "issue-a", identifier: "PAP-1001", title: "First inbox row" });
    const issueB = createIssue({ id: "issue-b", identifier: "PAP-1002", title: "Second inbox row" });
    setIssueRows([issueA, issueB]);

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 0, gcTime: 0 } },
    });
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Inbox />
        </QueryClientProvider>,
      );
    });
    await vi.waitFor(() => {
      expect(container.querySelectorAll("[data-inbox-item]").length).toBeGreaterThanOrEqual(2);
    });

    const rows = container.querySelectorAll("[data-inbox-item]");

    // The hover wash lives on the IssueRow root band (the overlay link's
    // parent), not the overlay link itself.
    const bandOf = (row: Element): HTMLElement | null =>
      row.querySelector<HTMLAnchorElement>("a[data-inbox-issue-link]")?.parentElement ?? null;

    // Nothing selected before hover — both rows show the hover-accent class.
    expect(bandOf(rows[0]!)?.className).toContain("hover:bg-accent/50");
    expect(bandOf(rows[1]!)?.className).toContain("hover:bg-accent/50");

    // Hovering paints via CSS `:hover` only — it must NOT flip a row into the
    // state-selected band (which would swap to hover:bg-transparent). Coupling
    // hover to React state was the per-hover re-render storm behind the lag;
    // scrubbing the list must not touch selection state. (Keyboard nav that
    // continues from the hovered row is exercised in live/e2e verification.)
    await act(async () => {
      rows[1]!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      rows[1]!.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false }));
    });
    expect(bandOf(rows[0]!)?.className).toContain("hover:bg-accent/50");
    expect(bandOf(rows[1]!)?.className).toContain("hover:bg-accent/50");
    expect(bandOf(rows[1]!)?.className).not.toContain("hover:bg-transparent");

    act(() => {
      root.unmount();
    });
  });

  describe("optional reads and the reveal gate", () => {
    const renderInbox = async (client: QueryClient, root: ReturnType<typeof createRoot>) => {
      await act(async () => {
        root.render(<QueryClientProvider client={client}><Inbox /></QueryClientProvider>);
      });
    };
    const rowKeys = () => [...container.querySelectorAll("[data-inbox-item]")]
      .map((row) => row.querySelector('[data-slot="task-row-identifier"]')?.textContent ?? "");
    const selectedRowIndex = () => [...container.querySelectorAll("[data-inbox-item]")].findIndex((row) =>
      row.querySelector<HTMLAnchorElement>("a[data-inbox-issue-link]")?.parentElement
        ?.className.split(/\s+/).includes("bg-accent/50"));
    const twoRows = () => {
      const base = new Date("2026-03-11T00:00:00.000Z").getTime();
      setIssueRows([
        createIssue({ id: "issue-a", identifier: "PAP-4001", title: "Directory row A", assigneeUserId: "user-2", lastActivityAt: new Date(base + 2000) }),
        createIssue({ id: "issue-b", identifier: "PAP-4002", title: "Directory row B", assigneeUserId: "user-2", lastActivityAt: new Date(base + 1000) }),
      ]);
    };

    it("reveals rows while the user directory is pending and keeps their order and selection when it arrives", async () => {
      routerMock.location.pathname = "/inbox/mine";
      twoRows();
      let resolveDirectory: (value: unknown) => void = () => {};
      apiMocks.userDirectoryList.mockReturnValue(new Promise((resolve) => { resolveDirectory = resolve; }));
      const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
      const root = createRoot(container);
      try {
        await renderInbox(client, root);
        await vi.waitFor(() => expect(rowKeys()).toEqual(["PAP-4001", "PAP-4002"]));
        for (let press = 0; press < 2; press += 1) {
          await act(async () => {
            document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true }));
          });
        }
        expect(selectedRowIndex()).toBe(1);
        const rowNodes = [...container.querySelectorAll("[data-inbox-item]")];

        await act(async () => {
          resolveDirectory({ users: [{ principalId: "user-2", user: { id: "user-2", name: "Robin Directory", email: "robin@example.test", image: null } }] });
        });

        expect(rowKeys()).toEqual(["PAP-4001", "PAP-4002"]);
        expect([...container.querySelectorAll("[data-inbox-item]")]).toEqual(rowNodes);
        expect(selectedRowIndex()).toBe(1);
      } finally { await act(() => root.unmount()); client.clear(); }
    });

    it("waits for the user directory when rows are grouped by assignee", async () => {
      routerMock.location.pathname = "/inbox/mine";
      localStorage.setItem("paperclip:inbox:group-by", "assignee");
      twoRows();
      let resolveDirectory: (value: unknown) => void = () => {};
      apiMocks.userDirectoryList.mockReturnValue(new Promise((resolve) => { resolveDirectory = resolve; }));
      const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
      const root = createRoot(container);
      try {
        await renderInbox(client, root);
        await vi.waitFor(() => expect(apiMocks.userDirectoryList).toHaveBeenCalled());
        expect(container.querySelector("[data-inbox-item]")).toBeNull();
        await act(async () => { resolveDirectory({ users: [] }); });
        await vi.waitFor(() => expect(container.textContent).toContain("Directory row A"));
      } finally { await act(() => root.unmount()); client.clear(); }
    });

    it("holds rows for a delayed approvals read so a late approval cannot push them down", async () => {
      routerMock.location.pathname = "/inbox/mine";
      twoRows();
      let resolveApprovals: (value: Approval[]) => void = () => {};
      apiMocks.approvalsList.mockReturnValue(new Promise((resolve) => { resolveApprovals = resolve; }));
      const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
      const root = createRoot(container);
      try {
        await renderInbox(client, root);
        await vi.waitFor(() => {
          const mineQueries = client.getQueryCache().findAll({ queryKey: queryKeys.issues.listMineByMe("company-1") });
          expect(mineQueries.some((query) => query.state.status === "success")).toBe(true);
        });
        expect(container.querySelector("[data-inbox-item]")).toBeNull();
        await act(async () => { resolveApprovals([]); });
        await vi.waitFor(() => expect(rowKeys()).toEqual(["PAP-4001", "PAP-4002"]));
      } finally { await act(() => root.unmount()); client.clear(); }
    });

    it.each([
      ["approvals", () => apiMocks.approvalsList],
      ["join requests", () => apiMocks.joinRequestsList],
    ] as const)("reveals rows and offers a retry when the %s read fails", async (_label, mock) => {
      routerMock.location.pathname = "/inbox/mine";
      twoRows();
      mock().mockRejectedValue(new ApiError("Optional read failed", 500, null));
      const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
      const root = createRoot(container);
      try {
        await renderInbox(client, root);
        await vi.waitFor(() => expect(rowKeys()).toEqual(["PAP-4001", "PAP-4002"]));
        await vi.waitFor(() => expect(document.body.textContent).toContain("Some inbox items couldn’t load."));
        expect(container.querySelector('[aria-label="Loading tasks"]')).toBeNull();
      } finally { await act(() => root.unmount()); client.clear(); }
    });

    it("stops waiting for an approvals read after its first failed attempt while it retries", async () => {
      routerMock.location.pathname = "/inbox/mine";
      twoRows();
      apiMocks.approvalsList
        .mockRejectedValueOnce(new ApiError("Busy", 503, null))
        .mockReturnValue(new Promise(() => {}));
      const client = new QueryClient({ defaultOptions: { queries: { retry: 3, retryDelay: 0, gcTime: 0 } } });
      const root = createRoot(container);
      try {
        await renderInbox(client, root);
        await vi.waitFor(() => expect(apiMocks.approvalsList).toHaveBeenCalledTimes(2));
        await vi.waitFor(() => expect(rowKeys()).toEqual(["PAP-4001", "PAP-4002"]));
      } finally { await act(() => root.unmount()); client.clear(); }
    });

    it.each([
      ["approvals", () => apiMocks.approvalsList],
      ["join requests", () => apiMocks.joinRequestsList],
    ] as const)("shows the missing-items notice when %s keep timing out under the app retry policy", async (_label, mock) => {
      routerMock.location.pathname = "/inbox/mine";
      twoRows();
      mock().mockRejectedValue(new ApiError("Timed out", 408, { error: "TIMEOUT" }));
      const client = new QueryClient({ defaultOptions: { queries: { retry: shouldRetryRequest, retryDelay: 0, gcTime: 0 } } });
      const root = createRoot(container);
      try {
        await renderInbox(client, root);
        await vi.waitFor(() => expect(rowKeys()).toEqual(["PAP-4001", "PAP-4002"]));
        await vi.waitFor(() => expect(document.body.textContent).toContain("Some inbox items couldn’t load."));
        expect(mock().mock.calls.length).toBeGreaterThan(1);
        expect(document.body.textContent).toContain("Retry missing items");
        expect(document.body.textContent).not.toContain("Inbox zero.");
      } finally { await act(() => root.unmount()); client.clear(); }
    });

    describe("returning visit with saved reveal sources", () => {
      const savedApproval = createApproval({ id: "approval-saved", payload: { name: "Saved approval" }, updatedAt: new Date("2026-03-11T00:00:01.500Z") });
      const approvalRowCount = () => container.querySelectorAll('a[href="/approvals/approval-saved"]').length;
      // First visit: every read answers and Mine saves what it showed. Then the
      // optional reads leave the cache, as on a hard load that restored only
      // the saved query cache, and the page mounts again.
      const visitThenReturn = async (client: QueryClient, root: ReturnType<typeof createRoot>) => {
        apiMocks.approvalsList.mockResolvedValue([savedApproval]);
        await renderInbox(client, root);
        await vi.waitFor(() => expect(approvalRowCount()).toBe(1));
        await vi.waitFor(() => expect(client.getQueryData<MineRevealSources>(mineRevealSourcesQueryKey("company-1", "local-board"))?.approvals
          .map((approval) => approval.id)).toEqual(["approval-saved"]));
        await act(async () => root.unmount());
        client.removeQueries({ queryKey: queryKeys.approvals.list("company-1") });
        client.removeQueries({ queryKey: queryKeys.access.joinRequests("company-1") });
        apiMocks.approvalsList.mockClear();
      };
      const client = () => new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });

      it("reveals rows and the saved approval while the reads are pending, then keeps selection when a new approval arrives", async () => {
        routerMock.location.pathname = "/inbox/mine";
        twoRows();
        const queryClient = client();
        let root = createRoot(container);
        try {
          await visitThenReturn(queryClient, root);
          let resolveApprovals: (value: Approval[]) => void = () => {};
          apiMocks.approvalsList.mockReturnValue(new Promise((resolve) => { resolveApprovals = resolve; }));
          apiMocks.joinRequestsList.mockReturnValue(new Promise(() => {}));
          root = createRoot(container);
          await renderInbox(queryClient, root);
          await vi.waitFor(() => expect(apiMocks.approvalsList).toHaveBeenCalled());
          expect(rowKeys().filter(Boolean)).toEqual(["PAP-4001", "PAP-4002"]);
          expect(approvalRowCount()).toBe(1);
          for (let press = 0; press < 3; press += 1) {
            await act(async () => { document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true })); });
          }
          const selectedText = () => [...container.querySelectorAll("[data-inbox-item]")]
            .filter((row) => row.querySelector('[class~="bg-accent/50"]') || row.className.split(/\s+/).includes("bg-accent/50"))
            .map((row) => row.textContent).join(" | ");
          const before = selectedText();
          expect(before).not.toBe("");
          await act(async () => {
            resolveApprovals([savedApproval, createApproval({ id: "approval-new", payload: { name: "Late approval" }, updatedAt: new Date("2026-03-11T00:00:05.000Z") })]);
          });
          await vi.waitFor(() => expect(container.querySelectorAll('a[href="/approvals/approval-new"]').length).toBe(1));
          expect(selectedText()).toBe(before);
        } finally { await act(() => root.unmount()); queryClient.clear(); }
      });

      it("keeps the saved approval through a transient failure and drops it after a refusal", async () => {
        routerMock.location.pathname = "/inbox/mine";
        twoRows();
        const queryClient = client();
        let root = createRoot(container);
        try {
          await visitThenReturn(queryClient, root);
          apiMocks.approvalsList.mockRejectedValue(new ApiError("Busy", 503, null));
          root = createRoot(container);
          await renderInbox(queryClient, root);
          await vi.waitFor(() => expect(apiMocks.approvalsList).toHaveBeenCalled());
          await vi.waitFor(() => expect(queryClient.getQueryState(queryKeys.approvals.list("company-1"))?.status).toBe("error"));
          expect(rowKeys().filter(Boolean)).toEqual(["PAP-4001", "PAP-4002"]);
          expect(approvalRowCount()).toBe(1);
          apiMocks.approvalsList.mockRejectedValue(new ApiError("No access", 403, null));
          await act(async () => { await queryClient.refetchQueries({ queryKey: queryKeys.approvals.list("company-1") }); });
          await vi.waitFor(() => expect(approvalRowCount()).toBe(0));
          expect(rowKeys().filter(Boolean)).toEqual(["PAP-4001", "PAP-4002"]);
        } finally { await act(() => root.unmount()); queryClient.clear(); }
      });

      it("ignores saved sources stamped for another user or company and waits as a first visit does", async () => {
        routerMock.location.pathname = "/inbox/mine";
        twoRows();
        const queryClient = client();
        queryClient.setQueryData(mineRevealSourcesQueryKey("company-1", "local-board"), {
          userId: "someone-else", companyId: "company-1", approvals: [savedApproval], joinRequests: [], dismissals: [],
        } satisfies MineRevealSources);
        apiMocks.approvalsList.mockReturnValue(new Promise(() => {}));
        const root = createRoot(container);
        try {
          await renderInbox(queryClient, root);
          await vi.waitFor(() => {
            const mineQueries = queryClient.getQueryCache().findAll({ queryKey: queryKeys.issues.listMineByMe("company-1") });
            expect(mineQueries.some((query) => query.state.status === "success")).toBe(true);
          });
          expect(container.querySelector("[data-inbox-item]")).toBeNull();
          expect(approvalRowCount()).toBe(0);
        } finally { await act(() => root.unmount()); queryClient.clear(); }
      });
    });

    it("bounds a stalled approvals read so rows do not stay behind a skeleton", async () => {
      routerMock.location.pathname = "/inbox/mine";
      twoRows();
      vi.useFakeTimers({ shouldAdvanceTime: true });
      // The API client turns `timeoutMs` into a 408 TIMEOUT error; model that for the stalled read.
      apiMocks.approvalsList.mockImplementation((_companyId: string, _status: unknown, options?: { timeoutMs?: number }) =>
        new Promise((_resolve, reject) => {
          if (options?.timeoutMs === undefined) return;
          setTimeout(() => reject(new ApiError("Timed out", 408, { error: "TIMEOUT" })), options.timeoutMs);
        }));
      const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
      const root = createRoot(container);
      try {
        await renderInbox(client, root);
        await vi.waitFor(() => expect(apiMocks.approvalsList).toHaveBeenCalled());
        const options = apiMocks.approvalsList.mock.calls[0]?.[2] as { timeoutMs?: number } | undefined;
        expect(options?.timeoutMs).toBeGreaterThan(0);
        expect(container.querySelector("[data-inbox-item]")).toBeNull();
        await act(async () => { vi.advanceTimersByTime(options?.timeoutMs ?? 0); });
        await vi.waitFor(() => expect(rowKeys()).toEqual(["PAP-4001", "PAP-4002"]));
      } finally {
        vi.useRealTimers();
        await act(() => root.unmount());
        client.clear();
      }
    });
  });

  it.each([true, false])("uses bold titles without unread dots (Streamlined UI=%s)", async streamlined => {
    apiMocks.experimentalSettings.mockResolvedValue({ enableIsolatedWorkspaces: false, enableStreamlinedUi: streamlined });
    routerMock.location.pathname = "/inbox/mine";
    // Two sibling leaf rows, one unread and one read, so their leading columns
    // are directly comparable.
    const unread = createIssue({
      id: "issue-unread",
      identifier: "PAP-2001",
      title: "Unread inbox row",
      isUnreadForMe: true,
    });
    const read = createIssue({
      id: "issue-read",
      identifier: "PAP-2002",
      title: "Read inbox row",
      isUnreadForMe: false,
    });
    setIssueRows([unread, read]);

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 0, gcTime: 0 } },
    });
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Inbox />
        </QueryClientProvider>,
      );
    });
    await vi.waitFor(() => {
      expect(container.textContent).toContain("Unread inbox row");
      expect(container.textContent).toContain("Read inbox row");
    });

    const rows = Array.from(container.querySelectorAll("[data-inbox-item]"));
    const rowFor = (text: string) => rows.find((row) => row.textContent?.includes(text));
    const unreadRow = rowFor("Unread inbox row")!;
    const readRow = rowFor("Read inbox row")!;
    expect(unreadRow.querySelector('[data-slot="task-row-title"]')?.className).toContain("font-semibold");
    expect(readRow.querySelector('[data-slot="task-row-title"]')?.className).not.toContain("font-semibold");
    expect(container.querySelector('[data-testid="issue-row-unread-slot"]')).toBeNull();
    expect(container.querySelector('button[aria-label="Mark as read"]')).toBeNull();
    if (streamlined) {
      for (const row of [unreadRow, readRow]) {
        expect(row.querySelector('[data-slot="task-row-disclosure-spacer"]')).not.toBeNull();
      }
    }

    act(() => {
      root.unmount();
    });
  });

  it("keeps hover→j/k selection in sync after the list reshapes (PAP-9679)", async () => {
    routerMock.location.pathname = "/inbox/mine";
    const issueA = createIssue({ id: "issue-a", identifier: "PAP-2001", title: "Sync row A" });
    const issueB = createIssue({ id: "issue-b", identifier: "PAP-2002", title: "Sync row B" });
    const issueC = createIssue({ id: "issue-c", identifier: "PAP-2003", title: "Sync row C" });
    setIssueRows([issueA, issueB, issueC]);

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 0, gcTime: 0 } },
    });
    const root = createRoot(container);

    // Canonical task rows put the selected wash on the root band (the overlay
    // link's parent); find the row with the standalone selected utility.
    const bandOf = (row: Element): HTMLElement | null =>
      row.querySelector<HTMLAnchorElement>("a[data-inbox-issue-link]")?.parentElement ?? null;
    const selectedRowIndex = () =>
      [...container.querySelectorAll("[data-inbox-item]")].findIndex((row) =>
        bandOf(row)?.className.split(/\s+/).includes("bg-accent/50"),
      );

    try {
      await act(async () => {
        root.render(
          <QueryClientProvider client={queryClient}>
            <Inbox />
          </QueryClientProvider>,
        );
      });
      await vi.waitFor(() => {
        expect(container.querySelectorAll("[data-inbox-item]").length).toBeGreaterThanOrEqual(3);
      });

      // Pointer physically moves, then hovers the middle row (index 1).
      await act(async () => {
        window.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
        const rows = container.querySelectorAll("[data-inbox-item]");
        rows[1]!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
        rows[1]!.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false }));
      });

      // A poll reshapes the list (row B's title changes → new nav array) before
      // the keypress. This is what used to null the hovered index and strand
      // j/k back at the top.
      setIssueRows([issueA, { ...issueB, title: "Sync row B (updated)" }, issueC]);
      await act(async () => {
        await queryClient.invalidateQueries();
      });
      await vi.waitFor(() => {
        expect(container.textContent).toContain("Sync row B (updated)");
      });

      // j must continue from the hovered row (index 1) → index 2, not jump to
      // the top of the list.
      await act(async () => {
        document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true }));
      });
      expect(selectedRowIndex()).toBe(2);
    } finally {
      act(() => {
        root.unmount();
      });
    }
  });

  it("holds the inbox order across a reordering poll, then re-sorts at an attention boundary (PAP-16015)", async () => {
    routerMock.location.pathname = "/inbox/mine";
    const base = new Date("2026-03-11T00:00:00.000Z").getTime();
    const issueA = createIssue({
      id: "issue-a",
      identifier: "PAP-3001",
      title: "Pin row A",
      lastActivityAt: new Date(base + 3000),
    });
    const issueB = createIssue({
      id: "issue-b",
      identifier: "PAP-3002",
      title: "Pin row B",
      lastActivityAt: new Date(base + 2000),
    });
    const issueC = createIssue({
      id: "issue-c",
      identifier: "PAP-3003",
      title: "Pin row C",
      lastActivityAt: new Date(base + 1000),
    });
    setIssueRows([issueA, issueB, issueC]);

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 0, gcTime: 0 } },
    });
    const root = createRoot(container);

    // Collapse each displayed row to its A/B/C identity so we can assert order.
    const orderOf = () =>
      [...container.querySelectorAll("[data-inbox-item]")].flatMap((row) => {
        const text = row.textContent ?? "";
        if (text.includes("Pin row A")) return ["A"];
        if (text.includes("Pin row B")) return ["B"];
        if (text.includes("Pin row C")) return ["C"];
        return [];
      });

    const visibilityDescriptor = Object.getOwnPropertyDescriptor(document, "visibilityState");
    const setVisibility = (state: DocumentVisibilityState) => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
    };
    let nowValue = base + 1_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => nowValue);

    try {
      await act(async () => {
        root.render(
          <QueryClientProvider client={queryClient}>
            <Inbox />
          </QueryClientProvider>,
        );
      });
      await vi.waitFor(() => {
        expect(container.querySelectorAll("[data-inbox-item]").length).toBeGreaterThanOrEqual(3);
      });
      expect(orderOf()).toEqual(["A", "B", "C"]);

      // A poll makes row C the most-recently-active: the fresh sort is now [C, A, B].
      setIssueRows([
        { ...issueA },
        { ...issueB },
        { ...issueC, lastActivityAt: new Date(base + 9000) },
      ]);
      await act(async () => {
        await queryClient.invalidateQueries();
      });
      await vi.waitFor(() => {
        expect(container.textContent).toContain("Pin row C");
      });

      // No attention boundary has fired, so the displayed order is held, not reshuffled.
      expect(orderOf()).toEqual(["A", "B", "C"]);

      // The tab is hidden long enough to lose attention, then regains focus: that
      // visibility boundary is a commit point, so the inbox adopts the fresh order.
      await act(async () => {
        setVisibility("hidden");
        document.dispatchEvent(new Event("visibilitychange"));
      });
      nowValue += 31_000;
      await act(async () => {
        setVisibility("visible");
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await vi.waitFor(() => {
        expect(orderOf()).toEqual(["C", "A", "B"]);
      });
    } finally {
      nowSpy.mockRestore();
      if (visibilityDescriptor) {
        Object.defineProperty(document, "visibilityState", visibilityDescriptor);
      } else {
        setVisibility("visible");
      }
      act(() => {
        root.unmount();
      });
    }
  });

  it("keeps other issue archive controls enabled while one archive is pending", async () => {
    routerMock.location.pathname = "/inbox/mine";
    const issueA = createIssue({ id: "issue-a", identifier: "PAP-1001", title: "First inbox row" });
    const issueB = createIssue({ id: "issue-b", identifier: "PAP-1002", title: "Second inbox row" });
    setIssueRows([issueA, issueB]);
    const archiveA = createDeferred<{ id: string; archivedAt: Date }>();
    apiMocks.archiveFromInbox.mockImplementation((id: string) =>
      id === "issue-a" ? archiveA.promise : Promise.resolve({ id, archivedAt: new Date() }),
    );

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 0, gcTime: 0 } },
    });
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Inbox />
        </QueryClientProvider>,
      );
    });
    await vi.waitFor(() => {
      expect(container.textContent).toContain("First inbox row");
      expect(container.textContent).toContain("Second inbox row");
    });

    const initialArchiveButtons = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button[aria-label="Archive"]'),
    );
    expect(initialArchiveButtons.length).toBeGreaterThanOrEqual(2);

    await act(async () => {
      initialArchiveButtons[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    await vi.waitFor(() => {
      expect(apiMocks.archiveFromInbox).toHaveBeenCalledWith("issue-a");
      expect(container.textContent).not.toContain("First inbox row");
      expect(container.textContent).toContain("Second inbox row");
    });

    const remainingArchiveButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Archive"]',
    );
    expect(remainingArchiveButton).not.toBeNull();
    expect(remainingArchiveButton?.disabled).toBe(false);

    await act(async () => {
      remainingArchiveButton!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    await vi.waitFor(() => {
      expect(apiMocks.archiveFromInbox).toHaveBeenCalledWith("issue-b");
    });

    await act(async () => {
      archiveA.resolve({ id: "issue-a", archivedAt: new Date() });
    });

    act(() => {
      root.unmount();
    });
  });

  it("keeps a successful archive hidden when stale query data arrives", async () => {
    routerMock.location.pathname = "/inbox/mine";
    const archivedIssue = createIssue({
      id: "issue-a",
      identifier: "PAP-1001",
      title: "Archived inbox row",
    });
    setIssueRows([archivedIssue]);

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 0, gcTime: 0 } },
    });
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Inbox />
        </QueryClientProvider>,
      );
    });
    await vi.waitFor(() => {
      expect(container.textContent).toContain("Archived inbox row");
    });

    const archiveButton = container.querySelector<HTMLButtonElement>('button[aria-label="Archive"]');
    expect(archiveButton).not.toBeNull();

    await act(async () => {
      archiveButton!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await vi.waitFor(() => {
      expect(apiMocks.archiveFromInbox).toHaveBeenCalledWith("issue-a");
      expect(container.textContent).not.toContain("Archived inbox row");
    });

    await act(async () => {
      queryClient.setQueriesData<Issue[]>(
        { queryKey: ["issues", "company-1", "mine-by-me"] },
        [archivedIssue],
      );
    });

    expect(container.textContent).not.toContain("Archived inbox row");

    act(() => {
      root.unmount();
    });
  });

  it("restores a locally hidden archive when undo is pressed", async () => {
    routerMock.location.pathname = "/inbox/mine";
    const archivedIssue = createIssue({
      id: "issue-a",
      identifier: "PAP-1001",
      title: "Undoable inbox row",
    });
    setIssueRows([archivedIssue]);

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 0, gcTime: 0 } },
    });
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(
          <QueryClientProvider client={queryClient}>
            <Inbox />
          </QueryClientProvider>,
        );
      });
      await vi.waitFor(() => {
        expect(container.textContent).toContain("Undoable inbox row");
      });

      const archiveButton = container.querySelector<HTMLButtonElement>('button[aria-label="Archive"]');
      expect(archiveButton).not.toBeNull();
      await act(async () => {
        archiveButton!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      });
      await vi.waitFor(() => {
        expect(container.textContent).not.toContain("Undoable inbox row");
        expect(queryClient.isMutating()).toBe(0);
      });

      await act(async () => {
        document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "u", bubbles: true }));
      });
      await vi.waitFor(() => {
        expect(apiMocks.unarchiveFromInbox).toHaveBeenCalledWith("issue-a");
        expect(container.textContent).toContain("Undoable inbox row");
      });
    } finally {
      act(() => root.unmount());
    }
  });
});

describe("FailedRunInboxRow", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it.each(["working", "failed"] as const)("shows saved-work shutdown guidance while %s without Retry", state => {
    const root = createRoot(container);
    const message = state === "working" ? "Your work is saved. Paperclip is finishing shutdown."
      : "Paperclip couldn’t confirm shutdown. Your work is saved; continuation is paused.";
    const issue = createIssue({ interruption: { intentId: "saved-input", responsibility: "system", state,
      nextRetryAt: null, canRetry: false, userAction: null, sourceRunIds: ["run-1"], observedRunId: "run-1",
      retryWait: { reason: "governed_wait_settlement", message } } });
    act(() => root.render(<FailedRunInboxRow run={createFailedRun({ issueId: issue.id })}
      issueById={new Map([[issue.id, issue]])} agentName="Worker" issueLinkState={null}
      onDismiss={() => {}} onRetry={() => {}} isRetrying={false} />));
    expect(container.textContent).toContain(message);
    expect(container.textContent).not.toContain("Couldn’t finish this attempt");
    expect(container.textContent).not.toContain("Retry");
    act(() => root.unmount());
  });

  it("uses task presentation instead of infrastructure errors and keeps Retry in the task", () => {
    const root = createRoot(container);
    const issue = createIssue({ interruption: { intentId: "saved-input", responsibility: "system", state: "failed",
      nextRetryAt: null, canRetry: true, userAction: null, sourceRunIds: ["run-1"], observedRunId: "run-1" } });
    act(() => root.render(<FailedRunInboxRow run={createFailedRun({ issueId: issue.id, error: "Internal process identity missing" })}
      issueById={new Map([[issue.id, issue]])} agentName="Worker" issueLinkState={null}
      onDismiss={() => {}} onRetry={() => {}} isRetrying={false} />));
    expect(container.textContent).toContain("Couldn’t finish this attempt. Your message is saved.");
    expect(container.textContent).not.toContain("Internal process identity missing");
    expect(container.querySelector("a")?.getAttribute("href")).toBe(`/issues/${issue.id}`);
    expect(container.textContent).toContain("Retry");
    act(() => root.unmount());
  });

  it("suppresses accent hover styling when selected", () => {
    const root = createRoot(container);
    const run = createFailedRun();

    act(() => {
      root.render(
        <FailedRunInboxRow
          run={run}
          issueById={new Map()}
          agentName="Agent"
          issueLinkState={null}
          onDismiss={() => {}}
          onRetry={() => {}}
          isRetrying={false}
          selected
        />,
      );
    });

    const link = container.querySelector("a");
    expect(link).not.toBeNull();
    expect(link?.className).toContain("hover:bg-transparent");
    expect(link?.className).not.toContain("hover:bg-accent/50");

    act(() => {
      root.unmount();
    });
  });
});

describe("InboxIssueMetaLeading", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("keeps status and live accents visible", () => {
    const root = createRoot(container);

    act(() => {
      root.render(<InboxIssueMetaLeading issue={createIssue()} isLive />);
    });

    // The status glyph is an <svg> coloured from its --status-task-icon-* var.
    const statusIcon = Array.from(container.querySelectorAll("svg")).find((svg) =>
      (svg.getAttribute("style") ?? "").includes("--status-task-icon"),
    );
    const liveBadge = container.querySelector('span[class*="px-1.5"][class*="bg-blue-500/10"]');
    const liveBadgeLabel = Array.from(container.querySelectorAll("span")).find(
      // The pill chassis is a Badge (itself a span with textContent "Live");
      // the label is the inner span without the rounded-full chassis class.
      (node) => node.textContent === "Live" && node.className.includes("text-") && !node.className.includes("rounded-full"),
    );
    const liveDot = container.querySelector('span[class*="bg-blue-500"]');
    const pulseRing = container.querySelector('span[class*="animate-pulse"]');

    expect(statusIcon).not.toBeUndefined();
    // Status accent stays visible — not neutralized to muted.
    expect(statusIcon?.getAttribute("class") ?? "").not.toContain("!text-muted-foreground");
    expect(liveBadge).not.toBeNull();
    expect(liveBadge?.className).toContain("bg-blue-500/10");
    expect(liveBadgeLabel).not.toBeNull();
    expect(liveBadgeLabel?.className).toContain("text-blue-600");
    expect(liveDot).not.toBeNull();
    expect(pulseRing).not.toBeNull();

    act(() => {
      root.unmount();
    });
  });
});

describe("InboxIssueTrailingColumns", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("renders an empty tags cell when an issue has no labels", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <InboxIssueTrailingColumns
          issue={createIssue({ labels: [], labelIds: [] })}
          columns={["labels"]}
          projectName={null}
          projectColor={null}
          workspaceName={null}
          assigneeName={null}
          currentUserId={null}
          parentIdentifier={null}
          parentTitle={null}
        />,
      );
    });

    expect(container.textContent).toBe("");

    act(() => {
      root.unmount();
    });
  });

  it("leaves the workspace cell blank when no explicit workspace label should be shown", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <InboxIssueTrailingColumns
          issue={createIssue()}
          columns={["workspace"]}
          projectName={null}
          projectColor={null}
          workspaceName={null}
          assigneeName={null}
          currentUserId={null}
          parentIdentifier={null}
          parentTitle={null}
        />,
      );
    });

    expect(container.textContent).toBe("");

    act(() => {
      root.unmount();
    });
  });
});

describe("formatJoinRequestInboxLabel", () => {
  it("shows the human requester's name and email when available", () => {
    expect(formatJoinRequestInboxLabel(createJoinRequest())).toBe(
      "Jordan Example (joiner@example.com)",
    );
  });

  it("falls back to the email snapshot when the requester profile is missing", () => {
    expect(
      formatJoinRequestInboxLabel(
        createJoinRequest({
          requesterUser: null,
          requestEmailSnapshot: "snapshot@example.com",
          requestingUserId: null,
        }),
      ),
    ).toBe("snapshot@example.com");
  });
});

describe("InboxGroupHeader", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("shows a left caret and expanded state for collapsible mobile headers", () => {
    const root = createRoot(container);

    act(() => {
      root.render(<InboxGroupHeader label="Primary workspace (default)" collapsible collapsed={false} />);
    });

    const button = container.querySelector("button");
    expect(button).not.toBeNull();
    expect(button?.getAttribute("aria-expanded")).toBe("true");
    expect(button?.textContent).toContain("Primary workspace (default)");
    const caret = container.querySelector("svg");
    expect(caret?.className.baseVal).toContain("rotate-90");

    act(() => {
      root.unmount();
    });
  });

  it("keeps the caret collapsed when the mobile group is hidden", () => {
    const root = createRoot(container);

    act(() => {
      root.render(<InboxGroupHeader label="Feature Branch" collapsible collapsed />);
    });

    const button = container.querySelector("button");
    expect(button?.getAttribute("aria-expanded")).toBe("false");
    const caret = container.querySelector("svg");
    expect(caret?.className.baseVal).not.toContain("rotate-90");

    act(() => {
      root.unmount();
    });
  });
});


describe("Coordinator Inbox collection reads", () => {
  it.each([true, false])("keeps optimized reads with Coordinator and Streamlined=%s", async (streamlined) => {
    resetInboxApiMocks(); localStorage.clear();
    routerMock.location.pathname = "/inbox/mine";
    const settings = { enableIsolatedWorkspaces: false, enableStreamlinedUi: streamlined };
    apiMocks.experimentalSettings.mockResolvedValue(settings);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: 0 } } });
    client.setQueryData(queryKeys.instance.experimentalSettings, settings);
    const container = document.createElement("div"); document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<QueryClientProvider client={client}><CoordinatorPresentation.Provider value={true}><Inbox /></CoordinatorPresentation.Provider></QueryClientProvider>));
      await vi.waitFor(() => expect(apiMocks.inboxMine).toHaveBeenCalledOnce());
      await vi.waitFor(() => expect(client.isFetching()).toBe(0));
      expect(apiMocks.issuesList).not.toHaveBeenCalled();
      expect(apiMocks.heartbeatRunsList).not.toHaveBeenCalled();
      expect(apiMocks.dashboardSummary).not.toHaveBeenCalled();
    } finally { await act(async () => root.unmount()); client.clear(); container.remove(); }
  });
});
