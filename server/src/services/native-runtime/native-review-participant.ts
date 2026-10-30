import {
  agents,
  heartbeatRuns,
  issueThreadInteractions,
  issues,
  statusDecisions,
  type Db,
} from "@paperclipai/db";
import { and, eq, isNull, or } from "drizzle-orm";
import { evaluateAgentInvokabilityFromDb } from "../agent-invokability.js";
import { canonicalizeStoredResolverPolicy } from "../issue-thread-interaction-resolution.js";

export type NativeReviewAssignmentContext = {
  nativeReviewInteractionId: string;
  nativeReviewDecisionId: string;
};

type ReviewPayload = {
  version?: number;
  prompt?: string;
  target?: { type?: string; key?: string; revisionId?: string } | null;
  toolAction?: unknown;
  secretProposal?: unknown;
};
type InteractionFacts = Pick<typeof issueThreadInteractions.$inferSelect,
  "id" | "companyId" | "issueId" | "kind" | "status" | "sourceRunId" | "addresseeAgentId" |
  "addresseeUserId" | "effectiveResolverPolicy" | "resolverPolicyProvenance" |
  "resolvedByAgentId" | "resolvedByRunId"> & { payload: ReviewPayload };
type DecisionFacts = Pick<typeof statusDecisions.$inferSelect,
  "id" | "companyId" | "issueId" | "runId" | "decisionJson" | "applicationState">;
type SourceRunFacts = Pick<typeof heartbeatRuns.$inferSelect,
  "id" | "companyId" | "agentId" | "nativeIssueId">;

export type NativeReviewAssignmentFacts = {
  companyId: string;
  issueId: string;
  agentId: string;
  issueStatus: string;
  issueStatusVersion: number;
  issueLastStatusDecisionId: string | null;
  issueAssigneeAgentId: string | null;
  issueExecutionRunId?: string | null;
  interaction: InteractionFacts;
  decision: DecisionFacts;
  sourceRun: SourceRunFacts;
  agentInvokable: boolean;
  actingRun?: {
    id: string;
    companyId: string;
    agentId: string;
    status: string;
    nativeIssueId: string | null;
    contextSnapshot: Record<string, unknown> | null;
  };
  allowResolvedByRunId?: string;
};

export type NativeReviewAssignment = {
  interaction: typeof issueThreadInteractions.$inferSelect;
  sourceDecision: typeof statusDecisions.$inferSelect;
  sourceRun: typeof heartbeatRuns.$inferSelect;
};

export function readNativeReviewAssignmentContext(
  snapshot: unknown,
): NativeReviewAssignmentContext | null {
  if (!snapshot || typeof snapshot !== "object") return null;
  const value = snapshot as Record<string, unknown>;
  const interactionId = value.nativeReviewInteractionId;
  const decisionId = value.nativeReviewDecisionId;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (typeof interactionId !== "string" || !uuid.test(interactionId)) return null;
  if (typeof decisionId !== "string" || !uuid.test(decisionId)) return null;
  return { nativeReviewInteractionId: interactionId, nativeReviewDecisionId: decisionId };
}

function isNativeCompletionReview(interaction: InteractionFacts, decisionId: string) {
  const target = interaction.payload?.target;
  return target?.type === "custom"
    && target.key === "native_completion_review"
    && target.revisionId === decisionId;
}

export function validateNativeReviewAssignmentFacts(input: NativeReviewAssignmentFacts): boolean {
  const { interaction, decision, sourceRun } = input;
  if (!input.agentInvokable) return false;
  if (input.issueAssigneeAgentId !== sourceRun?.agentId) return false;
  if (sourceRun?.agentId === input.agentId) return false;
  if (!interaction || interaction.companyId !== input.companyId || interaction.issueId !== input.issueId) return false;
  if (!decision || decision.companyId !== input.companyId || decision.issueId !== input.issueId) return false;
  if (decision.applicationState !== "applied") return false;
  if (!sourceRun || sourceRun.companyId !== input.companyId || sourceRun.nativeIssueId !== input.issueId) return false;
  if (interaction.kind !== "request_confirmation") return false;
  if (interaction.sourceRunId !== decision.runId || interaction.sourceRunId !== sourceRun.id) return false;
  if (interaction.addresseeAgentId !== input.agentId) return false;
  if (interaction.addresseeUserId) return false;
  if (interaction.payload?.toolAction || interaction.payload?.secretProposal) return false;
  if (!isNativeCompletionReview(interaction, decision.id)) return false;

  if (input.actingRun) {
    const actingContext = readNativeReviewAssignmentContext(
      input.actingRun.contextSnapshot,
    );
    if (
      input.actingRun.id.length === 0 ||
      input.actingRun.companyId !== input.companyId ||
      input.actingRun.agentId !== input.agentId ||
      input.actingRun.status !== "running" ||
      input.actingRun.nativeIssueId !== input.issueId ||
      (input.issueExecutionRunId !== undefined &&
        input.issueExecutionRunId !== input.actingRun.id) ||
      !actingContext ||
      actingContext.nativeReviewInteractionId !== interaction.id ||
      actingContext.nativeReviewDecisionId !== decision.id
    ) return false;
    const context = input.actingRun.contextSnapshot ?? {};
    if (context.issueId !== undefined && context.issueId !== input.issueId)
      return false;
    if (context.sourceRunId !== undefined && context.sourceRunId !== sourceRun.id)
      return false;
    if (context.revisionId !== undefined && context.revisionId !== decision.id)
      return false;
  }

  const policy = canonicalizeStoredResolverPolicy(
    interaction.effectiveResolverPolicy,
    interaction.resolverPolicyProvenance,
  );
  if (policy === "human_only") return false;
  if (interaction.status === "pending") {
    if (input.issueStatus !== "in_review") return false;
    if (input.issueLastStatusDecisionId !== decision.id) return false;
    const projected = Number(decision.decisionJson?.projectedStatusVersion);
    return Number.isFinite(projected) && input.issueStatusVersion === projected;
  }
  return (interaction.status === "accepted" || interaction.status === "rejected")
    && typeof input.allowResolvedByRunId === "string"
    && interaction.resolvedByRunId === input.allowResolvedByRunId
    && interaction.resolvedByAgentId === input.agentId;
}

export async function getNativeReviewAssignment(
  db: Db,
  input: {
    companyId: string;
    issueId: string;
    agentId: string;
    contextSnapshot: unknown;
    actingRunId?: string;
    issueExecutionRunId?: string | null;
    allowResolvedByRunId?: string;
  },
): Promise<NativeReviewAssignment | null> {
  const context = readNativeReviewAssignmentContext(input.contextSnapshot);
  if (!context) return null;
  const issue = await db.select().from(issues).where(and(
    eq(issues.companyId, input.companyId), eq(issues.id, input.issueId),
  )).limit(1).then((rows) => rows[0] ?? null);
  const agent = await db.select().from(agents).where(and(
    eq(agents.companyId, input.companyId), eq(agents.id, input.agentId),
  )).limit(1).then((rows) => rows[0] ?? null);
  if (!issue || !agent) return null;
  const interaction = await db.select().from(issueThreadInteractions).where(and(
    eq(issueThreadInteractions.id, context.nativeReviewInteractionId),
    eq(issueThreadInteractions.companyId, input.companyId),
    eq(issueThreadInteractions.issueId, input.issueId),
  )).limit(1).then((rows) => rows[0] ?? null);
  const decision = await db.select().from(statusDecisions).where(and(
    eq(statusDecisions.id, context.nativeReviewDecisionId),
    eq(statusDecisions.companyId, input.companyId),
    eq(statusDecisions.issueId, input.issueId),
  )).limit(1).then((rows) => rows[0] ?? null);
  if (!interaction || !decision) return null;
  const sourceRun = await db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.id, decision.runId),
    eq(heartbeatRuns.companyId, input.companyId),
    eq(heartbeatRuns.agentId, issue.assigneeAgentId ?? "00000000-0000-0000-0000-000000000000"),
    eq(heartbeatRuns.nativeIssueId, input.issueId),
  )).limit(1).then((rows) => rows[0] ?? null);
  if (!sourceRun) return null;
  const actingRun = input.actingRunId
    ? await db.select().from(heartbeatRuns).where(and(
        eq(heartbeatRuns.id, input.actingRunId),
        eq(heartbeatRuns.companyId, input.companyId),
        eq(heartbeatRuns.agentId, input.agentId),
      )).limit(1).then((rows) => rows[0] ?? null)
    : undefined;
  if (input.actingRunId && !actingRun) return null;
  const invokability = await evaluateAgentInvokabilityFromDb(db, agent);
  const valid = validateNativeReviewAssignmentFacts({
    companyId: input.companyId,
    issueId: input.issueId,
    agentId: input.agentId,
    issueStatus: issue.status,
    issueStatusVersion: Number(issue.statusVersion),
    issueLastStatusDecisionId: issue.lastStatusDecisionId,
    issueAssigneeAgentId: issue.assigneeAgentId,
    interaction: interaction as InteractionFacts,
    decision,
    sourceRun,
    agentInvokable: invokability.invokable,
    actingRun: actingRun
      ? {
          id: actingRun.id,
          companyId: actingRun.companyId,
          agentId: actingRun.agentId,
          status: actingRun.status,
          nativeIssueId: actingRun.nativeIssueId,
          contextSnapshot: actingRun.contextSnapshot,
        }
      : undefined,
    issueExecutionRunId: input.issueExecutionRunId,
    allowResolvedByRunId: input.allowResolvedByRunId,
  });
  return valid ? { interaction, sourceDecision: decision, sourceRun } : null;
}


/** Claim the normal issue execution lock without changing the worker assignee. */
export async function claimNativeReviewExecutionLock(db: Db, input: {
  companyId: string;
  issueId: string;
  agentId: string;
  runId: string;
  contextSnapshot: unknown;
  agentNameKey: string | null;
  claimedAt: Date;
}): Promise<boolean> {
  return db.transaction(async (tx) => {
    const issue = await tx.select({ id: issues.id }).from(issues).where(and(
      eq(issues.id, input.issueId), eq(issues.companyId, input.companyId),
    )).for("update").limit(1).then((rows) => rows[0]);
    if (!issue || !await getNativeReviewAssignment(tx as unknown as Db, input)) return false;
    const run = await tx.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId),
      eq(heartbeatRuns.agentId, input.agentId),
    )).limit(1).then((rows) => rows[0]);
    const admitted = readNativeReviewAssignmentContext(run?.contextSnapshot);
    const expected = readNativeReviewAssignmentContext(input.contextSnapshot);
    if (!run || !["queued", "running"].includes(run.status) || !admitted || !expected
      || admitted.nativeReviewInteractionId !== expected.nativeReviewInteractionId
      || admitted.nativeReviewDecisionId !== expected.nativeReviewDecisionId) return false;
    const claimed = await tx.update(issues).set({
      executionRunId: input.runId,
      executionAgentNameKey: input.agentNameKey,
      executionLockedAt: input.claimedAt,
      updatedAt: input.claimedAt,
    }).where(and(
      eq(issues.id, input.issueId), eq(issues.companyId, input.companyId),
      or(isNull(issues.executionRunId), eq(issues.executionRunId, input.runId)),
    )).returning({ id: issues.id });
    return claimed.length === 1;
  });
}
