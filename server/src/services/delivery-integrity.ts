import type { AgentStatus, IssueWorkIntent } from "@paperclipai/shared";
import { parseIssueExecutionState } from "./issue-execution-policy.js";
import { buildIssueRoutingText, resolveIssueWorkIntent as resolveHeuristicIssueWorkIntent } from "./issue-routing-heuristics.js";
import { classifyCapabilityBlockedIssue, type EligibleSpecialistRoleIds } from "./issue-capability-blocks.js";

const INELIGIBLE_ASSIGNEE_STATUSES = new Set<AgentStatus>(["error", "terminated", "pending_approval"]);
const REVIEW_STAGE_TYPES = new Set(["review", "approval"]);

export type DeliveryIntegrityClassification =
  | {
      kind: "canonical";
      workIntent: IssueWorkIntent;
    }
  | {
      kind: "normalize_non_delivery_review";
      workIntent: IssueWorkIntent;
      nextStatus: "todo";
      assigneeAgentId: string | null;
      assigneeUserId: string | null;
      qaReviewerAgentId: null;
      clearExecutionState: true;
    }
  | {
      kind: "normalize_workflow_lane_review_drift";
      workIntent: IssueWorkIntent;
      clearExecutionState: true;
    }
  | {
      kind: "repair_delivery_review";
      workIntent: IssueWorkIntent;
    }
  | {
      kind: "capability_blocked";
      workIntent: IssueWorkIntent;
      blockingRole: "security" | "qa" | "cto";
    }
  | {
      kind: "run_owner_mismatch";
      workIntent: IssueWorkIntent;
      canonicalAgentId: string | null;
      runAgentId: string;
    };

type DeliveryIntegrityIssueInput = {
  status: string;
  title?: string | null;
  description?: string | null;
  identifier?: string | null;
  projectName?: string | null;
  workflowTemplateKey?: string | null;
  workflowLaneRole?: string | null;
  assigneeAgentId: string | null;
  assigneeRole?: string | null;
  assigneeStatus?: string | null;
  assigneeUserId?: string | null;
  qaReviewerAgentId?: string | null;
  workIntent?: string | null;
  executionPolicy?: unknown;
  executionState?: unknown;
  executionRunId?: string | null;
};

export function hasCanonicalExecutionReviewState(input: {
  status: string;
  executionState?: unknown;
}) {
  if (input.status !== "in_review") return false;
  const executionState = parseIssueExecutionState(input.executionState);
  if (!executionState) return false;
  if (!executionState.currentStageType || !REVIEW_STAGE_TYPES.has(executionState.currentStageType)) {
    return false;
  }
  if (executionState.currentParticipant?.type !== "agent" || !executionState.currentParticipant.agentId) {
    return false;
  }
  return executionState.returnAssignee != null;
}

export function resolveIssueWorkIntent(input: {
  workIntent?: string | null | undefined;
  assigneeRole?: string | null | undefined;
  issueText?: string | null | undefined;
  title?: string | null | undefined;
  description?: string | null | undefined;
  identifier?: string | null | undefined;
  projectName?: string | null | undefined;
  workflowTemplateKey?: string | null | undefined;
  workflowLaneRole?: string | null | undefined;
}) {
  const issueText = input.issueText ?? buildIssueRoutingText({
    identifier: input.identifier ?? null,
    title: input.title ?? "",
    description: input.description ?? null,
    projectName: input.projectName ?? null,
  });
  return resolveHeuristicIssueWorkIntent({
    workIntent: input.workIntent,
    assigneeRole: input.assigneeRole,
    issueText,
    workflowTemplateKey: input.workflowTemplateKey,
    workflowLaneRole: input.workflowLaneRole,
  });
}

function isHealthyAssigneeStatus(status: string | null | undefined) {
  if (!status) return true;
  return !INELIGIBLE_ASSIGNEE_STATUSES.has(status as AgentStatus);
}

function canonicalOwnerAgentId(issue: DeliveryIntegrityIssueInput) {
  const executionState = parseIssueExecutionState(issue.executionState);
  if (
    issue.status === "in_review"
    && executionState?.currentStageType
    && REVIEW_STAGE_TYPES.has(executionState.currentStageType)
    && executionState.currentParticipant?.type === "agent"
    && executionState.currentParticipant.agentId
  ) {
    return executionState.currentParticipant.agentId;
  }
  return issue.assigneeAgentId;
}

export function classifyDeliveryIntegrity(input: {
  issue: DeliveryIntegrityIssueInput;
  run: {
    id: string;
    agentId: string;
    status: string;
  } | null;
  eligibleSpecialistRoleIds: EligibleSpecialistRoleIds;
}): DeliveryIntegrityClassification {
  const workIntent = resolveIssueWorkIntent(input.issue);
  const canonicalReviewState = hasCanonicalExecutionReviewState(input.issue);

  const capabilityBlock = classifyCapabilityBlockedIssue({
    issue: {
      status: input.issue.status,
      identifier: input.issue.identifier,
      title: input.issue.title,
      description: input.issue.description,
      workflowLaneRole: input.issue.workflowLaneRole,
      assigneeAgentId: input.issue.assigneeAgentId,
      assigneeUserId: input.issue.assigneeUserId ?? null,
    },
    eligibleSpecialistRoleIds: input.eligibleSpecialistRoleIds,
  });
  if (capabilityBlock) {
    return {
      kind: "capability_blocked",
      workIntent,
      blockingRole: capabilityBlock.blockingRole,
    };
  }

  if (input.issue.status === "in_review" && workIntent !== "delivery") {
    return {
      kind: "normalize_non_delivery_review",
      workIntent,
      nextStatus: "todo",
      assigneeAgentId:
        input.issue.assigneeAgentId && isHealthyAssigneeStatus(input.issue.assigneeStatus)
          ? input.issue.assigneeAgentId
          : null,
      assigneeUserId: input.issue.assigneeUserId ?? null,
      qaReviewerAgentId: null,
      clearExecutionState: true,
    };
  }

  if (
    input.issue.workflowLaneRole != null
    && input.issue.workflowLaneRole !== "qa"
    && (
      input.issue.status === "in_review"
      || input.issue.qaReviewerAgentId != null
      || input.issue.executionPolicy != null
      || input.issue.executionState != null
    )
  ) {
    return {
      kind: "normalize_workflow_lane_review_drift",
      clearExecutionState: true,
      workIntent,
    };
  }

  if (input.issue.status === "in_review" && workIntent === "delivery" && !canonicalReviewState) {
    return {
      kind: "repair_delivery_review",
      workIntent,
    };
  }

  if (
    input.run
    && (input.run.status === "queued" || input.run.status === "running")
    && input.issue.executionRunId === input.run.id
  ) {
    const canonicalAgentId = canonicalOwnerAgentId(input.issue);
    if (canonicalAgentId && canonicalAgentId !== input.run.agentId) {
      return {
        kind: "run_owner_mismatch",
        workIntent,
        canonicalAgentId,
        runAgentId: input.run.agentId,
      };
    }
  }

  return {
    kind: "canonical",
    workIntent,
  };
}
