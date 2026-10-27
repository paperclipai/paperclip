import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { completionContracts, heartbeatRuns, issues, issueThreadInteractions, statusDecisionEffects, statusDecisions, workAssessments, type Db } from "@paperclipai/db";
import { hasPublishedGitHubReview } from "../chat-channels/github/review-wait.js";
import { issueThreadInteractionService } from "../issue-thread-interactions.js";
import { enqueueTerminalIssueInteractionChatPublications } from "../chat-interaction-publications.js";
import { persistActivity, type ActivityPublication } from "../activity-log.js";

type ReviewBinding = {
  companyId: string; issueId: string; runId: string; agentId: string;
};

/** Read-only: a proposed finish report must never withdraw a pending card. */
export async function findSupersededExternalReviewRequests(db: Db, binding: ReviewBinding) {
  if (!await hasPublishedGitHubReview(db, binding)) return [];
  const [current] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
    .innerJoin(completionContracts, and(eq(completionContracts.id, heartbeatRuns.completionContractId),
      eq(completionContracts.companyId, binding.companyId), eq(completionContracts.issueId, binding.issueId),
      eq(completionContracts.risk, "low"), eq(completionContracts.completionAuthority, "agent_claim_policy")))
    .where(and(eq(heartbeatRuns.id, binding.runId), eq(heartbeatRuns.companyId, binding.companyId),
      eq(heartbeatRuns.nativeIssueId, binding.issueId), eq(heartbeatRuns.agentId, binding.agentId)));
  if (!current) return [];
  const candidates = await db.select({ interaction: issueThreadInteractions })
    .from(issueThreadInteractions)
    .innerJoin(heartbeatRuns, and(
      eq(heartbeatRuns.id, issueThreadInteractions.sourceRunId),
      eq(heartbeatRuns.companyId, binding.companyId),
      eq(heartbeatRuns.nativeIssueId, binding.issueId),
      eq(heartbeatRuns.agentId, binding.agentId),
    ))
    .innerJoin(issues, and(eq(issues.id, binding.issueId), eq(issues.companyId, binding.companyId),
      eq(issues.assigneeAgentId, binding.agentId), eq(issues.executionRunId, binding.runId)))
    .innerJoin(statusDecisionEffects, and(
      eq(statusDecisionEffects.companyId, binding.companyId), eq(statusDecisionEffects.issueId, binding.issueId),
      eq(statusDecisionEffects.effectKind, "bind_reviewer"), eq(statusDecisionEffects.targetType, "issue_thread_interaction"),
      sql`${statusDecisionEffects.targetId} = ${issueThreadInteractions.id}::text`))
    .innerJoin(statusDecisions, and(eq(statusDecisions.id, statusDecisionEffects.decisionId),
      eq(statusDecisions.companyId, binding.companyId), eq(statusDecisions.issueId, binding.issueId),
      eq(statusDecisions.runId, issueThreadInteractions.sourceRunId), eq(statusDecisions.applicationState, "applied"),
      eq(statusDecisions.reasonCode, "actionable_attention_pending")))
    .innerJoin(workAssessments, and(eq(workAssessments.id, statusDecisions.assessmentId),
      eq(workAssessments.companyId, binding.companyId), eq(workAssessments.issueId, binding.issueId)))
    .innerJoin(completionContracts, and(eq(completionContracts.id, workAssessments.contractId),
      eq(completionContracts.companyId, binding.companyId), eq(completionContracts.issueId, binding.issueId),
      eq(completionContracts.risk, "low"), eq(completionContracts.completionAuthority, "agent_claim_policy")))
    .where(and(
      eq(issueThreadInteractions.companyId, binding.companyId), eq(issueThreadInteractions.issueId, binding.issueId),
      eq(issueThreadInteractions.status, "pending"), eq(issueThreadInteractions.kind, "request_confirmation"),
      ne(issueThreadInteractions.sourceRunId, binding.runId),
      isNull(issueThreadInteractions.createdByAgentId), isNull(issueThreadInteractions.createdByUserId),
      isNull(issueThreadInteractions.addresseeAgentId), eq(issueThreadInteractions.effectiveResolverPolicy, "human_only"),
      sql`exists (select 1 from jsonb_array_elements(${statusDecisions.decisionJson}->'effects') effect
        where effect->>'kind' = 'bind_reviewer'
        and ${issueThreadInteractions.idempotencyKey} = 'native-review:' || ${statusDecisions.id}::text || coalesce(':' || (effect->>'requestKey'), '')
        and ${issueThreadInteractions.payload}->>'prompt' = effect->>'prompt')`,
      sql`${issueThreadInteractions.payload}->'target'->>'key' = 'native_completion_review'`,
      sql`${issueThreadInteractions.payload}->'target'->>'revisionId' = ${statusDecisions.id}::text`,
      sql`not (${issueThreadInteractions.payload} ? 'toolAction')`,
    ));
  const verified: typeof candidates = [];
  for (const { interaction } of candidates) {
    if (!await hasPublishedGitHubReview(db, { ...binding, runId: interaction.sourceRunId! })) continue;
    verified.push({ interaction });
  }
  return verified;
}

/** Caller holds the issue lock and commits these rows with the new status decision. */
export async function supersedeExternalReviewRequestsInTransaction(
  tx: Db, binding: ReviewBinding, candidates: Awaited<ReturnType<typeof findSupersededExternalReviewRequests>>,
  publications: ActivityPublication[],
) {
  for (const { interaction } of candidates) {
    const reason = "A later published review no longer requests human input.";
    const [retired] = await tx.update(issueThreadInteractions).set({ status: "cancelled",
      result: { version: 1, outcome: "withdrawn", reason }, resolvedAt: new Date(), updatedAt: new Date(),
      resolvedByAgentId: binding.agentId, resolvedByRunId: binding.runId,
    }).where(and(eq(issueThreadInteractions.id, interaction.id), eq(issueThreadInteractions.companyId, binding.companyId),
      eq(issueThreadInteractions.status, "pending"), eq(issueThreadInteractions.payload, interaction.payload))).returning();
    if (!retired) throw new Error("external_review_request_changed");
    const projected = await issueThreadInteractionService(tx).getById(retired.id);
    if (projected) await enqueueTerminalIssueInteractionChatPublications(tx, projected);
    const { publication } = await persistActivity(tx, { companyId: binding.companyId,
      actorType: "system", actorId: "native-status-committer", runId: binding.runId,
      action: "issue.interaction.withdrawn", entityType: "issue", entityId: binding.issueId, issueId: binding.issueId,
      details: { interactionId: interaction.id, reason },
    });
    publications.push(publication);
  }
}
