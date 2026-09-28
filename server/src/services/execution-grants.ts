import type { Db } from "@paperclipai/db";
import { agentConfigRevisions, agents, approvals, executionGrantPolicies, executionGrants, heartbeatRuns, issueApprovals, issues, issueThreadInteractions } from "@paperclipai/db";
import { executionGrantRequestPayloadSchema } from "@paperclipai/shared";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { conflict, forbidden, notFound } from "../errors.js";
import {
  executionGrantApprovalDetails,
  executionGrantDenial,
  executionGrantRequestHash,
  type ExecutionGrant,
  type ExecutionGrantAttempt,
} from "./execution-grant-contract.js";

function toContract(row: typeof executionGrants.$inferSelect): ExecutionGrant {
  return {
    companyId: row.companyId,
    issueId: row.issueId,
    proposerAgentId: row.proposerAgentId,
    executorAgentId: row.executorAgentId,
    targetAgentId: row.targetAgentId,
    operation: row.operation as ExecutionGrant["operation"],
    targetRevisionId: row.targetRevisionId,
    requestHash: row.requestHash,
    expiresAt: row.expiresAt,
    policyVersion: row.policyVersion,
    decision: row.decisionKind === "agent"
      ? { kind: "agent", decisionId: row.decisionId, approverAgentId: row.approverAgentId ?? "" }
      : { kind: "board", decisionId: row.decisionId, approverUserId: row.approverUserId ?? "" },
    consumedAt: row.consumedAt,
  };
}

export async function assertActiveExecutionGrantRun(input: {
  db: Db;
  companyId: string;
  executorAgentId: string;
  runId: string;
}) {
  const run = await input.db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.id, input.runId),
    eq(heartbeatRuns.companyId, input.companyId),
    eq(heartbeatRuns.agentId, input.executorAgentId),
    eq(heartbeatRuns.status, "running"),
  )).for("update").then((rows) => rows[0] ?? null);
  if (!run) throw forbidden("An active executor run is required", {
    code: "execution_grant_active_run_required",
  });
}

/** Materialize the immutable request that an agent or board already approved. */
export async function issueExecutionGrant(input: {
  db: Db;
  companyId: string;
  issueId: string;
  decisionKind: "agent" | "board";
  decisionId: string;
  executorAgentId: string;
}) {
  const policy = await input.db.select().from(executionGrantPolicies)
    .where(eq(executionGrantPolicies.companyId, input.companyId))
    .then((rows) => rows[0] ?? null);
  if (!policy) throw forbidden("Delegated authority policy is not configured", {
    code: "execution_grant_policy_missing",
  });
  const issue = await input.db.select({ id: issues.id })
    .from(issues)
    .where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)))
    .then((rows) => rows[0] ?? null);
  if (!issue) throw notFound("Issue not found");
  const priorGrant = await input.db.select({ consumedAt: executionGrants.consumedAt })
    .from(executionGrants).where(and(
      eq(executionGrants.companyId, input.companyId),
      eq(executionGrants.decisionKind, input.decisionKind),
      eq(executionGrants.decisionId, input.decisionId),
    )).then((rows) => rows[0] ?? null);
  if (priorGrant?.consumedAt) throw conflict("Decision grant was already consumed");

  let proposerAgentId: string | null = null;
  let approverAgentId: string | null = null;
  let approverUserId: string | null = null;
  let rawRequest: unknown = null;
  let displayedDetails: string | null = null;
  if (input.decisionKind === "agent") {
    const decision = await input.db.select().from(issueThreadInteractions).where(and(
      eq(issueThreadInteractions.id, input.decisionId),
      eq(issueThreadInteractions.companyId, input.companyId),
      eq(issueThreadInteractions.issueId, input.issueId),
      eq(issueThreadInteractions.kind, "request_confirmation"),
      eq(issueThreadInteractions.status, "accepted"),
    )).then((rows) => rows[0] ?? null);
    if (!decision || (decision.result as { outcome?: string } | null)?.outcome !== "accepted") {
      throw forbidden("An accepted agent decision is required", { code: "execution_grant_decision_required" });
    }
    proposerAgentId = decision.createdByAgentId;
    approverAgentId = decision.resolvedByAgentId;
    if (!approverAgentId || decision.addresseeAgentId !== approverAgentId ||
        approverAgentId !== policy.stewardAgentId) {
      throw forbidden("The named agent approver must resolve the decision", { code: "execution_grant_approver_mismatch" });
    }
    const payload = decision.payload as unknown as Record<string, unknown>;
    rawRequest = payload.executionGrant;
    displayedDetails = typeof payload.detailsMarkdown === "string" ? payload.detailsMarkdown : null;
  } else {
    const decision = await input.db.select().from(approvals).where(and(
      eq(approvals.id, input.decisionId),
      eq(approvals.companyId, input.companyId),
      eq(approvals.type, "request_board_approval"),
      eq(approvals.status, "approved"),
    )).then((rows) => rows[0] ?? null);
    const link = await input.db.select({ issueId: issueApprovals.issueId })
      .from(issueApprovals).where(and(
        eq(issueApprovals.companyId, input.companyId),
        eq(issueApprovals.issueId, input.issueId),
        eq(issueApprovals.approvalId, input.decisionId),
      )).then((rows) => rows[0] ?? null);
    if (!decision || !link || !decision.decidedByUserId) {
      throw forbidden("An approved board decision linked to this issue is required", {
        code: "execution_grant_decision_required",
      });
    }
    proposerAgentId = decision.requestedByAgentId;
    approverUserId = decision.decidedByUserId;
    rawRequest = decision.payload.executionGrant;
    displayedDetails = typeof decision.payload.detailsMarkdown === "string"
      ? decision.payload.detailsMarkdown : null;
  }

  const request = executionGrantRequestPayloadSchema.safeParse(rawRequest);
  if (!request.success) throw forbidden("Decision has no valid execution request", {
    code: "execution_grant_invalid_decision",
  });
  const proposed = request.data;
  const target = await input.db.select({ id: agents.id, updatedAt: agents.updatedAt })
    .from(agents).where(and(
      eq(agents.companyId, input.companyId),
      eq(agents.id, proposed.targetAgentId),
    )).then((rows) => rows[0] ?? null);
  const currentRevision = target ? await input.db.select({ id: agentConfigRevisions.id })
    .from(agentConfigRevisions).where(and(
      eq(agentConfigRevisions.companyId, input.companyId),
      eq(agentConfigRevisions.agentId, target.id),
    )).orderBy(desc(agentConfigRevisions.createdAt), desc(agentConfigRevisions.id))
      .limit(1).then((rows) => rows[0]?.id ?? null) : null;
  if (!target || !proposerAgentId ||
      proposed.executorAgentId !== input.executorAgentId ||
      proposerAgentId === proposed.executorAgentId ||
      proposed.targetAgentId === policy.stewardAgentId ||
      (input.decisionKind === "agent" &&
        (approverAgentId === proposerAgentId || approverAgentId === input.executorAgentId)) ||
      proposed.targetRevisionId !== currentRevision ||
      proposed.targetUpdatedAt !== target.updatedAt.toISOString() ||
      executionGrantRequestHash("PATCH", `/api/agents/${target.id}`,
        proposed.requestBody, proposed.targetUpdatedAt) !== proposed.requestHash ||
      displayedDetails !== executionGrantApprovalDetails(proposed) ||
      Date.parse(proposed.expiresAt) <= Date.now() ||
      proposed.policyVersion !== policy.version) {
    throw forbidden("Decision does not authorize the exact proposed execution grant", {
      code: "execution_grant_invalid_decision",
    });
  }

  const [inserted] = await input.db.insert(executionGrants).values({
    companyId: input.companyId,
    issueId: input.issueId,
    decisionKind: input.decisionKind,
    decisionId: input.decisionId,
    proposerAgentId,
    approverAgentId,
    approverUserId,
    executorAgentId: proposed.executorAgentId,
    targetAgentId: proposed.targetAgentId,
    operation: proposed.operation,
    targetRevisionId: proposed.targetRevisionId,
    requestHash: proposed.requestHash,
    expiresAt: new Date(proposed.expiresAt),
    policyVersion: proposed.policyVersion,
  }).onConflictDoNothing().returning();
  if (inserted) return { ...inserted, newlyIssued: true };
  const existing = await input.db.select().from(executionGrants).where(and(
    eq(executionGrants.companyId, input.companyId),
    eq(executionGrants.decisionKind, input.decisionKind),
    eq(executionGrants.decisionId, input.decisionId),
  )).then((rows) => rows[0] ?? null);
  if (!existing) return null;
  if (existing.consumedAt) throw conflict("Decision grant was already consumed");
  return { ...existing, newlyIssued: false };
}

/** The callback must perform the protected write through txDb, so a failure rolls back consumption. */
export async function withConsumedExecutionGrant<T>(input: {
  db: Db;
  grantId: string;
  attempt: Omit<ExecutionGrantAttempt, "targetRevisionId" | "now" | "decisionStewardAgentId" | "currentPolicyVersion">;
  requestBody?: unknown;
  runId: string;
  apply: (txDb: Db) => Promise<T>;
}): Promise<T> {
  return input.db.transaction(async (tx) => {
    const txDb = tx as unknown as Db;
    const target = await txDb.select({ id: agents.id, updatedAt: agents.updatedAt })
      .from(agents)
      .where(and(eq(agents.id, input.attempt.targetAgentId), eq(agents.companyId, input.attempt.companyId)))
      .for("update")
      .then((rows) => rows[0] ?? null);
    if (!target) throw notFound("Agent not found");

    const policy = await txDb.select().from(executionGrantPolicies)
      .where(eq(executionGrantPolicies.companyId, input.attempt.companyId))
      .for("update")
      .then((rows) => rows[0] ?? null);
    if (!policy) throw forbidden("Delegated authority policy is not configured", {
      code: "execution_grant_policy_missing",
    });

    const currentRevision = await txDb.select({ id: agentConfigRevisions.id })
      .from(agentConfigRevisions)
      .where(and(
        eq(agentConfigRevisions.companyId, input.attempt.companyId),
        eq(agentConfigRevisions.agentId, target.id),
      ))
      .orderBy(desc(agentConfigRevisions.createdAt), desc(agentConfigRevisions.id))
      .limit(1)
      .then((rows) => rows[0]?.id ?? null);
    const grant = await txDb.select()
      .from(executionGrants)
      .where(and(eq(executionGrants.id, input.grantId), eq(executionGrants.companyId, input.attempt.companyId)))
      .then((rows) => rows[0] ?? null);
    if (!grant) throw forbidden("Execution grant is unavailable", { code: "execution_grant_unavailable" });

    const now = new Date();
    const requestHash = input.requestBody === undefined
      ? input.attempt.requestHash
      : executionGrantRequestHash("PATCH", `/api/agents/${target.id}`,
        input.requestBody, target.updatedAt.toISOString());
    const denial = executionGrantDenial(toContract(grant), {
      ...input.attempt,
      requestHash,
      targetRevisionId: currentRevision,
      decisionStewardAgentId: policy.stewardAgentId,
      currentPolicyVersion: policy.version,
      now,
    });
    if (denial) throw forbidden("Execution grant does not authorize this write", { code: `execution_grant_${denial}` });

    await assertActiveExecutionGrantRun({
      db: txDb,
      companyId: input.attempt.companyId,
      executorAgentId: input.attempt.executorAgentId,
      runId: input.runId,
    });

    const [consumed] = await txDb.update(executionGrants)
      .set({ consumedAt: now, consumedByRunId: input.runId })
      .where(and(
        eq(executionGrants.id, input.grantId),
        eq(executionGrants.companyId, input.attempt.companyId),
        eq(executionGrants.executorAgentId, input.attempt.executorAgentId),
        eq(executionGrants.targetAgentId, input.attempt.targetAgentId),
        eq(executionGrants.operation, input.attempt.operation),
        eq(executionGrants.requestHash, requestHash),
        gt(executionGrants.expiresAt, now),
        isNull(executionGrants.consumedAt),
      ))
      .returning({ id: executionGrants.id });
    if (!consumed) throw forbidden("Execution grant was already consumed or expired", {
      code: "execution_grant_unavailable",
    });

    return input.apply(txDb);
  });
}
