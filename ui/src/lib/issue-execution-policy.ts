import type { IssueExecutionPolicy, IssueExecutionStageParticipant, IssueExecutionStagePrincipal } from "@paperclipai/shared";
import { issueExecutionPolicySchema } from "@paperclipai/shared";
import { parseAssigneeValue } from "./assignees";
import { createUuid as newId } from "./uuid";

type StageType = "review" | "approval";
const nullablePolicySchema = issueExecutionPolicySchema.nullable();

/** Apply wire-format defaults without treating an invalid policy as no policy. */
export function readExecutionPolicy(policy: unknown) {
  return nullablePolicySchema.safeParse(policy ?? null);
}

function principalKey(principal: IssueExecutionStagePrincipal | IssueExecutionStageParticipant) {
  return principal.type === "agent" ? `agent:${principal.agentId}` : `user:${principal.userId}`;
}

export function principalFromSelectionValue(value: string): IssueExecutionStagePrincipal | null {
  const selection = parseAssigneeValue(value);
  if (selection.assigneeAgentId) {
    return { type: "agent", agentId: selection.assigneeAgentId, userId: null };
  }
  if (selection.assigneeUserId) {
    return { type: "user", userId: selection.assigneeUserId, agentId: null };
  }
  return null;
}

export function selectionValueFromPrincipal(principal: IssueExecutionStagePrincipal | IssueExecutionStageParticipant): string {
  return principal.type === "agent" ? `agent:${principal.agentId}` : `user:${principal.userId}`;
}

export function stageParticipantValues(policy: IssueExecutionPolicy | null | undefined, stageType: StageType): string[] {
  const parsed = readExecutionPolicy(policy);
  if (!parsed.success) return [];
  const stage = parsed.data?.stages.find((candidate) => candidate.type === stageType);
  return stage?.participants.map((participant) => selectionValueFromPrincipal(participant)) ?? [];
}

function mergeParticipants(
  existing: Array<IssueExecutionStagePrincipal & { id?: string }> | undefined,
  values: string[],
): IssueExecutionStageParticipant[] {
  const existingByKey = new Map((existing ?? []).map((participant) => [principalKey(participant), participant]));
  const participants: IssueExecutionStageParticipant[] = [];
  for (const value of values) {
    const principal = principalFromSelectionValue(value);
    if (!principal) continue;
    const key = principalKey(principal);
    const previous = existingByKey.get(key);
    participants.push({
      id: previous?.id ?? newId(),
      type: principal.type,
      agentId: principal.type === "agent" ? principal.agentId ?? null : null,
      userId: principal.type === "user" ? principal.userId ?? null : null,
    });
  }
  return participants;
}

export function buildExecutionPolicy(input: {
  existingPolicy?: IssueExecutionPolicy | null;
  reviewerValues: string[];
  approverValues: string[];
}): IssueExecutionPolicy | null {
  const parsed = readExecutionPolicy(input.existingPolicy);
  if (!parsed.success) throw new Error("Execution policy is unavailable");
  const existingPolicy = parsed.data;
  const mode = existingPolicy?.mode ?? "normal";
  const stages: IssueExecutionPolicy["stages"] = [];
  const monitor = input.existingPolicy?.monitor ?? null;

  const existingReviewStage = existingPolicy?.stages.find((stage) => stage.type === "review");
  const reviewParticipants = mergeParticipants(existingReviewStage?.participants, input.reviewerValues);
  if (reviewParticipants.length > 0) {
    stages.push({
      id: existingReviewStage?.id ?? newId(),
      type: "review" as const,
      approvalsNeeded: 1 as const,
      participants: reviewParticipants,
    });
  }

  const existingApprovalStage = existingPolicy?.stages.find((stage) => stage.type === "approval");
  const approvalParticipants = mergeParticipants(existingApprovalStage?.participants, input.approverValues);
  if (approvalParticipants.length > 0) {
    stages.push({
      id: existingApprovalStage?.id ?? newId(),
      type: "approval" as const,
      approvalsNeeded: 1 as const,
      participants: approvalParticipants,
    });
  }

  if (stages.length === 0 && !monitor && !existingPolicy?.authorizationPolicy
    && !existingPolicy?.reviewPreset && existingPolicy?.maxReviewRounds == null) return null;

  return {
    ...input.existingPolicy,
    mode,
    commentRequired: true,
    stages,
    ...(monitor ? { monitor } : {}),
  };
}
