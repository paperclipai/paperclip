import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { issueComments, issueExecutionDecisions, issues, type Db } from "@paperclipai/db";
import type { StalledReviewDecisionAction } from "@paperclipai/shared";
import { conflict, notFound } from "../errors.js";
import { logActivity } from "./activity-log.js";
import { visibleIssueCondition } from "./issue-visibility.js";
import { issueService } from "./issues.js";
import { applyIssueExecutionPolicyTransition, normalizeIssueExecutionPolicy, parseIssueExecutionState } from "./issue-execution-policy.js";

export interface StalledReviewDecisionActor {
  userId: string;
  runId?: string | null;
}

export interface DecideStalledReviewInput {
  issueId: string;
  companyId: string;
  action: StalledReviewDecisionAction;
  note?: string;
  actor: StalledReviewDecisionActor;
}

function isApprovalEvidence(body: string) {
  const heading = body.replace(/\r\n?/g, "\n").match(/(?:^|\n)##\s*Review:\s*([^\n]*)/i)?.[1] ?? "";
  return /\bAPPROVED\b/i.test(heading) && !/\b(?:NOT|REJECT(?:ED|ING|S)?|DENY|DENIED|BLOCK(?:ED|ING|S)?|CHANGES?\s+REQUESTED)\b/i.test(heading);
}

export function stalledReviewDecisionService(db: Db) {
  return {
    decide: async (input: DecideStalledReviewInput) => db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      const lockedIssue = await tx
        .select()
        .from(issues)
        .where(and(
          eq(issues.id, input.issueId),
          eq(issues.companyId, input.companyId),
          visibleIssueCondition(),
        ))
        .for("update")
        .then((rows) => rows[0] ?? null);

      if (!lockedIssue) throw notFound("Issue not found");
      if (lockedIssue.status !== "in_review") {
        throw conflict("Issue is no longer a stalled review", {
          issueId: lockedIssue.id,
          currentStatus: lockedIssue.status,
        });
      }

      const svc = issueService(txDb);
      const reviewAttention = await svc
        .listReviewAttention(lockedIssue.companyId, [lockedIssue])
        .then((rows) => rows.get(lockedIssue.id));
      const executionState = parseIssueExecutionState(lockedIssue.executionState);
      const policy = normalizeIssueExecutionPolicy(lockedIssue.executionPolicy);
      const activeStage = executionState?.currentStageId
        ? policy?.stages.find((stage) => stage.id === executionState.currentStageId) ?? null
        : null;
      const participantAgentId = executionState?.currentParticipant?.type === "agent"
        ? executionState.currentParticipant.agentId ?? null
        : null;
      const evidence = executionState?.status === "pending" && participantAgentId
        ? await tx.select().from(issueComments)
          .where(and(eq(issueComments.issueId, lockedIssue.id), eq(issueComments.authorAgentId, participantAgentId)))
          .orderBy(desc(issueComments.createdAt), desc(issueComments.id))
          .then((rows) => rows.find((row) => isApprovalEvidence(row.body)) ?? null)
        : null;
      const coveredFinalApproval = input.action === "approve" && reviewAttention?.state === "covered" &&
        Boolean(activeStage && policy && executionState && evidence && !executionState.completedStageIds.includes(activeStage.id) &&
          policy.stages.every((stage) => stage.id === activeStage.id || executionState.completedStageIds.includes(stage.id)));
      if (reviewAttention?.state !== "stalled" && !coveredFinalApproval) {
        throw conflict("Issue is no longer a stalled review", {
          issueId: lockedIssue.id,
          reviewAttentionState: reviewAttention?.state ?? "none",
        });
      }

      const recoveredTransition = coveredFinalApproval && executionState && policy && activeStage && evidence && participantAgentId
        ? applyIssueExecutionPolicyTransition({
            issue: lockedIssue,
            policy,
            requestedStatus: "done",
            requestedAssigneePatch: {},
            actor: { agentId: participantAgentId },
            commentBody: evidence.body,
          })
        : null;
      const decisionId = recoveredTransition?.decision ? randomUUID() : null;

      const comment = input.note
        ? await svc.addComment(
            lockedIssue.id,
            input.note,
            { userId: input.actor.userId, runId: input.actor.runId ?? null },
            { authorType: "user" },
            tx,
          )
        : null;
      const status = input.action === "approve" ? "done" : "todo";
      const updated = await svc.update(lockedIssue.id, {
        status,
        actorUserId: input.actor.userId,
        ...(recoveredTransition?.patch ?? {}),
        ...(decisionId ? { executionState: { ...(recoveredTransition!.patch.executionState as object), lastDecisionId: decisionId } } : {}),
      }, tx);
      if (!updated) throw notFound("Issue not found");
      if (decisionId && recoveredTransition?.decision) {
        await tx.insert(issueExecutionDecisions).values({
          id: decisionId, companyId: updated.companyId, issueId: updated.id,
          stageId: recoveredTransition.decision.stageId, stageType: recoveredTransition.decision.stageType,
          actorAgentId: participantAgentId, actorUserId: null,
          outcome: recoveredTransition.decision.outcome, body: recoveredTransition.decision.body,
          createdByRunId: null,
        });
      }

      if (comment) {
        await logActivity(txDb, {
          companyId: updated.companyId,
          actorType: "user",
          actorId: input.actor.userId,
          runId: input.actor.runId ?? null,
          action: "issue.comment_added",
          entityType: "issue",
          entityId: updated.id,
          issueId: updated.id,
          details: {
            commentId: comment.id,
            authorUserId: input.actor.userId,
            source: "stalled_review_decision",
          },
        });
      }
      await logActivity(txDb, {
        companyId: updated.companyId,
        actorType: "user",
        actorId: input.actor.userId,
        runId: input.actor.runId ?? null,
        action: "issue.stalled_review_decided",
        entityType: "issue",
        entityId: updated.id,
        issueId: updated.id,
        details: {
          action: input.action,
          status,
          identifier: updated.identifier,
          commentId: comment?.id ?? null,
          authorUserId: comment ? input.actor.userId : null,
          _previous: { status: lockedIssue.status },
        },
      });

      return { issue: updated, comment };
    }),
  };
}
