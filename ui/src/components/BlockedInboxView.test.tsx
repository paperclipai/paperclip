// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Issue, IssueBlockedInboxAttention } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockIssuesApi = vi.hoisted(() => ({
  list: vi.fn(),
  count: vi.fn(),
  acceptInteraction: vi.fn(),
}));
const mockNavigate = vi.hoisted(() => vi.fn());

vi.mock("../api/issues", () => ({
  issuesApi: mockIssuesApi,
}));

vi.mock("@/lib/router", () => ({
  useNavigate: () => mockNavigate,
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

import { BlockedInboxView } from "./BlockedInboxView";
import { ToastProvider } from "../context/ToastContext";
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
    root.render(
      <QueryClientProvider client={queryClient}>
        <ToastProvider>{node}</ToastProvider>
      </QueryClientProvider>,
    );
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
    mockIssuesApi.acceptInteraction.mockReset();
    mockNavigate.mockReset();
  });

  afterEach(() => {
    container.remove();
  });

  it("shows the empty state when no blocked issues are returned", async () => {
    mockIssuesApi.list.mockResolvedValue([]);
    const { root } = renderWithClient(
      <BlockedInboxView
        {...blockedViewProps}
      />,
      container,
    );
    await waitFor(() => container.querySelector('[data-testid="blocked-inbox-empty"]') !== null);
    expect(container.querySelector('[data-testid="blocked-inbox-empty"]')).not.toBeNull();
    act(() => root.unmount());
  });

  it("offers an inline Approve button for a pending board decision and accepts the interaction", async () => {
    const interactionId = "00000000-0000-0000-0000-0000000000aa";
    mockIssuesApi.acceptInteraction.mockResolvedValue({ id: interactionId, kind: "request_confirmation" });
    mockIssuesApi.list.mockResolvedValue([
      makeIssue(
        "issue-approve",
        "PAP-50",
        "Approve cockpit data entry flows plan",
        attention({
          reason: "pending_board_decision",
          state: "awaiting_decision",
          owner: { type: "board", agentId: null, userId: null, label: "Board" },
          action: { label: "Answer confirmation", detail: null },
          interactionId,
        }),
      ),
    ]);

    const { root } = renderWithClient(<BlockedInboxView {...blockedViewProps} />, container);
    await waitFor(() => container.querySelector('[data-testid="blocked-row-approve"]') !== null);

    const approveButton = container.querySelector('[data-testid="blocked-row-approve"]') as HTMLButtonElement;
    expect(approveButton).not.toBeNull();
    await act(async () => {
      approveButton.click();
    });
    await waitFor(() => mockIssuesApi.acceptInteraction.mock.calls.length > 0);
    expect(mockIssuesApi.acceptInteraction).toHaveBeenCalledWith("issue-approve", interactionId, {});
    act(() => root.unmount());
  });

  it("shows a labelled action (not Approve) for a non-interaction blocker and opens the target issue", async () => {
    mockIssuesApi.list.mockResolvedValue([
      makeIssue(
        "issue-recovery",
        "PAP-60",
        "Open recovery row",
        attention({
          reason: "open_recovery_issue",
          severity: "high",
          action: { label: "Resolve recovery", detail: null },
          recoveryIssue: {
            id: "issue-recovery",
            identifier: "PAP-60",
            title: "Open recovery row",
            status: "in_review",
            priority: "high",
            assigneeAgentId: "agent-1",
            assigneeUserId: null,
          },
        }),
      ),
    ]);
    const { root } = renderWithClient(<BlockedInboxView {...blockedViewProps} />, container);
    await waitFor(() => container.querySelector('[data-testid="blocked-row-action"]') !== null);
    // No Approve button for a non-board-decision row...
    expect(container.querySelector('[data-testid="blocked-row-approve"]')).toBeNull();
    // ...but there is a labelled action control the user can act on.
    const actionButton = container.querySelector('[data-testid="blocked-row-action"]') as HTMLButtonElement;
    expect(actionButton).not.toBeNull();
    expect(actionButton.textContent).toContain("Resolve recovery");
    await act(async () => {
      actionButton.click();
    });
    expect(mockNavigate).toHaveBeenCalledWith("/issues/PAP-60");
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
          interactionId: "00000000-0000-0000-0000-0000000000b4",
        }),
      ),
    ]);

    const { root } = renderWithClient(
      <BlockedInboxView
        {...blockedViewProps}
      />,
      container,
    );
    await waitFor(() => container.querySelector("a") !== null);

    const rowText = container.querySelector("a")?.textContent ?? "";
    expect(rowText.indexOf("Pending board decision")).toBeGreaterThanOrEqual(0);
    expect(rowText.indexOf("Needs decision")).toBeGreaterThan(rowText.indexOf("Pending board decision"));
    expect(rowText.indexOf("Board")).toBeGreaterThan(rowText.indexOf("Needs decision"));
    // A real board decision carries an interaction id, so it shows Approve/Review
    // controls rather than dumping the raw server action label into the row.
    expect(rowText).not.toContain("Accept or reject");
    expect(container.querySelector('[data-testid="blocked-row-approve"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="blocked-row-reason-column"]')?.textContent).toContain("Needs decision");

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
