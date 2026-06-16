import { describe, expect, it } from "vitest";
import {
  formatAcPolicyCancelDashboardSections,
  partitionAcPolicyCancelCandidates,
  planAcPolicyAutoCancelBatch,
  type AcPolicyCancelCandidate,
} from "../services/ac-policy-sweep.js";

describe("AC-policy auto-cancel candidate partitioning", () => {
  it("keeps only stale agent-owned work in auto-cancel-safe from a mixed candidate fixture", () => {
    const candidates: AcPolicyCancelCandidate[] = [
      {
        id: "stale-agent-owned",
        identifier: "BLO-1",
        title: "Stale agent-owned task missing AC",
        status: "todo",
        assigneeAgentId: "agent-1",
        assigneeUserId: null,
        createdByUserId: null,
        originKind: "manual",
        blocks: [],
      },
      {
        id: "user-assigned-board-ask",
        identifier: "BLO-2",
        title: "Board ask: approve launch window",
        status: "todo",
        assigneeAgentId: null,
        assigneeUserId: "user-1",
        createdByUserId: "user-1",
        originKind: "manual",
        blocks: [],
      },
      {
        id: "productivity-review",
        identifier: "BLO-3",
        title: "[user-cover] productivity-review escalation: BLO-100",
        status: "todo",
        assigneeAgentId: null,
        assigneeUserId: "user-1",
        createdByUserId: null,
        originKind: "productivity_review_escalation",
        blocks: [],
      },
      {
        id: "active-blocker",
        identifier: "BLO-4",
        title: "Proof task currently blocking implementation",
        status: "todo",
        assigneeAgentId: "agent-1",
        assigneeUserId: null,
        createdByUserId: null,
        originKind: "manual",
        blocks: [{ id: "parent-1", identifier: "BLO-5", status: "blocked" }],
      },
    ];

    const partitioned = partitionAcPolicyCancelCandidates(candidates);

    expect(partitioned.autoCancelSafe.map((issue) => issue.id)).toEqual(["stale-agent-owned"]);
    expect(partitioned.needsHumanTriage.map((issue) => issue.id)).toEqual([
      "user-assigned-board-ask",
      "productivity-review",
      "active-blocker",
    ]);
    expect(partitioned.needsHumanTriage.find((issue) => issue.id === "user-assigned-board-ask")?.triageReasons).toEqual([
      "user_assigned",
      "user_owned_protected",
    ]);
    expect(partitioned.needsHumanTriage.find((issue) => issue.id === "productivity-review")?.triageReasons).toContain(
      "productivity_review_escalation",
    );
    expect(partitioned.needsHumanTriage.find((issue) => issue.id === "active-blocker")?.triageReasons).toEqual([
      "active_blocker_for_non_terminal_parent",
    ]);
  });

  it("does not triage candidates that only block terminal parent work", () => {
    const candidates: AcPolicyCancelCandidate[] = [
      {
        id: "terminal-parent-blocker",
        identifier: "BLO-6",
        title: "Old proof task blocking completed parent",
        status: "todo",
        assigneeAgentId: "agent-1",
        blocks: [{ id: "parent-1", identifier: "BLO-7", status: "done" }],
      },
    ];

    const partitioned = partitionAcPolicyCancelCandidates(candidates);

    expect(partitioned.autoCancelSafe.map((issue) => issue.id)).toEqual(["terminal-parent-blocker"]);
    expect(partitioned.needsHumanTriage).toEqual([]);
  });

  it("triages user-created board asks even when currently assigned to an agent", () => {
    const candidates: AcPolicyCancelCandidate[] = [
      {
        id: "user-created-agent-assigned",
        identifier: "BLO-15",
        title: "Board ask assigned to CTO",
        status: "todo",
        assigneeAgentId: "agent-1",
        assigneeUserId: null,
        createdByUserId: "user-1",
      },
    ];

    const partitioned = partitionAcPolicyCancelCandidates(candidates);

    expect(partitioned.autoCancelSafe).toEqual([]);
    expect(partitioned.needsHumanTriage[0]?.triageReasons).toEqual(["user_owned_protected"]);
  });

  it("triages blockers with missing parent status instead of destructively cancelling unknown dependency work", () => {
    const candidates: AcPolicyCancelCandidate[] = [
      {
        id: "unknown-parent-status",
        identifier: "BLO-8",
        title: "Old proof task with partial relation data",
        status: "todo",
        assigneeAgentId: "agent-1",
        blocks: [{ id: "parent-1", identifier: "BLO-9" }],
      },
    ];

    const partitioned = partitionAcPolicyCancelCandidates(candidates);

    expect(partitioned.autoCancelSafe).toEqual([]);
    expect(partitioned.needsHumanTriage[0]?.triageReasons).toEqual(["active_blocker_for_non_terminal_parent"]);
  });

  it("applies the destructive safety cap only to auto-cancel-safe candidates", () => {
    const candidates: AcPolicyCancelCandidate[] = [
      {
        id: "safe-1",
        identifier: "BLO-10",
        title: "Stale task one",
        status: "todo",
        assigneeAgentId: "agent-1",
      },
      {
        id: "safe-2",
        identifier: "BLO-11",
        title: "Stale task two",
        status: "todo",
        assigneeAgentId: "agent-1",
      },
      {
        id: "triage-1",
        identifier: "BLO-12",
        title: "Board ask",
        status: "todo",
        assigneeUserId: "user-1",
      },
    ];

    const plan = planAcPolicyAutoCancelBatch(candidates, 1);

    expect(plan.cancelPaused).toBe(true);
    expect(plan.autoCancelBatch).toEqual([]);
    expect(plan.autoCancelSafe.map((issue) => issue.id)).toEqual(["safe-1", "safe-2"]);
    expect(plan.needsHumanTriage.map((issue) => issue.id)).toEqual(["triage-1"]);
  });

  it("formats dashboard output with separate safe and triage sections", () => {
    const candidates: AcPolicyCancelCandidate[] = [
      {
        id: "safe-1",
        identifier: "BLO-13",
        title: "Stale task",
        status: "todo",
        assigneeAgentId: "agent-1",
      },
      {
        id: "triage-1",
        identifier: "BLO-14",
        title: "Board ask",
        status: "todo",
        assigneeUserId: "user-1",
      },
    ];

    expect(formatAcPolicyCancelDashboardSections(candidates)).toContain("### Auto-cancel-safe candidates (1)");
    expect(formatAcPolicyCancelDashboardSections(candidates)).toContain("- BLO-13 (safe-1) - Stale task");
    expect(formatAcPolicyCancelDashboardSections(candidates)).toContain("### Needs-human-triage candidates (1)");
    expect(formatAcPolicyCancelDashboardSections(candidates)).toContain("- BLO-14 (triage-1) - Board ask (user_assigned)");
  });
});
