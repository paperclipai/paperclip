// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Issue, IssueBlockedInboxAttention } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockIssuesApi = vi.hoisted(() => ({
  list: vi.fn(),
  count: vi.fn(),
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

describe("BlockedInboxView", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockIssuesApi.list.mockReset();
  });

  afterEach(() => {
    container.remove();
  });

  it("shows the empty state when no blocked issues are returned", async () => {
    mockIssuesApi.list.mockResolvedValue([]);
    const { root } = renderWithClient(
      <BlockedInboxView
        {...blockedViewProps}
        presentation="task"
      />,
      container,
    );
    await waitFor(() => container.querySelector('[data-testid="blocked-inbox-empty"]') !== null);
    expect(container.querySelector('[data-testid="blocked-inbox-empty"]')).not.toBeNull();
    act(() => root.unmount());
  });

  it("defaults to no grouping and orders rows by most recent stopped item first", async () => {
    const issues: Issue[] = [
      makeIssue(
        "issue-low",
        "PAP-1",
        "External wait row",
        attention({ reason: "external_owner_action", severity: "low" }),
      ),
      makeIssue(
        "issue-stalled-high",
        "PAP-2",
        "Stalled chain row",
        attention({
          reason: "blocked_chain_stalled",
          severity: "high",
          stoppedSinceAt: "2026-05-09T01:00:00.000Z",
          action: { label: "Resolve PAP-9", detail: null },
        }),
      ),
      makeIssue(
        "issue-stalled-critical",
        "PAP-3",
        "Critical stalled row",
        attention({
          reason: "blocked_chain_stalled",
          severity: "critical",
          stoppedSinceAt: "2026-05-09T05:00:00.000Z",
          action: { label: "Resolve PAP-10", detail: null },
        }),
      ),
      makeIssue(
        "issue-decision",
        "PAP-4",
        "Pending board decision",
        attention({
          reason: "pending_board_decision",
          severity: "medium",
          owner: { type: "board", agentId: null, userId: null, label: "Board" },
          action: { label: "Accept or reject", detail: null },
        }),
      ),
    ];
    mockIssuesApi.list.mockResolvedValue(issues);

    const { root } = renderWithClient(
      <BlockedInboxView
        {...blockedViewProps}
        agentNameById={new Map([["agent-1", "ClaudeCoder"]])}
      />,
      container,
    );
    await waitFor(() => container.querySelectorAll("a").length === 4);

    expect(container.querySelectorAll('[data-testid^="blocked-inbox-group-"]')).toHaveLength(0);

    const titles = Array.from(container.querySelectorAll("a")).map((a) => a.textContent ?? "");
    expect(titles[0]).toContain("Critical stalled row");
    expect(titles[1]).toContain("Stalled chain row");

    expect(mockIssuesApi.list).toHaveBeenCalledWith("company-1", expect.objectContaining({
      attention: "blocked",
      includeBlockedInboxAttention: true,
      includeBlockedBy: true,
    }));

    act(() => root.unmount());
  });

  it("places blocker reason chips with the title before owner and timestamp metadata", async () => {
    mockIssuesApi.list.mockResolvedValue([
      makeIssue(
        "issue-decision",
        "PAP-4",
        "Pending board decision",
        attention({
          reason: "pending_board_decision",
          severity: "medium",
          owner: { type: "board", agentId: null, userId: null, label: "Board" },
          action: { label: "Accept or reject", detail: null },
        }),
      ),
    ]);

    const { root } = renderWithClient(
      <BlockedInboxView
        {...blockedViewProps}
        presentation="task"
      />,
      container,
    );
    await waitFor(() => container.querySelector("a") !== null);

    const rowText = container.querySelector("a")?.parentElement?.textContent ?? "";
    expect(rowText.indexOf("Pending board decision")).toBeGreaterThanOrEqual(0);
    expect(rowText.indexOf("Board")).toBeGreaterThan(rowText.indexOf("Pending board decision"));
    // K-20108: the row now shows the server's recommended next step. It used to
    // assert the opposite -- `not.toContain("Accept or reject")` -- which is how
    // the action stayed invisible on 69 live rows while still being searchable.
    expect(rowText).toContain("Accept or reject");
    const reasonColumn = container.querySelector('[data-testid="blocked-row-reason-column"]');
    // The chip prints the specific reason, not the group label. `data-variant`
    // still carries the group so colour/icon stay right.
    expect(reasonColumn?.textContent).toContain("Pending board decision");
    expect(reasonColumn?.querySelector('[data-testid="blocked-reason-chip"]')?.getAttribute("data-variant")).toBe("needs_decision");
    expect(reasonColumn?.textContent).not.toContain("Needs decision");
    expect(reasonColumn?.querySelector('[data-testid="blocked-row-action"]')?.textContent).toBe("Accept or reject");
    const taskRow = container.querySelector('[data-slot="task-row"]');
    const identifier = container.querySelector('[data-slot="task-row-identifier"]');
    const timestamp = container.querySelector('[data-slot="task-row-timestamp"]');
    expect(taskRow).not.toBeNull();
    expect(taskRow?.className).not.toContain("border-b");
    expect(identifier).not.toBeNull();
    expect(timestamp).not.toBeNull();
    if (!identifier || !timestamp) throw new Error("Expected canonical identifier and timestamp columns");
    expect(identifier.compareDocumentPosition(timestamp) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);

    act(() => root.unmount());
  });

  it("restores the legacy status/id prefix, timestamp column, and row divider", async () => {
    mockIssuesApi.list.mockResolvedValue([
      makeIssue(
        "issue-legacy",
        "PAP-41",
        "Legacy blocked row",
        attention({ owner: { type: "board", agentId: null, userId: null, label: "Board" } }),
      ),
    ]);

    const { root } = renderWithClient(
      <BlockedInboxView {...blockedViewProps} presentation="legacy" />,
      container,
    );
    await waitFor(() => container.textContent?.includes("Legacy blocked row") === true);

    expect(container.querySelector('[data-slot="task-row"]')).toBeNull();
    expect(container.querySelector('[data-testid="blocked-row-age"]')).not.toBeNull();
    const row = container.querySelector("a")?.parentElement;
    expect(row?.className).toContain("border-b");
    expect(row?.textContent).toContain("PAP-41");

    act(() => root.unmount());
  });

  it("surfaces the action on the legacy presentation on desktop and mobile", async () => {
    mockIssuesApi.list.mockResolvedValue([
      makeIssue(
        "issue-legacy-action",
        "PAP-42",
        "Legacy row with a real next step",
        attention({
          reason: "pending_board_decision",
          severity: "high",
          action: { label: "Accept or reject", detail: null },
        }),
      ),
    ]);

    const { root } = renderWithClient(
      <BlockedInboxView {...blockedViewProps} presentation="legacy" />,
      container,
    );
    await waitFor(() => container.textContent?.includes("Legacy row with a real next step") === true);

    // The action is presentation-independent: legacy and task rows share the
    // same trailing/meta slots, so the server's next step is not a task-presentation
    // feature. Both the desktop column and the mobile meta line must carry it.
    const desktopAction = container.querySelector('[data-testid="blocked-row-action"]');
    expect(desktopAction?.textContent).toBe("Accept or reject");
    expect(desktopAction?.getAttribute("title")).toBe("Accept or reject");
    const mobileAction = container.querySelector('[data-testid="blocked-row-action-mobile"]');
    expect(mobileAction?.textContent).toBe("Accept or reject");

    act(() => root.unmount());
  });

  it("surfaces the action on the task presentation on mobile as well as desktop", async () => {
    mockIssuesApi.list.mockResolvedValue([
      makeIssue(
        "issue-task-action",
        "PAP-43",
        "Task row with a real next step",
        attention({
          reason: "missing_successful_run_disposition",
          action: { label: "Choose disposition", detail: null },
        }),
      ),
    ]);

    const { root } = renderWithClient(
      <BlockedInboxView {...blockedViewProps} presentation="task" />,
      container,
    );
    await waitFor(() => container.textContent?.includes("Task row with a real next step") === true);

    expect(container.querySelector('[data-testid="blocked-row-action"]')?.textContent).toBe("Choose disposition");
    expect(container.querySelector('[data-testid="blocked-row-action-mobile"]')?.textContent).toBe("Choose disposition");

    act(() => root.unmount());
  });

  it("renders no action element for the suppressed blocked_chain_stalled fallback", async () => {
    // The suppression rule, at the render boundary. `Inspect blocker chain` is
    // the liveness-walk fallback: identical on every stalled row, `leafIssue`
    // null on all of them, and the rows already sit under a group header that
    // says the same thing. Suppressing it must remove it from the DOM, not just
    // from the search haystack -- otherwise the search box is still a liar.
    mockIssuesApi.list.mockResolvedValue([
      makeIssue(
        "issue-stalled",
        "PAP-44",
        "Stalled row",
        attention({
          reason: "blocked_chain_stalled",
          action: {
            label: "Inspect blocker chain",
            detail: "Inspect the stalled blocker or review leaf and make the next owner/action explicit.",
          },
        }),
      ),
    ]);

    const { root } = renderWithClient(
      <BlockedInboxView {...blockedViewProps} searchQuery="" />,
      container,
    );
    await waitFor(() => container.textContent?.includes("Stalled row") === true);

    expect(container.querySelector('[data-testid="blocked-row-action"]')).toBeNull();
    expect(container.querySelector('[data-testid="blocked-row-action-mobile"]')).toBeNull();
    // The chip still says the specific reason, so the row is not left nameless.
    expect(container.querySelector('[data-testid="blocked-reason-chip"]')?.textContent).toContain(
      "Blocked chain stalled",
    );
    expect(container.textContent).not.toContain("Inspect blocker chain");

    act(() => root.unmount());
  });

  it("drops rows that only matched a suppressed action", async () => {
    // Parity, end to end: searching the suppressed label must return nothing,
    // because the label is not on the row.
    const issues: Issue[] = [
      makeIssue(
        "issue-stalled-1",
        "PAP-50",
        "Stalled one",
        attention({
          reason: "blocked_chain_stalled",
          action: { label: "Inspect blocker chain", detail: null },
        }),
      ),
      makeIssue(
        "issue-decision",
        "PAP-51",
        "Waiting on a confirmation",
        attention({
          reason: "pending_board_decision",
          action: { label: "Answer confirmation", detail: null },
        }),
      ),
    ];
    mockIssuesApi.list.mockResolvedValue(issues);

    const { root } = renderWithClient(
      <BlockedInboxView {...blockedViewProps} searchQuery="Inspect blocker chain" />,
      container,
    );
    await waitFor(
      () => container.querySelector('[data-testid="blocked-inbox-no-search-results"]') !== null,
    );

    const links = Array.from(container.querySelectorAll("a")).map((a) => a.textContent ?? "");
    expect(links.some((t) => t.includes("Stalled one"))).toBe(false);
    expect(links.some((t) => t.includes("Waiting on a confirmation"))).toBe(false);

    act(() => root.unmount());
  });

  it("does not match the group label when grouping is off, and does when it is on", async () => {
    // Parity, at the only place it is conditional. The variant label reaches
    // the screen through the group header, so with grouping set to "None" there
    // is no header and nothing draws it. Indexing it anyway let a search for
    // "Needs attention" return a row that reads only "Parked blocker" -- the
    // same findable-but-invisible defect the parity contract exists to stop.
    mockIssuesApi.list.mockResolvedValue([
      makeIssue(
        "issue-group-label",
        "PAP-60",
        "Parked chain",
        attention({
          reason: "blocked_by_assigned_backlog_issue",
          action: { label: "Resume parked blocker", detail: null },
        }),
      ),
    ]);

    const ungrouped = renderWithClient(
      <BlockedInboxView {...blockedViewProps} groupBy="none" searchQuery="Needs attention" />,
      container,
    );
    await waitFor(
      () => container.querySelector('[data-testid="blocked-inbox-no-search-results"]') !== null,
    );
    // The row is on the wire and its group label is "Needs attention"...
    expect(mockIssuesApi.list.mock.results.length).toBeGreaterThan(0);
    // ...but no header is drawn, so the label must not match.
    expect(container.querySelector('[data-testid="blocked-inbox"]')).toBeNull();
    act(() => ungrouped.root.unmount());
    container.remove();

    const fresh = document.createElement("div");
    document.body.appendChild(fresh);
    const grouped = renderWithClient(
      <BlockedInboxView {...blockedViewProps} groupBy="blocker_type" searchQuery="Needs attention" />,
      fresh,
    );
    await waitFor(() => fresh.querySelectorAll("a").length > 0);
    expect(fresh.textContent).toContain("Parked chain");
    expect(fresh.textContent).toContain("Needs attention");
    act(() => grouped.root.unmount());
    fresh.remove();
  });

  it("finds a row by the owner name it displays, not the raw owner field", async () => {
    // The inverse direction of the same contract: the server sets
    // `owner.label: null` on the finding-driven path, and the row still draws
    // the assignee name resolved from `owner.agentId`. A displayed name that
    // the filter cannot reach is a search box that lies by omission.
    mockIssuesApi.list.mockResolvedValue([
      makeIssue(
        "issue-owner",
        "PAP-61",
        "Waiting on a review gate",
        attention({
          reason: "in_review_without_action_path",
          owner: { type: "agent", agentId: "agent-77", userId: null, label: null },
          action: { label: "Choose review path", detail: null },
        }),
      ),
    ]);

    const { root } = renderWithClient(
      <BlockedInboxView
        {...blockedViewProps}
        agentNameById={new Map([["agent-77", "Priya"]])}
        searchQuery="Priya"
      />,
      container,
    );
    await waitFor(() => container.querySelectorAll("a").length > 0);

    expect(container.textContent).toContain("Waiting on a review gate");
    // The name is on the row and the filter reaches it.
    expect(container.querySelector('[data-testid="blocked-row-owner-mobile"]')?.textContent).toBe(
      "Priya",
    );

    act(() => root.unmount());
  });

  it("keeps a stalled row findable by the specific reason its chip prints", async () => {
    // The other half of the same contract: suppression must not make a row
    // unfindable. "Parked blocker" is the exact case from the report -- it used
    // to match K-20036 and then the row displayed "Needs attention".
    mockIssuesApi.list.mockResolvedValue([
      makeIssue(
        "issue-parked",
        "PAP-52",
        "Parked chain",
        attention({
          reason: "blocked_by_assigned_backlog_issue",
          action: { label: "Resume parked blocker", detail: null },
        }),
      ),
    ]);

    const { root } = renderWithClient(
      <BlockedInboxView {...blockedViewProps} searchQuery="Parked blocker" />,
      container,
    );
    await waitFor(() => container.querySelectorAll("a").length > 0);

    expect(container.textContent).toContain("Parked chain");
    const chip = container.querySelector('[data-testid="blocked-reason-chip"]');
    expect(chip?.textContent).toContain("Parked blocker");
    expect(chip?.getAttribute("data-variant")).toBe("needs_attention");
    expect(container.querySelector('[data-testid="blocked-row-action"]')?.textContent).toBe(
      "Resume parked blocker",
    );

    act(() => root.unmount());
  });

  it("filters rows by search query against title, identifier, owner and action", async () => {
    const issues: Issue[] = [
      makeIssue(
        "issue-1",
        "PAP-77",
        "Resume parked work",
        attention({
          reason: "blocked_by_assigned_backlog_issue",
          owner: { type: "agent", agentId: null, userId: null, label: "Charlie" },
          action: { label: "Resume parked blocker", detail: null },
        }),
      ),
      makeIssue(
        "issue-2",
        "PAP-99",
        "Other unrelated thing",
        attention({
          reason: "external_owner_action",
          owner: { type: "external", agentId: null, userId: null, label: "Vendor" },
          action: { label: "Awaiting Vendor", detail: null },
        }),
      ),
    ];
    mockIssuesApi.list.mockResolvedValue(issues);

    const { root } = renderWithClient(
      <BlockedInboxView
        {...blockedViewProps}
        searchQuery="charlie"
      />,
      container,
    );
    await waitFor(() => container.querySelectorAll("a").length > 0);

    const links = container.querySelectorAll("a");
    const titles = Array.from(links).map((a) => a.textContent ?? "");
    expect(titles.some((t) => t.includes("Resume parked work"))).toBe(true);
    expect(titles.some((t) => t.includes("Other unrelated thing"))).toBe(false);

    act(() => root.unmount());
  });

  it("uses loaded live descendants when blocked inbox rows do not have a server summary", async () => {
    mockIssuesApi.list.mockResolvedValue([
      {
        ...makeIssue(
          "blocked-parent",
          "PAP-77",
          "Blocked parent with active child",
          attention({ reason: "blocked_chain_stalled" }),
        ),
        status: "blocked",
        blockerAttention: null,
        liveDescendantCount: undefined,
      } as unknown as Issue,
    ]);

    const { root } = renderWithClient(
      <BlockedInboxView
        {...blockedViewProps}
        subtreeLiveCounts={new Map([["blocked-parent", 1]])}
      />,
      container,
    );
    await waitFor(() => container.querySelector("a") !== null);

    expect(container.querySelector('[aria-label="Blocked · waiting on 1 active sub-task"]')).not.toBeNull();

    act(() => root.unmount());
  });

  it("renders the visible error banner with retry when the query fails", async () => {
    mockIssuesApi.list.mockRejectedValue(new Error("network down"));

    const { root } = renderWithClient(
      <BlockedInboxView
        {...blockedViewProps}
      />,
      container,
    );
    await waitFor(() =>
      container.querySelector('[data-testid="blocked-inbox-error"]') !== null,
    );

    const banner = container.querySelector('[data-testid="blocked-inbox-error"]');
    expect(banner).not.toBeNull();
    expect(banner?.getAttribute("role")).toBe("alert");
    expect(banner?.textContent).toContain("Couldn't load the Blocked tab");

    act(() => root.unmount());
  });
});
