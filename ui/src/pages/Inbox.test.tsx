// @vitest-environment jsdom

import type { ComponentProps } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Issue } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompanyJoinRequest } from "../api/access";
import {
  clearLocalInboxArchive,
  getLocalInboxArchiveIssueIds,
} from "../lib/inboxArchiveCache";

const routerMock = vi.hoisted(() => ({
  location: { pathname: "/", search: "", hash: "" },
  navigate: vi.fn(),
}));

const apiMocks = vi.hoisted(() => ({
  approvalsList: vi.fn(),
  joinRequestsList: vi.fn(),
  userDirectoryList: vi.fn(),
  authSession: vi.fn(),
  dashboardSummary: vi.fn(),
  executionWorkspaceSummaries: vi.fn(),
  issuesList: vi.fn(),
  issuesCount: vi.fn(),
  issueLabels: vi.fn(),
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
  executionWorkspacesApi: { listSummaries: apiMocks.executionWorkspaceSummaries },
}));

vi.mock("../api/issues", () => ({
  issuesApi: {
    list: apiMocks.issuesList,
    listCompact: apiMocks.issuesList,
    count: apiMocks.issuesCount,
    listLabels: apiMocks.issueLabels,
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
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("../context/DialogContext", () => ({
  useDialogActions: () => ({ openNewIssue: vi.fn() }),
}));

vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => ({ isMobile: false }),
}));

const generalSettingsMock = { keyboardShortcutsEnabled: false };
vi.mock("../context/GeneralSettingsContext", () => ({
  useGeneralSettings: () => generalSettingsMock,
}));

vi.mock("../hooks/useInboxBadge", () => ({
  useDismissedInboxAlerts: () => ({ dismissed: new Set(), dismiss: vi.fn() }),
  useInboxDismissals: () => ({ dismissedAtByKey: new Map(), dismiss: vi.fn() }),
  useReadInboxItems: () => ({
    readItems: new Set(),
    markRead: vi.fn(),
    markUnread: vi.fn(),
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
  Link: ({ children, className, ...props }: ComponentProps<"a">) => (
    <a className={className} {...props}>{children}</a>
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

function createIssue(overrides: Partial<Issue> = {}): Issue {
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

function resetInboxApiMocks() {
  for (const mock of Object.values(apiMocks)) mock.mockReset();
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
  apiMocks.issuesList.mockResolvedValue([]);
  apiMocks.issuesCount.mockResolvedValue({ count: 0 });
  apiMocks.issueLabels.mockResolvedValue([]);
  apiMocks.archiveFromInbox.mockResolvedValue({ id: "issue-1", archivedAt: new Date() });
  apiMocks.unarchiveFromInbox.mockResolvedValue({ id: "issue-1", archivedAt: new Date() });
  apiMocks.agentsList.mockResolvedValue([]);
  apiMocks.heartbeatRunsList.mockResolvedValue([]);
  apiMocks.liveRunsForCompany.mockResolvedValue([]);
  apiMocks.experimentalSettings.mockResolvedValue({ enableIsolatedWorkspaces: false });
  apiMocks.projectsList.mockResolvedValue([]);
}

describe("Inbox toolbar", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
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

  it("requests live descendant summaries for issue rows", async () => {
    routerMock.location.pathname = "/inbox/mine";

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
      expect(apiMocks.issuesList).toHaveBeenCalledTimes(3);
    });

    expect(apiMocks.issuesList.mock.calls.map((call) => call[1]?.includeLiveDescendantSummary)).toEqual([
      true,
      true,
      true,
    ]);
    expect(apiMocks.issuesList.mock.calls.map((call) => call[1]?.limit)).toEqual([
      500,
      500,
      500,
    ]);

    act(() => {
      root.unmount();
    });
  });

  it("paints row hover via CSS only, without moving React selection state", async () => {
    routerMock.location.pathname = "/inbox/mine";
    const issueA = createIssue({ id: "issue-a", identifier: "PAP-1001", title: "First inbox row" });
    const issueB = createIssue({ id: "issue-b", identifier: "PAP-1002", title: "Second inbox row" });
    apiMocks.issuesList.mockResolvedValue([issueA, issueB]);

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

    const linkOf = (row: Element): HTMLAnchorElement | null =>
      row.querySelector("a[data-inbox-issue-link]");

    // Nothing selected before hover — both rows show the hover-accent class.
    expect(linkOf(rows[0]!)?.className).toContain("hover:bg-accent/50");
    expect(linkOf(rows[1]!)?.className).toContain("hover:bg-accent/50");

    // Hovering paints via CSS `:hover` only — it must NOT flip a row into the
    // state-selected band (which would swap to hover:bg-transparent). Coupling
    // hover to React state was the per-hover re-render storm behind the lag;
    // scrubbing the list must not touch selection state. (Keyboard nav that
    // continues from the hovered row is exercised in live/e2e verification —
    // this unit mocks keyboardShortcutsEnabled off.)
    await act(async () => {
      rows[1]!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      rows[1]!.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false }));
    });
    expect(linkOf(rows[0]!)?.className).toContain("hover:bg-accent/50");
    expect(linkOf(rows[1]!)?.className).toContain("hover:bg-accent/50");
    expect(linkOf(rows[1]!)?.className).not.toContain("hover:bg-transparent");

    act(() => {
      root.unmount();
    });
  });

  it("does not indent unread rows: the mark-read dot sits in a reserved leading slot present on every row", async () => {
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
    apiMocks.issuesList.mockResolvedValue([unread, read]);

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
    const linkOf = (row: Element) => row.querySelector<HTMLAnchorElement>("a[data-inbox-issue-link]");
    const markReadButton = (row: Element) => row.querySelector('button[aria-label="Mark as read"]');
    // The empty spacer that reserves the chevron column on every leaf row.
    // Excludes the tree-guide span (`.self-stretch`), which only renders on
    // nested rows.
    const hasLeadingSpacer = (row: Element) =>
      !!linkOf(row)?.querySelector("span.hidden.w-4.shrink-0.sm\\:block:not(.self-stretch)");
    // The reserved leading dot slot, present on read AND unread rows.
    const dotSlot = (row: Element) =>
      linkOf(row)?.querySelector('[data-testid="issue-row-unread-slot"]') ?? null;

    const unreadRow = rowFor("Unread inbox row")!;
    const readRow = rowFor("Read inbox row")!;

    // The dot lives in a fixed leading slot that is reserved on every inbox row
    // (in flow, NOT an absolute overlay). Because read and unread rows both
    // reserve it — and both keep the chevron spacer — their status icon + title
    // land at the same x (the bug this fix addresses: an unread-only dot column
    // used to push unread rows right).
    const unreadSlot = dotSlot(unreadRow);
    const readSlot = dotSlot(readRow);
    expect(unreadSlot).not.toBeNull();
    expect(readSlot).not.toBeNull();
    // In flow, not an absolute overlay.
    expect(unreadSlot?.className).not.toContain("absolute");
    // Only the unread row carries the dot button; the read slot is empty.
    expect(markReadButton(unreadSlot!)).not.toBeNull();
    expect(readSlot?.querySelector('button[aria-label="Mark as read"]')).toBeNull();
    expect(hasLeadingSpacer(unreadRow)).toBe(true);

    // Read rows keep the same spacer, so both rows line up.
    expect(hasLeadingSpacer(readRow)).toBe(true);

    act(() => {
      root.unmount();
    });
  });

  it("keeps hover→j/k selection in sync after the list reshapes (PAP-9679)", async () => {
    routerMock.location.pathname = "/inbox/mine";
    generalSettingsMock.keyboardShortcutsEnabled = true;
    const issueA = createIssue({ id: "issue-a", identifier: "PAP-2001", title: "Sync row A" });
    const issueB = createIssue({ id: "issue-b", identifier: "PAP-2002", title: "Sync row B" });
    const issueC = createIssue({ id: "issue-c", identifier: "PAP-2003", title: "Sync row C" });
    apiMocks.issuesList.mockResolvedValue([issueA, issueB, issueC]);

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 0, gcTime: 0 } },
    });
    const root = createRoot(container);

    const linkOf = (row: Element): HTMLAnchorElement | null =>
      row.querySelector("a[data-inbox-issue-link]");
    // The keyboard-selected row swaps to `hover:bg-transparent`; find its index.
    const selectedRowIndex = () =>
      [...container.querySelectorAll("[data-inbox-item]")].findIndex((row) =>
        linkOf(row)?.className.includes("hover:bg-transparent"),
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
      apiMocks.issuesList.mockResolvedValue([issueA, { ...issueB, title: "Sync row B (updated)" }, issueC]);
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
      generalSettingsMock.keyboardShortcutsEnabled = false;
      act(() => {
        root.unmount();
      });
    }
  });

  it("keeps other issue archive controls enabled while one archive is pending", async () => {
    routerMock.location.pathname = "/inbox/mine";
    const issueA = createIssue({ id: "issue-a", identifier: "PAP-1001", title: "First inbox row" });
    const issueB = createIssue({ id: "issue-b", identifier: "PAP-1002", title: "Second inbox row" });
    apiMocks.issuesList.mockResolvedValue([issueA, issueB]);
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
    apiMocks.issuesList.mockResolvedValue([archivedIssue]);

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
    generalSettingsMock.keyboardShortcutsEnabled = true;
    routerMock.location.pathname = "/inbox/mine";
    const archivedIssue = createIssue({
      id: "issue-a",
      identifier: "PAP-1001",
      title: "Undoable inbox row",
    });
    apiMocks.issuesList.mockResolvedValue([archivedIssue]);

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
      generalSettingsMock.keyboardShortcutsEnabled = false;
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

  it("suppresses accent hover styling when selected", () => {
    const root = createRoot(container);
    const run = {
      id: "run-1",
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
      lastOutputAt: null,
      lastOutputSeq: 0,
      lastOutputStream: null,
      lastOutputBytes: null,
      errorCode: null,
      externalRunId: null,
      processPid: null,
      processGroupId: null,
      processStartedAt: null,
      retryOfRunId: null,
      processLossRetryCount: 0,
      livenessState: null,
      livenessReason: null,
      continuationAttempt: 0,
      lastUsefulActionAt: null,
      nextAction: null,
      stdoutExcerpt: null,
      stderrExcerpt: null,
      contextSnapshot: null,
      startedAt: new Date("2026-03-11T00:00:00.000Z"),
      finishedAt: null,
      createdAt: new Date("2026-03-11T00:00:00.000Z"),
      updatedAt: new Date("2026-03-11T00:00:00.000Z"),
    } as const;

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
