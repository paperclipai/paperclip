import type { Db } from "@paperclipai/db";
import { sql } from "drizzle-orm";
import { inspectNativeRunnerUpgradeHeader } from "../native-runtime/native-runner-checkpoint.js";
import { readNativeWorkspaceSyncReference } from "../native-runtime/native-workspace-sync.js";
import { currentNativeControllerIdentity } from "../native-runtime/native-restart-recovery.js";

const MAX_UPGRADE_RUNS = 1_000;
type Counters = { activeRuns: number; pendingWakes: number; draining: boolean };
type Candidate = { id: string; recoverable: boolean };

/** An observation for Cloud's optional rollout policy, never execution authority.
 * Only explicit upgrade probes read the database; ordinary drain reads stay local.
 * The checkpoint owner inspects only bounded header evidence; Runner owns its format.
 */
export async function readUpgradeReadiness(db: Db, input: {
  activeRunIds: ReadonlySet<string>;
  counters: () => Counters;
}) {
  const before = input.counters();
  const beforeIds = [...input.activeRunIds];
  const owner = await currentNativeControllerIdentity();
  const rows = await db.transaction(async tx => {
    await tx.execute(sql`set local statement_timeout = '2s'`);
    return tx.execute<Candidate & { companyId: string; issueId: string; runnerId: string; sessionId: string; workspace: unknown; material: Record<string, unknown> | null }>(sql`
    select r.id, r.company_id as "companyId", r.native_issue_id as "issueId",
      r.runner_instance_id as "runnerId", r.native_session_id as "sessionId",
      r.runner_profile_json->'nativeWorkspaceSync' as workspace,
      case when pg_column_size(c.material) <= 65536 and sum(pg_column_size(c.material)) over () <= 2097152 then c.material else null end as material, (
      r.runtime_mode = 'native' and a.adapter_type = 'paperclip_runner'
      and r.runner_instance_id is not null and r.native_session_id is not null
      and r.process_pid is not null and r.process_started_at is not null
      and f.controller_boot_id = ${owner.bootId}
      and f.lease_expires_at > clock_timestamp()
      and f.lease_owner is not null and f.controller_generation > 0
      and f.phase = 'observed' and f.result_id is null and f.failure_code is null
      and c.run_id is not null
    ) is true as recoverable
    from heartbeat_runs r join agents a on a.id = r.agent_id and a.company_id = r.company_id
    left join native_run_finalizations f on f.run_id = r.id and f.company_id = r.company_id
    left join native_runner_checkpoints c on c.run_id = r.id and c.company_id = r.company_id
      and c.issue_id = r.native_issue_id and c.part = 'header'
    where r.status = 'running'
    limit ${MAX_UPGRADE_RUNS + 1}`);
  }, { accessMode: "read only" });
  const candidates = rows.map(row => {
    const workspace = readNativeWorkspaceSyncReference(row.workspace);
    const identity = row.recoverable && row.material
      ? inspectNativeRunnerUpgradeHeader({ companyId: row.companyId, issueId: row.issueId, runId: row.id }, row.material) : null;
    return { id: row.id, recoverable: Boolean(workspace && identity && identity.runId === row.id
      && identity.runnerInstanceId === row.runnerId && identity.normalizedSessionId === row.sessionId
      && identity.environmentLeaseId === workspace.leaseId) };
  });
  return summarizeUpgradeReadiness({ rows: candidates, before, after: input.counters(),
    activeRunIds: [...new Set([...beforeIds, ...input.activeRunIds])], controllerBootId: owner.bootId });
}

export function summarizeUpgradeReadiness(input: {
  rows: readonly Candidate[]; before: Counters; after: Counters;
  activeRunIds: readonly string[]; controllerBootId: string;
}) {
  const eligible = new Set(input.rows.filter(row => row.recoverable).map(row => row.id));
  const observedIds = new Set(input.rows.map(row => row.id));
  const unknown = input.activeRunIds.filter(id => !observedIds.has(id)).length;
  const activeRuns = Math.max(input.rows.length + unknown, input.before.activeRuns, input.after.activeRuns);
  const recoverableRuns = eligible.size;
  const blockingRuns = activeRuns - recoverableRuns;
  const pendingWakes = Math.max(input.before.pendingWakes, input.after.pendingWakes);
  const draining = input.before.draining || input.after.draining;
  const truncated = input.rows.length > MAX_UPGRADE_RUNS;
  return { version: 1 as const, observedAt: new Date().toISOString(), controllerBootId: input.controllerBootId,
    ready: !draining && !truncated && blockingRuns === 0 && pendingWakes === 0,
    activeRuns, recoverableRuns, blockingRuns, pendingWakes, draining, truncated,
    supportedOutageMs: 300_000, recoveryGraceMs: 420_000 };
}
