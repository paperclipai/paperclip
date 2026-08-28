// @vitest-environment node

import { describe, expect, it } from "vitest";
import type {
  Issue,
  IssueBlockedInboxAttention,
  IssueBlockedInboxReason,
  IssueBlockedInboxSeverity,
} from "@paperclipai/shared";
import {
  BLOCKED_REASON_VARIANT_ORDER,
  blockedBadgeTone,
  blockedReasonLabel,
  blockedReasonVariant,
  blockedRowMatchesSearch,
  blockedSeverityRank,
  blockedVariantLabel,
  buildBlockedInboxRows,
  compareBlockedAttention,
  compareBlockedRows,
  formatStoppedAge,
  groupBlockedInboxRows,
  sortBlockedInboxRows,
  type BlockedInboxIssueRow,
} from "./blockedInbox";

function makeAttention(
  overrides: Partial<IssueBlockedInboxAttention> = {},
): IssueBlockedInboxAttention {
  return {
    kind: "blocked",
    state: "needs_attention",
    reason: "blocked_chain_stalled",
    severity: "medium",
    stoppedSinceAt: "2026-05-08T12:00:00.000Z",
    owner: { type: "agent", agentId: null, userId: null, label: "QA" },
    action: { label: "Resolve PAP-1", detail: null },
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
  overrides: Partial<Issue> & { id: string },
  attention: IssueBlockedInboxAttention | null = null,
): Issue {
  const { id, ...rest } = overrides;
  return {
    id,
    companyId: "company-1",
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: "Title",
    description: null,
    status: "in_progress",
    workMode: "standard",
    priority: "medium",
    assigneeAgentId: null,
    assigneeUserId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
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
    blockedInboxAttention: attention,
    createdAt: new Date("2026-05-09T00:00:00.000Z"),
    updatedAt: new Date("2026-05-09T00:00:00.000Z"),
    ...rest,
  } as Issue;
}

describe("blockedInbox", () => {
  it("maps every reason to a known variant and label", () => {
    const reasons: IssueBlockedInboxReason[] = [
      "pending_board_decision",
      "pending_user_decision",
      "missing_successful_run_disposition",
      "blocked_chain_stalled",
      "blocked_by_unassigned_issue",
      "blocked_by_assigned_backlog_issue",
      "blocked_by_cancelled_issue",
      "blocked_by_uninvokable_assignee",
      "in_review_without_action_path",
      "invalid_review_participant",
      "open_recovery_issue",
      "external_owner_action",
    ];
    for (const reason of reasons) {
      const variant = blockedReasonVariant(reason);
      expect(BLOCKED_REASON_VARIANT_ORDER).toContain(variant);
      expect(blockedVariantLabel(variant)).toBeTruthy();
      expect(blockedReasonLabel(reason)).toBeTruthy();
    }
  });

  it("ranks severity critical first and low last", () => {
    const order: IssueBlockedInboxSeverity[] = ["critical", "high", "medium", "low"];
    const ranks = order.map((s) => blockedSeverityRank(s));
    expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
  });

  it("compares by severity first, then stoppedSinceAt", () => {
    const a = makeAttention({
      severity: "critical",
      stoppedSinceAt: "2026-05-08T13:00:00.000Z",
    });
    const b = makeAttention({
      severity: "high",
      stoppedSinceAt: "2026-05-08T10:00:00.000Z",
    });
    const c = makeAttention({
      severity: "high",
      stoppedSinceAt: "2026-05-08T12:00:00.000Z",
    });
    expect(compareBlockedAttention(a, b)).toBeLessThan(0);
    // both 'high', earlier stoppedSinceAt sorts first
    expect(compareBlockedAttention(b, c)).toBeLessThan(0);
  });

  it("keeps equal unstopped attention comparisons deterministic", () => {
    const a = makeAttention({ severity: "high", stoppedSinceAt: null });
    const b = makeAttention({ severity: "high", stoppedSinceAt: null });
    expect(compareBlockedAttention(a, b)).toBe(0);
  });

  it("buildBlockedInboxRows skips issues without attention", () => {
    const issues = [
      makeIssue({ id: "issue-1" }, makeAttention()),
      makeIssue({ id: "issue-2" }, null),
    ];
    const rows = buildBlockedInboxRows(issues);
    expect(rows).toHaveLength(1);
    expect(rows[0].issue.id).toBe("issue-1");
  });

  it("groupBlockedInboxRows orders groups by canonical variant order and sorts within group", () => {
    const issues = [
      makeIssue(
        { id: "external-1" },
        makeAttention({ reason: "external_owner_action", severity: "low" }),
      ),
      makeIssue(
        { id: "stalled-1" },
        makeAttention({
          reason: "blocked_chain_stalled",
          severity: "high",
          stoppedSinceAt: "2026-05-09T01:00:00.000Z",
        }),
      ),
      makeIssue(
        { id: "stalled-2" },
        makeAttention({
          reason: "blocked_chain_stalled",
          severity: "critical",
          stoppedSinceAt: "2026-05-09T05:00:00.000Z",
        }),
      ),
      makeIssue(
        { id: "decision-1" },
        makeAttention({ reason: "pending_board_decision", severity: "medium" }),
      ),
    ];
    const groups = groupBlockedInboxRows(buildBlockedInboxRows(issues));
    expect(groups.map((g) => g.variant)).toEqual([
      "needs_decision",
      "stalled",
      "external_wait",
    ]);
    const stalled = groups.find((g) => g.variant === "stalled")!;
    expect(stalled.rows.map((r) => r.issue.id)).toEqual(["stalled-2", "stalled-1"]);
  });

  it("sortBlockedInboxRows supports recent and longest-stopped ordering", () => {
    const rows = buildBlockedInboxRows([
      makeIssue(
        { id: "old", title: "Old stopped" },
        makeAttention({
          severity: "low",
          stoppedSinceAt: "2026-05-06T00:00:00.000Z",
        }),
      ),
      makeIssue(
        { id: "recent", title: "Recently stopped" },
        makeAttention({
          severity: "critical",
          stoppedSinceAt: "2026-05-09T00:00:00.000Z",
        }),
      ),
      makeIssue(
        { id: "middle", title: "Middle stopped" },
        makeAttention({
          severity: "medium",
          stoppedSinceAt: "2026-05-08T00:00:00.000Z",
        }),
      ),
    ]);

    expect(sortBlockedInboxRows(rows, "most_recent").map((row) => row.issue.id)).toEqual([
      "recent",
      "middle",
      "old",
    ]);
    expect(sortBlockedInboxRows(rows, "longest_stopped").map((row) => row.issue.id)).toEqual([
      "old",
      "middle",
      "recent",
    ]);
    expect(compareBlockedRows(rows[0], rows[1], "most_recent")).toBeGreaterThan(0);
  });

  it("blockedRowMatchesSearch matches title, identifier, owner, action and reason", () => {
    const issue = makeIssue(
      { id: "issue-1", identifier: "PAP-77", title: "Resume parked work" },
      makeAttention({
        reason: "blocked_by_assigned_backlog_issue",
        owner: { type: "agent", agentId: null, userId: null, label: "Charlie" },
        action: { label: "Resume parked blocker", detail: null },
      }),
    );
    const row: BlockedInboxIssueRow = buildBlockedInboxRows([issue])[0];
    expect(blockedRowMatchesSearch(row, "")).toBe(true);
    expect(blockedRowMatchesSearch(row, "pap-77")).toBe(true);
    expect(blockedRowMatchesSearch(row, "parked")).toBe(true);
    expect(blockedRowMatchesSearch(row, "charlie")).toBe(true);
    expect(blockedRowMatchesSearch(row, "no match")).toBe(false);
  });

  it("blockedBadgeTone reflects the highest severity present", () => {
    const empty: BlockedInboxIssueRow[] = [];
    expect(blockedBadgeTone(empty)).toBe("muted");

    const issues = [
      makeIssue({ id: "a" }, makeAttention({ severity: "low" })),
      makeIssue({ id: "b" }, makeAttention({ severity: "high" })),
    ];
    expect(blockedBadgeTone(buildBlockedInboxRows(issues))).toBe("amber");

    const critical = [
      ...issues,
      makeIssue({ id: "c" }, makeAttention({ severity: "critical" })),
    ];
    expect(blockedBadgeTone(buildBlockedInboxRows(critical))).toBe("red");
  });

  it("formatStoppedAge produces stable buckets", () => {
    const now = new Date("2026-05-10T00:00:00.000Z").getTime();
    expect(formatStoppedAge(null)).toBe("stopped");
    expect(formatStoppedAge("2026-05-09T23:59:30.000Z", now)).toBe("stopped just now");
    expect(formatStoppedAge("2026-05-09T23:30:00.000Z", now)).toBe("stopped 30m");
    expect(formatStoppedAge("2026-05-09T20:00:00.000Z", now)).toBe("stopped 4h");
    expect(formatStoppedAge("2026-05-07T00:00:00.000Z", now)).toBe("stopped 3d");
    expect(formatStoppedAge("2026-04-15T00:00:00.000Z", now)).toBe("stopped 3w");
  });
});
