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
  blockedRowActionLabel,
  blockedRowMatchesSearch,
  blockedRowSearchTokens,
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

  describe("blockedRowActionLabel", () => {
    it("suppresses the blocked_chain_stalled fallback action", () => {
      // K-20108. The stall branch is the fallback of the attention build: on
      // the live board it carried the action on 51 of 60 attended rows, all
      // with `leafIssue: null` and one byte-identical detail string, so it names
      // no target -- and the rows already sit under a group header reading
      // "Blocked chain stalled". The detail below is the server's real string
      // (`server/src/services/issues.ts`, the `blocked_chain_stalled` branch),
      // abbreviated in an earlier draft of this test, which made the fixture
      // differ from the measured case it is supposed to pin.
      expect(
        blockedRowActionLabel(
          makeAttention({
            reason: "blocked_chain_stalled",
            action: {
              label: "Inspect blocker chain",
              detail:
                "Inspect the stalled blocker or review leaf and make the next owner/action explicit.",
            },
          }),
        ),
      ).toBeNull();
    });

    it("keeps the specific actions the stall fallback crowds out", () => {
      // These are the 16 of 76 rows that named a real next step.
      const cases: Array<[IssueBlockedInboxReason, string]> = [
        ["pending_board_decision", "Answer confirmation"],
        ["pending_user_decision", "Answer confirmation"],
        ["missing_successful_run_disposition", "Choose disposition"],
        ["blocked_by_assigned_backlog_issue", "Resume parked blocker"],
        ["blocked_by_unassigned_issue", "Assign blocker"],
        ["blocked_by_cancelled_issue", "Replace blocker"],
      ];
      for (const [reason, label] of cases) {
        expect(blockedRowActionLabel(makeAttention({ reason, action: { label, detail: null } }))).toBe(label);
      }
    });

    it("does not suppress a specific action that arrives on a stalled row", () => {
      // The rule keys on the label, not the reason, so a future server that
      // attaches a real target to a stalled chain will surface it rather than
      // silently dropping it. This is re-open condition 1 of 3.
      expect(
        blockedRowActionLabel(
          makeAttention({
            reason: "blocked_chain_stalled",
            action: { label: "Unblock K-20015 by removing done blocker K-20016", detail: null },
          }),
        ),
      ).toBe("Unblock K-20015 by removing done blocker K-20016");
    });

    it("re-opens the fallback label on a stalled row that carries a leaf", () => {
      // Re-open condition 2. The design guide promises this, so it has to be
      // implemented, not just described. A stalled row with a leaf now names a
      // target, which is the whole reason the label was suppressed before.
      expect(
        blockedRowActionLabel(
          makeAttention({
            reason: "blocked_chain_stalled",
            action: {
              label: "Inspect blocker chain",
              detail: "Inspect the stalled blocker or review leaf and make the next owner/action explicit.",
            },
            leafIssue: {
              id: "leaf-1",
              identifier: "PAP-20119",
              title: "The blocker this chain stalls on",
              status: "backlog",
              priority: "medium",
              assigneeAgentId: null,
              assigneeUserId: null,
            },
          }),
        ),
      ).toBe("Inspect blocker chain");
    });

    it("re-opens the fallback label when the detail stops being the canonical string", () => {
      // Re-open condition 3. One byte-identical detail across all 51 stalled
      // rows is what makes the row noise; the moment it is not, the row is
      // carrying something the label alone does not.
      expect(
        blockedRowActionLabel(
          makeAttention({
            reason: "blocked_chain_stalled",
            action: {
              label: "Inspect blocker chain",
              detail: "Done blocker K-20016 is still linked; remove it to release K-20015.",
            },
          }),
        ),
      ).toBe("Inspect blocker chain");
    });

    it("still suppresses the fallback when a leaf is present but the detail is canonical", () => {
      // A leaf alone is not the signal -- the row must actually differ. This is
      // the one combination that is ambiguous, and it stays suppressed because
      // it is byte-identical to the measured degenerate case.
      const withLeaf = makeAttention({
        reason: "blocked_chain_stalled",
        action: {
          label: "Inspect blocker chain",
          detail: "Inspect the stalled blocker or review leaf and make the next owner/action explicit.",
        },
      });
      // A recovery ref is not a target the action can point at, so it does not
      // lift suppression on its own.
      expect(blockedRowActionLabel(withLeaf)).toBeNull();
      expect(
        blockedRowActionLabel(
          makeAttention({
            ...withLeaf,
            recoveryIssue: {
              id: "rec-1",
              identifier: "PAP-20120",
              title: "Recovery run",
              status: "in_progress",
              priority: "medium",
              assigneeAgentId: null,
              assigneeUserId: null,
            },
          }),
        ),
      ).toBeNull();
    });

    it("treats a blank action as no action", () => {
      expect(
        blockedRowActionLabel(makeAttention({ reason: "pending_board_decision", action: { label: "   ", detail: null } })),
      ).toBeNull();
    });
  });

  describe("blockedRowSearchTokens", () => {
    it("only indexes text the row actually displays", () => {
      // The parity contract. Before K-20108 the haystack carried
      // `action.detail`, which the row never rendered in any form, so a search
      // could match a row that showed nothing of the sort.
      const row = buildBlockedInboxRows([
        makeIssue(
          { id: "p1", title: "Ship the batch" },
          makeAttention({
            reason: "pending_board_decision",
            action: { label: "Answer confirmation", detail: "SECRET_DETAIL_SENTINEL" },
          }),
        ),
      ])[0]!;
      const tokens = blockedRowSearchTokens(row).join(" ");
      expect(tokens).toContain("Answer confirmation");
      expect(tokens).toContain("Pending board decision");
      expect(tokens).not.toContain("SECRET_DETAIL_SENTINEL");
    });

    it("does not index leaf/recovery refs the row never renders", () => {
      // The property above was asserted in its name but not in its body: every
      // fixture here defaults `leafIssue`/`recoveryIssue` to null, so nothing
      // ever exercised a row that carried them. It did once -- these four
      // tokens were indexed while no render path drew them, so a search for a
      // leaf or recovery title matched a row showing none of it.
      const row = buildBlockedInboxRows([
        makeIssue(
          { id: "p5", title: "Ship the batch" },
          makeAttention({
            reason: "blocked_chain_stalled",
            action: { label: "Inspect blocker chain", detail: null },
            leafIssue: {
              id: "leaf-1",
              identifier: "PAP-90001",
              title: "Leaf sentinel title",
              status: "todo",
              priority: "medium",
              assigneeAgentId: null,
              assigneeUserId: null,
            },
            recoveryIssue: {
              id: "rec-1",
              identifier: "PAP-90002",
              title: "Recovery sentinel title",
              status: "todo",
              priority: "medium",
              assigneeAgentId: null,
              assigneeUserId: null,
            },
          }),
        ),
      ])[0]!;
      const tokens = blockedRowSearchTokens(row).join(" ");
      expect(tokens).not.toContain("PAP-90001");
      expect(tokens).not.toContain("Leaf sentinel title");
      expect(tokens).not.toContain("PAP-90002");
      expect(tokens).not.toContain("Recovery sentinel title");
      expect(blockedRowMatchesSearch(row, "Leaf sentinel title")).toBe(false);
      expect(blockedRowMatchesSearch(row, "Recovery sentinel title")).toBe(false);
      // The row's own identity is still indexed -- the drop is scoped to the
      // refs, not to search in general.
      expect(blockedRowMatchesSearch(row, "Ship the batch")).toBe(true);
    });

    it("indexes the specific reason and the group label, and not a suppressed action", () => {
      const row = buildBlockedInboxRows([
        makeIssue(
          { id: "p2", title: "Stalled thing" },
          makeAttention({
            reason: "blocked_chain_stalled",
            action: { label: "Inspect blocker chain", detail: null },
          }),
        ),
      ])[0]!;
      const tokens = blockedRowSearchTokens(row);
      // The specific reason the chip now prints.
      expect(tokens).toContain("Blocked chain stalled");
      // Suppressed on screen, so it must not be findable either -- otherwise the
      // suppression hides the text while leaving it searchable.
      expect(tokens).not.toContain("Inspect blocker chain");
      expect(blockedRowMatchesSearch(row, "Inspect blocker chain")).toBe(false);
    });

    it("indexes the group label only when the group header is rendered", () => {
      // Two different strings, and only one of them is always on screen: the
      // reason is on the chip, the variant is on the group header the row is
      // bucketed under. With grouping set to "None" there is no header, so
      // indexing "Needs attention" would match a row that reads only "Parked
      // blocker" -- the same findable-but-invisible defect, other door.
      const row = buildBlockedInboxRows([
        makeIssue(
          { id: "p4", title: "Needs an owner" },
          makeAttention({
            reason: "blocked_by_unassigned_issue",
            action: { label: "Assign blocker", detail: null },
          }),
        ),
      ])[0]!;
      expect(blockedVariantLabel(row.variant)).toBe("Needs attention");

      // Grouping on: the header is drawn, so the label is findable.
      const grouped = { groupLabel: blockedVariantLabel(row.variant) };
      expect(blockedRowSearchTokens(row, grouped)).toContain("Needs attention");
      expect(blockedRowMatchesSearch(row, "Needs attention", grouped)).toBe(true);

      // Grouping off: nothing draws it, so it must not match.
      expect(blockedRowSearchTokens(row, { groupLabel: null })).not.toContain("Needs attention");
      expect(blockedRowMatchesSearch(row, "Needs attention", { groupLabel: null })).toBe(false);
      // Omitting the context is the conservative default for the same reason.
      expect(blockedRowMatchesSearch(row, "Needs attention")).toBe(false);

      // The specific reason the chip actually prints is findable either way.
      expect(blockedRowMatchesSearch(row, "Unassigned blocker")).toBe(true);
    });

    it("indexes the owner name the row resolves, not the raw owner field", () => {
      // The server sets `owner.label: null` on the finding-driven path
      // (server/src/services/issues.ts ~L6345) while the row still draws the
      // assignee name resolved from `owner.agentId`. Indexing the raw field
      // alone made a displayed name unfindable -- the inverse of the defect
      // above, and lower severity, but the same parity contract.
      const row = buildBlockedInboxRows([
        makeIssue(
          { id: "p5", title: "Waiting on a review gate" },
          makeAttention({
            reason: "in_review_without_action_path",
            owner: { type: "agent", agentId: "agent-77", userId: null, label: null },
            action: { label: "Choose review path", detail: null },
          }),
        ),
      ])[0]!;

      expect(row.attention.owner.label).toBeNull();
      expect(blockedRowMatchesSearch(row, "agent-77")).toBe(false);

      // The row displays the resolved name, so the search must index it.
      expect(blockedRowMatchesSearch(row, "Priya", { ownerLabel: "Priya" })).toBe(true);
      expect(blockedRowSearchTokens(row, { ownerLabel: "Priya" })).toContain("Priya");
    });

    it("finds a row by the specific reason its chip now prints", () => {
      // The bug this fixes: typing "Parked blocker" matched K-20036 and the row
      // then displayed "Needs attention".
      const row = buildBlockedInboxRows([
        makeIssue(
          { id: "p3", title: "Waiting on a parked task" },
          makeAttention({
            reason: "blocked_by_assigned_backlog_issue",
            action: { label: "Resume parked blocker", detail: null },
          }),
        ),
      ])[0]!;
      expect(blockedRowMatchesSearch(row, "Parked blocker")).toBe(true);
      expect(blockedReasonLabel(row.attention.reason)).toBe("Parked blocker");
      expect(blockedRowActionLabel(row.attention)).toBe("Resume parked blocker");
    });
  });
});
