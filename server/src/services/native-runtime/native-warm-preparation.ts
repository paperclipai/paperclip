import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { parseNativeExecutionInput } from "../../vendor/paperclip-runner/index.js";
import { readNativeCheckpointPublicationIdentity } from "./native-runner-checkpoint.js";
import { rebindNativeSessionCheckpoint } from "./native-session-resume.js";

export async function readNativeWarmPreparation(db: Db, scope: {
  companyId: string; agentId: string; issueId: string; runId: string; runnerInstanceId: string; nativeSessionId: string;
}) {
  const [prior] = await db.execute<{ id: string; execution: unknown; source: {
    id: string; companyId: string; agentId: string; nativeSessionId: string; errorCode: string | null; runnerProfileJson: unknown;
  } }>(sql`
    select p.id, c.runner_profile_json->'nativeExecutionInput' as execution,
      jsonb_build_object('id', p.id, 'companyId', p.company_id, 'agentId', p.agent_id, 'nativeSessionId', p.native_session_id,
        'errorCode', p.error_code, 'runnerProfileJson', jsonb_build_object(
          'nativeExecutionInput', p.runner_profile_json->'nativeExecutionInput',
          'nativeToolContractFingerprint', p.runner_profile_json->'nativeToolContractFingerprint',
          'sessionCheckpoint', p.runner_profile_json->'sessionCheckpoint')) as source
    from heartbeat_runs c join heartbeat_runs p
      on p.id::text=c.runner_profile_json->>'nativePreparationHandoffSourceRunId' and p.company_id=c.company_id
    join native_run_finalizations f on f.run_id=p.id and f.company_id=p.company_id and f.issue_id=p.native_issue_id
    join native_run_results result on result.id=f.result_id and result.run_id=p.id and result.company_id=p.company_id
      and result.issue_id=p.native_issue_id and result.completion_contract_id=p.completion_contract_id and result.schema_status='accepted'
    where c.id=${scope.runId}::uuid and c.company_id=${scope.companyId}::uuid and c.agent_id=${scope.agentId}::uuid
      and c.native_issue_id=${scope.issueId}::uuid and c.native_session_id=${scope.nativeSessionId}::uuid
      and c.runner_instance_id=${scope.runnerInstanceId} and c.runtime_mode='native' and c.status='running'
      and octet_length(coalesce(c.runner_profile_json->'nativeExecutionInput', 'null'::jsonb)::text)<=1048576
      and octet_length(coalesce(p.runner_profile_json->'nativeExecutionInput', 'null'::jsonb)::text)<=1048576
      and octet_length(coalesce(p.runner_profile_json->'sessionCheckpoint', 'null'::jsonb)::text)<=1048576
      and c.runner_profile_json#>>'{nativeExecutionInput,session,lifecyclePolicy,mode}'='warm'
      and c.runner_profile_json#>>'{sessionCheckpoint,identity,runId}'=c.id::text
      and c.runner_profile_json#>>'{sessionCheckpoint,identity,companyId}'=c.company_id::text
      and c.runner_profile_json#>>'{sessionCheckpoint,identity,agentId}'=c.agent_id::text
      and c.runner_profile_json#>>'{sessionCheckpoint,identity,issueId}'=c.native_issue_id::text
      and c.runner_profile_json#>>'{sessionCheckpoint,identity,sessionId}'=c.native_session_id::text
      and (c.runner_profile_json#>'{sessionCheckpoint,activeTurnId}' is null
        or c.runner_profile_json#>'{sessionCheckpoint,activeTurnId}'='null'::jsonb)
      and coalesce(c.runner_profile_json#>'{sessionCheckpoint,pendingRuntimeRequests}','[]'::jsonb) in ('null'::jsonb,'[]'::jsonb)
      and (nullif(c.runner_profile_json#>>'{sessionCheckpoint,providerSessionId}','') is not null
        or (jsonb_typeof(c.runner_profile_json#>'{sessionCheckpoint,providerIdentity}')='object'
          and c.runner_profile_json#>'{sessionCheckpoint,providerIdentity}'!='{}'::jsonb))
      and c.runner_profile_json#>'{sessionCheckpoint,providerSessionId}' is not distinct from p.runner_profile_json#>'{sessionCheckpoint,providerSessionId}'
      and c.runner_profile_json#>'{sessionCheckpoint,providerIdentity}' is not distinct from p.runner_profile_json#>'{sessionCheckpoint,providerIdentity}'
      and p.agent_id=c.agent_id and p.native_issue_id=c.native_issue_id and p.native_session_id=c.native_session_id
      and p.runner_instance_id=c.runner_instance_id and p.runtime_mode='native'
      and p.status='succeeded'
      and p.created_at<c.created_at and p.finished_at is not null and p.finished_at<=coalesce(c.started_at,c.created_at)
      and p.process_pid is not distinct from c.process_pid and p.process_group_id is not distinct from c.process_group_id
      and p.process_started_at is not distinct from c.process_started_at
      and f.phase='committed' and f.lease_owner is null and f.recovery_state is null and f.failure_code is null limit 1`);
  if (!prior) return null;
  try {
    if (!rebindNativeSessionCheckpoint({ previousRun: prior.source,
      currentExecution: parseNativeExecutionInput(prior.execution), executionTargetKind: "remote" })) return null;
  } catch { return null; }
  const checkpoint = await readNativeCheckpointPublicationIdentity(db, { companyId: scope.companyId, issueId: scope.issueId, runId: prior.id });
  if (!checkpoint || checkpoint.identity.runId !== prior.id || checkpoint.identity.runnerInstanceId !== scope.runnerInstanceId
    || checkpoint.identity.normalizedSessionId !== scope.nativeSessionId) return null;
  return { runId: prior.id, identity: checkpoint.identity };
}
