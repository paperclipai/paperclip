import { randomUUID } from "node:crypto";
import type { IssueExecutionDecision, IssueExecutionPolicy, IssueExecutionStage, IssueExecutionStagePrincipal, IssueExecutionState } from "@paperclipai/shared";
import { issueExecutionPolicySchema, issueExecutionStateSchema } from "@paperclipai/shared";
import { unprocessable } from "../errors.js";

type AssigneeLike = {
  assigneeAgentId?: string | null;
  assigneeUserId?: string | null;
};

type IssueLike = AssigneeLike & {
  status: string;
  executionPolicy?: IssueExecutionPolicy | Record<string, unknown> | null;
  executionState?: IssueExecutionState | Record<string, unknown> | null;
};

type ActorLike = {
  agentId?: string | null;
  userId?: string | null;
};

type RequestedAssigneePatch = {
  assigneeAgentId?: string | null;
  assigneeUserId?: string | null;
};

type TransitionInput = {
  issue: IssueLike;
  policy: IssueExecutionPolicy | null;
  requestedStatus?: string;
  requestedAssigneePatch: RequestedAssigneePatch;
  actor: ActorLike;
  commentBody?: string | null;
};

type TransitionResult = {
  patch: Record<string, unknown>;
  decision?: Pick<IssueExecutionDecision, "stageId" | "stageType" | "outcome" | "body">;
};

const COMPLETED_STATUS: IssueExecutionState["status"] = "completed";
const PENDING_STATUS: IssueExecutionState["status"] = "pending";
const CHANGES_REQUESTED_STATUS: IssueExecutionState["status"] = "changes_requested";

export function normalizeIssueExecutionPolicy(input: unknown): IssueExecutionPolicy | null {
  if (input == null) return null;
  const parsed = issueExecutionPolicySchema.safeParse(input);
  if (!parsed.success) {
    throw unprocessable("Invalid execution policy", parsed.error.flatten());
  }

  const stages = parsed.data.stages
    .map((stage) => {
      const participants: IssueExecutionStage["participants"] = stage.participants
        .map((participant) => ({
          id: participant.id ?? randomUUID(),
          type: participant.type,
          agentId: participant.type === "agent" ? participant.agentId ?? null : null,
          userId: participant.type === "user" ? participant.userId ?? null : null,
        }))
        .filter((participant) => (participant.type === "agent" ? Boolean(participant.agentId) : Boolean(participant.userId)));

      const dedupedParticipants: IssueExecutionStage["participants"] = [];
      const seen = new Set<string>();
      for (const participant of participants) {
        const key = participant.type === "agent" ? `agent:${participant.agentId}` : `user:${participant.userId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        dedupedParticipants.push(participant);
      }

      if (dedupedParticipants.length === 0) return null;
      return {
        id: stage.id ?? randomUUID(),
        type: stage.type,
        approvalsNeeded: 1 as const,
        participants: dedupedParticipants,
      };
    })
    .filter((stage): stage is NonNullable<typeof stage> => stage !== null);

  if (stages.length === 0) return null;

  return {
    mode: parsed.data.mode ?? "normal",
    commentRequired: true,
    stages,
  };
}

export function parseIssueExecutionState(input: unknown): IssueExecutionState | null {
  if (input == null) return null;
  const parsed = issueExecutionStateSchema.safeParse(input);
  if (!parsed.success) return null;
  return parsed.data;
}

export function assigneePrincipal(input: AssigneeLike): IssueExecutionStagePrincipal | null {
  if (input.assigneeAgentId) {
    return { type: "agent", agentId: input.assigneeAgentId, userId: null };
  }
  if (input.assigneeUserId) {
    return { type: "user", userId: input.assigneeUserId, agentId: null };
  }
  return null;
}

function actorPrincipal(actor: ActorLike): IssueExecutionStagePrincipal | null {
  if (actor.agentId) return { type: "agent", agentId: actor.agentId, userId: null };
  if (actor.userId) return { type: "user", userId: actor.userId, agentId: null };
  return null;
}

function principalsEqual(a: IssueExecutionStagePrincipal | null, b: IssueExecutionStagePrincipal | null): boolean {
  if (!a || !b) return false;
  if (a.type !== b.type) return false;
  return a.type === "agent" ? a.agentId === b.agentId : a.userId === b.userId;
}

function findStageById(policy: IssueExecutionPolicy, stageId: string | null | undefined) {
  if (!stageId) return null;
  return policy.stages.find((stage) => stage.id === stageId) ?? null;
}

function nextPendingStage(policy: IssueExecutionPolicy, state: IssueExecutionState | null) {
  const completed = new Set(state?.completedStageIds ?? []);
  return policy.stages.find((stage) => !completed.has(stage.id)) ?? null;
}

function selectStageParticipant(
  stage: IssueExecutionStage,
  opts?: {
    preferred?: IssueExecutionStagePrincipal | null;
    exclude?: IssueExecutionStagePrincipal | null;
  },
): IssueExecutionStagePrincipal | null {
  const participants = stage.participants.filter((participant) => !principalsEqual(participant, opts?.exclude ?? null));
  if (participants.length === 0) return null;
  if (opts?.preferred) {
    const preferred = participants.find((participant) => principalsEqual(participant, opts.preferred ?? null));
    if (preferred) return preferred;
  }
  const first = participants[0];
  return first ? { type: first.type, agentId: first.agentId ?? null, userId: first.userId ?? null } : null;
}

function patchForPrincipal(principal: IssueExecutionStagePrincipal | null) {
  if (!principal) {
    return { assigneeAgentId: null, assigneeUserId: null };
  }
  return principal.type === "agent"
    ? { assigneeAgentId: principal.agentId ?? null, assigneeUserId: null }
    : { assigneeAgentId: null, assigneeUserId: principal.userId ?? null };
}

function buildCompletedState(previous: IssueExecutionState | null, currentStage: IssueExecutionStage): IssueExecutionState {
  const completedStageIds = Array.from(new Set([...(previous?.completedStageIds ?? []), currentStage.id]));
  return {
    status: COMPLETED_STATUS,
    currentStageId: null,
    currentStageIndex: null,
    currentStageType: null,
    currentParticipant: null,
    returnAssignee: previous?.returnAssignee ?? null,
    completedStageIds,
    lastDecisionId: previous?.lastDecisionId ?? null,
    lastDecisionOutcome: "approved",
  };
}

function buildPendingState(input: {
  previous: IssueExecutionState | null;
  stage: IssueExecutionStage;
  stageIndex: number;
  participant: IssueExecutionStagePrincipal;
  returnAssignee: IssueExecutionStagePrincipal | null;
}): IssueExecutionState {
  return {
    status: PENDING_STATUS,
    currentStageId: input.stage.id,
    currentStageIndex: input.stageIndex,
    currentStageType: input.stage.type,
    currentParticipant: input.participant,
    returnAssignee: input.returnAssignee,
    completedStageIds: input.previous?.completedStageIds ?? [],
    lastDecisionId: input.previous?.lastDecisionId ?? null,
    lastDecisionOutcome: input.previous?.lastDecisionOutcome ?? null,
  };
}

function buildChangesRequestedState(previous: IssueExecutionState, currentStage: IssueExecutionStage): IssueExecutionState {
  return {
    ...previous,
    status: CHANGES_REQUESTED_STATUS,
    currentStageId: currentStage.id,
    currentStageType: currentStage.type,
    lastDecisionOutcome: "changes_requested",
  };
}

export function applyIssueExecutionPolicyTransition(input: TransitionInput): TransitionResult {
  const patch: Record<string, unknown> = {};
  const existingState = parseIssueExecutionState(input.issue.executionState);
  const currentAssignee = assigneePrincipal(input.issue);
  const actor = actorPrincipal(input.actor);
  const explicitAssignee = assigneePrincipal(input.requestedAssigneePatch);
  const currentStage = input.policy ? findStageById(input.policy, existingState?.currentStageId) : null;
  const requestedStatus = input.requestedStatus;

  if (!input.policy) {
    if (existingState) {
      patch.executionState = null;
      if (input.issue.status === "in_review" && existingState.returnAssignee) {
        patch.status = "in_progress";
        Object.assign(patch, patchForPrincipal(existingState.returnAssignee));
      }
    }
    return { patch };
  }

  if (
    (input.issue.status === "done" || input.issue.status === "cancelled") &&
    requestedStatus &&
    requestedStatus !== "done" &&
    requestedStatus !== "cancelled"
  ) {
    patch.executionState = null;
    return { patch };
  }

  if (currentStage && input.issue.status === "in_review") {
    if (!principalsEqual(existingState?.currentParticipant ?? null, actor)) {
      if (requestedStatus && requestedStatus !== "in_review") {
        throw unprocessable("Only the active reviewer or approver can advance the current execution stage");
      }
      return { patch };
    }

    if (requestedStatus === "done") {
      if (!input.commentBody?.trim()) {
        throw unprocessable("Approving a review or approval stage requires a comment");
      }
      const approvedState = buildCompletedState(existingState, currentStage);
      const nextStage = nextPendingStage(
        input.policy,
        { ...approvedState, completedStageIds: approvedState.completedStageIds },
      );

      if (!nextStage) {
        patch.executionState = approvedState;
        return {
          patch,
          decision: {
            stageId: currentStage.id,
            stageType: currentStage.type,
            outcome: "approved",
            body: input.commentBody.trim(),
          },
        };
      }

      const participant = selectStageParticipant(nextStage, {
        preferred: explicitAssignee,
        exclude: existingState?.returnAssignee ?? null,
      });
      if (!participant) {
        throw unprocessable(`No eligible ${nextStage.type} participant is configured for this issue`);
      }

      patch.status = "in_review";
      Object.assign(patch, patchForPrincipal(participant));
      patch.executionState = buildPendingState({
        previous: approvedState,
        stage: nextStage,
        stageIndex: input.policy.stages.findIndex((stage) => stage.id === nextStage.id),
        participant,
        returnAssignee: existingState?.returnAssignee ?? currentAssignee,
      });
      return {
        patch,
        decision: {
          stageId: currentStage.id,
          stageType: currentStage.type,
          outcome: "approved",
          body: input.commentBody.trim(),
        },
      };
    }

    if (requestedStatus && requestedStatus !== "in_review") {
      if (!input.commentBody?.trim()) {
        throw unprocessable("Requesting changes requires a comment");
      }
      if (!existingState?.returnAssignee) {
        throw unprocessable("This execution stage has no return assignee");
      }
      patch.status = "in_progress";
      Object.assign(patch, patchForPrincipal(existingState.returnAssignee));
      patch.executionState = buildChangesRequestedState(existingState, currentStage);
      return {
        patch,
        decision: {
          stageId: currentStage.id,
          stageType: currentStage.type,
          outcome: "changes_requested",
          body: input.commentBody.trim(),
        },
      };
    }

    return { patch };
  }

  if (requestedStatus !== "done") {
    return { patch };
  }

  const pendingStage =
    existingState?.status === CHANGES_REQUESTED_STATUS && currentStage
      ? currentStage
      : nextPendingStage(input.policy, existingState);
  if (!pendingStage) return { patch };

  const returnAssignee = existingState?.returnAssignee ?? currentAssignee;
  const participant = selectStageParticipant(pendingStage, {
    preferred:
      existingState?.status === CHANGES_REQUESTED_STATUS
        ? explicitAssignee ?? existingState.currentParticipant ?? null
        : explicitAssignee,
    exclude: returnAssignee,
  });
  if (!participant) {
    throw unprocessable(`No eligible ${pendingStage.type} participant is configured for this issue`);
  }

  patch.status = "in_review";
  Object.assign(patch, patchForPrincipal(participant));
  patch.executionState = buildPendingState({
    previous: existingState,
    stage: pendingStage,
    stageIndex: input.policy.stages.findIndex((stage) => stage.id === pendingStage.id),
    participant,
    returnAssignee,
  });
  return { patch };
}
