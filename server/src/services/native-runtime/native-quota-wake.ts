import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { notifyExecutionRunWork } from "../execution-control-notifications.js";
import { notifyScheduledRetryDispatch } from "../run-dispatch-notifications.js";

/** Call inside the producer's transaction before changing a pool or account. */
export async function reopenNativeQuotaPoolWaits(
  tx: Db,
  input: { companyId: string; poolId?: string; connectionId?: string },
): Promise<number> {
  await notifyExecutionRunWork(tx, { companyId: input.companyId });
  await notifyScheduledRetryDispatch(tx, { companyId: input.companyId });
  const pool = input.poolId
    ? sql`coalesce(r.context_snapshot->'aiRouterSelection'->>'poolId', r.context_snapshot->>'aiRouterPoolId') = ${input.poolId}`
    // A credential can be shared by different grants and connections. Wake all
    // company pools before the account mutation; reconciliation rechecks eligibility.
    : sql`true`;
  const rows = await tx.execute<{ run_id: string }>(sql`update native_run_finalizations f set next_attempt_at = null
    from heartbeat_runs r where f.run_id = r.id and f.company_id = ${input.companyId} and r.company_id = ${input.companyId}
      and f.phase = 'terminal_failure' and f.failure_code in ('native_provider_usage_limit', 'native_provider_auth_failed', 'native_provider_runner_failed')
      and f.result_id is null and coalesce(f.failure_detail->>'successorRunId', '') = ''
      and coalesce(f.failure_detail->>'replacementDenied', '') = '' and f.next_attempt_at is not null
      and ${pool} returning f.run_id`);
  const waiting = await tx.execute<{ id: string }>(sql`update heartbeat_runs r set scheduled_retry_at = now(),
      context_snapshot = r.context_snapshot #- '{aiPoolFailover,waitingUntil}', updated_at = now()
    where r.company_id = ${input.companyId} and r.status = 'scheduled_retry'
      and ((r.runtime_mode = 'legacy' and r.context_snapshot->'aiPoolFailover'->>'waitingUntil' is not null)
        or (r.scheduled_retry_reason = 'ai_connection_pool_wait' and r.started_at is null
          and r.runtime_mode_resolved_at is null and r.runner_instance_id is null
          and r.native_session_id is null and r.process_pid is null
          and exists (select 1 from heartbeat_runs source where source.id = r.retry_of_run_id
            and source.company_id = r.company_id and source.agent_id = r.agent_id
            and source.scope_kind = r.scope_kind and source.issue_id is not distinct from r.issue_id
            and source.status = 'cancelled' and source.result_json->'executionRecovery'->>'kind' = 'ai_connection_wait'
            and source.result_json->'executionRecovery'->>'providerWorkStarted' = 'false')))
      and r.scheduled_retry_at > now() and ${pool} returning r.id`);
  return rows.length + waiting.length;
}
