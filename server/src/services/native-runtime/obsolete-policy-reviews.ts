import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  approvals, issueApprovals, issueThreadInteractions, issues,
  nativeRunFinalizations, statusDecisionEffects, statusDecisions, workAssessments,
  type Db,
} from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import { issueService } from "../issues.js";
import { issueThreadInteractionService } from "../issue-thread-interactions.js";
import { enqueueTerminalIssueInteractionChatPublications } from "../chat-interaction-publications.js";
import { persistActivity, publishActivity, type ActivityPublication } from "../activity-log.js";

const obsoletePrompt = "Review the superseding native policy assessment.";

/** Retire only the old version-change gate, never a real completion review. */
export async function dismissObsoleteNativePolicyReviews(db: Db, runIds?: string[]) {
  const candidates = await db.select({
    interaction: issueThreadInteractions,
    decision: statusDecisions,
    priorDecisionId: workAssessments.priorDecisionId,
  }).from(issueThreadInteractions)
    .innerJoin(statusDecisionEffects, and(
      eq(statusDecisionEffects.companyId, issueThreadInteractions.companyId),
      eq(statusDecisionEffects.issueId, issueThreadInteractions.issueId),
      sql`${statusDecisionEffects.targetId} = ${issueThreadInteractions.id}::text`,
      eq(statusDecisionEffects.targetType, "issue_thread_interaction"),
      eq(statusDecisionEffects.effectKind, "bind_reviewer"),
    ))
    .innerJoin(statusDecisions, and(
      eq(statusDecisions.id, statusDecisionEffects.decisionId),
      eq(statusDecisions.companyId, issueThreadInteractions.companyId),
      eq(statusDecisions.issueId, issueThreadInteractions.issueId),
      eq(statusDecisions.runId, issueThreadInteractions.sourceRunId),
    ))
    .innerJoin(workAssessments, and(
      eq(workAssessments.id, statusDecisions.assessmentId),
      eq(workAssessments.companyId, statusDecisions.companyId),
      eq(workAssessments.issueId, statusDecisions.issueId),
    ))
    .where(and(
      eq(issueThreadInteractions.status, "pending"),
      eq(issueThreadInteractions.kind, "request_confirmation"),
      isNull(issueThreadInteractions.createdByAgentId),
      isNull(issueThreadInteractions.createdByUserId),
      eq(statusDecisions.applicationState, "applied"),
      eq(statusDecisions.reasonCode, "completion_review_required"),
      eq(statusDecisions.toStatus, "in_review"),
      sql`${issueThreadInteractions.idempotencyKey} = 'native-review:' || ${statusDecisions.id}::text`,
      sql`${issueThreadInteractions.payload}->>'prompt' = ${obsoletePrompt}`,
      // Match the complete old decision, including its unique assessment-only effect.
      sql`${statusDecisions.decisionJson}->'effects' = ${JSON.stringify([
        { kind: "bind_reviewer", prompt: obsoletePrompt, ownerUserId: null },
        { kind: "append_superseding_assessment" },
      ])}::jsonb`,
      ...(runIds?.length ? [inArray(statusDecisions.runId, runIds)] : []),
    )).limit(100);

  for (const { interaction, decision, priorDecisionId } of candidates) {
    const publications: ActivityPublication[] = [];
    try {
      await db.transaction(async (tx) => {
        // Same lock order as status commits: coordinator, issue, interaction.
        await tx.select({ runId: nativeRunFinalizations.runId }).from(nativeRunFinalizations)
          .where(and(eq(nativeRunFinalizations.runId, decision.runId),
            eq(nativeRunFinalizations.companyId, decision.companyId)))
          .for("update");
        const issue = await tx.select().from(issues).where(and(
          eq(issues.id, decision.issueId), eq(issues.companyId, decision.companyId),
        )).for("update").then((rows) => rows[0]);
        if (!issue) return;
        const now = new Date();
        const [cancelled] = await tx.update(issueThreadInteractions).set({
          status: "cancelled",
          result: { version: 1, outcome: "withdrawn", reason: "A Paperclip upgrade does not require completion review." },
          resolvedAt: now,
          updatedAt: now,
        }).where(and(
          eq(issueThreadInteractions.id, interaction.id),
          eq(issueThreadInteractions.companyId, decision.companyId),
          eq(issueThreadInteractions.status, "pending"),
        )).returning({ id: issueThreadInteractions.id });
        if (!cancelled) return;
        const terminalInteraction = await issueThreadInteractionService(tx as unknown as Db).getById(cancelled.id);
        if (terminalInteraction) {
          await enqueueTerminalIssueInteractionChatPublications(tx as unknown as Db, terminalInteraction);
        }

        const pendingInteraction = await tx.select({ id: issueThreadInteractions.id })
          .from(issueThreadInteractions).where(and(
            eq(issueThreadInteractions.companyId, issue.companyId),
            eq(issueThreadInteractions.issueId, issue.id),
            eq(issueThreadInteractions.status, "pending"),
          )).limit(1);
        const pendingApproval = await tx.select({ id: approvals.id }).from(issueApprovals)
          .innerJoin(approvals, and(eq(approvals.id, issueApprovals.approvalId),
            eq(approvals.companyId, issue.companyId)))
          .where(and(eq(issueApprovals.companyId, issue.companyId), eq(issueApprovals.issueId, issue.id),
            inArray(approvals.status, ["pending", "revision_requested"]))).limit(1);
        const restoreStatus = issue.status === "in_review"
          && issue.lastStatusDecisionId === decision.id
          && issue.statusVersion === Number(decision.decisionJson.projectedStatusVersion ?? decision.decisionVersion)
          && ["backlog", "todo", "in_progress", "blocked"].includes(decision.fromStatus)
          && pendingInteraction.length === 0 && pendingApproval.length === 0
          && issue.executionState?.status !== "pending";
        if (restoreStatus) {
          const priorDecision = priorDecisionId ? await tx.select().from(statusDecisions).where(and(
            eq(statusDecisions.id, priorDecisionId), eq(statusDecisions.companyId, issue.companyId),
            eq(statusDecisions.issueId, issue.id),
          )).then((rows) => rows[0]) : null;
          await issueService(tx as unknown as Db).update(issue.id, {
            status: decision.fromStatus,
            // This is an administrative correction, not a replay of the old decision.
            lastStatusDecisionId: null,
            unblockDescriptor: priorDecision?.decisionJson.unblockDescriptor as typeof issue.unblockDescriptor ?? null,
          }, tx, publications);
        }
        const { publication } = await persistActivity(tx as unknown as Db, {
          companyId: issue.companyId,
          actorType: "system",
          actorId: "native-policy-review-cleanup",
          action: restoreStatus ? "issue.updated" : "issue.interaction_cancelled",
          entityType: "issue",
          entityId: issue.id,
          issueId: issue.id,
          runId: decision.runId,
          details: {
            source: "obsolete_native_policy_review",
            interactionId: interaction.id,
            decisionId: decision.id,
            fromStatus: issue.status,
            toStatus: restoreStatus ? decision.fromStatus : issue.status,
          },
        });
        publications.push(publication);
      });
    } catch (err) {
      logger.warn({ err, interactionId: interaction.id, issueId: decision.issueId },
        "Failed to withdraw obsolete native policy review; will retry on the next pass");
      continue;
    }
    for (const publication of publications) {
      try {
        publishActivity(publication);
      } catch (err) {
        logger.warn({ err, interactionId: interaction.id, issueId: decision.issueId },
          "Obsolete native policy review cleanup committed; live activity publication failed, history is preserved");
      }
    }
  }
}
