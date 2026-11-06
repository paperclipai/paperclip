// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Issue, IssueBlockedInboxAttention } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockIssuesApi = vi.hoisted(() => ({
  list: vi.fn(),
  count: vi.fn(),
  markRead: vi.fn(),
}));

vi.mock("../api/issues", () => ({
  issuesApi: mockIssuesApi,
}));

vi.mock("@/lib/router", () => ({
  Link: ({
    children,
    className,
    disableIssueQuicklook: _disableIssueQuicklook,
    issuePrefetch: _issuePrefetch,
    ...props
  }: React.ComponentProps<"a"> & { disableIssueQuicklook?: boolean; issuePrefetch?: Issue | null }) => (
    <a className={className} {...props}>
      {children}
    </a>
  ),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> | undefined;
  flushSync(() => {
    result = callback();
  });
  return result;
}

import { BlockedInboxView } from "./BlockedInboxView";
import { defaultIssueFilterState } from "../lib/issue-filters";
import { loadInboxWorkItemGroupBy, saveInboxWorkItemGroupBy } from "../lib/inbox";

function attention(
  overrides: Partial<IssueBlockedInboxAttention> = {},
): IssueBlockedInboxAttention {
  return {
    kind: "blocked",
    state: "needs_attention",
    reason: "blocked_chain_stalled",
    severity: "medium",
    stoppedSinceAt: "2026-05-08T10:00:00.000Z",
    owner: { type: "agent", agentId: "agent-1", userId: null, label: null },
    action: { label: "Resolve PAP-77", detail: null },
    sourceIssue: null,
    leafIssue: null,
    recoveryIssue: null,
    approvalId: null,
    interactionId: null,
    sampleIssueIdentifier: null,
    redaction: { externalDetailsRedacted: false, secretFieldsOmitted: true },
    ...overrides,
  };
}

function makeIssue(
  id: string,
  identifier: string,
  title: string,
  attentionPayload: IssueBlockedInboxAttention,
): Issue {
  return {
    id,
    companyId: "company-1",
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title,
    description: null,
    status: "in_progress",
    workMode: "standard",
    priority: "medium",
    assigneeAgentId: "agent-1",
    assigneeUserId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    issueNumber: 1,
    identifier,
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
    blockedInboxAttention: attentionPayload,
    createdAt: new Date("2026-05-09T00:00:00.000Z"),
    updatedAt: new Date("2026-05-09T00:00:00.000Z"),
  } as Issue;
}

function renderWithClient(node: React.ReactNode, container: HTMLDivElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0, gcTime: 0 } },
  });
  const root = createRoot(container);
  act(() => {
    root.render(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>);
  });
  return { root, queryClient };
}

const blockedViewProps = {
  companyId: "company-1",
  searchQuery: "",
  agentNameById: new Map<string, string>(),
  issueLinkState: null,
  groupBy: "none" as const,
  sortBy: "most_recent" as const,
  issueFilters: defaultIssueFilterState,
  currentUserId: "local-board",
  liveIssueIds: new Set<string>(),
  subtreeLiveCounts: new Map<string, number>(),
  workspaceFilterContext: {},
  showStatusColumn: true,
  showIdentifierColumn: true,
  showUpdatedColumn: true,
};

async function waitFor(predicate: () => boolean, attempts = 30): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    if (predicate()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
  throw new Error("waitFor predicate did not become true");
}

describe("BlockedInboxView source grouping", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockIssuesApi.list.mockReset();
    mockIssuesApi.markRead.mockReset();
  });

  afterEach(() => {
    container.remove();
  });

  it("persists Source as an inbox grouping preference", () => {
    saveInboxWorkItemGroupBy("source");
    expect(loadInboxWorkItemGroupBy()).toBe("source");
  });

  it("groups by source and marks only one group's unread tasks as read after one confirm", async () => {
    const withSource = (issue: Issue, originKind: Issue["originKind"]): Issue => ({ ...issue, originKind });
    // The blocked list has no read state; the unread-for-me query supplies it.
    const blockedIssues = [
      withSource(makeIssue("work-unread", "PAP-1", "Work unread", attention()), "manual"),
      withSource(makeIssue("work-read", "PAP-2", "Work read", attention()), "manual"),
      withSource(makeIssue("routine-unread", "PAP-3", "Routine unread", attention()), "routine_execution"),
      withSource(makeIssue("system-unread", "PAP-4", "System unread", attention()), "stranded_issue_recovery"),
    ];
    mockIssuesApi.list.mockImplementation(async (_companyId: string, filters: { unreadForUserId?: string }) =>
      filters.unreadForUserId === "me"
        ? blockedIssues.filter((issue) => issue.id !== "work-read")
        : blockedIssues,
    );
    mockIssuesApi.markRead.mockResolvedValue(undefined);

    const { root } = renderWithClient(
      <BlockedInboxView {...blockedViewProps} groupBy="source" />,
      container,
    );
    await waitFor(() => container.querySelectorAll("a").length === 4);
    await waitFor(() => container.querySelector('button[aria-label="Mark all in Work as read"]') !== null);
    expect(mockIssuesApi.list).toHaveBeenCalledWith("company-1", expect.objectContaining({
      attention: "blocked",
      unreadForUserId: "me",
    }));

    const groupIds = Array.from(container.querySelectorAll('[data-testid^="blocked-inbox-group-"]'))
      .map((group) => group.getAttribute("data-testid"));
    expect(groupIds).toEqual([
      "blocked-inbox-group-source-work",
      "blocked-inbox-group-source-routines",
      "blocked-inbox-group-source-system",
    ]);

    const workGroup = container.querySelector('[data-testid="blocked-inbox-group-source-work"]')!;
    act(() => workGroup.querySelector<HTMLButtonElement>('button[aria-label="Mark all in Work as read"]')!.click());

    await waitFor(() => document.body.textContent?.includes("Mark all in Work as read?") ?? false);
    expect(mockIssuesApi.markRead).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("This will mark 1 unread item in Work as read.");

    const confirm = Array.from(document.body.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'))
      .find((button) => button.textContent === "Mark all as read");
    act(() => confirm!.click());

    await waitFor(() => mockIssuesApi.markRead.mock.calls.length > 0);
    expect(mockIssuesApi.markRead.mock.calls.map(([id]) => id)).toEqual(["work-unread"]);
    act(() => root.unmount());
  });

  it("keeps blocked tasks visible and offers a retry when the unread request fails", async () => {
    const blockedIssues = [
      { ...makeIssue("work-unread", "PAP-1", "Work unread", attention()), originKind: "manual" } as Issue,
    ];
    let unreadRequests = 0;
    mockIssuesApi.list.mockImplementation(async (_companyId: string, filters: { unreadForUserId?: string }) => {
      if (filters.unreadForUserId !== "me") return blockedIssues;
      unreadRequests += 1;
      if (unreadRequests === 1) throw new Error("unread request failed");
      return blockedIssues;
    });

    const { root } = renderWithClient(
      <BlockedInboxView {...blockedViewProps} groupBy="source" />,
      container,
    );
    await waitFor(() => container.querySelector('[data-testid="blocked-inbox-unread-error"]') !== null);
    expect(container.querySelectorAll("a")).toHaveLength(1);
    expect(container.querySelector('button[aria-label="Mark all in Work as read"]')).toBeNull();

    const retry = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[data-testid="blocked-inbox-unread-error"] button'),
    ).find((button) => button.textContent === "Try again");
    act(() => retry!.click());

    await waitFor(() => container.querySelector('button[aria-label="Mark all in Work as read"]') !== null);
    expect(container.querySelector('[data-testid="blocked-inbox-unread-error"]')).toBeNull();
    expect(unreadRequests).toBe(2);
    act(() => root.unmount());
  });
});
