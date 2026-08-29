import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { issueExecutionDecisions, issues, type Db } from "@paperclipai/db";
import type { StalledReviewDecisionAction } from "@paperclipai/shared";
import { conflict, forbidden, notFound } from "../errors.js";
import { logActivity } from "./activity-log.js";
import {
  applyIssueExecutionPolicyTransition,
  normalizeIssueExecutionPolicy,
  parseIssueExecutionState,
} from "./issue-execution-policy.js";
import { visibleIssueCondition } from "./issue-visibility.js";
import { issueService } from "./issues.js";

export type StalledReviewDecisionActor =
  | { actorType: "agent"; agentId: string; runId?: string | null }
  | { actorType: "user"; userId: string; runId?: string | null };

export interface DecideStalledReviewInput {
  issueId: string;
  companyId: string;
  action: StalledReviewDecisionAction;
  note?: string;
  actor: StalledReviewDecisionActor;
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
      if (input.actor.actorType === "agent") {
        const executionState = parseIssueExecutionState(lockedIssue.executionState);
        const currentParticipant = executionState?.status === "pending"
          ? executionState.currentParticipant
          : null;
        if (
          currentParticipant?.type !== "agent" ||
          currentParticipant.agentId !== input.actor.agentId
        ) {
          throw forbidden("Only the active execution participant can decide this stalled review");
        }
      }
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
      if (reviewAttention?.state !== "stalled") {
        throw conflict("Issue is no longer a stalled review", {
          issueId: lockedIssue.id,
          reviewAttentionState: reviewAttention?.state ?? "none",
        });
      }

      const actorId = input.actor.actorType === "agent" ? input.actor.agentId : input.actor.userId;
      const actorAgentId = input.actor.actorType === "agent" ? input.actor.agentId : null;
      const actorUserId = input.actor.actorType === "user" ? input.actor.userId : null;
      const comment = input.note
        ? await svc.addComment(
            lockedIssue.id,
            input.note,
            {
              agentId: actorAgentId ?? undefined,
              userId: actorUserId ?? undefined,
              runId: input.actor.runId ?? null,
            },
            { authorType: input.actor.actorType },
            tx,
          )
        : null;
      const requestedStatus = input.action === "approve" ? "done" : "todo";
      const updatePatch: Record<string, unknown> = { status: requestedStatus };
      let decisionId: string | null = null;
      let executionDecision: ReturnType<typeof applyIssueExecutionPolicyTransition>["decision"];
      if (input.actor.actorType === "agent") {
        const executionPolicy = normalizeIssueExecutionPolicy(lockedIssue.executionPolicy ?? null);
        const transition = applyIssueExecutionPolicyTransition({
          issue: lockedIssue,
          policy: executionPolicy,
          previousPolicy: executionPolicy,
          requestedStatus,
          requestedAssigneePatch: {},
          actor: { agentId: input.actor.agentId, userId: null },
          commentBody: input.note ?? null,
        });
        Object.assign(updatePatch, transition.patch);
        executionDecision = transition.decision;
        if (executionDecision) {
          decisionId = randomUUID();
          const nextExecutionState = updatePatch.executionState;
          if (!nextExecutionState || typeof nextExecutionState !== "object") {
            throw new Error("Execution policy decision patch is missing executionState");
          }
          updatePatch.executionState = { ...nextExecutionState, lastDecisionId: decisionId };
        }
      }
      const updated = await svc.update(lockedIssue.id, {
        ...updatePatch,
        actorAgentId,
        actorUserId,
      }, tx);
      if (!updated) throw notFound("Issue not found");

      if (executionDecision && decisionId) {
        await tx.insert(issueExecutionDecisions).values({
          id: decisionId,
          companyId: updated.companyId,
          issueId: updated.id,
          stageId: executionDecision.stageId,
          stageType: executionDecision.stageType,
          actorAgentId,
          actorUserId,
          outcome: executionDecision.outcome,
          body: executionDecision.body,
          createdByRunId: input.actor.runId ?? null,
        });
      }

      if (comment) {
        await logActivity(txDb, {
          companyId: updated.companyId,
          actorType: input.actor.actorType,
          actorId,
          agentId: actorAgentId,
          runId: input.actor.runId ?? null,
          action: "issue.comment_added",
          entityType: "issue",
          entityId: updated.id,
          issueId: updated.id,
          details: {
            commentId: comment.id,
            authorAgentId: actorAgentId,
            authorUserId: actorUserId,
            source: "stalled_review_decision",
          },
        });
      }
      await logActivity(txDb, {
        companyId: updated.companyId,
        actorType: input.actor.actorType,
        actorId,
        agentId: actorAgentId,
        runId: input.actor.runId ?? null,
        action: "issue.stalled_review_decided",
        entityType: "issue",
        entityId: updated.id,
        issueId: updated.id,
        details: {
          action: input.action,
          status: updated.status,
          identifier: updated.identifier,
          commentId: comment?.id ?? null,
          authorAgentId: comment ? actorAgentId : null,
          authorUserId: comment ? actorUserId : null,
          _previous: { status: lockedIssue.status },
        },
      });

      return { issue: updated, comment };
    }),
  };
}
