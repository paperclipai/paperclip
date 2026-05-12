import { randomUUID } from "node:crypto";
import type {
  IssueExecutionDecision,
  IssueExecutionMonitorClearReason,
  IssueExecutionMonitorPolicy,
  IssueExecutionMonitorState,
  IssueExecutionPolicy,
  IssueExecutionStage,
  IssueExecutionStagePrincipal,
  IssueExecutionState,
  IssueMonitorScheduledBy,
} from "@paperclipai/shared";
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
  monitorNextCheckAt?: Date | null;
  monitorWakeRequestedAt?: Date | null;
  monitorLastTriggeredAt?: Date | null;
  monitorAttemptCount?: number | null;
  monitorNotes?: string | null;
  monitorScheduledBy?: string | null;
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
  previousPolicy?: IssueExecutionPolicy | null;
  requestedStatus?: string;
  requestedAssigneePatch: RequestedAssigneePatch;
  actor: ActorLike;
  commentBody?: string | null;
  reviewRequest?: IssueExecutionState["reviewRequest"] | null;
  monitorExplicitlyUpdated?: boolean;
};

type TransitionResult = {
  patch: Record<string, unknown>;
  decision?: Pick<IssueExecutionDecision, "stageId" | "stageType" | "outcome" | "body">;
  workflowControlledAssignment?: boolean;
};

const COMPLETED_STATUS: IssueExecutionState["status"] = "completed";
const PENDING_STATUS: IssueExecutionState["status"] = "pending";
const CHANGES_REQUESTED_STATUS: IssueExecutionState["status"] = "changes_requested";
const MONITOR_INVALID_MESSAGE = "Monitor can only be scheduled on issues assigned to an agent in in_progress or in_review";
const MONITOR_BOUNDS_EXHAUSTED_MESSAGE = "Monitor bounds are already exhausted";
export const REDACTED_ISSUE_MONITOR_EXTERNAL_REF = "[redacted]";

function normalizeMonitorNotes(notes: string | null | undefined) {
  if (typeof notes !== "string") return null;
  const trimmed = notes.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeMonitorText(value: string | null | undefined) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function redactIssueMonitorExternalRef(value: string | null | undefined) {
  return normalizeMonitorText(value) ? REDACTED_ISSUE_MONITOR_EXTERNAL_REF : null;
}

function monitorMetadataFromPolicy(monitor: IssueExecutionMonitorPolicy) {
  return {
    kind: monitor.kind ?? null,
    serviceName: normalizeMonitorText(monitor.serviceName),
    externalRef: redactIssueMonitorExternalRef(monitor.externalRef),
    timeoutAt: monitor.timeoutAt ?? null,
    maxAttempts: monitor.maxAttempts ?? null,
    recoveryPolicy: monitor.recoveryPolicy ?? null,
  };
}

function monitorMetadataFromState(state: IssueExecutionMonitorState | null | undefined) {
  return {
    kind: state?.kind ?? null,
    serviceName: normalizeMonitorText(state?.serviceName),
    externalRef: redactIssueMonitorExternalRef(state?.externalRef),
    timeoutAt: state?.timeoutAt ?? null,
    maxAttempts: state?.maxAttempts ?? null,
    recoveryPolicy: state?.recoveryPolicy ?? null,
  };
}

function blankExecutionState(): IssueExecutionState {
  return {
    status: "idle",
    currentStageId: null,
    currentStageIndex: null,
    currentStageType: null,
    currentParticipant: null,
    returnAssignee: null,
    reviewRequest: null,
    completedStageIds: [],
    lastDecisionId: null,
    lastDecisionOutcome: null,
    monitor: null,
  };
}

function isoString(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return value;
}

function monitorStatesEqual(left: IssueExecutionMonitorState | null, right: IssueExecutionMonitorState | null): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function executionStateWithMonitor(
  stageState: IssueExecutionState | null,
  monitorState: IssueExecutionMonitorState | null,
): IssueExecutionState | null {
  if (!stageState && !monitorState) return null;
  const base = stageState ? { ...stageState } : blankExecutionState();
  return {
    ...base,
    monitor: monitorState,
  };
}

function derivePersistedMonitorState(input: {
  issue: IssueLike;
  state: IssueExecutionState | null;
  policy: IssueExecutionPolicy | null;
}): IssueExecutionMonitorState | null {
  const fromState = input.state?.monitor ?? null;
  const scheduledMonitor = input.policy?.monitor ?? null;
  const nextCheckAt = isoString(input.issue.monitorNextCheckAt) ?? scheduledMonitor?.nextCheckAt ?? fromState?.nextCheckAt ?? null;
  const lastTriggeredAt = isoString(input.issue.monitorLastTriggeredAt) ?? fromState?.lastTriggeredAt ?? null;
  const attemptCount = input.issue.monitorAttemptCount ?? fromState?.attemptCount ?? 0;
  const notes = scheduledMonitor?.notes ?? normalizeMonitorNotes(input.issue.monitorNotes) ?? fromState?.notes ?? null;
  const scheduledByRaw = input.issue.monitorScheduledBy ?? scheduledMonitor?.scheduledBy ?? fromState?.scheduledBy ?? null;
  const scheduledBy =
    scheduledByRaw === "assignee" || scheduledByRaw === "board" ? scheduledByRaw : null;
  const metadata = scheduledMonitor ? monitorMetadataFromPolicy(scheduledMonitor) : monitorMetadataFromState(fromState);

  if (nextCheckAt) {
    return {
      status: "scheduled",
      nextCheckAt,
      lastTriggeredAt,
      attemptCount,
      notes,
      scheduledBy,
      ...metadata,
      clearedAt: null,
      clearReason: null,
    };
  }

  if (fromState?.status === "cleared") {
    return {
      ...fromState,
      notes,
      scheduledBy,
      attemptCount,
      lastTriggeredAt,
      ...metadata,
    };
  }

  if (fromState?.status === "triggered" || lastTriggeredAt || attemptCount > 0) {
    return {
      status: "triggered",
      nextCheckAt: null,
      lastTriggeredAt,
      attemptCount,
      notes,
      scheduledBy,
      ...metadata,
      clearedAt: null,
      clearReason: null,
    };
  }

  return null;
}

function buildScheduledMonitorState(
  previous: IssueExecutionMonitorState | null,
  monitor: IssueExecutionMonitorPolicy,
): IssueExecutionMonitorState {
  return {
    status: "scheduled",
    nextCheckAt: monitor.nextCheckAt,
    lastTriggeredAt: previous?.lastTriggeredAt ?? null,
    attemptCount: previous?.attemptCount ?? 0,
    notes: monitor.notes ?? null,
    scheduledBy: monitor.scheduledBy,
    ...monitorMetadataFromPolicy(monitor),
    clearedAt: null,
    clearReason: null,
  };
}

function buildTriggeredMonitorState(input: {
  previous: IssueExecutionMonitorState | null;
  triggeredAt: Date;
}): IssueExecutionMonitorState {
  return {
    status: "triggered",
    nextCheckAt: null,
    lastTriggeredAt: input.triggeredAt.toISOString(),
    attemptCount: (input.previous?.attemptCount ?? 0) + 1,
    notes: input.previous?.notes ?? null,
    scheduledBy: input.previous?.scheduledBy ?? null,
    ...monitorMetadataFromState(input.previous),
    clearedAt: null,
    clearReason: null,
  };
}

function buildClearedMonitorState(input: {
  previous: IssueExecutionMonitorState | null;
  clearReason: IssueExecutionMonitorClearReason;
  clearedAt: Date;
}): IssueExecutionMonitorState {
  return {
    status: "cleared",
    nextCheckAt: null,
    lastTriggeredAt: input.previous?.lastTriggeredAt ?? null,
    attemptCount: input.previous?.attemptCount ?? 0,
    notes: input.previous?.notes ?? null,
    scheduledBy: input.previous?.scheduledBy ?? null,
    ...monitorMetadataFromState(input.previous),
    clearedAt: input.clearedAt.toISOString(),
    clearReason: input.clearReason,
  };
}

function issueAllowsMonitor(status: string, assigneeAgentId: string | null, assigneeUserId: string | null) {
  return Boolean(assigneeAgentId) && !assigneeUserId && (status === "in_progress" || status === "in_review");
}

function monitorClearReasonForIssue(
  status: string,
  assigneeAgentId: string | null,
  assigneeUserId: string | null,
): IssueExecutionMonitorClearReason | null {
  if (status === "done") return "done";
  if (status === "cancelled") return "cancelled";
  if (!issueAllowsMonitor(status, assigneeAgentId, assigneeUserId)) {
    if (assigneeUserId || !assigneeAgentId) return "invalid_assignee";
    return "invalid_status";
  }
  return null;
}

function parseMonitorDate(value: string | null | undefined) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function exhaustedMonitorClearReason(input: {
  monitor: IssueExecutionMonitorPolicy;
  attemptCount: number;
  now: Date;
}): IssueExecutionMonitorClearReason | null {
  const timeoutAt = parseMonitorDate(input.monitor.timeoutAt ?? null);
  if (timeoutAt && input.now.getTime() >= timeoutAt.getTime()) {
    return "timeout_exceeded";
  }
  const maxAttempts = input.monitor.maxAttempts ?? null;
  if (maxAttempts !== null && input.attemptCount >= maxAttempts) {
    return "max_attempts_exhausted";
  }
  return null;
}

function nextAssigneeIds(input: {
  issue: IssueLike;
  requestedAssigneePatch: RequestedAssigneePatch;
  stagePatch: Record<string, unknown>;
}) {
  const assigneeAgentId =
    input.stagePatch.assigneeAgentId !== undefined
      ? (input.stagePatch.assigneeAgentId as string | null)
      : input.requestedAssigneePatch.assigneeAgentId !== undefined
        ? input.requestedAssigneePatch.assigneeAgentId ?? null
        : input.issue.assigneeAgentId ?? null;
  const assigneeUserId =
    input.stagePatch.assigneeUserId !== undefined
      ? (input.stagePatch.assigneeUserId as string | null)
      : input.requestedAssigneePatch.assigneeUserId !== undefined
        ? input.requestedAssigneePatch.assigneeUserId ?? null
        : input.issue.assigneeUserId ?? null;
  return { assigneeAgentId, assigneeUserId };
}

export function stripMonitorFromExecutionPolicy(policy: IssueExecutionPolicy | null): IssueExecutionPolicy | null {
  if (!policy) return null;
  if (!policy.monitor) return policy;
  if (policy.stages.length === 0) return null;
  return {
    mode: policy.mode,
    commentRequired: policy.commentRequired,
    stages: policy.stages,
  };
}

export function setIssueExecutionPolicyMonitorScheduledBy(
  policy: IssueExecutionPolicy | null,
  scheduledBy: IssueMonitorScheduledBy,
): IssueExecutionPolicy | null {
  if (!policy?.monitor) return policy;
  return {
    ...policy,
    monitor: {
      ...policy.monitor,
      scheduledBy,
    },
  };
}

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

  const monitor = parsed.data.monitor
    ? {
      nextCheckAt: parsed.data.monitor.nextCheckAt,
      notes: normalizeMonitorNotes(parsed.data.monitor.notes),
      scheduledBy: parsed.data.monitor.scheduledBy,
      kind: parsed.data.monitor.kind ?? null,
      serviceName: normalizeMonitorText(parsed.data.monitor.serviceName),
      externalRef: redactIssueMonitorExternalRef(parsed.data.monitor.externalRef),
      timeoutAt: parsed.data.monitor.timeoutAt ?? null,
      maxAttempts: parsed.data.monitor.maxAttempts ?? null,
      recoveryPolicy: parsed.data.monitor.recoveryPolicy ?? null,
    }
    : null;

  if (stages.length === 0 && !monitor) return null;

  return {
    mode: parsed.data.mode ?? "normal",
    commentRequired: true,
    stages,
    ...(monitor ? { monitor } : {}),
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

function stageHasParticipant(stage: IssueExecutionStage, participant: IssueExecutionStagePrincipal | null): boolean {
  if (!participant) return false;
  return stage.participants.some((candidate) => principalsEqual(candidate, participant));
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
    reviewRequest: null,
    completedStageIds,
    lastDecisionId: previous?.lastDecisionId ?? null,
    lastDecisionOutcome: "approved",
    monitor: previous?.monitor ?? null,
  };
}

function buildStateWithCompletedStages(input: {
  previous: IssueExecutionState | null;
  completedStageIds: string[];
  returnAssignee: IssueExecutionStagePrincipal | null;
}): IssueExecutionState {
  return {
    status: input.previous?.status ?? PENDING_STATUS,
    currentStageId: input.previous?.currentStageId ?? null,
    currentStageIndex: input.previous?.currentStageIndex ?? null,
    currentStageType: input.previous?.currentStageType ?? null,
    currentParticipant: input.previous?.currentParticipant ?? null,
    returnAssignee: input.previous?.returnAssignee ?? input.returnAssignee,
    reviewRequest: input.previous?.reviewRequest ?? null,
    completedStageIds: input.completedStageIds,
    lastDecisionId: input.previous?.lastDecisionId ?? null,
    lastDecisionOutcome: input.previous?.lastDecisionOutcome ?? null,
    monitor: input.previous?.monitor ?? null,
  };
}

function buildSkippedStageCompletedState(input: {
  previous: IssueExecutionState | null;
  completedStageIds: string[];
  returnAssignee: IssueExecutionStagePrincipal | null;
}): IssueExecutionState {
  return {
    status: COMPLETED_STATUS,
    currentStageId: null,
    currentStageIndex: null,
    currentStageType: null,
    currentParticipant: null,
    returnAssignee: input.previous?.returnAssignee ?? input.returnAssignee,
    reviewRequest: null,
    completedStageIds: input.completedStageIds,
    lastDecisionId: input.previous?.lastDecisionId ?? null,
    lastDecisionOutcome: input.previous?.lastDecisionOutcome ?? null,
    monitor: input.previous?.monitor ?? null,
  };
}

function buildPendingState(input: {
  previous: IssueExecutionState | null;
  stage: IssueExecutionStage;
  stageIndex: number;
  participant: IssueExecutionStagePrincipal;
  returnAssignee: IssueExecutionStagePrincipal | null;
  reviewRequest?: IssueExecutionState["reviewRequest"] | null;
}): IssueExecutionState {
  return {
    status: PENDING_STATUS,
    currentStageId: input.stage.id,
    currentStageIndex: input.stageIndex,
    currentStageType: input.stage.type,
    currentParticipant: input.participant,
    returnAssignee: input.returnAssignee,
    reviewRequest: input.reviewRequest ?? null,
    completedStageIds: input.previous?.completedStageIds ?? [],
    lastDecisionId: input.previous?.lastDecisionId ?? null,
    lastDecisionOutcome: input.previous?.lastDecisionOutcome ?? null,
    monitor: input.previous?.monitor ?? null,
  };
}

function buildChangesRequestedState(previous: IssueExecutionState, currentStage: IssueExecutionStage): IssueExecutionState {
  return {
    ...previous,
    status: CHANGES_REQUESTED_STATUS,
    currentStageId: currentStage.id,
    currentStageType: currentStage.type,
    reviewRequest: null,
    lastDecisionOutcome: "changes_requested",
  };
}

function buildPendingStagePatch(input: {
  patch: Record<string, unknown>;
  previous: IssueExecutionState | null;
  policy: IssueExecutionPolicy;
  stage: IssueExecutionStage;
  participant: IssueExecutionStagePrincipal;
  returnAssignee: IssueExecutionStagePrincipal | null;
  reviewRequest?: IssueExecutionState["reviewRequest"] | null;
}) {
  input.patch.status = "in_review";
  Object.assign(input.patch, patchForPrincipal(input.participant));
  input.patch.executionState = buildPendingState({
    previous: input.previous,
    stage: input.stage,
    stageIndex: input.policy.stages.findIndex((candidate) => candidate.id === input.stage.id),
    participant: input.participant,
    returnAssignee: input.returnAssignee,
    reviewRequest: input.reviewRequest,
  });
}

function clearExecutionStatePatch(input: {
  patch: Record<string, unknown>;
  issueStatus: string;
  requestedStatus?: string;
  returnAssignee: IssueExecutionStagePrincipal | null;
}) {
  input.patch.executionState = null;
  if (input.requestedStatus === undefined && input.issueStatus === "in_review" && input.returnAssignee) {
    input.patch.status = "in_progress";
    Object.assign(input.patch, patchForPrincipal(input.returnAssignee));
  }
}

function canAutoSkipPendingStage(input: {
  stage: IssueExecutionStage;
  returnAssignee: IssueExecutionStagePrincipal | null;
  requestedStatus?: string;
}) {
  if (input.requestedStatus !== "done" || input.stage.type !== "review" || !input.returnAssignee) {
    return false;
  }
  return input.stage.participants.length > 0 &&
    input.stage.participants.every((participant) => principalsEqual(participant, input.returnAssignee));
}

function applyIssueExecutionStageTransition(input: TransitionInput): TransitionResult {
  const patch: Record<string, unknown> = {};
  const existingState = parseIssueExecutionState(input.issue.executionState);
  const currentAssignee = assigneePrincipal(input.issue);
  const actor = actorPrincipal(input.actor);
  const requestedAssigneePatchProvided =
    input.requestedAssigneePatch.assigneeAgentId !== undefined || input.requestedAssigneePatch.assigneeUserId !== undefined;
  const explicitAssignee = assigneePrincipal(input.requestedAssigneePatch);
  const currentStage = input.policy ? findStageById(input.policy, existingState?.currentStageId) : null;
  const requestedStatus = input.requestedStatus;
  const activeStage = currentStage && existingState?.status === PENDING_STATUS ? currentStage : null;
  const effectiveReviewRequest = input.reviewRequest === undefined
    ? existingState?.reviewRequest ?? null
    : input.reviewRequest;

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

  if (existingState?.currentStageId && !currentStage) {
    clearExecutionStatePatch({
      patch,
      issueStatus: input.issue.status,
      requestedStatus,
      returnAssignee: existingState.returnAssignee,
    });
    return { patch };
  }

  if (activeStage) {
    const currentParticipant =
      existingState?.currentParticipant ??
      selectStageParticipant(activeStage, {
        exclude: existingState?.returnAssignee ?? null,
      });
    if (!currentParticipant) {
      throw unprocessable(`No eligible ${activeStage.type} participant is configured for this issue`);
    }

    if (!stageHasParticipant(activeStage, currentParticipant)) {
      const participant = selectStageParticipant(activeStage, {
        preferred: explicitAssignee ?? existingState?.currentParticipant ?? null,
        exclude: existingState?.returnAssignee ?? null,
      });
      if (!participant) {
        clearExecutionStatePatch({
          patch,
          issueStatus: input.issue.status,
          requestedStatus,
          returnAssignee: existingState?.returnAssignee ?? null,
        });
        return { patch };
      }

      buildPendingStagePatch({
        patch,
        previous: existingState,
        policy: input.policy,
        stage: activeStage,
        participant,
        returnAssignee: existingState?.returnAssignee ?? currentAssignee ?? actor,
        reviewRequest: effectiveReviewRequest,
      });
      return {
        patch,
        workflowControlledAssignment: true,
      };
    }

    if (principalsEqual(currentParticipant, actor)) {
      if (requestedStatus === "done") {
        if (!input.commentBody?.trim()) {
          throw unprocessable("Approving a review or approval stage requires a comment");
        }
        const approvedState = buildCompletedState(existingState, activeStage);
        const nextStage = nextPendingStage(
          input.policy,
          { ...approvedState, completedStageIds: approvedState.completedStageIds },
        );

        if (!nextStage) {
          patch.executionState = approvedState;
          return {
            patch,
            decision: {
              stageId: activeStage.id,
              stageType: activeStage.type,
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

        buildPendingStagePatch({
          patch,
          previous: approvedState,
          policy: input.policy,
          stage: nextStage,
          participant,
          returnAssignee: existingState?.returnAssignee ?? currentAssignee ?? actor,
          reviewRequest: input.reviewRequest ?? null,
        });
        return {
          patch,
          decision: {
            stageId: activeStage.id,
            stageType: activeStage.type,
            outcome: "approved",
            body: input.commentBody.trim(),
          },
          workflowControlledAssignment: true,
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
        patch.executionState = buildChangesRequestedState(existingState, activeStage);
        return {
          patch,
          decision: {
            stageId: activeStage.id,
            stageType: activeStage.type,
            outcome: "changes_requested",
            body: input.commentBody.trim(),
          },
          workflowControlledAssignment: true,
        };
      }
    }

    const attemptedStageAdvance =
      (requestedStatus !== undefined && requestedStatus !== "in_review") ||
      (requestedAssigneePatchProvided && !principalsEqual(explicitAssignee, currentParticipant));
    const stageStateDrifted =
      input.issue.status !== "in_review" ||
      !principalsEqual(currentAssignee, currentParticipant) ||
      !principalsEqual(existingState?.currentParticipant ?? null, currentParticipant);

    if (attemptedStageAdvance && !stageStateDrifted) {
      throw unprocessable("Only the active reviewer or approver can advance the current execution stage");
    }

    if (stageStateDrifted) {
      buildPendingStagePatch({
        patch,
        previous: existingState,
        policy: input.policy,
        stage: activeStage,
        participant: currentParticipant,
        returnAssignee: existingState?.returnAssignee ?? currentAssignee ?? actor,
        reviewRequest: effectiveReviewRequest,
      });
      return {
        patch,
        workflowControlledAssignment: true,
      };
    }

    return { patch };
  }

  const shouldStartWorkflow =
    requestedStatus === "done" ||
    requestedStatus === "in_review";

  if (!shouldStartWorkflow) {
    return { patch };
  }

  let pendingStage =
    existingState?.status === CHANGES_REQUESTED_STATUS && currentStage
      ? currentStage
      : nextPendingStage(input.policy, existingState);
  if (!pendingStage) return { patch };

  const returnAssignee = existingState?.returnAssignee ?? currentAssignee;
  const skippedStageIds = [...(existingState?.completedStageIds ?? [])];
  let participant = selectStageParticipant(pendingStage, {
    preferred:
      existingState?.status === CHANGES_REQUESTED_STATUS
        ? explicitAssignee ?? existingState.currentParticipant ?? null
        : explicitAssignee,
    exclude: returnAssignee,
  });
  while (!participant && canAutoSkipPendingStage({ stage: pendingStage, returnAssignee, requestedStatus })) {
    skippedStageIds.push(pendingStage.id);
    pendingStage = nextPendingStage(
      input.policy,
      buildStateWithCompletedStages({
        previous: existingState,
        completedStageIds: skippedStageIds,
        returnAssignee,
      }),
    );
    if (!pendingStage) {
      patch.executionState = buildSkippedStageCompletedState({
        previous: existingState,
        completedStageIds: skippedStageIds,
        returnAssignee,
      });
      return { patch };
    }
    participant = selectStageParticipant(pendingStage, {
      preferred:
        existingState?.status === CHANGES_REQUESTED_STATUS
          ? explicitAssignee ?? existingState.currentParticipant ?? null
          : explicitAssignee,
      exclude: returnAssignee,
    });
  }
  if (!participant) {
    throw unprocessable(`No eligible ${pendingStage.type} participant is configured for this issue`);
  }

  buildPendingStagePatch({
    patch,
    previous:
      skippedStageIds.length === (existingState?.completedStageIds ?? []).length
        ? existingState
        : buildStateWithCompletedStages({
            previous: existingState,
            completedStageIds: skippedStageIds,
            returnAssignee,
          }),
    policy: input.policy,
    stage: pendingStage,
    participant,
    returnAssignee,
    reviewRequest: input.reviewRequest ?? null,
  });
  return {
    patch,
    workflowControlledAssignment: true,
  };
}

function applyMonitorTransition(input: TransitionInput, stagePatch: Record<string, unknown>) {
  const patch: Record<string, unknown> = {};
  const previousPolicy = input.previousPolicy ?? normalizeIssueExecutionPolicy(input.issue.executionPolicy ?? null);
  const existingState = parseIssueExecutionState(input.issue.executionState);
  const currentMonitorState = derivePersistedMonitorState({
    issue: input.issue,
    state: existingState,
    policy: previousPolicy,
  });
  const nextStatus =
    typeof stagePatch.status === "string"
      ? (stagePatch.status as string)
      : input.requestedStatus ?? input.issue.status;
  const { assigneeAgentId, assigneeUserId } = nextAssigneeIds({
    issue: input.issue,
    requestedAssigneePatch: input.requestedAssigneePatch,
    stagePatch,
  });
  const stageState =
    stagePatch.executionState !== undefined
      ? parseIssueExecutionState(stagePatch.executionState)
      : existingState;
  const invalidReason = input.policy?.monitor
    ? monitorClearReasonForIssue(nextStatus, assigneeAgentId, assigneeUserId)
    : null;

  let targetMonitorState = currentMonitorState;

  if (input.policy?.monitor) {
    if (invalidReason) {
      if (input.monitorExplicitlyUpdated) {
        throw unprocessable(MONITOR_INVALID_MESSAGE);
      }
      patch.executionPolicy = stripMonitorFromExecutionPolicy(input.policy);
      patch.monitorNextCheckAt = null;
      patch.monitorWakeRequestedAt = null;
      targetMonitorState = buildClearedMonitorState({
        previous: currentMonitorState,
        clearReason: invalidReason,
        clearedAt: new Date(),
      });
    } else {
      const exhaustedReason = exhaustedMonitorClearReason({
        monitor: input.policy.monitor,
        attemptCount: currentMonitorState?.attemptCount ?? 0,
        now: new Date(),
      });
      if (exhaustedReason) {
        if (input.monitorExplicitlyUpdated) {
          throw unprocessable(MONITOR_BOUNDS_EXHAUSTED_MESSAGE, { clearReason: exhaustedReason });
        }
        patch.executionPolicy = stripMonitorFromExecutionPolicy(input.policy);
        patch.monitorNextCheckAt = null;
        patch.monitorWakeRequestedAt = null;
        targetMonitorState = buildClearedMonitorState({
          previous: currentMonitorState,
          clearReason: exhaustedReason,
          clearedAt: new Date(),
        });
      } else {
        patch.monitorNextCheckAt = new Date(input.policy.monitor.nextCheckAt);
        patch.monitorWakeRequestedAt = null;
        patch.monitorNotes = input.policy.monitor.notes ?? null;
        patch.monitorScheduledBy = input.policy.monitor.scheduledBy;
        targetMonitorState = buildScheduledMonitorState(currentMonitorState, input.policy.monitor);
      }
    }
  } else if (previousPolicy?.monitor) {
    patch.monitorNextCheckAt = null;
    patch.monitorWakeRequestedAt = null;
    targetMonitorState = buildClearedMonitorState({
      previous: currentMonitorState,
      clearReason:
        input.monitorExplicitlyUpdated
          ? "manual"
          : monitorClearReasonForIssue(nextStatus, assigneeAgentId, assigneeUserId) ?? "manual",
      clearedAt: new Date(),
    });
  }

  if (stagePatch.executionState !== undefined || !monitorStatesEqual(currentMonitorState, targetMonitorState)) {
    patch.executionState = executionStateWithMonitor(stageState, targetMonitorState);
  }

  return patch;
}

export function buildInitialIssueMonitorFields(input: {
  policy: IssueExecutionPolicy | null;
  status: string;
  assigneeAgentId?: string | null;
  assigneeUserId?: string | null;
}) {
  if (!input.policy?.monitor) return {};
  if (!issueAllowsMonitor(input.status, input.assigneeAgentId ?? null, input.assigneeUserId ?? null)) {
    throw unprocessable(MONITOR_INVALID_MESSAGE);
  }
  const exhaustedReason = exhaustedMonitorClearReason({
    monitor: input.policy.monitor,
    attemptCount: 0,
    now: new Date(),
  });
  if (exhaustedReason) {
    throw unprocessable(MONITOR_BOUNDS_EXHAUSTED_MESSAGE, { clearReason: exhaustedReason });
  }

  const monitorState = buildScheduledMonitorState(null, input.policy.monitor);
  return {
    monitorNextCheckAt: new Date(input.policy.monitor.nextCheckAt),
    monitorWakeRequestedAt: null,
    monitorNotes: input.policy.monitor.notes ?? null,
    monitorScheduledBy: input.policy.monitor.scheduledBy,
    executionState: executionStateWithMonitor(null, monitorState) as Record<string, unknown> | null,
  };
}

export function buildIssueMonitorTriggeredPatch(input: {
  issue: IssueLike;
  policy: IssueExecutionPolicy | null;
  triggeredAt: Date;
}) {
  const existingState = parseIssueExecutionState(input.issue.executionState);
  const currentMonitorState = derivePersistedMonitorState({
    issue: input.issue,
    state: existingState,
    policy: input.policy,
  });
  const nextMonitorState = buildTriggeredMonitorState({
    previous: currentMonitorState,
    triggeredAt: input.triggeredAt,
  });

  return {
    executionPolicy: stripMonitorFromExecutionPolicy(input.policy) as Record<string, unknown> | null,
    executionState: executionStateWithMonitor(existingState, nextMonitorState) as Record<string, unknown> | null,
    monitorNextCheckAt: null,
    monitorWakeRequestedAt: null,
    monitorLastTriggeredAt: input.triggeredAt,
    monitorAttemptCount: nextMonitorState.attemptCount,
    monitorNotes: nextMonitorState.notes,
    monitorScheduledBy: nextMonitorState.scheduledBy,
  };
}

export function buildIssueMonitorClearedPatch(input: {
  issue: IssueLike;
  policy: IssueExecutionPolicy | null;
  clearReason: IssueExecutionMonitorClearReason;
  clearedAt?: Date;
}) {
  const existingState = parseIssueExecutionState(input.issue.executionState);
  const currentMonitorState = derivePersistedMonitorState({
    issue: input.issue,
    state: existingState,
    policy: input.policy,
  });
  const nextMonitorState = buildClearedMonitorState({
    previous: currentMonitorState,
    clearReason: input.clearReason,
    clearedAt: input.clearedAt ?? new Date(),
  });

  return {
    executionPolicy: stripMonitorFromExecutionPolicy(input.policy) as Record<string, unknown> | null,
    executionState: executionStateWithMonitor(existingState, nextMonitorState) as Record<string, unknown> | null,
    monitorNextCheckAt: null,
    monitorWakeRequestedAt: null,
  };
}

export function applyIssueExecutionPolicyTransition(input: TransitionInput): TransitionResult {
  const stageResult = applyIssueExecutionStageTransition(input);
  const monitorPatch = applyMonitorTransition(input, stageResult.patch);
  Object.assign(stageResult.patch, monitorPatch);
  return stageResult;
}
