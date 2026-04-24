import { buildIssueRoutingText, isQaLikeIssueText } from "./issue-routing-heuristics.js";

export type EligibleSpecialistRoleIds = {
  security: string[];
  qa?: string[];
  cto?: string[];
};

export type SpecialistLaneRequirement = {
  blockingRole: "security" | "qa" | "cto";
  headline: string;
  detail: string;
};

const OPEN_ISSUE_STATUSES = new Set(["backlog", "todo", "in_progress", "in_review", "blocked"]);

export function resolveSpecialistLaneRequirement(input: {
  workflowLaneRole?: string | null;
  qaLikeIssue?: boolean;
}): SpecialistLaneRequirement | null {
  if (input.workflowLaneRole === "security") {
    return {
      blockingRole: "security",
      headline: "No security specialist available",
      detail: "security workflow lane requires a security specialist, but none are currently available",
    };
  }
  if (input.workflowLaneRole === "qa") {
    return {
      blockingRole: "qa",
      headline: "No healthy QA reviewer available",
      detail: "QA workflow lane requires an active QA reviewer, but none are currently available",
    };
  }
  if (input.qaLikeIssue) {
    return {
      blockingRole: "qa",
      headline: "No healthy QA reviewer available",
      detail: "QA-scoped work requires an active QA reviewer, but none are currently available",
    };
  }
  if (input.workflowLaneRole === "cto") {
    return {
      blockingRole: "cto",
      headline: "No CTO available",
      detail: "CTO workflow lane requires an active CTO, but none are currently available",
    };
  }
  return null;
}

export function hasEligibleSpecialistForRequirement(
  requirement: SpecialistLaneRequirement,
  eligibleSpecialistRoleIds: EligibleSpecialistRoleIds,
) {
  if (requirement.blockingRole === "security") {
    return eligibleSpecialistRoleIds.security.length > 0;
  }
  if (requirement.blockingRole === "qa") {
    return (eligibleSpecialistRoleIds.qa ?? []).length > 0;
  }
  if (requirement.blockingRole === "cto") {
    return (eligibleSpecialistRoleIds.cto ?? []).length > 0;
  }
  return false;
}

export function resolveOutstandingSpecialistCapabilityBlock(input: {
  workflowLaneRole?: string | null;
  qaLikeIssue?: boolean;
  hasActiveBlockers?: boolean;
  eligibleSpecialistRoleIds: EligibleSpecialistRoleIds;
}): SpecialistLaneRequirement | null {
  if (input.hasActiveBlockers) return null;
  const requirement = resolveSpecialistLaneRequirement({
    workflowLaneRole: input.workflowLaneRole,
    qaLikeIssue: input.qaLikeIssue,
  });
  if (!requirement) return null;
  if (hasEligibleSpecialistForRequirement(requirement, input.eligibleSpecialistRoleIds)) return null;
  return requirement;
}

export function classifyCapabilityBlockedIssue(input: {
  issue: {
    status: string;
    workflowLaneRole?: string | null;
    identifier?: string | null;
    title?: string | null;
    description?: string | null;
    projectName?: string | null;
    preferredRole?: string | null;
    assigneeAgentId: string | null;
    assigneeUserId?: string | null;
    hasActiveBlockers?: boolean;
  };
  eligibleSpecialistRoleIds: EligibleSpecialistRoleIds;
}): SpecialistLaneRequirement | null {
  if (!OPEN_ISSUE_STATUSES.has(input.issue.status)) return null;
  if (input.issue.assigneeAgentId || input.issue.assigneeUserId) return null;
  const qaLikeIssue =
    input.issue.preferredRole === "qa"
    || isQaLikeIssueText(buildIssueRoutingText({
      identifier: input.issue.identifier ?? null,
      title: input.issue.title ?? "",
      description: input.issue.description ?? null,
      projectName: input.issue.projectName ?? null,
    }));
  return resolveOutstandingSpecialistCapabilityBlock({
    workflowLaneRole: input.issue.workflowLaneRole,
    qaLikeIssue,
    hasActiveBlockers: input.issue.hasActiveBlockers,
    eligibleSpecialistRoleIds: input.eligibleSpecialistRoleIds,
  });
}
