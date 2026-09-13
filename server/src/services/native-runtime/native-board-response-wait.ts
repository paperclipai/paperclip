import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  agentWakeupRequests,
  approvals,
  completionContracts,
  heartbeatRuns,
  issueApprovals,
  issueComments,
  issues,
  issueThreadInteractions,
  nativeRunFinalizations,
  nativeRunResults,
  statusDecisions,
  type Db,
} from "@paperclipai/db";
import { nativeSha256 } from "./canonical.js";

type Binding = {
  companyId: string;
  issueId: string;
  runId: string;
  agentId: string;
};
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** A server-issued decision receipt, never a caller/context-supplied grant. */
export interface NativeBoardResponseWaitSource extends Binding {
  schema: "paperclip.native_board_response_wait.v1";
  wakeupRequestId: string;
  sourceCommentId: string;
  sourceUserId: string;
  sourceSha256: string;
  resultId: string;
  resultSha256: string;
  contractId: string;
  contractSha256: string;
}

export type NativeBoardResponseWaitOrigin = Omit<
  NativeBoardResponseWaitSource,
  "schema" | "sourceSha256"
> & {
  schema: "paperclip.native_board_response_wait_origin.v1";
};

/**
 * Denial-only provenance: an accepted response to a direct user comment asks
 * for the next response, not an automatic replay. It remains passive if its
 * source was edited/deleted/superseded. This never authorizes presentation or
 * a new run; those still need current source/assignment checks.
 */
export async function readNativeBoardResponseWaitOrigin(
  db: Db,
  binding: Binding,
  locked = false,
): Promise<NativeBoardResponseWaitOrigin | null> {
  const query = db
    .select({
      run: heartbeatRuns,
      wake: agentWakeupRequests,
      result: nativeRunResults,
      contract: completionContracts,
    })
    .from(heartbeatRuns)
    .innerJoin(
      agentWakeupRequests,
      and(
        eq(agentWakeupRequests.id, heartbeatRuns.wakeupRequestId),
        eq(agentWakeupRequests.companyId, binding.companyId),
        eq(agentWakeupRequests.agentId, binding.agentId),
        eq(agentWakeupRequests.runId, binding.runId),
        eq(agentWakeupRequests.source, "automation"),
        inArray(agentWakeupRequests.reason, ["issue_commented", "issue_reopened_via_comment"]),
        eq(agentWakeupRequests.requestedByActorType, "user"),
      ),
    )
    .innerJoin(
      nativeRunFinalizations,
      and(
        eq(nativeRunFinalizations.runId, binding.runId),
        eq(nativeRunFinalizations.companyId, binding.companyId),
        eq(nativeRunFinalizations.issueId, binding.issueId),
      ),
    )
    .innerJoin(
      nativeRunResults,
      and(
        eq(nativeRunResults.id, nativeRunFinalizations.resultId),
        eq(nativeRunResults.runId, binding.runId),
        eq(nativeRunResults.companyId, binding.companyId),
        eq(nativeRunResults.issueId, binding.issueId),
        eq(
          nativeRunResults.completionContractId,
          heartbeatRuns.completionContractId,
        ),
        eq(nativeRunResults.schemaStatus, "accepted"),
      ),
    )
    .innerJoin(
      completionContracts,
      and(
        eq(completionContracts.id, heartbeatRuns.completionContractId),
        eq(completionContracts.companyId, binding.companyId),
        eq(completionContracts.issueId, binding.issueId),
      ),
    )
    .where(
      and(
        eq(heartbeatRuns.id, binding.runId),
        eq(heartbeatRuns.companyId, binding.companyId),
        eq(heartbeatRuns.agentId, binding.agentId),
        eq(heartbeatRuns.nativeIssueId, binding.issueId),
        eq(heartbeatRuns.runtimeMode, "native"),
      ),
    )
    .limit(1);
  const [row] = await (locked ? query.for("share", { noWait: true }) : query);
  if (
    !row ||
    !row.wake.requestedByActorId ||
    row.contract.canonicalSha256 !== row.run.completionContractSha256
  )
    return null;
  const payload = record(row.wake.payload);
  if (
    payload.issueId !== binding.issueId ||
    typeof payload.commentId !== "string" ||
    !/^[a-f0-9-]{36}$/i.test(payload.commentId)
  )
    return null;
  const result = record(record(row.result.resultJson).result);
  const terminal = record(record(row.result.resultJson).terminal);
  const continuation = record(result.continuation);
  if (
    result.schema !== "paperclip.run_result.v1" ||
    result.reportedWorkDisposition !== "yielded" ||
    continuation.kind !== "response_wake" ||
    typeof continuation.idempotencyKey !== "string" ||
    !continuation.idempotencyKey.trim() ||
    terminal.runTerminalState !== "succeeded" ||
    terminal.turnTerminalState !== "completed" ||
    terminal.reportedWorkDisposition !== "yielded" ||
    !Array.isArray(result.attentionRequests) ||
    result.attentionRequests.length !== 0
  )
    return null;
  return {
    schema: "paperclip.native_board_response_wait_origin.v1",
    companyId: binding.companyId,
    issueId: binding.issueId,
    runId: binding.runId,
    agentId: binding.agentId,
    wakeupRequestId: row.wake.id,
    sourceCommentId: payload.commentId,
    sourceUserId: row.wake.requestedByActorId,
    resultId: row.result.id,
    resultSha256: row.result.canonicalSha256,
    contractId: row.contract.id,
    contractSha256: row.contract.canonicalSha256,
  };
}

/**
 * Only an unchanged, directly admitted Board comment can make response_wake a
 * passive wait. Context snapshots, model prose and automatic retry ancestry do
 * not grant this exception. In the committer the issue is already locked; use
 * NOWAIT for child rows to avoid reversing a concurrent wake/comment lock order.
 */
export async function readNativeBoardResponseWaitSource(
  db: Db,
  binding: Binding,
  locked = false,
): Promise<{ source: NativeBoardResponseWaitSource; summary: string } | null> {
  const runQuery = db
    .select()
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.id, binding.runId),
        eq(heartbeatRuns.companyId, binding.companyId),
        eq(heartbeatRuns.agentId, binding.agentId),
        eq(heartbeatRuns.nativeIssueId, binding.issueId),
        eq(heartbeatRuns.runtimeMode, "native"),
      ),
    )
    .limit(1);
  const [run] = await (locked
    ? runQuery.for("share", { noWait: true })
    : runQuery);
  if (!run?.wakeupRequestId || !run.completionContractId || !run.startedAt)
    return null;
  const wakeQuery = db
    .select()
    .from(agentWakeupRequests)
    .where(
      and(
        eq(agentWakeupRequests.id, run.wakeupRequestId),
        eq(agentWakeupRequests.companyId, binding.companyId),
        eq(agentWakeupRequests.agentId, binding.agentId),
        eq(agentWakeupRequests.runId, binding.runId),
        eq(agentWakeupRequests.source, "automation"),
        inArray(agentWakeupRequests.reason, ["issue_commented", "issue_reopened_via_comment"]),
        eq(agentWakeupRequests.requestedByActorType, "user"),
      ),
    )
    .limit(1);
  const [wake] = await (locked
    ? wakeQuery.for("share", { noWait: true })
    : wakeQuery);
  const payload = record(wake?.payload);
  if (
    !wake?.requestedByActorId ||
    payload.issueId !== binding.issueId ||
    typeof payload.commentId !== "string" ||
    !/^[a-f0-9-]{36}$/i.test(payload.commentId)
  )
    return null;
  const [issue] = await db
    .select()
    .from(issues)
    .where(
      and(
        eq(issues.id, binding.issueId),
        eq(issues.companyId, binding.companyId),
        eq(issues.assigneeAgentId, binding.agentId),
        eq(issues.status, "in_progress"),
        isNull(issues.hiddenAt),
      ),
    )
    .limit(1);
  if (!issue || record(issue.executionState).status === "pending") return null;
  const commentQuery = db
    .select()
    .from(issueComments)
    .where(
      and(
        eq(issueComments.id, payload.commentId),
        eq(issueComments.companyId, binding.companyId),
        eq(issueComments.issueId, binding.issueId),
        eq(issueComments.authorType, "user"),
        eq(issueComments.authorUserId, wake.requestedByActorId),
        isNull(issueComments.authorAgentId),
        isNull(issueComments.createdByRunId),
        isNull(issueComments.deletedAt),
        isNull(issueComments.sourceTrust),
        // Compare in PostgreSQL, preserving timestamp precision across JS reads.
        sql`${issueComments.updatedAt} = ${issueComments.createdAt}`,
        sql`${issueComments.createdAt} <= (select started_at from heartbeat_runs where id = ${run.id})`,
      ),
    )
    .limit(1);
  const [comment] = await (locked
    ? commentQuery.for("share", { noWait: true })
    : commentQuery);
  if (!comment?.body.trim()) return null;
  const [newer, interaction, approval] = await Promise.all([
    db
      .select({ id: issueComments.id })
      .from(issueComments)
      .where(
        and(
          eq(issueComments.companyId, binding.companyId),
          eq(issueComments.issueId, binding.issueId),
          eq(issueComments.authorType, "user"),
          isNull(issueComments.createdByRunId),
          isNull(issueComments.deletedAt),
          sql`(${issueComments.createdAt}, ${issueComments.id}) > (select created_at, id from issue_comments where id = ${comment.id})`,
        ),
      )
      .limit(1),
    db
      .select({ id: issueThreadInteractions.id })
      .from(issueThreadInteractions)
      .where(
        and(
          eq(issueThreadInteractions.companyId, binding.companyId),
          eq(issueThreadInteractions.issueId, binding.issueId),
          eq(issueThreadInteractions.status, "pending"),
        ),
      )
      .limit(1),
    db
      .select({ id: approvals.id })
      .from(issueApprovals)
      .innerJoin(approvals, eq(approvals.id, issueApprovals.approvalId))
      .where(
        and(
          eq(issueApprovals.companyId, binding.companyId),
          eq(issueApprovals.issueId, binding.issueId),
          eq(approvals.companyId, binding.companyId),
          inArray(approvals.status, ["pending", "revision_requested"]),
        ),
      )
      .limit(1),
  ]);
  if (newer.length || interaction.length || approval.length) return null;
  const [accepted] = await db
    .select({ result: nativeRunResults, contract: completionContracts })
    .from(nativeRunFinalizations)
    .innerJoin(
      nativeRunResults,
      and(
        eq(nativeRunResults.id, nativeRunFinalizations.resultId),
        eq(nativeRunResults.companyId, binding.companyId),
        eq(nativeRunResults.issueId, binding.issueId),
        eq(nativeRunResults.runId, binding.runId),
        eq(nativeRunResults.completionContractId, run.completionContractId),
        eq(nativeRunResults.schemaStatus, "accepted"),
      ),
    )
    .innerJoin(
      completionContracts,
      and(
        eq(completionContracts.id, run.completionContractId),
        eq(completionContracts.companyId, binding.companyId),
        eq(completionContracts.issueId, binding.issueId),
      ),
    )
    .where(
      and(
        eq(nativeRunFinalizations.runId, run.id),
        eq(nativeRunFinalizations.companyId, binding.companyId),
        eq(nativeRunFinalizations.issueId, binding.issueId),
      ),
    )
    .limit(1);
  if (
    !accepted ||
    accepted.contract.canonicalSha256 !== run.completionContractSha256
  )
    return null;
  const envelope = record(accepted.result.resultJson);
  const result = record(envelope.result);
  const terminal = record(envelope.terminal);
  const continuation = record(result.continuation);
  if (
    result.schema !== "paperclip.run_result.v1" ||
    result.reportedWorkDisposition !== "yielded" ||
    continuation.kind !== "response_wake" ||
    typeof continuation.idempotencyKey !== "string" ||
    !continuation.idempotencyKey.trim() ||
    terminal.runTerminalState !== "succeeded" ||
    terminal.turnTerminalState !== "completed" ||
    terminal.reportedWorkDisposition !== "yielded" ||
    !Array.isArray(result.attentionRequests) ||
    result.attentionRequests.length !== 0 ||
    typeof result.summary !== "string" ||
    !result.summary.trim()
  )
    return null;
  return {
    source: {
      schema: "paperclip.native_board_response_wait.v1",
      companyId: binding.companyId,
      issueId: binding.issueId,
      runId: binding.runId,
      agentId: binding.agentId,
      wakeupRequestId: wake.id,
      sourceCommentId: comment.id,
      sourceUserId: wake.requestedByActorId,
      sourceSha256: nativeSha256({
        id: comment.id,
        userId: comment.authorUserId,
        body: comment.body,
      }),
      resultId: accepted.result.id,
      resultSha256: accepted.result.canonicalSha256,
      contractId: accepted.contract.id,
      contractSha256: accepted.contract.canonicalSha256,
    },
    summary: result.summary.trim(),
  };
}

/** Recovery suppresses only this exact applied passive wait, never another run. */
export async function hasCommittedNativeBoardResponseWait(
  db: Db,
  binding: Binding,
): Promise<boolean> {
  const [decision] = await db
    .select({ decision: statusDecisions })
    .from(nativeRunFinalizations)
    .innerJoin(
      statusDecisions,
      and(
        eq(statusDecisions.id, nativeRunFinalizations.decisionId),
        eq(statusDecisions.assessmentId, nativeRunFinalizations.assessmentId),
        eq(statusDecisions.companyId, binding.companyId),
        eq(statusDecisions.issueId, binding.issueId),
        eq(statusDecisions.runId, binding.runId),
        eq(statusDecisions.applicationState, "applied"),
        inArray(statusDecisions.reasonCode, [
          "board_response_waiting",
          "board_response_wait_superseded",
        ]),
      ),
    )
    .innerJoin(
      issues,
      and(
        eq(issues.id, binding.issueId),
        eq(issues.companyId, binding.companyId),
        eq(issues.assigneeAgentId, binding.agentId),
        eq(issues.status, "in_progress"),
      ),
    )
    .where(
      and(
        eq(nativeRunFinalizations.companyId, binding.companyId),
        eq(nativeRunFinalizations.issueId, binding.issueId),
        eq(nativeRunFinalizations.runId, binding.runId),
        eq(nativeRunFinalizations.phase, "committed"),
      ),
    )
    .limit(1);
  if (!decision) return false;
  const origin = await readNativeBoardResponseWaitOrigin(db, binding);
  // A new comment cannot grant a replay of the old response. New independent
  // wakes are admitted normally and their new run ID is not this receipt.
  return (
    origin !== null &&
    nativeSha256(
      record(decision.decision.decisionJson).boardResponseWaitOrigin,
    ) === nativeSha256(origin)
  );
}
