import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  completionContracts,
  issueThreadInteractions,
  issues,
  nativeRunFinalizations,
  statusDecisionEffects,
  statusDecisions,
  workAssessments,
  type Db,
} from "@paperclipai/db";
import {
  persistActivity,
  publishActivity,
  type ActivityPublication,
} from "../activity-log.js";
import { enqueueTerminalIssueInteractionChatPublications } from "../chat-interaction-publications.js";
import { issueThreadInteractionService } from "../issue-thread-interactions.js";
import { logger } from "../../middleware/logger.js";

const withdrawalReason = "automatic_completion_review_removed";
const automaticPrompt =
  "Review the persisted native-run evidence and confirm whether this issue may be completed.";

/** Identify only proven system fallback cards; this lookup never changes state. */
export async function findAutomaticCompletionReviews(db: Db, issueId?: string) {
  return db
    .select({ interaction: issueThreadInteractions, decision: statusDecisions })
    .from(issueThreadInteractions)
    .innerJoin(
      statusDecisionEffects,
      and(
        eq(statusDecisionEffects.companyId, issueThreadInteractions.companyId),
        eq(statusDecisionEffects.issueId, issueThreadInteractions.issueId),
        sql`${statusDecisionEffects.targetId} = ${issueThreadInteractions.id}::text`,
        eq(statusDecisionEffects.targetType, "issue_thread_interaction"),
        eq(statusDecisionEffects.effectKind, "bind_reviewer"),
      ),
    )
    .innerJoin(
      statusDecisions,
      and(
        eq(statusDecisions.id, statusDecisionEffects.decisionId),
        eq(statusDecisions.companyId, issueThreadInteractions.companyId),
        eq(statusDecisions.issueId, issueThreadInteractions.issueId),
        eq(statusDecisions.runId, issueThreadInteractions.sourceRunId),
      ),
    )
    .innerJoin(
      workAssessments,
      and(
        eq(workAssessments.id, statusDecisions.assessmentId),
        eq(workAssessments.companyId, statusDecisions.companyId),
        eq(workAssessments.issueId, statusDecisions.issueId),
      ),
    )
    .innerJoin(
      completionContracts,
      and(
        eq(completionContracts.id, workAssessments.contractId),
        eq(completionContracts.companyId, workAssessments.companyId),
        eq(completionContracts.issueId, workAssessments.issueId),
      ),
    )
    .where(
      and(
        eq(issueThreadInteractions.status, "pending"),
        eq(issueThreadInteractions.kind, "request_confirmation"),
        isNull(issueThreadInteractions.createdByAgentId),
        isNull(issueThreadInteractions.createdByUserId),
        eq(statusDecisions.applicationState, "applied"),
        eq(statusDecisions.toStatus, "in_review"),
        inArray(statusDecisions.reasonCode, [
          "completion_claim_incomplete",
          "completion_claim_conflict",
          "external_verification_required",
        ]),
        eq(completionContracts.risk, "low"),
        eq(completionContracts.completionAuthority, "agent_claim_policy"),
        sql`${workAssessments.assessmentJson}->'attentionRequests' = '[]'::jsonb`,
        sql`${issueThreadInteractions.idempotencyKey} = 'native-review:' || ${statusDecisions.id}::text`,
        sql`${issueThreadInteractions.payload}->'target'->>'key' = 'native_completion_review'`,
        sql`${issueThreadInteractions.payload}->'target'->>'revisionId' = ${statusDecisions.id}::text`,
        sql`split_part(${issueThreadInteractions.payload}->>'prompt', E'\n', 1) = ${automaticPrompt}`,
        ...(issueId ? [eq(issueThreadInteractions.issueId, issueId)] : []),
      ),
    )
    .limit(100)
    .catch((err) => {
      logger.warn(
        { err },
        "Automatic completion review lookup failed; will retry",
      );
      return [];
    });
}

/** Narrow, replay-safe retirement. Explicit requests and answered cards are immutable here. */
export async function dismissAutomaticCompletionReviews(
  db: Db,
  issueId?: string,
) {
  const candidates = await findAutomaticCompletionReviews(db, issueId);
  for (const { interaction, decision } of candidates) {
    const publications: ActivityPublication[] = [];
    try {
      await db.transaction(async (tx) => {
        await tx
          .select()
          .from(nativeRunFinalizations)
          .where(
            and(
              eq(nativeRunFinalizations.runId, decision.runId),
              eq(nativeRunFinalizations.companyId, decision.companyId),
            ),
          )
          .for("update");
        const [issue] = await tx
          .select()
          .from(issues)
          .where(
            and(
              eq(issues.id, decision.issueId),
              eq(issues.companyId, decision.companyId),
            ),
          )
          .for("update");
        if (!issue) return;
        const now = new Date();
        const [retired] = await tx
          .update(issueThreadInteractions)
          .set({
            status: "cancelled",
            result: {
              version: 1,
              outcome: "withdrawn",
              reason: withdrawalReason,
            },
            resolvedAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(issueThreadInteractions.id, interaction.id),
              eq(issueThreadInteractions.companyId, issue.companyId),
              eq(issueThreadInteractions.status, "pending"),
              eq(issueThreadInteractions.payload, interaction.payload),
            ),
          )
          .returning();
        if (!retired) return;
        const projected = await issueThreadInteractionService(
          tx as unknown as Db,
        ).getById(retired.id);
        if (projected)
          await enqueueTerminalIssueInteractionChatPublications(
            tx as unknown as Db,
            projected,
          );
        const { publication } = await persistActivity(tx as unknown as Db, {
          companyId: issue.companyId,
          actorType: "system",
          actorId: "native-completion-review-cleanup",
          action: "issue.interaction_cancelled",
          entityType: "issue",
          entityId: issue.id,
          issueId: issue.id,
          runId: decision.runId,
          details: {
            source: withdrawalReason,
            interactionId: retired.id,
            decisionId: decision.id,
          },
        });
        publications.push(publication);
      });
      for (const publication of publications) publishActivity(publication);
    } catch (err) {
      logger.warn(
        { err, interactionId: interaction.id },
        "Automatic completion review cleanup failed; will retry",
      );
    }
  }
}

/** A durable trigger survives a restart between withdrawing a card and reassessment. */
export async function decisionHasRetiredAutomaticReview(
  db: Db,
  decision: typeof statusDecisions.$inferSelect,
) {
  const effects = decision.decisionJson.effects as
    Array<{ kind: string; gate?: { kind: string; id: string } }> | undefined;
  const ids =
    effects?.flatMap((effect) =>
      effect.gate?.kind === "interaction" ? [effect.gate.id] : [],
    ) ?? [];
  const rows = await db
    .select({ id: issueThreadInteractions.id })
    .from(issueThreadInteractions)
    .where(
      and(
        eq(issueThreadInteractions.companyId, decision.companyId),
        eq(issueThreadInteractions.issueId, decision.issueId),
        eq(issueThreadInteractions.status, "cancelled"),
        sql`${issueThreadInteractions.result}->>'reason' = ${withdrawalReason}`,
        sql`(${issueThreadInteractions.payload}->'target'->>'revisionId' = ${decision.id}::text
      or ${ids.length ? inArray(issueThreadInteractions.id, ids) : sql`false`})`,
      ),
    )
    .limit(1);
  return rows.length > 0;
}
