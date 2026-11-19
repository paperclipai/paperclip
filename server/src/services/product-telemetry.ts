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
import { withTelemetryCompany } from "../telemetry-company-scope.js";

export type TelemetryActorKind = "user" | "agent" | "system";

export function telemetryActorKind(actor: { agentId?: string | null; userId?: string | null }): TelemetryActorKind {
  if (actor.agentId) return "agent";
  if (actor.userId) return "user";
  return "system";
}

function emitAfterCommit(companyId: string, event: string, emit: (client: TelemetryClient) => void): void {
  afterTransactionCommit(() => {
    try {
      const client = getTelemetryClient();
      if (client) withTelemetryCompany(companyId, () => emit(client));
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
}): void {
  if (issue.conversationAgentId) return;
  const createdByKind = issue.originKind === "routine_execution"
    ? "routine"
    : issue.originKind === ONBOARDING_FIRST_TASK_ORIGIN_KIND
      ? "onboarding"
      : telemetryActorKind({ agentId: issue.createdByAgentId, userId: issue.createdByUserId });
  emitAfterCommit(issue.companyId, "task.created", (client) =>
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
}): void {
  if (input.previousStatus === input.nextStatus || input.conversationAgentId) return;
  const actorKind = telemetryActorKind({ agentId: input.actorAgentId, userId: input.actorUserId });
  if (input.nextStatus === "done") {
    emitAfterCommit(input.companyId, "task.completed", (client) =>
      trackTaskCompleted(client, { completedByKind: actorKind, isSubtask: Boolean(input.parentId) }));
  } else if (input.nextStatus === "blocked") {
    const blockedReason = taskBlockedReason({
      hasOpenBlockers: input.hasOpenBlockers,
      unblockDescriptor: input.unblockDescriptor,
      actorKind,
    });
    emitAfterCommit(input.companyId, "task.blocked", (client) =>
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
  });
}

export function emitPlanCreatedAfterCommit(input: {
  companyId: string;
  createdByAgentId: string | null | undefined;
  createdByUserId: string | null | undefined;
  atTaskCreation: boolean;
}): void {
  const createdByKind = telemetryActorKind({ agentId: input.createdByAgentId, userId: input.createdByUserId });
  emitAfterCommit(input.companyId, "plan.created", (client) =>
    trackPlanCreated(client, { createdByKind, atTaskCreation: input.atTaskCreation }));
}

export function emitPlanApprovedAfterCommit(input: {
  companyId: string;
  actor: { agentId?: string | null; userId?: string | null };
  startsExecution: boolean;
}): void {
  const approvedByKind = telemetryActorKind(input.actor);
  emitAfterCommit(input.companyId, "plan.approved", (client) =>
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
}): void {
  emitAfterCommit(input.companyId, "artifact.created", (client) =>
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
}): void {
  emitAfterCommit(input.companyId, "model.connected", (client) =>
    trackModelConnected(client, {
      provider: input.provider,
      connectionMethod: input.method,
      ownership: input.ownership,
      routingKind: input.routingKind ?? null,
      firstForCompany: input.firstForCompany,
    }));
}
