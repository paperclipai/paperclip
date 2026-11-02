import type { Db } from "@paperclipai/db";
import { sql } from "drizzle-orm";
import { inspectNativeRunnerUpgradeHeader } from "./native-runner-checkpoint.js";

/** An explicit, paginated diagnostic. Never called by an idle/background scan.
 * This inventories selected retained task-session pointers, not all history.
 * Header evidence is preliminary: full snapshot/journal validation still occurs
 * only when ordinary admission selects its exact continuation source. */
export async function readNativeControllerRecoveryInventory(db: Db, input: { afterId?: string; limit?: number } = {}) {
  if (input.limit !== undefined && !Number.isFinite(input.limit)) throw new Error("native_recovery_inventory_limit_invalid");
  const limit = Math.min(128, Math.max(1, Math.floor(input.limit ?? 128)));
  const rows = await db.transaction(async tx => {
    await tx.execute(sql`set local statement_timeout = '2s'`);
    return tx.execute<{
      id: string; runId: string | null; companyId: string; issueId: string | null; sessionId: string | null;
      runnerId: string | null; metadata: Record<string, unknown> | null; material: Record<string, unknown> | null;
      pending: boolean;
    }>(sql`with selected as (
      select id, company_id, agent_id, last_run_id from agent_task_sessions
      where adapter_type = 'paperclip_runner' ${input.afterId ? sql`and id > ${input.afterId}::uuid` : sql``}
      order by id limit ${limit + 1}
    ) select s.id, s.company_id as "companyId", r.id as "runId", r.native_issue_id as "issueId",
      r.native_session_id as "sessionId", r.runner_instance_id as "runnerId",
      case when pg_column_size(r.runner_profile_json->'nativeControllerRecovery') <= 4096
        then r.runner_profile_json->'nativeControllerRecovery' else null end as metadata,
      case when pg_column_size(c.material) <= 262144 and sum(pg_column_size(c.material)) over () <= 8388608
        then c.material else null end as material,
      (r.finished_at is null or r.status not in ('succeeded', 'failed', 'cancelled', 'interrupted', 'timed_out')
        or f.run_id is null or f.lease_owner is not null or f.recovery_state is not null
        or f.phase not in ('committed', 'terminal_failure')) is true as pending
      from selected s left join heartbeat_runs r on r.id = s.last_run_id and r.company_id = s.company_id and r.agent_id = s.agent_id
      left join native_run_finalizations f on f.run_id = r.id and f.company_id = s.company_id
      left join native_runner_checkpoints c on c.run_id = r.id and c.company_id = s.company_id
        and c.issue_id = r.native_issue_id and c.part = 'header'
      order by s.id`);
  }, { accessMode: "read only" });
  const truncated = rows.length > limit;
  const page = rows.slice(0, limit);
  const reasons: Record<string, number> = {};
  let selectedRetainedEvidence = 0, outstandingObligations = 0;
  for (const row of page) {
    let reason: string | null = null;
    if (row.pending) { outstandingObligations++; reason = "persistence_or_handoff_pending"; }
    else if (!row.runId || !row.issueId || !row.sessionId) reason = "selected_binding_missing";
    else if (row.metadata?.schema !== "paperclip.native-controller-recovery.v1") reason = "metadata_unsupported_or_missing";
    else {
      const checkpoint = row.metadata.checkpoint as Record<string, unknown> | null;
      const header = row.material ? inspectNativeRunnerUpgradeHeader({ companyId: row.companyId, issueId: row.issueId, runId: row.runId }, row.material) : null;
      if (!checkpoint || checkpoint.runId !== row.runId || checkpoint.runnerInstanceId !== row.runnerId
        || checkpoint.normalizedSessionId !== row.sessionId || !header
        || header.runnerInstanceId !== row.runnerId || header.normalizedSessionId !== row.sessionId) reason = "checkpoint_binding_missing";
      else selectedRetainedEvidence++;
    }
    if (reason) reasons[reason] = (reasons[reason] ?? 0) + 1;
  }
  return { version: 1 as const, observedAt: new Date().toISOString(), inspected: page.length,
    coverage: truncated || input.afterId ? "partial" as const : "selected_task_session_pointers" as const,
    truncated, nextAfterId: truncated ? page.at(-1)!.id : null,
    selectedRetainedEvidence, outstandingObligations, reasons,
    fullPayloadsValidated: false as const };
}
