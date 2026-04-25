import { issuePriorityWeight } from "@paperclipai/shared";

export type CooBlockedReason =
  | "active_execution"
  | "assignee_unavailable"
  | "blocked_dependency"
  | "capability_blocked_specialist"
  | "cooldown"
  | "human_owned"
  | "merge_blocked"
  | "no_assignable_agent"
  | "no_free_slot"
  | "pending_wakeup"
  | "waiting_external"
  | "policy_blocked"
  | "unknown";

export type CooIssueActionability =
  | {
      kind: "active";
      issueId: string;
    }
  | {
      kind: "blocked";
      issueId: string;
      reason: CooBlockedReason;
      requiredRole?: string | null;
    }
  | {
      kind: "needs_repair";
      issueId: string;
      priority: string | null;
      updatedAt: Date;
      reason: string;
      newlyUnblocked?: boolean;
    }
  | {
      kind: "ready_owned";
      issueId: string;
      assigneeAgentId: string;
      priority: string | null;
      updatedAt: Date;
      reason: string;
      newlyUnblocked?: boolean;
    }
  | {
      kind: "ready_reassignable";
      issueId: string;
      currentAssigneeAgentId: string;
      eligibleAgentIds: string[];
      priority: string | null;
      updatedAt: Date;
      reason: string;
      correctionReason: CooOwnershipCorrectionReason;
      preferredAgentId?: string | null;
      newlyUnblocked?: boolean;
    }
  | {
      kind: "ready_unassigned";
      issueId: string;
      eligibleAgentIds: string[];
      priority: string | null;
      updatedAt: Date;
      reason: string;
      preferredAgentId?: string | null;
      requiredRole?: string | null;
      newlyUnblocked?: boolean;
    };

export type CooOwnershipCorrectionReason =
  | "wrong_specialist_reassigned"
  | "slot_rebalanced";

export type CooCapacityLedger = {
  agents: Array<{
    agentId: string;
    role: string;
    totalSlots: number;
    occupiedSlots: number;
    reservedSlots: number;
    unavailableReason?: string | null;
  }>;
};

export type CooAllocationAction =
  | {
      kind: "repair_issue";
      issueId: string;
      reason: string;
    }
  | {
      kind: "wake_owner";
      issueId: string;
      agentId: string;
      reason: string;
    }
  | {
      kind: "assign_issue";
      issueId: string;
      agentId: string;
      reason: string;
    }
  | {
      kind: "reassign_issue";
      issueId: string;
      fromAgentId: string;
      agentId: string;
      reason: string;
      correctionReason: CooOwnershipCorrectionReason;
    }
  | {
      kind: "record_block";
      issueId: string;
      reason: CooBlockedReason;
      requiredRole?: string | null;
    };

export type CooAllocationReport = {
  actions: CooAllocationAction[];
  readyIssueCount: number;
  residualReadyIssueCount: number;
  blockedReasonCounts: Record<string, number>;
  freeSlotsByRole: Record<string, number>;
  unavailableSlotsByRole: Record<string, number>;
  unavailableCapacityReasonsByRole: Record<string, Record<string, number>>;
  plannedActionCounts: Record<CooAllocationAction["kind"], number>;
  unusedCapacityReasons: Record<string, string>;
  invariantBreaches: string[];
};

type AllocatableIssue = Extract<CooIssueActionability, {
  kind: "needs_repair" | "ready_owned" | "ready_reassignable" | "ready_unassigned";
}>;

function addCount(counts: Record<string, number>, key: string, amount = 1) {
  counts[key] = (counts[key] ?? 0) + amount;
}

function getFreeSlots(agent: CooCapacityLedger["agents"][number]) {
  if (agent.unavailableReason) return 0;
  return Math.max(0, agent.totalSlots - agent.occupiedSlots - agent.reservedSlots);
}

function compareAllocatableIssues(left: AllocatableIssue, right: AllocatableIssue) {
  const repairDelta = Number(right.kind === "needs_repair") - Number(left.kind === "needs_repair");
  if (repairDelta !== 0) return repairDelta;

  const unblockedDelta = Number(right.newlyUnblocked === true) - Number(left.newlyUnblocked === true);
  if (unblockedDelta !== 0) return unblockedDelta;

  const priorityDelta = issuePriorityWeight(right.priority) - issuePriorityWeight(left.priority);
  if (priorityDelta !== 0) return priorityDelta;

  const ageDelta = left.updatedAt.getTime() - right.updatedAt.getTime();
  if (ageDelta !== 0) return ageDelta;

  return left.issueId.localeCompare(right.issueId);
}

function summarizeFreeSlots(
  agents: CooCapacityLedger["agents"],
  freeSlotsByAgentId: ReadonlyMap<string, number>,
) {
  const freeSlotsByRole: Record<string, number> = {};
  for (const agent of agents) {
    const freeSlots = freeSlotsByAgentId.get(agent.agentId) ?? 0;
    if (freeSlots <= 0) continue;
    const role = agent.role || "unknown";
    freeSlotsByRole[role] = (freeSlotsByRole[role] ?? 0) + freeSlots;
  }
  return freeSlotsByRole;
}

function summarizeUnavailableCapacity(agents: CooCapacityLedger["agents"]) {
  const unavailableSlotsByRole: Record<string, number> = {};
  const unavailableCapacityReasonsByRole: Record<string, Record<string, number>> = {};

  for (const agent of agents) {
    if (!agent.unavailableReason) continue;
    const role = agent.role || "unknown";
    const unavailableSlots = Math.max(0, agent.totalSlots);
    if (unavailableSlots <= 0) continue;
    unavailableSlotsByRole[role] = (unavailableSlotsByRole[role] ?? 0) + unavailableSlots;
    const reasonCounts = unavailableCapacityReasonsByRole[role] ?? {};
    reasonCounts[agent.unavailableReason] = (reasonCounts[agent.unavailableReason] ?? 0) + unavailableSlots;
    unavailableCapacityReasonsByRole[role] = reasonCounts;
  }

  return { unavailableSlotsByRole, unavailableCapacityReasonsByRole };
}

function summarizeUnusedCapacityReason(blockedReasonCounts: Record<string, number>) {
  if ((blockedReasonCounts.capability_blocked_specialist ?? 0) > 0 || (blockedReasonCounts.no_assignable_agent ?? 0) > 0) {
    return "no_matching_capability";
  }
  if ((blockedReasonCounts.policy_blocked ?? 0) > 0) return "policy_blocked";
  if ((blockedReasonCounts.blocked_dependency ?? 0) > 0) return "dependency_block";
  if ((blockedReasonCounts.waiting_external ?? 0) > 0) return "external_wait";
  if ((blockedReasonCounts.human_owned ?? 0) > 0) return "human_ownership";
  if ((blockedReasonCounts.cooldown ?? 0) > 0) return "cooldown";
  if ((blockedReasonCounts.pending_wakeup ?? 0) > 0) return "pending_wakeup";
  if ((blockedReasonCounts.assignee_unavailable ?? 0) > 0) return "assignee_unavailable";
  if ((blockedReasonCounts.merge_blocked ?? 0) > 0) return "merge_blocked";
  return "no_ready_work_for_role";
}

function selectEligibleAgent(input: {
  issue: Pick<Extract<CooIssueActionability, { kind: "ready_reassignable" | "ready_unassigned" }>, "eligibleAgentIds" | "preferredAgentId">;
  agentById: ReadonlyMap<string, CooCapacityLedger["agents"][number]>;
  freeSlotsByAgentId: ReadonlyMap<string, number>;
}) {
  const preferredAgentId = input.issue.preferredAgentId ?? null;
  if (preferredAgentId && (input.freeSlotsByAgentId.get(preferredAgentId) ?? 0) > 0) {
    return preferredAgentId;
  }

  const eligibleRankByAgentId = new Map(input.issue.eligibleAgentIds.map((agentId, index) => [agentId, index]));
  return input.issue.eligibleAgentIds
    .filter((agentId) => (input.freeSlotsByAgentId.get(agentId) ?? 0) > 0)
    .sort((leftId, rightId) => {
      const freeDelta = (input.freeSlotsByAgentId.get(rightId) ?? 0) - (input.freeSlotsByAgentId.get(leftId) ?? 0);
      if (freeDelta !== 0) return freeDelta;
      const rankDelta = (eligibleRankByAgentId.get(leftId) ?? 0) - (eligibleRankByAgentId.get(rightId) ?? 0);
      if (rankDelta !== 0) return rankDelta;
      const leftRole = input.agentById.get(leftId)?.role ?? "";
      const rightRole = input.agentById.get(rightId)?.role ?? "";
      return leftRole.localeCompare(rightRole) || leftId.localeCompare(rightId);
    })[0] ?? null;
}

export function planCooFlowAllocation(input: {
  issues: CooIssueActionability[];
  capacity: CooCapacityLedger;
}): CooAllocationReport {
  const agentById = new Map(input.capacity.agents.map((agent) => [agent.agentId, agent]));
  const freeSlotsByAgentId = new Map(
    input.capacity.agents.map((agent) => [agent.agentId, getFreeSlots(agent)] as const),
  );
  const actions: CooAllocationAction[] = [];
  const blockedReasonCounts: Record<string, number> = {};
  const plannedActionCounts: Record<CooAllocationAction["kind"], number> = {
    assign_issue: 0,
    record_block: 0,
    repair_issue: 0,
    reassign_issue: 0,
    wake_owner: 0,
  };
  const handledIssueIds = new Set<string>();

  const recordBlock = (input: {
    issueId: string;
    reason: CooBlockedReason;
    requiredRole?: string | null;
  }) => {
    actions.push({
      kind: "record_block",
      issueId: input.issueId,
      reason: input.reason,
      requiredRole: input.requiredRole ?? undefined,
    });
    plannedActionCounts.record_block += 1;
    addCount(blockedReasonCounts, input.reason);
    handledIssueIds.add(input.issueId);
  };

  const readyIssueCount = input.issues.filter((issue) => (
    issue.kind === "needs_repair" ||
    issue.kind === "ready_owned" ||
    issue.kind === "ready_reassignable" ||
    issue.kind === "ready_unassigned"
  )).length;

  for (const issue of input.issues) {
    if (issue.kind !== "blocked") continue;
    recordBlock({
      issueId: issue.issueId,
      reason: issue.reason,
      requiredRole: issue.requiredRole ?? undefined,
    });
  }

  const allocatableIssues = input.issues
    .filter((issue): issue is AllocatableIssue => (
      issue.kind === "needs_repair" ||
      issue.kind === "ready_owned" ||
      issue.kind === "ready_reassignable" ||
      issue.kind === "ready_unassigned"
    ))
    .sort(compareAllocatableIssues);

  for (const issue of allocatableIssues) {
    if (issue.kind === "needs_repair") {
      actions.push({
        kind: "repair_issue",
        issueId: issue.issueId,
        reason: issue.reason,
      });
      plannedActionCounts.repair_issue += 1;
      handledIssueIds.add(issue.issueId);
      continue;
    }

    if (issue.kind === "ready_owned") {
      const freeSlots = freeSlotsByAgentId.get(issue.assigneeAgentId) ?? 0;
      if (freeSlots <= 0) {
        recordBlock({
          issueId: issue.issueId,
          reason: "no_free_slot",
        });
        continue;
      }
      actions.push({
        kind: "wake_owner",
        issueId: issue.issueId,
        agentId: issue.assigneeAgentId,
        reason: issue.reason,
      });
      plannedActionCounts.wake_owner += 1;
      freeSlotsByAgentId.set(issue.assigneeAgentId, freeSlots - 1);
      handledIssueIds.add(issue.issueId);
      continue;
    }

    if (issue.kind === "ready_reassignable") {
      const selectedAgentId = selectEligibleAgent({ issue, agentById, freeSlotsByAgentId });
      if (!selectedAgentId) {
        recordBlock({
          issueId: issue.issueId,
          reason: "no_free_slot",
        });
        continue;
      }

      actions.push({
        kind: "reassign_issue",
        issueId: issue.issueId,
        fromAgentId: issue.currentAssigneeAgentId,
        agentId: selectedAgentId,
        reason: issue.reason,
        correctionReason: issue.correctionReason,
      });
      plannedActionCounts.reassign_issue += 1;
      freeSlotsByAgentId.set(selectedAgentId, (freeSlotsByAgentId.get(selectedAgentId) ?? 0) - 1);
      handledIssueIds.add(issue.issueId);
      continue;
    }

    if (issue.eligibleAgentIds.length === 0) {
      const reason = issue.requiredRole ? "capability_blocked_specialist" : "no_assignable_agent";
      recordBlock({
        issueId: issue.issueId,
        reason,
        requiredRole: issue.requiredRole ?? undefined,
      });
      continue;
    }

    const selectedAgentId = selectEligibleAgent({ issue, agentById, freeSlotsByAgentId });
    if (!selectedAgentId) {
      recordBlock({
        issueId: issue.issueId,
        reason: "no_free_slot",
        requiredRole: issue.requiredRole ?? undefined,
      });
      continue;
    }

    actions.push({
      kind: "assign_issue",
      issueId: issue.issueId,
      agentId: selectedAgentId,
      reason: issue.reason,
    });
    plannedActionCounts.assign_issue += 1;
    freeSlotsByAgentId.set(selectedAgentId, (freeSlotsByAgentId.get(selectedAgentId) ?? 0) - 1);
    handledIssueIds.add(issue.issueId);
  }

  const residualReadyIssues = allocatableIssues.filter((issue) => !handledIssueIds.has(issue.issueId));
  const freeSlotsByRole = summarizeFreeSlots(input.capacity.agents, freeSlotsByAgentId);
  const {
    unavailableSlotsByRole,
    unavailableCapacityReasonsByRole,
  } = summarizeUnavailableCapacity(input.capacity.agents);
  const unusedCapacityReasons: Record<string, string> = {};
  const rolesWithReadyWork = new Set<string>();
  for (const issue of residualReadyIssues) {
    if (issue.kind === "ready_owned") {
      const role = agentById.get(issue.assigneeAgentId)?.role ?? "unknown";
      rolesWithReadyWork.add(role);
      continue;
    }
    if (issue.kind === "ready_unassigned") {
      for (const agentId of issue.eligibleAgentIds) {
        rolesWithReadyWork.add(agentById.get(agentId)?.role ?? "unknown");
      }
      continue;
    }
    if (issue.kind === "ready_reassignable") {
      for (const agentId of issue.eligibleAgentIds) {
        rolesWithReadyWork.add(agentById.get(agentId)?.role ?? "unknown");
      }
    }
  }

  for (const [role, count] of Object.entries(freeSlotsByRole)) {
    if (count <= 0) continue;
    unusedCapacityReasons[role] = rolesWithReadyWork.has(role)
      ? "eligible_ready_work_was_not_allocated"
      : summarizeUnusedCapacityReason(blockedReasonCounts);
  }

  const invariantBreaches = Object.entries(unusedCapacityReasons)
    .filter(([, reason]) => reason === "eligible_ready_work_was_not_allocated")
    .map(([role]) => `ready work remains while ${role} capacity is free`);

  return {
    actions,
    readyIssueCount,
    residualReadyIssueCount: residualReadyIssues.length,
    blockedReasonCounts,
    freeSlotsByRole,
    unavailableSlotsByRole,
    unavailableCapacityReasonsByRole,
    plannedActionCounts,
    unusedCapacityReasons,
    invariantBreaches,
  };
}
