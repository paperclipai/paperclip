import { idleWorkSnapshot } from "./task-admission.js";
import { readIdleLocalWork, type IdleLocalWork } from "./idle-local-work.js";
import { readIdleRoutineSchedule, type ScheduledWake } from "./idle-scheduled-work.js";
import { combineIdleSchedules, readIdleIssueSchedule } from "./idle-issue-schedule.js";
import type { Db } from "@paperclipai/db";
import { sql } from "drizzle-orm";

export interface IdleSleepDrainStatus {
  ownerId?: string;
  draining: boolean;
  startedAt: Date | null;
  expiresAt: Date | null;
  activeRuns: number;
  pendingWakes: number;
}

export interface IdleSleepSafety {
  version: 1 | 2;
  backgroundWork: "none" | "present" | "unknown";
  scheduledWake?: ScheduledWake;
}

export type InspectIdlePlugins = (hold: { ownerId: string; expiresAt: number }) => Promise<{
  backgroundWork: "none" | "present" | "unknown";
  pluginIds: string[];
}>;

// Retry promotion keeps its due date as history on the run. Only a terminal
// run finished at or after that date has consumed the schedule. Newer retry
// dates, unfinished runs and accounting work still require the instance.
function finishedRun(alias: string): string {
  return `${alias}.status IN ('succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted')
    AND ${alias}.finished_at IS NOT NULL
    AND (${alias}.scheduled_retry_at IS NULL OR ${alias}.scheduled_retry_at <= ${alias}.finished_at)
    AND ${alias}.cost_accounting_pending = false`;
}

// A failed turn may have successfully torn down its ephemeral allocation. A
// cleanup label alone is not provider termination proof. Require the exact
// host-owned receipt and finished run, and retain all cleanup/export intents.
// Aliases are fixed at the call sites, never supplied by a client.
function finishedFailedLease(alias: string): string {
  const receipt = `${alias}.metadata->'remoteExecutionTermination'`;
  return `${alias}.status = 'failed' AND ${alias}.lease_policy = 'ephemeral'
    AND ${alias}.cleanup_status = 'success' AND ${alias}.released_at IS NOT NULL
    AND COALESCE(${alias}.metadata->>'pendingCleanupInFlight', 'false') = 'false'
    AND NOT (COALESCE(${alias}.metadata, '{}'::jsonb) ?| ARRAY['nativeWorkspaceExportResume', 'sandboxStopAndRetain'])
    AND ${alias}.provider IS NOT NULL AND ${alias}.provider <> 'local'
    AND ${alias}.provider_lease_id IS NOT NULL AND ${alias}.provider_lease_id <> ''
    AND ${receipt}->>'schema' = 'paperclip.remote-termination.v1'
    AND ${receipt}->>'companyId' = ${alias}.company_id::text
    AND ${receipt}->>'runId' = ${alias}.heartbeat_run_id::text
    AND ${receipt}->>'leaseId' = ${alias}.id::text
    AND ${receipt}->>'provider' = ${alias}.provider
    AND ${receipt}->>'providerLeaseId' = ${alias}.provider_lease_id
    AND ${receipt}->>'state' IN ('stopped', 'destroyed')
    AND EXISTS (SELECT 1 FROM heartbeat_runs r WHERE r.id = ${alias}.heartbeat_run_id
      AND r.company_id = ${alias}.company_id
      AND ${finishedRun("r")})`;
}

// These are deliberately conservative. Completed agent runs and workspace
// operations are history, not reasons to keep an otherwise idle instance up.
// Other background features remain awake until their work and inbound events
// have a durable wake path. In particular, an empty in-memory run set is not
// evidence that a restarted process has no persisted work to recover.
const WORK_CHECKS = [
  `SELECT 1 FROM agents WHERE status = 'running' OR
    (status NOT IN ('terminated', 'paused', 'pending_approval') AND
     runtime_config->'heartbeat'->>'enabled' = 'true' AND
     COALESCE((runtime_config->'heartbeat'->>'intervalSec')::numeric, 0) > 0)`,
  `SELECT 1 FROM heartbeat_runs WHERE
    status NOT IN ('succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted')
    OR (scheduled_retry_at IS NOT NULL
      AND (finished_at IS NULL OR scheduled_retry_at > finished_at))
    OR cost_accounting_pending`,
  `SELECT 1 FROM agent_instruction_working_copies WHERE
    state NOT IN ('saved', 'unchanged', 'resolved', 'unavailable', 'conflict')
    OR process_stopped_at IS NULL OR next_attempt_at IS NOT NULL
    OR receipt ? 'baseline' OR receipt->>'cleanupPending' = 'true'`,
  `SELECT 1 FROM budget_reservations WHERE state NOT IN ('settled', 'released')`,
  // Persistent machine credentials can receive work without a human opening
  // the instance. They need an ingress wake contract before we can sleep.
  `SELECT 1 FROM agent_api_keys WHERE revoked_at IS NULL`,
  `SELECT 1 FROM board_api_keys WHERE revoked_at IS NULL
    AND (expires_at IS NULL OR expires_at > now())`,
  // Coalescing consumes a request into another run. Retain it as work until
  // both the request and that exact company/agent's run have finished.
  `SELECT 1 FROM agent_wakeup_requests w WHERE
    w.status NOT IN ('completed', 'failed', 'cancelled', 'skipped', 'timed_out', 'coalesced')
    OR (w.status = 'coalesced' AND (w.finished_at IS NULL OR NOT EXISTS (
      SELECT 1 FROM heartbeat_runs r WHERE r.id = w.run_id
        AND r.company_id = w.company_id AND r.agent_id = w.agent_id
        AND ${finishedRun("r")})))`,
  `SELECT 1 FROM issues WHERE status NOT IN ('done', 'cancelled')`,
  // A completed issue can still need its first watchdog review, including a
  // retry after immediate evaluation failed before creating a review/run.
  `SELECT 1 FROM issue_watchdogs WHERE status <> 'disabled'`,
  `SELECT 1 FROM workspace_operations WHERE status NOT IN ('succeeded', 'failed', 'cancelled')`,
  // A local directory has no independent worker. Keep unfamiliar providers,
  // runtime/command configuration, reopen fences and due cleanup awake. Runs,
  // operations, runtime services, retained leases and backup work are checked
  // separately; inspecting the row never deletes or shortens retained data.
  `SELECT 1 FROM execution_workspaces w WHERE (
    w.provider_type IN ('local_fs', 'git_worktree')
    AND w.strategy_type IN ('project_primary', 'git_worktree')
    AND w.mode IN ('inherit', 'shared_workspace', 'isolated_workspace', 'operator_branch', 'reuse_existing', 'agent_default')
    AND w.status IN ('active', 'idle', 'in_review', 'archived')
    AND (w.metadata IS NULL OR jsonb_typeof(w.metadata) = 'object')
    -- A shared workspace can inherit runtime configuration from its project.
    AND (w.mode <> 'shared_workspace' OR w.project_workspace_id IS NULL)
    AND (w.provider_ref IS NULL OR w.provider_ref = w.cwd)
    AND (w.cleanup_eligible_at IS NULL OR w.cleanup_eligible_at > now())
    AND COALESCE(w.metadata->>'reopenPendingConsumption', 'false') = 'false'
    AND (w.metadata->'config' IS NULL OR w.metadata->'config' = 'null'::jsonb
      OR (jsonb_typeof(w.metadata->'config') = 'object'
        AND CASE WHEN jsonb_typeof(w.metadata->'config') = 'object' THEN
          (w.metadata->'config') - ARRAY['environmentId', 'provisionCommand', 'runtimeProvisionCommand',
            'teardownCommand', 'cleanupCommand', 'workspaceRuntime', 'desiredState', 'serviceStates'] = '{}'::jsonb
          ELSE false END
        AND COALESCE(w.metadata->'config'->'workspaceRuntime', 'null'::jsonb) = 'null'::jsonb
        AND COALESCE(w.metadata->'config'->'serviceStates', 'null'::jsonb) IN ('null'::jsonb, '{}'::jsonb)
        AND COALESCE(w.metadata->'config'->>'desiredState', 'stopped') = 'stopped'
        AND COALESCE(w.metadata->'config'->>'provisionCommand', '') = ''
        AND COALESCE(w.metadata->'config'->>'runtimeProvisionCommand', '') = ''
        AND COALESCE(w.metadata->'config'->>'teardownCommand', '') = ''
        AND COALESCE(w.metadata->'config'->>'cleanupCommand', '') = ''))
    ) IS NOT TRUE`,
  `SELECT 1 FROM environment_leases l WHERE status NOT IN ('released', 'expired')
    AND (${finishedFailedLease("l")}) IS NOT TRUE`,
  `SELECT 1 FROM routines WHERE status NOT IN ('paused', 'archived')`,
  `SELECT 1 FROM routine_runs WHERE status NOT IN ('completed', 'failed', 'skipped', 'cancelled')`,
  `SELECT 1 FROM plugin_jobs WHERE status <> 'paused'`,
  `SELECT 1 FROM plugin_job_runs WHERE status NOT IN ('succeeded', 'failed', 'cancelled')`,
  `SELECT 1 FROM plugin_webhook_deliveries WHERE status NOT IN ('succeeded', 'failed')`,
  // Saved AI credentials have no independent worker. Login sessions, accepted
  // quota/refresh work and recovery journals have their own checks. Other
  // integrations still need an ingress/scheduler wake contract.
  `SELECT 1 FROM tool_connections WHERE status <> 'archived'
    AND NOT (status = 'active' AND connection_purpose = 'ai' AND transport = 'runtime_auth')`,
  `SELECT 1 FROM issue_recovery_actions WHERE status NOT IN ('resolved', 'cancelled')`,
  `SELECT 1 FROM status_cards WHERE archived_at IS NULL`,
  `SELECT 1 FROM external_objects WHERE NOT is_terminal OR next_refresh_at IS NOT NULL`,
  // Login history keeps its provider reference after teardown. A terminal
  // label alone is insufficient: require a finished, unclaimed session and
  // positive cleanup evidence for its resource in the same company/environment.
  // Cast only UUID-shaped session references, leaving both lease indexes usable.
  `SELECT 1 FROM adapter_auth_sessions s WHERE
    s.status NOT IN ('authenticated', 'completed', 'failed', 'timed_out', 'cancelled')
    OR s.finished_at IS NULL OR s.promotion_expires_at IS NOT NULL
    OR (s.provider_lease_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM environment_leases l WHERE l.company_id = s.company_id
        AND l.environment_id = s.environment_id
        AND (l.provider_lease_id = s.provider_lease_id OR l.id = CASE
          WHEN s.provider_lease_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          THEN s.provider_lease_id::uuid END)
        AND (l.status IN ('released', 'expired') OR (${finishedFailedLease("l")}))
        AND l.cleanup_status = 'success'
        AND l.released_at IS NOT NULL))
    OR (s.provider_lease_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM environment_leases l WHERE l.company_id = s.company_id
        AND l.environment_id = s.environment_id
        AND (l.provider_lease_id = s.provider_lease_id OR l.id = CASE
          WHEN s.provider_lease_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          THEN s.provider_lease_id::uuid END)
        AND ((l.status IN ('released', 'expired') OR (${finishedFailedLease("l")})) AND l.cleanup_status = 'success'
          AND l.released_at IS NOT NULL) IS NOT TRUE))`,
  // Answer delivery history is not work once its acknowledged handoff has
  // finished. Keep pending deliveries, unfinished target runs, and missing or
  // unfinished fallback wake receipts awake. Other work checks still apply.
  `SELECT 1 FROM issue_question_response_deliveries d WHERE
    d.status NOT IN ('delivered', 'fallback_queued', 'failed')
    OR (d.status IN ('delivered', 'fallback_queued') AND d.acknowledged_at IS NULL)
    OR (d.status = 'delivered' AND d.target_run_id IS NULL)
    OR (d.target_run_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM heartbeat_runs r WHERE r.id = d.target_run_id
        AND r.company_id = d.company_id
        AND ${finishedRun("r")}))
    OR (d.status = 'fallback_queued' AND d.target_run_id IS NULL AND NOT EXISTS (
      SELECT 1 FROM agent_wakeup_requests w WHERE w.company_id = d.company_id
        AND w.idempotency_key = 'question-response:' || d.interaction_id::text
        AND w.idempotency_key LIKE 'question-response:%'
        AND w.finished_at IS NOT NULL
        AND (w.status IN ('completed', 'failed', 'cancelled', 'skipped', 'timed_out')
          OR (w.status = 'coalesced' AND EXISTS (
            SELECT 1 FROM heartbeat_runs r WHERE r.id = w.run_id
              AND r.company_id = w.company_id AND r.agent_id = w.agent_id
              AND ${finishedRun("r")})))))`,
  // These less common work sources fail closed on any retained state. Their
  // terminal-state exceptions can be added with tests for the owning service.
  ...[
    "chat_endpoints", "chat_deliveries", "chat_publications", "chat_actions",
    "chat_completion_deliveries", "connection_event_deliveries",
    "connection_intent_deliveries", "tool_action_requests", "tool_action_deliveries",
    "workspace_runtime_services",
    "execution_workspace_runtime_leases", "pipeline_automation_executions",
    "native_run_finalizations", "company_transfer_runs", "decisions", "decision_effect_executions",
    "decision_archive_notification_outbox", "browser_use_sessions", "browser_use_runs",
    "browser_use_browsers", "environment_custom_image_setup_sessions", "feedback_exports",
    "company_secret_proposals",
    "mcp_oauth_grants", "mcp_mutation_receipts", "mcp_event_subscriptions",
    "mcp_event_deliveries", "mcp_attachment_uploads", "dot_agent_bindings",
    "dot_runner_assignments", "dot_runner_operations", "dot_mailbox_items",
  ].map((table) => `SELECT 1 FROM ${table}`),
] as const;

function sameQuietHold(before: IdleSleepDrainStatus, after: IdleSleepDrainStatus, now: number): boolean {
  return before.ownerId === after.ownerId && before.draining && after.draining && before.activeRuns === 0 && before.pendingWakes === 0
    && after.activeRuns === 0 && after.pendingWakes === 0
    && before.startedAt !== null && after.startedAt?.getTime() === before.startedAt.getTime()
    && (after.expiresAt === null || after.expiresAt.getTime() > now);
}

/** Inventory persisted work after the task-drain admission hold lands.
 * Only a caller holding the exact idle owner may receive an empty report.
 */
export async function readIdleSleepSafety(
  db: Db,
  getDrainStatus: () => IdleSleepDrainStatus,
  now: () => number = Date.now,
  ownerId?: string,
  inspectLocalWork: () => Promise<IdleLocalWork> = readIdleLocalWork,
  inspectPlugins?: InspectIdlePlugins,
  prepareBackup?: () => Promise<boolean>,
  scheduledRoutines = false,
  scheduledIssueMonitors = false,
): Promise<IdleSleepSafety> {
  const unknown: IdleSleepSafety = { version: 1, backgroundWork: "unknown" };
  const before = getDrainStatus();
  const localBefore = idleWorkSnapshot();
  if (!sameQuietHold(before, before, now())) return unknown;
  try {
    // Reject known local blockers before querying (and potentially waking)
    // the tenant database. Keep the final inspection below as a second fence.
    const localFirst = await inspectLocalWork();
    if (localFirst !== "none") return { version: 1, backgroundWork: localFirst };
    let quietPlugins: string[] = [];
    if (inspectPlugins) {
      if (!ownerId || ownerId !== before.ownerId || before.expiresAt === null || localBefore.active !== 0) return unknown;
      const pluginWork = await inspectPlugins({ ownerId, expiresAt: before.expiresAt.getTime() });
      if (pluginWork.backgroundWork !== "none") return { version: 1, backgroundWork: pluginWork.backgroundWork };
      quietPlugins = pluginWork.pluginIds;
    }
    let scheduledWake: ScheduledWake | undefined;
    const blocked = await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
      const checks = WORK_CHECKS.filter(query =>
        (!scheduledRoutines || query !== `SELECT 1 FROM routines WHERE status NOT IN ('paused', 'archived')`)
        && (!scheduledIssueMonitors || query !== `SELECT 1 FROM issues WHERE status NOT IN ('done', 'cancelled')`))
        .map((query) => sql`EXISTS (${sql.raw(query)})`);
      // Only the current worker's owned runtime drain can exempt a plugin.
      // Missing workers, old SDKs, and newly installed plugins still block.
      checks.push(quietPlugins.length === 0
        ? sql`EXISTS (SELECT 1 FROM plugins WHERE status <> 'disabled')`
        : sql`EXISTS (SELECT 1 FROM plugins WHERE status <> 'disabled' AND id NOT IN (${sql.join(quietPlugins.map((id) => sql`${id}::uuid`), sql`, `)}))`);
      const rows = await tx.execute<{ blocked: boolean }>(sql`SELECT ${sql.join(checks, sql` OR `)} AS blocked`);
      if (rows.length !== 1 || typeof rows[0]?.blocked !== "boolean") return undefined;
      if (rows[0].blocked) return true;
      if (scheduledRoutines) {
        if (!ownerId || ownerId !== before.ownerId) return undefined;
        const schedule = await readIdleRoutineSchedule(tx, ownerId, now());
        if (schedule.blocked) return true;
        scheduledWake = schedule.scheduledWake;
      }
      if (scheduledIssueMonitors) {
        if (!scheduledRoutines || !ownerId || ownerId !== before.ownerId) return undefined;
        const schedule = await readIdleIssueSchedule(tx, ownerId, now());
        if (schedule.blocked) return true;
        scheduledWake = combineIdleSchedules(scheduledWake, schedule.scheduledWake);
      }
      return false;
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
    if (blocked === undefined || !sameQuietHold(before, getDrainStatus(), now())) return unknown;
    if (blocked) return { version: 1, backgroundWork: "present" };
    if (!ownerId || ownerId !== before.ownerId || before.expiresAt === null || localBefore.active !== 0) return unknown;
    let expectedGeneration = localBefore.generation;
    if (prepareBackup) {
      if (!sameQuietHold(before, getDrainStatus(), now()) ||
          idleWorkSnapshot().generation !== expectedGeneration || idleWorkSnapshot().active !== 0) return unknown;
      // The runner owns exactly one tracked-work receipt through dump,
      // archive verification and fsync. Its start/finish are the only work
      // allowed during this scan. Any concurrent work invalidates the dump.
      if (!(await prepareBackup())) return unknown;
      expectedGeneration += 2;
    }
    const local = await inspectLocalWork();
    const after = getDrainStatus();
    const localAfter = idleWorkSnapshot();
    if (!sameQuietHold(before, after, now()) || localAfter.active !== 0 ||
        expectedGeneration !== localAfter.generation) return unknown;
    if (local === "none" && scheduledWake) {
      if (Date.parse(scheduledWake.nextWakeAt) <= now()) return { version: 1, backgroundWork: "present" };
      return { version: 2, backgroundWork: "none", scheduledWake };
    }
    return { version: 1, backgroundWork: local };

  } catch {
    // Missing migrations, unknown state, malformed configuration, timeouts and
    // database failures never authorize stopping the application. Do not leak
    // SQL, configuration or tenant data through this control response.
    return unknown;
  }
}
