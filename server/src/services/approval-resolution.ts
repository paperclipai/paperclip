import type { Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";
import {
  approvalService,
  heartbeatService,
  issueApprovalService,
  logActivity,
} from "./index.js";

export type ApprovalResolutionDecision = "approve" | "reject" | "revise";

export interface ApprovalResolutionActor {
  activityActorType: "agent" | "user" | "system" | "plugin";
  activityActorId: string;
  activityAgentId?: string | null;
  activityRunId?: string | null;
  requesterWakeActorType: "user" | "agent" | "system";
  requesterWakeActorId?: string | null;
}

export interface ResolveApprovalWithSideEffectsInput {
  approvalId: string;
  decision: ApprovalResolutionDecision;
  decidedByUserId: string;
  decisionNote?: string | null;
  actor: ApprovalResolutionActor;
}

export async function resolveApprovalWithSideEffects(
  db: Db,
  options: { pluginWorkerManager?: PluginWorkerManager } = {},
  input: ResolveApprovalWithSideEffectsInput,
) {
  const svc = approvalService(db);
  const issueApprovalsSvc = issueApprovalService(db);
  const heartbeat = heartbeatService(db, {
    pluginWorkerManager: options.pluginWorkerManager,
  });
  const { approvalId, decision, decidedByUserId, decisionNote, actor } = input;

  if (decision === "revise") {
    const approval = await svc.requestRevision(approvalId, decidedByUserId, decisionNote);
    await logActivity(db, {
      companyId: approval.companyId,
      actorType: actor.activityActorType,
      actorId: actor.activityActorId,
      agentId: actor.activityAgentId ?? null,
      runId: actor.activityRunId ?? null,
      action: "approval.revision_requested",
      entityType: "approval",
      entityId: approval.id,
      details: { type: approval.type, decidedByUserId },
    });
    return { approval, applied: true };
  }

  const { approval, applied } =
    decision === "approve"
      ? await svc.approve(approvalId, decidedByUserId, decisionNote)
      : await svc.reject(approvalId, decidedByUserId, decisionNote);

  if (!applied) {
    return { approval, applied };
  }

  const linkedIssues = await issueApprovalsSvc.listIssuesForApproval(approval.id);
  const linkedIssueIds = linkedIssues.map((issue) => issue.id);
  const primaryIssueId = linkedIssueIds[0] ?? null;

  await logActivity(db, {
    companyId: approval.companyId,
    actorType: actor.activityActorType,
    actorId: actor.activityActorId,
    agentId: actor.activityAgentId ?? null,
    runId: actor.activityRunId ?? null,
    action: decision === "approve" ? "approval.approved" : "approval.rejected",
    entityType: "approval",
    entityId: approval.id,
    details: {
      type: approval.type,
      requestedByAgentId: approval.requestedByAgentId,
      linkedIssueIds,
      decidedByUserId,
    },
  });

  if (decision === "approve" && approval.requestedByAgentId) {
    try {
      const wakeRun = await heartbeat.wakeup(approval.requestedByAgentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "approval_approved",
        payload: {
          approvalId: approval.id,
          approvalStatus: approval.status,
          issueId: primaryIssueId,
          issueIds: linkedIssueIds,
        },
        requestedByActorType: actor.requesterWakeActorType,
        requestedByActorId: actor.requesterWakeActorId ?? null,
        contextSnapshot: {
          source: "approval.approved",
          approvalId: approval.id,
          approvalStatus: approval.status,
          issueId: primaryIssueId,
          issueIds: linkedIssueIds,
          taskId: primaryIssueId,
          wakeReason: "approval_approved",
        },
      });

      await logActivity(db, {
        companyId: approval.companyId,
        actorType: actor.activityActorType,
        actorId: actor.activityActorId,
        agentId: actor.activityAgentId ?? null,
        runId: actor.activityRunId ?? null,
        action: "approval.requester_wakeup_queued",
        entityType: "approval",
        entityId: approval.id,
        details: {
          requesterAgentId: approval.requestedByAgentId,
          wakeRunId: wakeRun?.id ?? null,
          linkedIssueIds,
          decidedByUserId,
        },
      });
    } catch (err) {
      logger.warn(
        {
          err,
          approvalId: approval.id,
          requestedByAgentId: approval.requestedByAgentId,
        },
        "failed to queue requester wakeup after approval",
      );
      await logActivity(db, {
        companyId: approval.companyId,
        actorType: actor.activityActorType,
        actorId: actor.activityActorId,
        agentId: actor.activityAgentId ?? null,
        runId: actor.activityRunId ?? null,
        action: "approval.requester_wakeup_failed",
        entityType: "approval",
        entityId: approval.id,
        details: {
          requesterAgentId: approval.requestedByAgentId,
          linkedIssueIds,
          decidedByUserId,
          error: err instanceof Error ? err.message : String(err),
        },
      });
    }
  }

  return { approval, applied };
}
