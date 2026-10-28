import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { agentWakeupRequests, environmentLeases, heartbeatRuns, issues, issueRecoveryActions, type Db } from "@paperclipai/db";
import { adoptSystemRecovery } from "./system-recovery.js";
import { terminalWorkspaceRunStates, workspaceExportCauses } from "./workspace-recovery-source.js";

/** Progress lives on each source, so restarts and additional servers neither
 * restart a global scan nor grant a second policy-adoption budget. */
export async function adoptHistoricalWorkspaceRecoveries(db: Db) {
  const rows = await db.select().from(issueRecoveryActions).where(and(
    sql`not (${issueRecoveryActions.evidence} ? 'systemRecovery')`,
    sql`${issueRecoveryActions.evidence}->>'runId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'`,
    sql`(${issueRecoveryActions.evidence}->'workspaceRestoreRecovery'->>'schema' = 'paperclip.workspace-restore-recovery.v1'
      or ${inArray(issueRecoveryActions.cause, workspaceExportCauses)})`,
  )).orderBy(asc(issueRecoveryActions.id)).limit(50);
  for (const action of rows) await adoptSystemRecovery(db, {
    companyId: action.companyId, issueId: action.sourceIssueId, actionId: action.id, runId: String(action.evidence.runId),
  });
  const remaining = 50 - rows.length;
  if (remaining === 0) return rows.length;
  // Both branches use durable indexed candidate identities. The lease branch
  // covers old runs which predate the run-level restore descriptor. It never
  // searches for a replacement allocation or consults today's agent config.
  const candidates = sql`(
    select id from ${heartbeatRuns} where result_json->'workspaceRestoreRecovery'->>'schema' = 'paperclip.workspace-restore-recovery.v1'
      and not (coalesce(result_json, '{}'::jsonb) ? 'systemRecoveryAdoption')
      and status in ('failed', 'interrupted', 'timed_out', 'cancelled', 'succeeded')
    union
    select heartbeat_run_id from ${environmentLeases}
      where lease_policy = 'retain_on_failure' and heartbeat_run_id is not null
      and not (coalesce(metadata, '{}'::jsonb) ? 'systemRecoveryAdoption')
  )`;
  const missing = await db.select({ run: heartbeatRuns, issue: issues }).from(heartbeatRuns).innerJoin(issues, and(
    eq(issues.companyId, heartbeatRuns.companyId),
    sql`${issues.id}::text = coalesce(${heartbeatRuns.nativeIssueId}::text, ${heartbeatRuns.issueId}::text, ${heartbeatRuns.contextSnapshot}->>'issueId')`,
  )).where(and(inArray(heartbeatRuns.status, terminalWorkspaceRunStates),
    sql`${heartbeatRuns.id} in ${candidates}`,
    sql`not (coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb) ? 'systemRecoveryAdoption')`,
  )).orderBy(asc(heartbeatRuns.id)).limit(remaining);
  for (const { run, issue } of missing) await db.transaction(async tx => {
    await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, issue.id)).for("update");
    const [current] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, run.companyId),
      eq(heartbeatRuns.id, run.id))).for("update");
    if (!current || current.resultJson?.systemRecoveryAdoption) return;
    const [existing] = await tx.select().from(issueRecoveryActions).where(and(
      eq(issueRecoveryActions.companyId, run.companyId), eq(issueRecoveryActions.sourceIssueId, issue.id),
      sql`${issueRecoveryActions.evidence}->>'runId' = ${run.id}`,
      sql`(${issueRecoveryActions.evidence}->'workspaceRestoreRecovery'->>'schema' = 'paperclip.workspace-restore-recovery.v1'
        or ${inArray(issueRecoveryActions.cause, [...workspaceExportCauses,
          "legacy_execution_requires_reconciliation", "native_continuation_requires_reconciliation"])})`)).limit(1);
    const [active] = await tx.select({ id: issueRecoveryActions.id }).from(issueRecoveryActions).where(and(
      eq(issueRecoveryActions.companyId, run.companyId), eq(issueRecoveryActions.sourceIssueId, issue.id),
      inArray(issueRecoveryActions.status, ["active", "escalated"]))).limit(1);
    const retained = await tx.select({ id: environmentLeases.id }).from(environmentLeases).where(and(
      eq(environmentLeases.companyId, run.companyId), eq(environmentLeases.heartbeatRunId, run.id),
      eq(environmentLeases.issueId, issue.id), eq(environmentLeases.leasePolicy, "retain_on_failure"),
    )).orderBy(asc(environmentLeases.id)).for("update");
    const historicalWorkspaceSource = { schema: "paperclip.historical-workspace-source.v1", runId: run.id,
      leaseIds: retained.map(lease => lease.id) };
    const action = existing ?? (await tx.insert(issueRecoveryActions).values({
      companyId: run.companyId, sourceIssueId: issue.id, kind: "active_run_watchdog", ownerType: "system",
      returnOwnerAgentId: run.agentId,
      cause: run.runtimeMode === "native" ? "native_continuation_requires_reconciliation" : "legacy_execution_requires_reconciliation",
      fingerprint: `retained-source:${run.id}`,
      // A maintenance record may retain a no-replay obligation without stealing
      // the current task's active approval/user-action owner.
      status: active || ["done", "cancelled"].includes(issue.status) ? "resolved" : "active",
      outcome: active ? "blocked" : null,
      nextAction: "Paperclip owns preservation of this historical source.",
      evidence: { runId: run.id, workspaceRestoreRecovery: current.resultJson?.workspaceRestoreRecovery,
        workspaceRestoreFailure: current.resultJson?.workspaceRestoreFailure, historicalWorkspaceSource,
        automaticRecovery: { replay: "blocked" } },
    }).returning())[0];
    if (existing && !existing.evidence.historicalWorkspaceSource) await tx.update(issueRecoveryActions).set({
      evidence: sql`${issueRecoveryActions.evidence} || ${JSON.stringify({ historicalWorkspaceSource })}::jsonb`,
    }).where(eq(issueRecoveryActions.id, action.id));
    await adoptSystemRecovery(tx as unknown as Db, { companyId: run.companyId, issueId: issue.id, runId: run.id, actionId: action.id });
    const adoption = { policyVersion: 1, actionId: action.id };
    await tx.update(heartbeatRuns).set({ resultJson: sql`coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb) ||
      ${JSON.stringify({ systemRecoveryAdoption: adoption })}::jsonb` })
      .where(eq(heartbeatRuns.id, run.id));
    if (retained.length) await tx.update(environmentLeases).set({
      metadata: sql`coalesce(${environmentLeases.metadata}, '{}'::jsonb) || ${JSON.stringify({ systemRecoveryAdoption: adoption })}::jsonb`,
    }).where(and(eq(environmentLeases.companyId, run.companyId), inArray(environmentLeases.id, retained.map(lease => lease.id))));
  });
  return rows.length + missing.length;
}

/** Protected diagnostics report actual outcomes, not just completion of a scan. */
export async function historicalRecoveryCounts(db: Db, companyId: string) {
  const rows = await db.select({
    classified: sql<number>`count(*)::int`,
    repaired: sql<number>`count(*) filter (where ${issueRecoveryActions.evidence}#>>'{systemRecovery,state}' = 'complete')::int`,
    waitingInputDelivered: sql<number>`count(*) filter (where exists (
      select 1 from ${agentWakeupRequests} w where w.company_id = ${issueRecoveryActions.companyId}
      and w.run_id::text = ${issueRecoveryActions.evidence}#>>'{explicitUserContinuation,runId}'
      and w.status in ('coalesced', 'completed') and w.requested_by_actor_type = 'user'))::int`,
    awaitingRetry: sql<number>`count(*) filter (where ${issueRecoveryActions.evidence}#>>'{systemRecovery,state}' = 'complete'
      and exists (select 1 from ${issues} i where i.id = ${issueRecoveryActions.sourceIssueId}
        and i.company_id = ${issueRecoveryActions.companyId} and i.status not in ('done', 'cancelled')
        and i.execution_run_id is null)
      and not exists (select 1 from ${agentWakeupRequests} w where w.company_id = ${issueRecoveryActions.companyId}
        and w.payload->>'issueId' = ${issueRecoveryActions.sourceIssueId}::text and w.status = 'deferred_issue_execution')
      and ${issueRecoveryActions.evidence}#>>'{explicitUserContinuation,runId}' is null)::int`,
    unresolvedSources: sql<number>`count(*) filter (where ${issueRecoveryActions.evidence}#>>'{systemRecovery,state}' <> 'complete')::int`,
  }).from(issueRecoveryActions).where(and(eq(issueRecoveryActions.companyId, companyId),
    sql`${issueRecoveryActions.evidence}#>>'{systemRecovery,policyVersion}' = '1'`));
  return rows[0];
}
