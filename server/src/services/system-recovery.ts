import { and, eq, sql } from "drizzle-orm";
import { heartbeatRuns, issueComments, issueRecoveryActions, type Db } from "@paperclipai/db";
import { writeExecutionControl } from "./execution-control-notifications.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";
import { createSystemRecovery, readSystemRecovery, type SystemRecoveryState } from "./system-recovery-state.js";
import { workspaceRecoverySourceEligible, type WorkspaceRecoverySourceIdentity } from "./workspace-recovery-source.js";

export async function adoptSystemRecovery(db: Db, source: WorkspaceRecoverySourceIdentity) {
  return db.transaction(async tx => {
    const [existing] = await tx.select({ evidence: issueRecoveryActions.evidence }).from(issueRecoveryActions)
      .where(and(eq(issueRecoveryActions.companyId, source.companyId), eq(issueRecoveryActions.id, source.actionId),
        eq(issueRecoveryActions.sourceIssueId, source.issueId))).for("update");
    if (!existing || existing.evidence.systemRecovery) return;
    await notifyDeliveryWork(tx, DELIVERY_QUEUES.workspaceRecovery);
    const state = createSystemRecovery(source.runId);
    // Atomic, once per source. An exhausted previous execution budget is history;
    // adoption grants only the explicitly versioned maintenance capability.
    const adopted = await tx.update(issueRecoveryActions).set({
      ownerType: "system", ownerAgentId: null, ownerUserId: null,
      evidence: sql`${issueRecoveryActions.evidence} || jsonb_build_object(
        'previousWorkspaceRecovery', ${issueRecoveryActions.evidence}->'workspaceRecovery',
        'systemRecovery', ${JSON.stringify(state)}::jsonb,
        'workspaceRecovery', ${JSON.stringify({
          schema: "paperclip.workspace-recovery.v1", runId: source.runId, status: "queued",
          stage: "verifying_stop", attempt: 0, attemptLimit: 6, requestIds: [],
        })}::jsonb)`,
      updatedAt: new Date(),
    }).where(and(eq(issueRecoveryActions.companyId, source.companyId), eq(issueRecoveryActions.id, source.actionId),
      eq(issueRecoveryActions.sourceIssueId, source.issueId),
      sql`${issueRecoveryActions.evidence}->>'runId' = ${source.runId}`,
      sql`not (${issueRecoveryActions.evidence} ? 'systemRecovery')`))
      .returning({ id: issueRecoveryActions.id });
    if (!adopted.length) return;
    // Classify only notices emitted by the historical recovery producer, bound
    // to this exact source/action. Their content remains available in diagnostics;
    // neither user prose nor unrelated user-action notices are suppressed.
    await tx.update(issueComments).set({
      metadata: sql`${issueComments.metadata} || '{"recoveryResponsibility":"system"}'::jsonb`,
    }).where(and(eq(issueComments.companyId, source.companyId), eq(issueComments.issueId, source.issueId),
      eq(issueComments.authorType, "system"),
      sql`${issueComments.presentation}->>'kind' = 'system_notice'`,
      sql`${issueComments.metadata}->>'recoveryResponsibility' is null`,
      sql`${issueComments.metadata} @> ${JSON.stringify({ version: 1, sourceRunId: source.runId,
        sections: [{ rows: [{ type: "key_value", label: "Recovery action", value: source.actionId }] }] })}::jsonb`));
  });
}

/** CAS protects a newer manual generation from an old worker's late write.
 * This is bookkeeping authority only; physical writes still require ownership. */
export async function updateSystemRecovery(db: Db, source: WorkspaceRecoverySourceIdentity,
  previous: SystemRecoveryState, next: SystemRecoveryState) {
  const status = next.state === "complete" ? "recovered" : next.state === "exhausted" ? "blocked"
    : next.state === "running" ? "recovering" : "queued";
  const compatibility = {
    schema: "paperclip.workspace-recovery.v1", runId: source.runId, status,
    stage: next.phase === "verify_execution" ? "verifying_stop" : next.phase === "preserve_files" ? "restoring_files" : "saving_receipts",
    attempt: next.attempts, attemptLimit: 6, retryable: true, retryAt: next.nextAttemptAt ?? undefined,
  };
  return writeExecutionControl(db, DELIVERY_QUEUES.workspaceRecovery, async tx => {
    const [updated] = await tx.update(issueRecoveryActions).set({
      ownerType: "system", ownerAgentId: null, ownerUserId: null,
      evidence: sql`${issueRecoveryActions.evidence} || jsonb_build_object('systemRecovery', ${JSON.stringify(next)}::jsonb ||
        ${next.generationId === previous.generationId && next.intentId === previous.intentId
          ? sql`jsonb_build_object('intentId', ${issueRecoveryActions.evidence}#>'{systemRecovery,intentId}')`
          : sql`'{}'::jsonb`},
        'workspaceRecovery', ${JSON.stringify(compatibility)}::jsonb || jsonb_build_object('requestIds',
          coalesce(${issueRecoveryActions.evidence}#>'{workspaceRecovery,requestIds}', '[]'::jsonb)))`,
      updatedAt: new Date(),
    }).where(and(eq(issueRecoveryActions.companyId, source.companyId), eq(issueRecoveryActions.id, source.actionId),
      sql`${issueRecoveryActions.evidence}#>>'{systemRecovery,generationId}' = ${previous.generationId}`,
      sql`${issueRecoveryActions.evidence}#>>'{systemRecovery,revision}' = ${String(previous.revision)}`))
      .returning({ id: issueRecoveryActions.id });
    return Boolean(updated);
  });
}

export async function loadSystemRecovery(db: Db, source: WorkspaceRecoverySourceIdentity) {
  const [row] = await db.select({ evidence: issueRecoveryActions.evidence }).from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.companyId, source.companyId), eq(issueRecoveryActions.sourceIssueId, source.issueId),
    eq(issueRecoveryActions.id, source.actionId)));
  return readSystemRecovery(row?.evidence);
}

export async function nextWorkspaceRecoveryAt(db: Db): Promise<number | null> {
  const rows = await db.select({ at: sql<number>`case
    when jsonb_typeof(${issueRecoveryActions.evidence}#>'{systemRecovery,nextAttemptAt}') = 'number'
    then (${issueRecoveryActions.evidence}#>>'{systemRecovery,nextAttemptAt}')::bigint else 0 end` })
    .from(issueRecoveryActions).innerJoin(heartbeatRuns, and(
      eq(heartbeatRuns.companyId, issueRecoveryActions.companyId),
      eq(heartbeatRuns.id, sql`case when ${issueRecoveryActions.evidence}->>'runId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        then (${issueRecoveryActions.evidence}->>'runId')::uuid end`),
      sql`${heartbeatRuns.status} in ('failed', 'interrupted', 'timed_out', 'cancelled', 'succeeded')`,
    )).where(and(
      workspaceRecoverySourceEligible(),
      sql`${issueRecoveryActions.evidence}#>>'{systemRecovery,state}' in ('scheduled', 'running', 'awaiting_evidence')`,
    )).orderBy(sql`1`).limit(1);
  return rows.length ? Number(rows[0].at) : null;
}
