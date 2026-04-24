import { describe, expect, it } from "vitest";
import {
  planCooFlowAllocation,
  type CooCapacityLedger,
  type CooIssueActionability,
} from "../services/coo-flow-planner.ts";

const baseCapacity: CooCapacityLedger = {
  agents: [
    {
      agentId: "eng-1",
      role: "engineer",
      totalSlots: 2,
      occupiedSlots: 0,
      reservedSlots: 0,
    },
    {
      agentId: "qa-1",
      role: "qa",
      totalSlots: 1,
      occupiedSlots: 0,
      reservedSlots: 0,
    },
  ],
};

describe("COO flow planner", () => {
  it("fills eligible owned and unassigned slots in one batch", () => {
    const issues: CooIssueActionability[] = [
      {
        kind: "ready_owned",
        issueId: "owned-1",
        assigneeAgentId: "eng-1",
        priority: "high",
        updatedAt: new Date("2026-04-20T00:00:00.000Z"),
        reason: "owned issue is idle and has available capacity",
      },
      {
        kind: "ready_unassigned",
        issueId: "unassigned-1",
        eligibleAgentIds: ["eng-1"],
        priority: "medium",
        updatedAt: new Date("2026-04-21T00:00:00.000Z"),
        reason: "ready unassigned work requires ownership",
      },
      {
        kind: "ready_unassigned",
        issueId: "qa-1",
        eligibleAgentIds: ["qa-1"],
        priority: "medium",
        updatedAt: new Date("2026-04-21T00:00:00.000Z"),
        reason: "QA lane is unblocked",
      },
    ];

    const report = planCooFlowAllocation({ issues, capacity: baseCapacity });

    expect(report.actions).toEqual([
      {
        kind: "wake_owner",
        issueId: "owned-1",
        agentId: "eng-1",
        reason: "owned issue is idle and has available capacity",
      },
      {
        kind: "assign_issue",
        issueId: "qa-1",
        agentId: "qa-1",
        reason: "QA lane is unblocked",
      },
      {
        kind: "assign_issue",
        issueId: "unassigned-1",
        agentId: "eng-1",
        reason: "ready unassigned work requires ownership",
      },
    ]);
    expect(report.residualReadyIssueCount).toBe(0);
    expect(report.invariantBreaches).toEqual([]);
  });

  it("treats strict specialist gaps as capability blocks instead of generic allocation", () => {
    const issues: CooIssueActionability[] = [
      {
        kind: "ready_unassigned",
        issueId: "qa-gap",
        eligibleAgentIds: [],
        requiredRole: "qa",
        priority: "urgent",
        updatedAt: new Date("2026-04-20T00:00:00.000Z"),
        reason: "QA-scoped work requires an active QA reviewer",
      },
    ];

    const report = planCooFlowAllocation({ issues, capacity: baseCapacity });

    expect(report.actions).toEqual([
      {
        kind: "record_block",
        issueId: "qa-gap",
        reason: "capability_blocked_specialist",
        requiredRole: "qa",
      },
    ]);
    expect(report.blockedReasonCounts).toMatchObject({
      capability_blocked_specialist: 1,
    });
    expect(report.invariantBreaches).toEqual([]);
  });

  it("reserves pending wake slots before assigning more work", () => {
    const report = planCooFlowAllocation({
      issues: [
        {
          kind: "ready_unassigned",
          issueId: "reserved-slot-work",
          eligibleAgentIds: ["eng-1"],
          priority: "high",
          updatedAt: new Date("2026-04-20T00:00:00.000Z"),
          reason: "ready work should wait behind the pending wake reservation",
        },
      ],
      capacity: {
        agents: [
          {
            agentId: "eng-1",
            role: "engineer",
            totalSlots: 1,
            occupiedSlots: 0,
            reservedSlots: 1,
          },
        ],
      },
    });

    expect(report.actions).toEqual([]);
    expect(report.residualReadyIssueCount).toBe(1);
    expect(report.blockedReasonCounts.no_free_slot).toBe(1);
    expect(report.freeSlotsByRole).toEqual({});
  });

  it("plans reassignment through the same slot ledger as new work", () => {
    const report = planCooFlowAllocation({
      issues: [
        {
          kind: "ready_reassignable",
          issueId: "wrong-owner",
          currentAssigneeAgentId: "qa-1",
          eligibleAgentIds: ["eng-1"],
          preferredAgentId: "eng-1",
          priority: "high",
          updatedAt: new Date("2026-04-20T00:00:00.000Z"),
          reason: "assigned specialist no longer matches the work",
          correctionReason: "wrong_specialist_reassigned",
        },
        {
          kind: "ready_unassigned",
          issueId: "second-work",
          eligibleAgentIds: ["eng-1"],
          priority: "medium",
          updatedAt: new Date("2026-04-21T00:00:00.000Z"),
          reason: "ready unassigned work requires ownership",
        },
      ],
      capacity: {
        agents: [{
          agentId: "eng-1",
          role: "engineer",
          totalSlots: 1,
          occupiedSlots: 0,
          reservedSlots: 0,
        }],
      },
    });

    expect(report.actions).toEqual([
      {
        kind: "reassign_issue",
        issueId: "wrong-owner",
        fromAgentId: "qa-1",
        agentId: "eng-1",
        reason: "assigned specialist no longer matches the work",
        correctionReason: "wrong_specialist_reassigned",
      },
    ]);
    expect(report.residualReadyIssueCount).toBe(1);
    expect(report.blockedReasonCounts.no_free_slot).toBe(1);
  });

  it("uses priority first and age as the starvation tie-breaker", () => {
    const issues: CooIssueActionability[] = [
      {
        kind: "ready_unassigned",
        issueId: "medium-old",
        eligibleAgentIds: ["eng-1"],
        priority: "medium",
        updatedAt: new Date("2026-04-10T00:00:00.000Z"),
        reason: "old but lower priority",
      },
      {
        kind: "ready_unassigned",
        issueId: "high-new",
        eligibleAgentIds: ["eng-1"],
        priority: "high",
        updatedAt: new Date("2026-04-23T00:00:00.000Z"),
        reason: "higher priority",
      },
      {
        kind: "ready_unassigned",
        issueId: "high-old",
        eligibleAgentIds: ["eng-1"],
        priority: "high",
        updatedAt: new Date("2026-04-12T00:00:00.000Z"),
        reason: "same priority but older",
      },
    ];

    const report = planCooFlowAllocation({
      issues,
      capacity: {
        agents: [{
          agentId: "eng-1",
          role: "engineer",
          totalSlots: 2,
          occupiedSlots: 0,
          reservedSlots: 0,
        }],
      },
    });

    expect(report.actions.map((action) => action.issueId)).toEqual(["high-old", "high-new"]);
    expect(report.residualReadyIssueCount).toBe(1);
    expect(report.blockedReasonCounts.no_free_slot).toBe(1);
  });

  it("explains unused capacity when slots remain open", () => {
    const report = planCooFlowAllocation({
      issues: [
        {
          kind: "blocked",
          issueId: "external-wait",
          reason: "waiting_external",
        },
      ],
      capacity: baseCapacity,
    });

    expect(report.freeSlotsByRole).toEqual({ engineer: 2, qa: 1 });
    expect(report.unusedCapacityReasons).toEqual({
      engineer: "external_wait",
      qa: "external_wait",
    });
    expect(report.blockedReasonCounts.waiting_external).toBe(1);
  });

  it("reports unavailable slots separately from free slots", () => {
    const report = planCooFlowAllocation({
      issues: [
        {
          kind: "blocked",
          issueId: "external-wait",
          reason: "waiting_external",
        },
      ],
      capacity: {
        agents: [
          {
            agentId: "eng-1",
            role: "engineer",
            totalSlots: 2,
            occupiedSlots: 0,
            reservedSlots: 0,
          },
          {
            agentId: "qa-paused",
            role: "qa",
            totalSlots: 2,
            occupiedSlots: 0,
            reservedSlots: 0,
            unavailableReason: "paused",
          },
          {
            agentId: "qa-pending",
            role: "qa",
            totalSlots: 1,
            occupiedSlots: 0,
            reservedSlots: 0,
            unavailableReason: "pending_approval",
          },
        ],
      },
    });

    expect(report.freeSlotsByRole).toEqual({ engineer: 2 });
    expect(report.unavailableSlotsByRole).toEqual({ qa: 3 });
    expect(report.unavailableCapacityReasonsByRole).toEqual({
      qa: {
        paused: 2,
        pending_approval: 1,
      },
    });
  });
});
