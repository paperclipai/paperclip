import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  completionContracts,
  heartbeatRuns,
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
import { classifyNativeInfrastructureRecovery } from "./native-infrastructure-recovery.js";
import type { NativeEvidenceAssessment } from "./evidence-classifier.js";
import type { NativeInfrastructureRecoveryClassification } from "./native-infrastructure-recovery.js";

const withdrawalReason = "automatic_completion_review_removed";
const automaticPrompt =
  "Review the persisted native-run evidence and confirm whether this issue may be completed.";
const infrastructureRecoveryWithdrawalReason =
  "native_infrastructure_recovery_authorized";

type NativeInfrastructureRecoveryAssessment = Pick<
  NativeEvidenceAssessment,
  | "attentionRequests"
  | "verificationAssessments"
  | "hasFailedVerification"
  | "acceptedEvidenceRefs"
>;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function isAttentionRequest(value: unknown): value is NativeEvidenceAssessment["attentionRequests"][number] {
  const candidate = record(value);
  return (
    typeof candidate.kind === "string" &&
    typeof candidate.summary === "string" &&
    typeof candidate.ownerClass === "string" &&
    typeof candidate.sourceKind === "string" &&
    Number.isInteger(candidate.sourceIndex) &&
    Number(candidate.sourceIndex) >= 0
  );
}

function isVerificationAssessment(
  value: unknown,
): value is NativeEvidenceAssessment["verificationAssessments"][number] {
  const candidate = record(value);
  return (
    typeof candidate.commandOrCheck === "string" &&
    ["passed", "failed", "not_run"].includes(String(candidate.claimStatus)) &&
    typeof candidate.reasonCode === "string" &&
    (candidate.reportedReasonCode === null ||
      typeof candidate.reportedReasonCode === "string")
  );
}

/** Read only the structured fields needed for the server-owned recovery rule. */
function readNativeInfrastructureRecoveryAssessment(
  value: unknown,
): NativeInfrastructureRecoveryAssessment | null {
  const candidate = record(value);
  if (!Array.isArray(candidate.attentionRequests) ||
      !Array.isArray(candidate.verificationAssessments) ||
      !Array.isArray(candidate.acceptedEvidenceRefs) ||
      !candidate.attentionRequests.every(isAttentionRequest) ||
      !candidate.verificationAssessments.every(isVerificationAssessment) ||
      !candidate.acceptedEvidenceRefs.every((entry) => typeof entry === "string")) {
    return null;
  }
  return {
    attentionRequests: candidate.attentionRequests,
    verificationAssessments: candidate.verificationAssessments,
    hasFailedVerification:
      candidate.hasFailedVerification === true ||
      candidate.verificationAssessments.some(
        (entry) => entry.claimStatus === "failed",
      ),
    acceptedEvidenceRefs: candidate.acceptedEvidenceRefs,
  };
}

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

/**
 * Retire only an already-materialized, system-created Runner review whose
 * persisted evidence now matches the ratified canary recovery policy. This is
 * deliberately separate from the generic completion-review cleanup so that a
 * human-created review can never be withdrawn by this recovery path.
 */
export async function dismissAuthorizedNativeInfrastructureRecoveryReviews(
  db: Db,
  issueId?: string,
) {
  const candidates = await db
    .select({
      interaction: issueThreadInteractions,
      decision: statusDecisions,
    })
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
      issues,
      and(
        eq(issues.id, issueThreadInteractions.issueId),
        eq(issues.companyId, issueThreadInteractions.companyId),
      ),
    )
    .innerJoin(
      heartbeatRuns,
      and(
        eq(heartbeatRuns.id, statusDecisions.runId),
        eq(heartbeatRuns.companyId, statusDecisions.companyId),
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
        eq(statusDecisions.reasonCode, "actionable_attention_pending"),
        eq(heartbeatRuns.runtimeMode, "native"),
        sql`${issueThreadInteractions.payload}->'target'->>'key' = 'native_completion_review'`,
        sql`${issueThreadInteractions.payload}->'target'->>'revisionId' = ${statusDecisions.id}::text`,
        ...(issueId ? [eq(issueThreadInteractions.issueId, issueId)] : []),
      ),
    )
    .limit(100)
    .catch((err) => {
      logger.warn(
        { err },
        "Native infrastructure recovery review lookup failed; will retry",
      );
      return [];
    });

  for (const { interaction, decision } of candidates) {
    const publications: ActivityPublication[] = [];
    let recovery: Extract<
      NativeInfrastructureRecoveryClassification,
      { authorized: true }
    > | null = null;
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
        const [run] = await tx
          .select()
          .from(heartbeatRuns)
          .where(
            and(
              eq(heartbeatRuns.id, decision.runId),
              eq(heartbeatRuns.companyId, decision.companyId),
              eq(heartbeatRuns.nativeIssueId, issue.id),
            ),
          )
          .for("update");
        const [assessmentRow] = await tx
          .select()
          .from(workAssessments)
          .where(
            and(
              eq(workAssessments.id, decision.assessmentId),
              eq(workAssessments.companyId, decision.companyId),
              eq(workAssessments.issueId, issue.id),
              eq(workAssessments.runId, decision.runId),
            ),
          )
          .for("update");
        if (!run || !assessmentRow || run.runtimeMode !== "native") return;
        const assessment = readNativeInfrastructureRecoveryAssessment(
          assessmentRow.assessmentJson,
        );
        if (!assessment) return;
        const classification = classifyNativeInfrastructureRecovery({
          executionPolicy: issue.executionPolicy,
          runtimeMode: "native",
          governanceGate: null,
          assessment,
          attempt: run.continuationAttempt,
        });
        if (!classification.authorized) return;
        recovery = classification;
        const now = new Date();
        const [retired] = await tx
          .update(issueThreadInteractions)
          .set({
            status: "cancelled",
            result: {
              version: 1,
              outcome: "withdrawn",
              reason: infrastructureRecoveryWithdrawalReason,
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
          actorId: "native-infrastructure-recovery-cleanup",
          action: "issue.interaction_cancelled",
          entityType: "issue",
          entityId: issue.id,
          issueId: issue.id,
          runId: decision.runId,
          details: {
            source: infrastructureRecoveryWithdrawalReason,
            interactionId: retired.id,
            decisionId: decision.id,
            recoveryFingerprint: recovery.fingerprint,
            recoveryCause: recovery.cause,
            recoveryAttempt: recovery.attempt,
            recoveryMaxAttempts: recovery.maxAttempts,
            recoveryExhausted: recovery.exhausted,
          },
        });
        publications.push(publication);
      });
      for (const publication of publications) publishActivity(publication);
    } catch (err) {
      logger.warn(
        { err, interactionId: interaction.id },
        "Native infrastructure recovery review cleanup failed; will retry",
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
        sql`(${issueThreadInteractions.result}->>'reason' = ${withdrawalReason}
          or ${issueThreadInteractions.result}->>'reason' = ${infrastructureRecoveryWithdrawalReason})`,
        sql`(${issueThreadInteractions.payload}->'target'->>'revisionId' = ${decision.id}::text
      or ${ids.length ? inArray(issueThreadInteractions.id, ids) : sql`false`})`,
      ),
    )
    .limit(1);
  return rows.length > 0;
}
