// @vitest-environment jsdom

import { act } from "react";
import type { ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Issue } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompanyJoinRequest } from "../api/access";

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
    count: apiMocks.issuesCount,
    listLabels: apiMocks.issueLabels,
    markRead: vi.fn(),
    markUnread: vi.fn(),
    archiveFromInbox: vi.fn(),
    unarchiveFromInbox: vi.fn(),
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

vi.mock("../context/GeneralSettingsContext", () => ({
  useGeneralSettings: () => ({ keyboardShortcutsEnabled: false }),
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

    const statusIcon = container.querySelector('span[class*="border-blue-600"]');
    const liveBadge = container.querySelector('span[class*="px-1.5"][class*="bg-blue-500/10"]');
    const liveBadgeLabel = Array.from(container.querySelectorAll("span")).find(
      (node) => node.textContent === "Live" && node.className.includes("text-"),
    );
    const liveDot = container.querySelector('span[class*="bg-blue-500"]');
    const pulseRing = container.querySelector('span[class*="animate-pulse"]');

    expect(statusIcon).not.toBeNull();
    expect(statusIcon?.className).not.toContain("!border-muted-foreground");
    expect(statusIcon?.className).not.toContain("!text-muted-foreground");
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
