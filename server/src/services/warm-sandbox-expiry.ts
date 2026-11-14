import { PAPERCLIP_RUNNER_IDLE_TIMEOUT_MAX_MS } from "@paperclipai/adapter-utils";
import { and, asc, eq, sql } from "drizzle-orm";
import { environmentLeases, type Db } from "@paperclipai/db";
import { REUSABLE_SANDBOX_KEPT_AFTER_REPLACEMENT_KEY } from "./reusable-sandbox-kept-marker.js";
import { prepareSupersededWarmSandboxStop } from "./sandbox-stop-and-retain.js";

/**
 * Warm sandbox expiry.
 *
 * A warm run ends with its reusable lease `retained` and its sandbox still
 * running, so the next turn on the same task starts warm. Once the run's warm
 * window has passed, nothing needs that sandbox running: the warm runner has
 * already gone idle. Before this, only the provider's own idle auto-stop ever
 * stopped it, and any provider activity (or a provider with no auto-stop) kept
 * it running, and billing, indefinitely.
 *
 * The warm window is the run's resolved runner idle timeout
 * (`resolveWarmRunnerIdleTimeoutMsForRun`). Acquisition saves it on the lease; the window starts when
 * the run releases the lease (`lastUsedAt`). A lease saved before the window was
 * recorded uses the longest window a run can configure, so it is never stopped
 * early.
 *
 * Due sandboxes are stopped through the existing stop-only contract
 * (`prepareSupersededWarmSandboxStop`): the lease moves to `pending_cleanup`
 * with a stop-and-retain intent, the environment cleanup sweep asks the
 * provider to stop the exact sandbox, and the confirmed stop releases the lease
 * as stopped and kept, which the next run on the task resumes. Nothing here
 * calls a provider or lists provider resources: only this instance's own lease
 * rows are judged, so another company's or environment's sandbox is never
 * touched.
 *
 * The environment cleanup worker wakes at `nextWarmSandboxStopAt` (and on every
 * lease release, and at boot), so an idle instance schedules one deadline and
 * never scans.
 */

/** Lease metadata key holding the run's warm window (ms), saved at acquisition. */
export const WARM_SANDBOX_IDLE_TIMEOUT_KEY = "warmSandboxIdleTimeoutMs";

/** Marker on the stop-and-retain intent: the warm window ended. */
export const WARM_WINDOW_EXPIRED_KEY = "warmWindowExpired";

export const WARM_SANDBOX_IDLE_CLOSE_MARGIN_MS = 2 * 60_000;

const STOP_PAGE_SIZE = 25;

function positiveWindowSql(value: ReturnType<typeof sql>) {
  return sql`case when jsonb_typeof(${value}) = 'number' and (${value})::numeric > 0
    then (${value})::numeric end`;
}

/** Epoch ms when the lease's warm window ends. */
export function warmWindowEndsAtSql() {
  const window = sql`least(coalesce(
    ${positiveWindowSql(sql`${environmentLeases.metadata}->${WARM_SANDBOX_IDLE_TIMEOUT_KEY}`)},
    ${PAPERCLIP_RUNNER_IDLE_TIMEOUT_MAX_MS}), ${PAPERCLIP_RUNNER_IDLE_TIMEOUT_MAX_MS})`;
  return sql`(extract(epoch from ${environmentLeases.lastUsedAt}) * 1000 + ${window} + ${WARM_SANDBOX_IDLE_CLOSE_MARGIN_MS})`;
}

/**
 * A retained warm sandbox that only its own ended run references. Anything
 * still using the sandbox holds it: a live run's lease on the same sandbox, a
 * run on the task that is starting now (it may be resuming this sandbox before
 * its lease is written), or an operation already in progress on the lease.
 * Superseded and replaced leases belong to the retained-orphan settle.
 * Plugin Runner task leases (`driver: "plugin"`) are excluded: their cleanup
 * releases through the plugin rather than the verified stop-only contract, so
 * it cannot promise to keep the task's files.
 */
export function warmSandboxExpiryCandidateCondition() {
  return and(
    eq(environmentLeases.status, "retained"),
    eq(environmentLeases.leasePolicy, "reuse_by_environment"),
    sql`coalesce(${environmentLeases.metadata}->>'driver', '') <> 'plugin'`,
    sql`${environmentLeases.heartbeatRunId} is not null`,
    sql`${environmentLeases.provider} is not null and ${environmentLeases.provider} <> 'local'`,
    sql`${environmentLeases.providerLeaseId} is not null`,
    sql`not (coalesce(${environmentLeases.metadata}, '{}'::jsonb) ?| array['nativeWorkspaceExportResume',
      'sandboxStopAndRetain', 'workspaceRestoreRecovery', 'workspaceRecoveryCleanup', 'runnerTaskSourceConsumer',
      'portableTaskSuccessor', 'reusableLeaseSuccessor', 'reusableSandboxLeaseSuperseded',
      ${REUSABLE_SANDBOX_KEPT_AFTER_REPLACEMENT_KEY}])`,
    sql`coalesce(${environmentLeases.metadata}->>'pendingCleanupInFlight', 'false') <> 'true'`,
    sql`coalesce(${environmentLeases.metadata}#>>'{legacyShutdownWorkspaceSettlement,state}', '') <> 'pending'`,
    sql`not exists (select 1 from heartbeat_runs run where run.id = ${environmentLeases.heartbeatRunId}
      and run.status not in ('succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted'))`,
    sql`not exists (select 1 from environment_leases other where other.id <> ${environmentLeases.id}
      and other.provider = ${environmentLeases.provider} and other.provider_lease_id = ${environmentLeases.providerLeaseId}
      and other.status in ('active', 'retained', 'pending_cleanup'))`,
    sql`not exists (select 1 from heartbeat_runs other where other.company_id = ${environmentLeases.companyId}
      and other.id <> ${environmentLeases.heartbeatRunId} and other.status = 'running'
      and ${environmentLeases.issueId} is not null
      and (other.issue_id = ${environmentLeases.issueId} or other.native_issue_id = ${environmentLeases.issueId}))`,
  );
}

/** When the next retained warm sandbox's window ends, or null when none waits. */
export async function nextWarmSandboxStopAt(db: Db): Promise<number | null> {
  const [row] = await db.select({ next: sql<string | null>`min(${warmWindowEndsAtSql()})` })
    .from(environmentLeases).where(warmSandboxExpiryCandidateCondition());
  return row?.next == null ? null : Number(row.next);
}

/**
 * Hand every retained warm sandbox whose window has ended to the stop-only
 * cleanup. Returns how many were handed over; the cleanup sweep that follows
 * dispatches their stops at once.
 */
export async function stopWarmSandboxesPastWindow(db: Db, now = new Date()): Promise<{ stopping: number }> {
  const ends = warmWindowEndsAtSql();
  const due = await db.select({ lease: environmentLeases, endsAt: sql<string>`${ends}` }).from(environmentLeases)
    .where(and(warmSandboxExpiryCandidateCondition(), sql`${ends} <= ${now.getTime()}`))
    .orderBy(asc(environmentLeases.lastUsedAt)).limit(STOP_PAGE_SIZE);
  let stopping = 0;
  for (const { lease, endsAt } of due) {
    // The stop intent is a compare-and-swap on the exact retained row, so a run
    // that reacquired the sandbox since this read keeps it.
    const prepared = await prepareSupersededWarmSandboxStop(db, lease, {
      [WARM_WINDOW_EXPIRED_KEY]: true, warmWindowEndedAt: new Date(Number(endsAt)).toISOString(),
    });
    if (prepared) stopping++;
  }
  return { stopping };
}

export async function stopWarmSandboxesPastWindowWhenDue(db: Db, now = new Date()): Promise<{ stopping: number }> {
  const next = await nextWarmSandboxStopAt(db);
  if (next === null || next > now.getTime()) return { stopping: 0 };
  return await stopWarmSandboxesPastWindow(db, now);
}

/** Lease metadata that records the run's warm window, or nothing for a run
 * that keeps no warm runner on the sandbox. */
export function warmSandboxWindowMetadata(warmRunnerIdleTimeoutMs: number | undefined): Record<string, number> {
  return warmRunnerIdleTimeoutMs !== undefined && Number.isSafeInteger(warmRunnerIdleTimeoutMs) && warmRunnerIdleTimeoutMs > 0
    ? { [WARM_SANDBOX_IDLE_TIMEOUT_KEY]: warmRunnerIdleTimeoutMs } : {};
}
