import { sql } from "drizzle-orm";
import { heartbeatRuns, nativeRunFinalizations, nativeRunResults } from "@paperclipai/db";

/** Provider-owned normalization of the existing server-authored accounting
 * contract. Runtime selection validates the explicit unmetered acknowledgement
 * before freezing v6/v8; the executor authors providerAccounting after execution.
 * Neither current agent configuration nor a provider's raw result grants this.
 * A matching accepted, committed result closes the operation even when its
 * disposition failed. No usage or price is manufactured by this closure. */
export const externallyBilledNativeAccountingClosure = sql<boolean>`coalesce((
  ${heartbeatRuns.runtimeMode} = 'native'
  and ${heartbeatRuns.status} in ('succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted')
  and ${heartbeatRuns.usageJson}->>'accountingCaptureFailed' is distinct from 'true'
  and ${heartbeatRuns.resultJson}->'providerAccounting'->'externallyBilled' = 'true'::jsonb
  and ${heartbeatRuns.resultJson}->'providerAccounting'->'usage' = 'null'::jsonb
  and ${heartbeatRuns.resultJson}->'providerAccounting'->'cost' = 'null'::jsonb
  and ${heartbeatRuns.runnerProfileJson}->'nativeExecutionInput'->'binding'->>'companyId' = ${heartbeatRuns.companyId}::text
  and ${heartbeatRuns.runnerProfileJson}->'nativeExecutionInput'->'binding'->>'agentId' = ${heartbeatRuns.agentId}::text
  and ${heartbeatRuns.runnerProfileJson}->'nativeExecutionInput'->'binding'->>'runId' = ${heartbeatRuns.id}::text
  and ${heartbeatRuns.runnerProfileJson}->'nativeExecutionInput'->'binding'->>'issueId' = ${heartbeatRuns.nativeIssueId}::text
  and (
    (${heartbeatRuns.runnerProfileJson}->'nativeExecutionInput'->>'schema' = 'paperclip.native-execution-input.v6'
      and ((${heartbeatRuns.runnerProfileJson}->'nativeExecutionInput'->'provider'->>'kind' = 'openai_dot'
        and ${heartbeatRuns.runnerProfileJson}->'nativeExecutionInput'->'session'->>'driverKind' = 'openai_dot_mcp')
      or (${heartbeatRuns.runnerProfileJson}->'nativeExecutionInput'->'provider'->>'kind' = 'grok_bot'
        and ${heartbeatRuns.runnerProfileJson}->'nativeExecutionInput'->'session'->>'driverKind' = 'grok_bot_mcp')))
    or (${heartbeatRuns.runnerProfileJson}->'nativeExecutionInput'->>'schema' = 'paperclip.native-execution-input.v8'
      and ${heartbeatRuns.runnerProfileJson}->'nativeExecutionInput'->'provider'->>'kind' = 'muse'
      and ${heartbeatRuns.runnerProfileJson}->'nativeExecutionInput'->'session'->>'driverKind' = 'muse_external')
  )
  and exists (select 1 from ${nativeRunFinalizations} accounting_finalizer
    join ${nativeRunResults} accounting_result on accounting_result.id = accounting_finalizer.result_id
      and accounting_result.company_id = accounting_finalizer.company_id
      and accounting_result.run_id = accounting_finalizer.run_id
      and accounting_result.issue_id = accounting_finalizer.issue_id
    where accounting_finalizer.company_id = ${heartbeatRuns.companyId}
      and accounting_finalizer.run_id = ${heartbeatRuns.id}
      and accounting_finalizer.issue_id = ${heartbeatRuns.nativeIssueId}
      and accounting_finalizer.phase = 'committed'
      and accounting_result.schema_status = 'accepted')
), false)`;
