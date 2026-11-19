import { afterTransactionCommit } from "@paperclipai/db";
import { hasUnfinishedBlockers } from "./issue-dependency-wakeups.js";
import {
  ONBOARDING_FIRST_TASK_ORIGIN_KIND,
  type IssueUnblockDescriptor,
} from "@paperclipai/shared";
import {
  trackArtifactCreated,
  trackModelConnected,
  trackPlanApproved,
  trackPlanCreated,
  trackTaskBlocked,
  trackTaskCompleted,
  trackTaskCreated,
  type TelemetryClient,
} from "@paperclipai/shared/telemetry";
import { logger } from "../middleware/logger.js";
import { getTelemetryClient } from "../telemetry.js";
import { resolveTelemetryPerson, withTelemetryActor } from "../telemetry-company-scope.js";

export type TelemetryActorKind = "user" | "agent" | "system";

export function telemetryActorKind(actor: { agentId?: string | null; userId?: string | null }): TelemetryActorKind {
  if (actor.agentId) return "agent";
  if (actor.userId) return "user";
  return "system";
}

export type TelemetryPersonSources = Parameters<typeof resolveTelemetryPerson>[0];

function emitAfterCommit(
  companyId: string,
  personSources: TelemetryPersonSources,
  event: string,
  emit: (client: TelemetryClient) => void,
): void {
  const person = resolveTelemetryPerson(personSources);
  afterTransactionCommit(() => {
    try {
      const client = getTelemetryClient();
      if (client) withTelemetryActor({ companyId, person }, () => emit(client));
    } catch (err) {
      logger.warn({ err, event }, "failed to emit product telemetry");
    }
  });
}

export function emitTaskCreatedAfterCommit(issue: {
  companyId: string;
  originKind: string | null;
  parentId: string | null;
  conversationAgentId: string | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  responsibleUserId: string | null;
}): void {
  if (issue.conversationAgentId) return;
  const createdByKind = issue.originKind === "routine_execution"
    ? "routine"
    : issue.originKind === ONBOARDING_FIRST_TASK_ORIGIN_KIND
      ? "onboarding"
      : telemetryActorKind({ agentId: issue.createdByAgentId, userId: issue.createdByUserId });
  const personSources = { taskCreatedByUserId: issue.createdByUserId, taskAssignedByUserId: issue.responsibleUserId };
  emitAfterCommit(issue.companyId, personSources, "task.created", (client) =>
    trackTaskCreated(client, { createdByKind, isSubtask: Boolean(issue.parentId) }));
}

export type TaskBlockedReason = "waiting_on_task" | "waiting_for_person" | "waiting_for_agent" | "needs_recovery" | "unspecified";

export function taskBlockedReason(input: {
  hasOpenBlockers: boolean;
  unblockDescriptor: IssueUnblockDescriptor | null | undefined;
  actorKind: TelemetryActorKind;
}): TaskBlockedReason {
  if (input.hasOpenBlockers) return "waiting_on_task";
  const owner = input.unblockDescriptor?.owner;
  if (owner === "board" || (owner && typeof owner === "object" && "userId" in owner)) return "waiting_for_person";
  if (owner && typeof owner === "object" && "agentId" in owner) return "waiting_for_agent";
  return input.actorKind === "system" ? "needs_recovery" : "unspecified";
}

export function emitTaskStatusTransitionAfterCommit(input: {
  companyId: string;
  previousStatus: string;
  nextStatus: string;
  parentId: string | null;
  conversationAgentId: string | null;
  actorAgentId: string | null | undefined;
  actorUserId: string | null | undefined;
  hasOpenBlockers: boolean;
  unblockDescriptor: IssueUnblockDescriptor | null | undefined;
  taskCreatedByUserId: string | null;
  taskResponsibleUserId: string | null;
  runOwnerUserId: string | null | undefined;
}): void {
  if (input.previousStatus === input.nextStatus || input.conversationAgentId) return;
  const actorKind = telemetryActorKind({ agentId: input.actorAgentId, userId: input.actorUserId });
  const personSources = {
    taskCreatedByUserId: input.taskCreatedByUserId,
    taskAssignedByUserId: input.taskResponsibleUserId,
    runOwnerUserId: input.runOwnerUserId,
  };
  if (input.nextStatus === "done") {
    emitAfterCommit(input.companyId, personSources, "task.completed", (client) =>
      trackTaskCompleted(client, { completedByKind: actorKind, isSubtask: Boolean(input.parentId) }));
  } else if (input.nextStatus === "blocked") {
    const blockedReason = taskBlockedReason({
      hasOpenBlockers: input.hasOpenBlockers,
      unblockDescriptor: input.unblockDescriptor,
      actorKind,
    });
    emitAfterCommit(input.companyId, personSources, "task.blocked", (client) =>
      trackTaskBlocked(client, { blockedReason, blockedByKind: actorKind }));
  }
}

export async function emitSystemTaskBlockedAfterCommit(
  tx: Parameters<typeof hasUnfinishedBlockers>[0],
  task: {
    id: string;
    companyId: string;
    parentId: string | null;
    conversationAgentId: string | null;
    unblockDescriptor: IssueUnblockDescriptor | null;
    createdByUserId: string | null;
    responsibleUserId: string | null;
  },
  previousStatus: string,
): Promise<void> {
  if (previousStatus === "blocked") return;
  emitTaskStatusTransitionAfterCommit({
    companyId: task.companyId,
    previousStatus,
    nextStatus: "blocked",
    parentId: task.parentId,
    conversationAgentId: task.conversationAgentId,
    actorAgentId: null,
    actorUserId: null,
    hasOpenBlockers: await hasUnfinishedBlockers(tx, task),
    unblockDescriptor: task.unblockDescriptor,
    taskCreatedByUserId: task.createdByUserId,
    taskResponsibleUserId: task.responsibleUserId,
    runOwnerUserId: null,
  });
}

export function emitPlanCreatedAfterCommit(input: {
  companyId: string;
  createdByAgentId: string | null | undefined;
  createdByUserId: string | null | undefined;
  atTaskCreation: boolean;
  task: { createdByUserId: string | null; responsibleUserId: string | null };
}): void {
  const createdByKind = telemetryActorKind({ agentId: input.createdByAgentId, userId: input.createdByUserId });
  const personSources = {
    taskCreatedByUserId: input.task.createdByUserId,
    taskAssignedByUserId: input.task.responsibleUserId,
    runOwnerUserId: input.createdByUserId,
  };
  emitAfterCommit(input.companyId, personSources, "plan.created", (client) =>
    trackPlanCreated(client, { createdByKind, atTaskCreation: input.atTaskCreation }));
}

export function emitPlanApprovedAfterCommit(input: {
  companyId: string;
  actor: { agentId?: string | null; userId?: string | null };
  startsExecution: boolean;
  task: { createdByUserId: string | null; responsibleUserId: string | null };
}): void {
  const approvedByKind = telemetryActorKind(input.actor);
  const personSources = {
    taskCreatedByUserId: input.task.createdByUserId,
    taskAssignedByUserId: input.task.responsibleUserId,
    runOwnerUserId: input.actor.userId,
  };
  emitAfterCommit(input.companyId, personSources, "plan.approved", (client) =>
    trackPlanApproved(client, { approvedByKind, startsExecution: input.startsExecution }));
}

const CATALOG_ARTIFACT_PROVIDERS = new Set(["paperclip", "github", "vercel", "s3"]);

export function artifactTelemetryProvider(provider: string): "paperclip" | "github" | "vercel" | "s3" | "custom" {
  return CATALOG_ARTIFACT_PROVIDERS.has(provider) ? provider as "paperclip" | "github" | "vercel" | "s3" : "custom";
}

export function emitArtifactCreatedAfterCommit(input: {
  companyId: string;
  type: string;
  provider: string;
  creationFlow: "direct" | "promotion" | "run_deliverable";
  task: { createdByUserId: string | null; responsibleUserId: string | null } | null;
  runOwnerUserId: string | null | undefined;
}): void {
  const personSources = {
    taskCreatedByUserId: input.task?.createdByUserId,
    taskAssignedByUserId: input.task?.responsibleUserId,
    runOwnerUserId: input.runOwnerUserId,
  };
  emitAfterCommit(input.companyId, personSources, "artifact.created", (client) =>
    trackArtifactCreated(client, {
      artifactType: input.type,
      provider: artifactTelemetryProvider(input.provider),
      creationFlow: input.creationFlow,
    }));
}

export function emitModelConnectedAfterCommit(input: {
  companyId: string;
  provider: string;
  method: string;
  ownership: string;
  routingKind: string | null | undefined;
  firstForCompany: boolean;
  ownerUserId: string;
}): void {
  emitAfterCommit(input.companyId, { runOwnerUserId: input.ownerUserId }, "model.connected", (client) =>
    trackModelConnected(client, {
      provider: input.provider,
      connectionMethod: input.method,
      ownership: input.ownership,
      routingKind: input.routingKind ?? null,
      firstForCompany: input.firstForCompany,
    }));
}
