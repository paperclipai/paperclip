import type { Db } from "@paperclipai/db";
import { sql } from "drizzle-orm";
import { remoteWorkspaceRunReferenceSchema } from "@paperclipai/shared";
import { inspectNativeRunnerUpgradeHeader, NATIVE_CHECKPOINT_HEADER_INSPECTION_MAX_BYTES,
  NATIVE_CHECKPOINT_INSPECTION_TOTAL_MAX_BYTES } from "../native-runtime/native-runner-checkpoint.js";
import { readNativeWorkspaceSyncReference } from "../native-runtime/native-workspace-sync.js";
import { REMOTE_RUNNER_RECONNECT_GRACE_MS } from "../native-runtime/native-runner-recovery-contract.js";
import { currentNativeControllerIdentity } from "../native-runtime/native-restart-recovery.js";
import { readNativeControllerRecoveryInventory } from "../native-runtime/native-controller-recovery-inventory.js";
import { readNativeFinalizationUpgradeReadiness } from "../native-runtime/native-finalization-upgrade-readiness.js";
import { NATIVE_PREPARATION_FENCING_VERSION } from "../native-runtime/native-active-runs.js";
import { PROCESS_IDENTITY_RECORDED, PROCESS_START_REQUESTED } from "../native-local-process-stop.js";

const MAX_UPGRADE_RUNS = 1_000;
const POST_RESULT_INSPECTION_BUDGET_MS = 2_000;
/** `unsavedWakes`: pending wakes whose wake and run have not committed. A caller
 * that does not report it leaves every pending wake unsaved. */
type Counters = { activeRuns: number; pendingWakes: number; unsavedWakes?: number; draining: boolean };
/** `restartable`: the row and its events show no launched agent work, so a replacement
 * server starts the same work again. It is weaker than `recoverable` and never implies it. */
type Candidate = { id: string; recoverable: boolean; restartable?: boolean; retainedUnowned?: boolean };

/** An observation for Cloud's optional rollout policy, never execution authority.
 * Only explicit upgrade probes read the database; ordinary drain reads stay local.
 * The checkpoint owner inspects only bounded header evidence; Runner owns its format.
 */
export async function readUpgradeReadiness(db: Db, input: {
  activeRunIds: ReadonlySet<string>;
  counters: () => Counters;
}) {
  const inspectionDeadline = performance.now() + POST_RESULT_INSPECTION_BUDGET_MS;
  const before = input.counters();
  const beforeIds = [...input.activeRunIds];
  const owner = await currentNativeControllerIdentity();
  const rows = await db.transaction(async tx => {
    await tx.execute(sql`set local statement_timeout = '2s'`);
    return tx.execute<Candidate & { companyId: string; issueId: string; runnerId: string; sessionId: string; workspace: unknown; remoteWorkspace: unknown; hasRemoteWorkspace: boolean; hasResult: boolean; pluginLeaseId: string | null; material: Record<string, unknown> | null }>(sql`
    select r.id, r.company_id as "companyId", r.native_issue_id as "issueId",
      r.runner_instance_id as "runnerId", r.native_session_id as "sessionId",
      r.runner_profile_json->'nativeWorkspaceSync' as workspace,
      r.runner_profile_json->'remoteWorkspace' as "remoteWorkspace",
      r.runner_profile_json ? 'remoteWorkspace' as "hasRemoteWorkspace", p.id as "pluginLeaseId",
      f.result_id is not null as "hasResult",
      (r.runtime_mode = 'native' and a.adapter_type = 'paperclip_runner' and r.native_phase = 'observed'
        and f.recovery_state = 'awaiting_evidence' and f.phase = 'observed' and f.result_id is null and f.failure_code is null
        and f.controller_boot_id is not null and f.controller_boot_id <> '' and f.controller_boot_id <> ${owner.bootId}
        and f.controller_generation > 0 and f.lease_owner is not null and f.lease_owner <> ''
        and f.lease_expires_at <= clock_timestamp()
        and r.process_pid is null and r.process_started_at is null and c.run_id is null
      ) is true as "retainedUnowned",
      case when pg_column_size(c.material) <= ${NATIVE_CHECKPOINT_HEADER_INSPECTION_MAX_BYTES}
        and sum(pg_column_size(c.material)) over () <= ${NATIVE_CHECKPOINT_INSPECTION_TOTAL_MAX_BYTES} then c.material else null end as material, (
      r.runtime_mode = 'native' and a.adapter_type = 'paperclip_runner'
      and r.runner_instance_id is not null and r.native_session_id is not null
      and r.process_pid is not null and r.process_started_at is not null
      and f.controller_boot_id = ${owner.bootId}
      and f.lease_expires_at > clock_timestamp()
      and f.lease_owner is not null and f.controller_generation > 0
      and f.phase = 'observed' and f.result_id is null and f.failure_code is null
      and c.run_id is not null
    ) is true as recoverable, (
      -- Nothing has reached a runner or a provider: no process identity, no provider
      -- session, no checkpoint, no dispatched runner task and no execution-start event
      -- (the executor records the start request before any backend may spawn a runner).
      -- Restart recovery proves the same facts before it starts such a run again.
      a.adapter_type = 'paperclip_runner'
      and r.process_pid is null and r.process_group_id is null and r.process_started_at is null
      and r.session_id_before is null and r.session_id_after is null
      and c.run_id is null and p.id is null
      and ((r.runtime_mode = 'native' and r.native_phase = 'observed'
          and r.runner_profile_json->>'nativePreparationFencingVersion' = ${String(NATIVE_PREPARATION_FENCING_VERSION)}
          and f.phase = 'observed' and f.result_id is null and f.failure_code is null)
        or (r.runtime_mode = 'legacy' and r.execution_stage = 'preparing' and r.controller_boot_id is not null))
      and not exists (select 1 from heartbeat_run_events e
        where e.company_id = r.company_id and e.run_id = r.id and (e.source_event_id is not null
          or e.event_type in ('adapter.invoke', ${PROCESS_START_REQUESTED}, ${PROCESS_IDENTITY_RECORDED}, 'tool.execution.started')))
    ) is true as restartable
    from heartbeat_runs r join agents a on a.id = r.agent_id and a.company_id = r.company_id
    left join native_run_finalizations f on f.run_id = r.id and f.company_id = r.company_id
    left join native_runner_checkpoints c on c.run_id = r.id and c.company_id = r.company_id
      and c.issue_id = r.native_issue_id and c.part = 'header'
    left join lateral (select l.id from environment_leases l
      where l.company_id = r.company_id and l.heartbeat_run_id = r.id and l.status = 'active'
        and l.issue_id = r.native_issue_id and l.metadata->>'agentId' = r.agent_id::text
        and l.released_at is null and l.cleanup_status is null
        and (l.expires_at is null or l.expires_at > clock_timestamp())
        and l.metadata->>'runnerTaskLease' = 'true' and l.metadata->>'runnerTaskDispatched' = 'true'
        and coalesce(l.metadata->>'runnerTaskExecutionStopped', 'false') != 'true'
        and coalesce(l.metadata->>'runnerTaskRetiring', 'false') != 'true'
      order by l.created_at desc limit 1) p on true
    where r.status = 'running'
    limit ${MAX_UPGRADE_RUNS + 1}`);
  }, { accessMode: "read only" });
  const candidates: Candidate[] = [];
  for (const row of rows) {
    const remote = remoteWorkspaceRunReferenceSchema.safeParse(row.remoteWorkspace);
    // A remote reference owns the logical workspace identity. Corruption or conflicting
    // plugin authority must not fall back to a different recoverable-looking record.
    const workspaceId = row.hasRemoteWorkspace
      ? remote.success && !row.pluginLeaseId ? remote.data.workspaceId : null
      : row.pluginLeaseId ?? readNativeWorkspaceSyncReference(row.workspace)?.workspaceId;
    const identity = (row.recoverable || row.hasResult) && row.material
      ? inspectNativeRunnerUpgradeHeader({ companyId: row.companyId, issueId: row.issueId, runId: row.id }, row.material) : null;
    const bound = Boolean(workspaceId && identity && identity.runId === row.id
      && identity.runnerInstanceId === row.runnerId && identity.normalizedSessionId === row.sessionId
      && identity.environmentLeaseId === workspaceId);
    const finalization = bound && row.hasResult && remote.success && !row.pluginLeaseId
      && performance.now() < inspectionDeadline
      ? await readNativeFinalizationUpgradeReadiness(db, { companyId: row.companyId, runId: row.id,
        controller: owner, supportedOutageMs: 300_000 }).catch(() => false) : false;
    candidates.push({ id: row.id, recoverable: bound && (row.recoverable || finalization),
      restartable: row.restartable === true, retainedUnowned: row.retainedUnowned });
  }
  // Additive evidence does not strengthen or redefine the existing ready flag.
  const retained = await readNativeControllerRecoveryInventory(db).catch(() => ({
    version: 1 as const, observedAt: new Date().toISOString(), coverage: "unknown" as const,
    reasons: { inventory_unavailable: 1 }, fullPayloadsValidated: false as const,
  }));
  const summary = summarizeUpgradeReadiness({ rows: candidates, before, after: input.counters(),
    activeRunIds: [...new Set([...beforeIds, ...input.activeRunIds])], controllerBootId: owner.bootId });
  return { ...summary, nativeControllerRecovery: { activeExecutionAdoption: {
    recoverableRuns: summary.recoverableRuns, blockingRuns: summary.blockingRuns,
    retainedBlockedRuns: summary.retainedBlockedRuns, truncated: summary.truncated,
  }, retained } };
}

export function summarizeUpgradeReadiness(input: {
  rows: readonly Candidate[]; before: Counters; after: Counters;
  activeRunIds: readonly string[]; controllerBootId: string;
}) {
  const activeIds = new Set(input.activeRunIds);
  const retained = input.rows.filter(row => row.retainedUnowned === true && !activeIds.has(row.id));
  const executions = input.rows.filter(row => row.retainedUnowned !== true || activeIds.has(row.id));
  const eligible = new Set(executions.filter(row => row.recoverable).map(row => row.id));
  const observedIds = new Set(executions.map(row => row.id));
  const unknown = input.activeRunIds.filter(id => !observedIds.has(id)).length;
  const activeRuns = Math.max(executions.length + unknown, input.before.activeRuns, input.after.activeRuns);
  const recoverableRuns = eligible.size;
  const blockingRuns = activeRuns - recoverableRuns;
  const pendingWakes = Math.max(input.before.pendingWakes, input.after.pendingWakes);
  const draining = input.before.draining || input.after.draining;
  const truncated = input.rows.length > MAX_UPGRADE_RUNS;
  // Additive verdict for a graceful server replacement. It separates work a swap would
  // lose from work that is only in flight, and leaves the version 1 fields above as they were.
  // - Restartable runs have launched no agent work; restart recovery starts them again.
  // - Pending wakes are admissions in flight in this process. A saved one has committed
  //   its queued run, which the next server dispatches at startup. An unsaved one exists
  //   only in memory: shutdown waits a bounded time for it, so it can be lost and blocks.
  // - Everything else without recovery evidence, including an execution this report
  //   could not observe, would lose work and blocks.
  const restartableRuns = executions.filter(row => row.restartable === true && !eligible.has(row.id)).length;
  const handoffBlockingRuns = blockingRuns - restartableRuns;
  const unsavedWakes = Math.max(...[input.before, input.after].map(counters => {
    const unsaved = counters.unsavedWakes ?? counters.pendingWakes;
    return Number.isSafeInteger(unsaved) && unsaved >= 0 && unsaved <= counters.pendingWakes ? unsaved : counters.pendingWakes;
  }));
  const handoff = { version: 1 as const,
    ready: !draining && !truncated && handoffBlockingRuns === 0 && unsavedWakes === 0,
    recoverableRuns, restartableRuns, blockingRuns: handoffBlockingRuns, pendingWakes, unsavedWakes };
  return { version: 1 as const, observedAt: new Date().toISOString(), controllerBootId: input.controllerBootId,
    ready: !draining && !truncated && blockingRuns === 0 && pendingWakes === 0,
    activeRuns, recoverableRuns, blockingRuns, retainedBlockedRuns: retained.length, pendingWakes, draining, truncated,
    supportedOutageMs: 300_000, recoveryGraceMs: REMOTE_RUNNER_RECONNECT_GRACE_MS, handoff };
}
