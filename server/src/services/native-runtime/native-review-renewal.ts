import { and, asc, eq, sql } from "drizzle-orm";
import { heartbeatRuns, issueThreadInteractions, issues, statusDecisionEffects, statusDecisions, type Db } from "@paperclipai/db";
import { notifyAttentionRetentionWork } from "../retention-work-notifications.js";
import { enqueueTerminalIssueInteractionChatPublications } from "../chat-interaction-publications.js";
import { issueThreadInteractionService } from "../issue-thread-interactions.js";
import { persistActivity, type ActivityPublication } from "../activity-log.js";
import type { NativeStatusDecision, NativeStatusEffect } from "./status-arbiter.js";

export async function hasPendingNativeReviewSiblings(db: Db, input: {
  companyId: string; issueId: string; interactionId: string; agentId: string;
}) {
  const [row] = await db.select({ interaction: issueThreadInteractions }).from(issueThreadInteractions)
    .innerJoin(issues, and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId), eq(issues.assigneeAgentId, input.agentId)))
    .where(and(
    eq(issueThreadInteractions.id, input.interactionId), eq(issueThreadInteractions.companyId, input.companyId),
    eq(issueThreadInteractions.issueId, input.issueId), eq(issueThreadInteractions.status, "accepted"),
    sql`${issueThreadInteractions.payload}->'target'->>'key' = 'native_completion_review'`,
  ));
  const resolved = row?.interaction;
  const revision = (resolved?.payload as { target?: { revisionId?: string } } | undefined)?.target?.revisionId;
  if (!resolved?.sourceRunId || !revision) return false;
  const [pending] = await db.select({ id: issueThreadInteractions.id }).from(issueThreadInteractions).where(and(
    eq(issueThreadInteractions.companyId, input.companyId), eq(issueThreadInteractions.issueId, input.issueId),
    eq(issueThreadInteractions.sourceRunId, resolved.sourceRunId), eq(issueThreadInteractions.status, "pending"),
    sql`${issueThreadInteractions.payload}->'target'->>'key' = 'native_completion_review'`,
    sql`${issueThreadInteractions.payload}->'target'->>'revisionId' = ${revision}`,
  )).limit(1);
  return Boolean(pending);
}

export async function prepareNativeReviewRenewal(tx: Db, input: {
  companyId: string; issueId: string; runId: string; agentId: string | null;
  issueStatus: string; assigneeAgentId: string | null; responsibleUserId: string | null;
  decision: NativeStatusDecision;
}) {
  const effect = input.decision.effects.find(effect => effect.kind === "create_interaction" && effect.gate?.kind === "interaction");
  if (!effect || effect.kind !== "create_interaction" || !effect.gate || input.issueStatus !== "in_review" ||
      input.decision.statusAction !== "in_review" || !input.agentId || input.agentId !== input.assigneeAgentId) return null;
  const [gate] = await tx.select().from(issueThreadInteractions).where(and(
    eq(issueThreadInteractions.id, effect.gate.id), eq(issueThreadInteractions.companyId, input.companyId),
    eq(issueThreadInteractions.issueId, input.issueId), eq(issueThreadInteractions.status, "pending"),
    sql`${issueThreadInteractions.payload}->'target'->>'key' = 'native_completion_review'`,
  ));
  if (!gate || !gate.sourceRunId || gate.sourceRunId === input.runId) return null;
  const revisionId = (gate.payload as { target?: { revisionId?: string } }).target?.revisionId;
  const [source] = await tx.select({ id: statusDecisions.id }).from(statusDecisions)
    .innerJoin(heartbeatRuns, eq(heartbeatRuns.id, statusDecisions.runId)).where(and(
      sql`${statusDecisions.id}::text = ${revisionId ?? ""}`, eq(statusDecisions.companyId, input.companyId),
      eq(statusDecisions.issueId, input.issueId), eq(statusDecisions.applicationState, "applied"),
      eq(statusDecisions.runId, gate.sourceRunId), eq(heartbeatRuns.companyId, input.companyId),
      eq(heartbeatRuns.nativeIssueId, input.issueId), eq(heartbeatRuns.agentId, input.agentId),
    ));
  if (!source) return null;
  const rows = await tx.select({ interaction: issueThreadInteractions }).from(issueThreadInteractions)
    .innerJoin(statusDecisionEffects, and(eq(statusDecisionEffects.decisionId, source.id),
      eq(statusDecisionEffects.companyId, input.companyId), eq(statusDecisionEffects.issueId, input.issueId),
      eq(statusDecisionEffects.effectKind, "bind_reviewer"), eq(statusDecisionEffects.targetType, "issue_thread_interaction"),
      sql`${statusDecisionEffects.targetId} = ${issueThreadInteractions.id}::text`))
    .where(and(eq(issueThreadInteractions.companyId, input.companyId), eq(issueThreadInteractions.issueId, input.issueId),
      eq(issueThreadInteractions.sourceRunId, gate.sourceRunId), eq(issueThreadInteractions.kind, "request_confirmation"),
      sql`${issueThreadInteractions.payload}->'target'->>'key' = 'native_completion_review'`,
      sql`${issueThreadInteractions.payload}->'target'->>'revisionId' = ${source.id}::text`))
    .orderBy(asc(issueThreadInteractions.id)).for("update", { of: issueThreadInteractions });
  if (!rows.some(row => row.interaction.id === gate.id)) return null;
  const reviewers: NativeStatusEffect[] = rows.map(({ interaction }) => ({
    kind: "bind_reviewer", requestKey: `renew:${interaction.id}`,
    prompt: (interaction.payload as { prompt: string }).prompt,
    detailsMarkdown: (interaction.payload as { detailsMarkdown?: string | null }).detailsMarkdown,
    ownerAgentId: interaction.effectiveResolverPolicy === "human_only" ? null : interaction.addresseeAgentId,
    ownerUserId: interaction.addresseeUserId ?? (interaction.effectiveResolverPolicy === "human_only" ? input.responsibleUserId : null),
  }));
  return { interactions: rows.map(row => row.interaction), decision: { ...input.decision,
    effects: input.decision.effects.flatMap(candidate => candidate === effect ? reviewers :
      candidate.kind === "notify_owner" && candidate.reason === "governed_gate_pending" ? [] : [candidate]) } };
}

export async function retireRenewedNativeReviews(tx: Db, input: {
  companyId: string; issueId: string; runId: string;
  interactions: (typeof issueThreadInteractions.$inferSelect)[];
}, publications: ActivityPublication[]) {
  await notifyAttentionRetentionWork(tx, { companyId: input.companyId });
  for (const interaction of input.interactions) {
    if (interaction.status !== "pending") continue;
    const reason = "A later owner run requires a new completion review. Previous verdicts remain history.";
    const [retired] = await tx.update(issueThreadInteractions).set({ status: "cancelled", resolvedAt: new Date(), updatedAt: new Date(),
      resolvedByRunId: input.runId, result: { version: 1, outcome: "withdrawn", reason },
    }).where(and(eq(issueThreadInteractions.id, interaction.id), eq(issueThreadInteractions.companyId, input.companyId),
      eq(issueThreadInteractions.status, "pending"))).returning();
    if (!retired) throw new Error("native_review_renewal_race");
    const projected = await issueThreadInteractionService(tx).getById(retired.id);
    if (projected) await enqueueTerminalIssueInteractionChatPublications(tx, projected);
    const { publication } = await persistActivity(tx, { companyId: input.companyId, actorType: "system", actorId: "native-status-committer",
      runId: input.runId, action: "issue.interaction.withdrawn", entityType: "issue", entityId: input.issueId, issueId: input.issueId,
      details: { interactionId: interaction.id, reason } });
    publications.push(publication);
  }
}
