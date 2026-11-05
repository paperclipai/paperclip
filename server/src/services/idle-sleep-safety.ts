import { readIdleDeadlineProof, deadlineWorkReplacement, type IdleDeadlineProof } from "./idle-deadline-proof.js";
import type { DomainScheduledWake, IdleDeadlineReceipt } from "./idle-deadline-types.js";
import type { IdlePluginCatalogEntry } from "./plugin-idle-catalog.js";
import type { ApiWakeAdmission } from "./idle-api-wake-admission.js";
import { readIdleIncomingWakeProof, incomingWakeWorkQuery, type IdleIncomingWakeProof } from "./idle-incoming-wake.js";
import type { VerifiedIdleCapabilities, IdleIncomingWakeCapability } from "./idle-incoming-wake-capability.js";
import { idleWorkSnapshot } from "./task-admission.js";
import { readIdleLocalWork, type IdleLocalWork } from "./idle-local-work.js";
import { readIdleRoutineSchedule, type ScheduledWake } from "./idle-scheduled-work.js";
import { combineIdleSchedules, readIdleIssueSchedule } from "./idle-issue-schedule.js";
import { connectionDeliveryWaitingForResponse, finishedIdleRun as finishedRun, finishedIdleWake, finishedFailedIdleLease as finishedFailedLease, passiveBoardRecovery } from "./idle-work-proof.js";
import type { Db } from "@paperclipai/db";
import { sql, type SQLWrapper } from "drizzle-orm";
import { createIdleSleepDiagnostics, type IdleSleepDiagnosticSink, type IdleSleepDiagnostics } from "./idle-sleep-diagnostics.js";
import { verifiedResourceCleanup } from "./cleanup-verification-proof.js";
import { companyHoldMismatch } from "../modules/agent-lifecycle/index.js";
import { pendingBudgetRunCancellationPredicate } from "./heartbeat/budget-cancellation.js";
import { nativeResponsePresentationPendingQuery } from "./native-runtime/native-response-presentation-query.js";
import { passiveIdleConversation } from "./conversation-idle-proof.js";
import { idleChatHistoryChecks } from "./chat-channels/idle-history-proof.js";
import { idleToolActionHistoryChecks } from "./tool-action-idle-proof.js";
import { idleBrowserHistoryChecks } from "./browser-use-idle-proof.js";
import { idleDecisionHistoryChecks } from "./decision-idle-proof.js";
import { idleWorkspaceHistoryChecks } from "./workspace-history-idle-proof.js";
import { idleMcpHistoryChecks } from "./public-mcp/idle-history-proof.js";
import { idleExternalAgentHistoryChecks } from "../modules/external-agents/index.js";

export const completedHistoryChecks = [
  ...idleChatHistoryChecks, ...idleToolActionHistoryChecks, ...idleBrowserHistoryChecks,
  ...idleDecisionHistoryChecks, ...idleWorkspaceHistoryChecks, ...idleMcpHistoryChecks,
  ...idleExternalAgentHistoryChecks,
] as const;

const ordinaryIssues = `SELECT 1 FROM issues i WHERE i.status NOT IN ('done', 'cancelled')
  AND (${passiveIdleConversation('i')}) IS NOT TRUE`;

export interface IdleSleepDrainStatus {
  ownerId?: string;
  draining: boolean;
  startedAt: Date | null;
  expiresAt: Date | null;
  activeRuns: number;
  pendingWakes: number;
}

export interface IdleSleepSafety {
  version: 1 | 2 | 3;
  backgroundWork: "none" | "present" | "unknown";
  scheduledWake?: ScheduledWake | DomainScheduledWake;
  diagnostics?: IdleSleepDiagnostics;
  incomingWake?: IdleIncomingWakeCapability;
  deadlineProof?: IdleDeadlineReceipt;
  apiWakeAdmission?: ApiWakeAdmission;
}

export type InspectIdlePlugins = (hold: { ownerId: string; expiresAt: number }) => Promise<{
  backgroundWork: "none" | "present" | "unknown";
  pluginIds: string[];
  catalogGeneration?: string;
  catalog?: IdlePluginCatalogEntry[];
}>;

// A failed turn may have successfully torn down its ephemeral allocation. A
// cleanup label alone is not provider termination proof. Require the exact
// host-owned receipt and finished run, and retain all cleanup/export intents.
// Aliases are fixed at the call sites, never supplied by a client.

// These are deliberately conservative. Completed agent runs and workspace
// operations are history, not reasons to keep an otherwise idle instance up.
// Other background features remain awake until their work and inbound events
// have a durable wake path. In particular, an empty in-memory run set is not
// evidence that a restarted process has no persisted work to recover.
const workCheck = (reason: string, query: string | SQLWrapper) => ({ reason, query: typeof query === "string" ? sql.raw(query) : query });

const WORK_CHECKS = [
  workCheck("native_event_cursor_rebuild", `SELECT 1 FROM heartbeat_runs WHERE event_cursor_rebuild_pending = true`),
  workCheck("agents.execution_or_timer", `SELECT 1 FROM agents WHERE status = 'running' OR
    (status NOT IN ('terminated', 'paused', 'pending_approval') AND
     runtime_config->'heartbeat'->>'enabled' = 'true' AND
     COALESCE((runtime_config->'heartbeat'->>'intervalSec')::numeric, 0) > 0)`),
  workCheck("heartbeat_runs", `SELECT 1 FROM heartbeat_runs WHERE
    status NOT IN ('succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted')
    OR (scheduled_retry_at IS NOT NULL
      AND (finished_at IS NULL OR scheduled_retry_at > finished_at))
    OR cost_accounting_pending`),
  workCheck("agent_instruction_working_copies", `SELECT 1 FROM agent_instruction_working_copies WHERE
    state NOT IN ('saved', 'unchanged', 'resolved', 'unavailable', 'conflict')
    OR process_stopped_at IS NULL OR next_attempt_at IS NOT NULL
    OR receipt ? 'baseline' OR receipt->>'cleanupPending' = 'true'`),
  workCheck("sandbox_creation_operations", `SELECT 1 FROM sandbox_creation_operations WHERE state IN ('pending', 'needs_reconciliation')`),
  workCheck("budget_reservations", `SELECT 1 FROM budget_reservations WHERE state NOT IN ('settled', 'released')`),
  workCheck("budget_policies", `SELECT 1 FROM budget_policies WHERE enforcement_version > enforcement_delivered_version`),
  workCheck("agents.lifecycle", `SELECT 1 FROM agents WHERE lifecycle_state IN
    ('preparing', 'verifying', 'pausing', 'resuming', 'terminating', 'cleaning_up')`),
  workCheck("decision_invocations", `SELECT 1 FROM decision_invocations WHERE status = 'running'`),
  workCheck("prompt_injection_invocations", `SELECT 1 FROM prompt_injection_invocations WHERE status = 'running'`),
  // Persistent machine credentials can receive work without a human opening
  // the instance. They need an ingress wake contract before we can sleep.
  workCheck("agent_api_keys", incomingWakeWorkQuery("agent_api_keys")!),
  workCheck("board_api_keys", incomingWakeWorkQuery("board_api_keys")!),
  // Coalescing consumes a request into another run. Retain it as work until
  // both the request and that exact company/agent's run have finished.
  workCheck("agent_wakeup_requests", `SELECT 1 FROM agent_wakeup_requests w WHERE
    w.status NOT IN ('completed', 'failed', 'cancelled', 'skipped', 'timed_out', 'coalesced')
    OR (w.status = 'coalesced' AND (w.finished_at IS NULL OR NOT EXISTS (
      SELECT 1 FROM heartbeat_runs r WHERE r.id = w.run_id
        AND r.company_id = w.company_id AND r.agent_id = w.agent_id
        AND ${finishedRun("r")})))`),
  workCheck("issues", ordinaryIssues),
  // A completed issue can still need its first watchdog review, including a
  // retry after immediate evaluation failed before creating a review/run.
  workCheck("issue_watchdogs", `SELECT 1 FROM issue_watchdogs WHERE status <> 'disabled'`),
  workCheck("workspace_operations", `SELECT 1 FROM workspace_operations WHERE status NOT IN ('succeeded', 'failed', 'cancelled')`),
  // A local directory has no independent worker. Keep unfamiliar providers,
  // runtime/command configuration, reopen fences and due cleanup awake. Runs,
  // operations, runtime services, retained leases and backup work are checked
  // separately; inspecting the row never deletes or shortens retained data.
  workCheck("execution_workspaces", `SELECT 1 FROM execution_workspaces w WHERE (
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
    ) IS NOT TRUE`),
  workCheck("environment_leases", `SELECT 1 FROM environment_leases l WHERE status NOT IN ('released', 'expired')
    AND (${finishedFailedLease("l")}) IS NOT TRUE`),
  workCheck("environment_custom_image_setup_sessions", `SELECT 1 FROM environment_custom_image_setup_sessions s WHERE
    (s.status IN ('promoted', 'cancelled', 'timed_out', 'failed') AND s.finished_at IS NOT NULL
      AND s.connection_secret_ref IS NULL AND (${verifiedResourceCleanup('s', 'image_setup')})) IS NOT TRUE`),
  // An unconfigured Slack draft has no provider identity or inbound runtime.
  // Setup still wakes through normal browser admission. Retain every enabled,
  // previously active, partially connected, foreign, or unsupported endpoint.
  workCheck("chat_endpoints", incomingWakeWorkQuery("chat_endpoints")!),
  workCheck("routines", `SELECT 1 FROM routines WHERE status NOT IN ('paused', 'archived')`),
  workCheck("routine_runs", `SELECT 1 FROM routine_runs WHERE status NOT IN ('completed', 'failed', 'skipped', 'cancelled')`),
  workCheck("plugin_jobs", `SELECT 1 FROM plugin_jobs WHERE status <> 'paused'`),
  workCheck("plugin_job_runs", `SELECT 1 FROM plugin_job_runs WHERE status NOT IN ('succeeded', 'failed', 'cancelled')`),
  workCheck("plugin_webhook_deliveries", `SELECT 1 FROM plugin_webhook_deliveries WHERE status NOT IN ('succeeded', 'failed')`),
  // Saved outbound MCP configuration and disabled drafts have no independent
  // listener. Keep local processes, channels and GitHub webhook bindings awake;
  // accepted calls, credential recovery and delivery work have separate fences.
  workCheck("tool_connections", incomingWakeWorkQuery("tool_connections")!),
  // An explicit board escalation has no automatic retry. Retain the visible
  // action and all execution/cleanup checks while the board decides what to do.
  workCheck("issue_recovery_actions", `SELECT 1 FROM issue_recovery_actions a WHERE a.status NOT IN ('resolved', 'cancelled')
    AND (${passiveBoardRecovery('a')}) IS NOT TRUE`),
  workCheck("status_cards", `SELECT 1 FROM status_cards WHERE archived_at IS NULL`),
  workCheck("external_objects", `SELECT 1 FROM external_objects WHERE NOT is_terminal OR next_refresh_at IS NOT NULL`),
  // Login history keeps its provider reference after teardown. A terminal
  // label alone is insufficient: require a finished, unclaimed session and
  // positive cleanup evidence for its resource in the same company/environment.
  // Cast only UUID-shaped session references, leaving both lease indexes usable.
  workCheck("adapter_auth_sessions", `SELECT 1 FROM adapter_auth_sessions s WHERE
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
          AND l.released_at IS NOT NULL) IS NOT TRUE))`),
  // Answer delivery history is not work once its acknowledged handoff has
  // finished. Keep pending deliveries, unfinished target runs, and missing or
  // unfinished fallback wake receipts awake. Other work checks still apply.
  workCheck("issue_question_response_deliveries", `SELECT 1 FROM issue_question_response_deliveries d WHERE
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
              AND ${finishedRun("r")})))))`),
  // Cloud owns inbound event durability. A processed receipt is idempotency
  // history; any downstream run, wake or delivery is still checked separately.
  workCheck("connection_event_deliveries", `SELECT 1 FROM connection_event_deliveries WHERE status <> 'processed' OR processed_at IS NULL`),
  // A delivered outbox row is history after its exact accepted wake finishes.
  // A system-retired connection card may also be parked behind a still-pending
  // response. Keep the outbox intact: the normal reply path resumes delivery.
  workCheck("connection_intent_deliveries", `SELECT 1 FROM connection_intent_deliveries d WHERE
    (d.delivered_at IS NULL AND (${connectionDeliveryWaitingForResponse('d')}) IS NOT TRUE)
    OR EXISTS (SELECT 1 FROM agent_wakeup_requests connection_wake
      WHERE connection_wake.company_id = d.company_id AND connection_wake.idempotency_key IN (
        'connection-intent:' || d.interaction_id::text || ':accepted',
        'connection-intent:' || d.interaction_id::text || ':rejected',
        'connection-intent:' || d.interaction_id::text || ':expired')
      AND (${finishedIdleWake('connection_wake')}) IS NOT TRUE)`),
  // Saved private feedback and acknowledged uploads have no delivery job.
  // Pending/failed exports and unfamiliar states retain the instance. A sent
  // label requires its completion stamp and a cleared failure reason.
  workCheck("feedback_exports", `SELECT 1 FROM feedback_exports WHERE (status = 'local_only'
    OR (status = 'sent' AND exported_at IS NOT NULL AND failure_reason IS NULL)) IS NOT TRUE`),
  // Skill package conversion and retention are optional maintenance. Legacy
  // contents remain authoritative until verified conversion; retries may wait
  // for ingress, including when external package storage is disabled.
  workCheck("project_skill_sources", `SELECT 1 FROM project_skill_sources b JOIN companies c ON c.id = b.company_id
    WHERE c.status = 'active' AND b.active AND b.source_id IS NULL`),
  workCheck("company_skill_sources", `SELECT 1 FROM company_skill_sources s JOIN companies c ON c.id = s.company_id
    WHERE c.status = 'active' AND s.enabled AND s.automatic_updates
      AND (s.access_scope = 'company' OR EXISTS (
        SELECT 1 FROM project_skill_sources b WHERE b.source_id = s.id AND b.company_id = s.company_id AND b.active))`),
  workCheck("native_run_finalizations", `SELECT 1 FROM native_run_finalizations f WHERE (
    f.phase = 'committed' AND f.lease_owner IS NULL AND f.lease_expires_at IS NULL
    AND f.next_attempt_at IS NULL AND f.control_deadline_at IS NULL
    AND f.recovery_state IS NULL AND f.recovery_request_id IS NULL
    AND f.failure_code IS NULL AND f.failure_detail IS NULL
    AND EXISTS (
      SELECT 1 FROM heartbeat_runs r
      JOIN native_run_results result_row ON result_row.id = f.result_id
        AND result_row.company_id = r.company_id AND result_row.issue_id = r.native_issue_id
        AND result_row.run_id = r.id AND result_row.completion_contract_id = r.completion_contract_id
      JOIN work_assessments assessment ON assessment.id = f.assessment_id
        AND assessment.company_id = r.company_id AND assessment.issue_id = r.native_issue_id
        AND assessment.run_id = r.id AND assessment.result_id = result_row.id
      JOIN status_decisions decision ON decision.id = f.decision_id
        AND decision.company_id = r.company_id AND decision.issue_id = r.native_issue_id
        AND decision.run_id = r.id AND decision.assessment_id = assessment.id
      WHERE r.id = f.run_id AND r.company_id = f.company_id AND r.native_issue_id = f.issue_id
        AND r.runtime_mode = 'native' AND r.native_phase = 'committed'
        AND ${finishedRun("r")}
        AND r.result_json->>'finalizationPhase' = 'committed'
        AND r.result_json->>'nextAttemptAt' IS NULL AND r.result_json->>'failureCode' IS NULL
        AND r.result_json->>'originalFailureCode' IS NULL
        AND result_row.schema_status = 'accepted'
        AND result_row.result_json->'terminal'->>'runTerminalState' = r.status
        AND decision.application_state = 'applied' AND decision.applied_at IS NOT NULL)
    AND EXISTS (SELECT 1 FROM workspace_operations operation
      WHERE operation.company_id = f.company_id AND operation.issue_id = f.issue_id
        AND operation.heartbeat_run_id = f.run_id
        AND operation.phase = 'workspace_finalize' AND operation.status = 'succeeded')
    AND NOT EXISTS (
      SELECT 1 FROM status_decision_effects effect WHERE effect.decision_id = f.decision_id
        AND (effect.company_id <> f.company_id OR effect.issue_id <> f.issue_id
          OR effect.delivery_state <> 'delivered' OR effect.delivered_at IS NULL
          OR effect.next_attempt_at IS NOT NULL))
    ) IS NOT TRUE`),
  ...completedHistoryChecks.map(check => workCheck(check.reason, check.query)),
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
export interface IdleSleepSafetyOptions {
  incomingWake?: VerifiedIdleCapabilities;
  deadlineCapability?: VerifiedIdleCapabilities;
  collectDiagnostics?: true;
}

export async function readIdleSleepSafety(
  db: Db,
  getDrainStatus: () => IdleSleepDrainStatus,
  now: () => number = Date.now,
  ownerId?: string,
  inspectLocalWork: (diagnostic?: IdleSleepDiagnosticSink) => Promise<IdleLocalWork> =
    diagnostic => readIdleLocalWork({ diagnostic, deadlineCapability: options.deadlineCapability }),
  inspectPlugins?: InspectIdlePlugins,
  prepareBackup?: () => Promise<boolean>,
  scheduledRoutines = false,
  scheduledIssueMonitors = false,
  options: IdleSleepSafetyOptions = {},
): Promise<IdleSleepSafety> {
  let incomingProof: IdleIncomingWakeProof | undefined;
  let deadlineProof: IdleDeadlineProof | undefined;
  const deadlines = options.deadlineCapability?.deadlineCatalog === "domain_deadlines_v1";
  const diagnostic = options.collectDiagnostics ? createIdleSleepDiagnostics() : undefined;
  const report = (backgroundWork: IdleLocalWork, scheduledWake?: ScheduledWake): IdleSleepSafety => {
    const diagnostics = diagnostic?.report();
    if (backgroundWork === "none" && diagnostics?.checks.some(check =>
      check.state === "unknown" || check.state === "not_checked")) backgroundWork = "unknown";
    if (backgroundWork === "none" && deadlines && (!deadlineProof || deadlineProof.blocked || !deadlineProof.generation)) backgroundWork = "unknown";
    const wake = deadlineProof ? deadlineProof.scheduledWake : scheduledWake;
    return { version: backgroundWork === "none" && (incomingProof || deadlineProof) ? 3 : backgroundWork === "none" && wake ? 2 : 1, backgroundWork,
      ...(backgroundWork === "none" && incomingProof ? { incomingWake: incomingProof.capability,
        ...(incomingProof.apiWakeAdmission ? { apiWakeAdmission: incomingProof.apiWakeAdmission } : {}) } : {}),
      ...(backgroundWork === "none" && deadlineProof?.generation ? { deadlineProof: {
        catalog: "domain_deadlines_v1" as const, generation: deadlineProof.generation } } : {}),
      ...(backgroundWork === "none" && wake ? { scheduledWake: wake } : {}),
      ...(diagnostics ? { diagnostics } : {}) };
  };
  const before = getDrainStatus();
  const localBefore = idleWorkSnapshot();
  const owned = () => Boolean(ownerId && ownerId === before.ownerId && before.expiresAt !== null);
  if (!sameQuietHold(before, before, now()) || (diagnostic && !owned())) {
    diagnostic?.record("inspection.hold", "unknown");
    diagnostic?.record("durable.snapshot", "not_checked");
    return report("unknown");
  }
  diagnostic?.record("inspection.hold", "none");
  let failureReason = "local.inspection";
  try {
    const localFirst = await inspectLocalWork(diagnostic?.record);
    diagnostic?.record("local.inspection", localFirst);
    if (localFirst !== "none" && !diagnostic) return report(localFirst);
    let quietPlugins: string[] = [];
    let quietPluginGeneration: string | undefined;
    let quietPluginCatalog: IdlePluginCatalogEntry[] | undefined;
    let pluginState: IdleLocalWork = "none";
    if (inspectPlugins) {
      const currentLocal = diagnostic ? idleWorkSnapshot() : localBefore;
      if (!owned() || currentLocal.active !== 0 || (diagnostic &&
        (!sameQuietHold(before, getDrainStatus(), now()) || currentLocal.generation !== localBefore.generation))) {
        if (!diagnostic) return report("unknown");
        diagnostic.record("plugins.runtime_drain", "not_checked");
        pluginState = "unknown";
      } else {
        failureReason = "plugins.runtime_drain";
        const pluginWork = await inspectPlugins({ ownerId: ownerId!, expiresAt: before.expiresAt!.getTime() });
        pluginState = pluginWork.backgroundWork;
        diagnostic?.record("plugins.runtime_drain", pluginState);
        if (pluginState !== "none" && !diagnostic) return report(pluginState);
        if (pluginState === "none") {
          quietPlugins = pluginWork.pluginIds;
          quietPluginGeneration = pluginWork.catalogGeneration;
          quietPluginCatalog = pluginWork.catalog;
        }
      }
    }
    if (diagnostic && !sameQuietHold(before, getDrainStatus(), now())) {
      diagnostic.record("inspection.hold", "unknown");
      diagnostic.record("durable.snapshot", "not_checked");
      return report("unknown");
    }
    failureReason = "durable.snapshot";
    let scheduledWake: ScheduledWake | undefined;
    const blocked = await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
      if (options.incomingWake?.incomingWake) {
        if (!ownerId || ownerId !== before.ownerId) return undefined;
        incomingProof = await readIdleIncomingWakeProof(tx, { capabilities: options.incomingWake, ownerId, receiverOwner: db });
      }
      if (deadlines) {
        if (!owned() || !scheduledRoutines || !scheduledIssueMonitors) return undefined;
        const routine = await readIdleRoutineSchedule(tx, ownerId!, now());
        const issue = await readIdleIssueSchedule(tx, ownerId!, now());
        diagnostic?.record("routines.schedule", routine.inspectionComplete === false ? "unknown" : routine.blocked ? "present" : "none");
        diagnostic?.record("issues.schedule", issue.inspectionComplete === false ? "unknown" : issue.blocked ? "present" : "none");
        diagnostic?.expect(["deadlines.catalog"]);
        failureReason = "deadlines.catalog";
        if (routine.blocked || issue.blocked) deadlineProof = { blocked: true };
        else {
          scheduledWake = combineIdleSchedules(routine.scheduledWake, issue.scheduledWake, issue.generation);
          deadlineProof = await readIdleDeadlineProof(tx, { ownerId: ownerId!, expiresAt: before.expiresAt!.getTime() }, {
            now: now(), verifiedCapability: options.deadlineCapability,
            quietPluginIds: quietPlugins, quietPluginGeneration, quietPluginCatalog,
            scheduledWake, passiveGeneration: issue.generation,
          });
        }
        diagnostic?.record("deadlines.catalog", deadlineProof.blocked ? "present" : "none");
        if (deadlineProof.blocked && !diagnostic) return true;
      }
      failureReason = "durable.snapshot";
      const checks = WORK_CHECKS.filter(check =>
        (!scheduledRoutines || check.reason !== "routines")
        && (!scheduledIssueMonitors || check.reason !== "issues"))
        .map(check => {
          const replacement = deadlineProof?.blocked === false ? deadlineWorkReplacement(check.reason) : undefined;
          return { ...check, query: incomingWakeWorkQuery(check.reason, incomingProof,
            deadlineProof?.githubContinuity?.connectionIds) ?? (replacement ? sql.raw(replacement) : check.query) };
        });
      checks.push(workCheck("agents.company_hold", sql`SELECT 1 FROM agents JOIN companies ON companies.id = agents.company_id
        WHERE ${companyHoldMismatch()}`));
      checks.push(workCheck("heartbeat_runs.budget_cancellation", sql`SELECT 1 FROM heartbeat_runs WHERE ${pendingBudgetRunCancellationPredicate()}`));
      checks.push(workCheck("native_response_presentation", nativeResponsePresentationPendingQuery()));
      // Only the current worker's owned runtime drain can exempt a plugin.
      // Missing workers, old SDKs, and newly installed plugins still block.
      checks.push(workCheck("plugins", quietPlugins.length === 0
        ? sql`SELECT 1 FROM plugins WHERE status <> 'disabled'`
        : sql`SELECT 1 FROM plugins WHERE status <> 'disabled' AND id NOT IN (${sql.join(quietPlugins.map((id) => sql`${id}::uuid`), sql`, `)})`));
      let found: boolean;
      if (diagnostic) {
        diagnostic.expect(checks.map(check => check.reason));
        const rows = await tx.execute<Record<string, boolean>>(sql`SELECT ${sql.join(checks.map(check =>
          sql`EXISTS (${check.query}) AS ${sql.identifier(check.reason)}`), sql`, `)}`);
        if (rows.length !== 1 || Object.keys(rows[0] ?? {}).length !== checks.length
          || checks.some(check => !Object.hasOwn(rows[0]!, check.reason) || typeof rows[0]![check.reason] !== "boolean")) return undefined;
        for (const check of checks) diagnostic.record(check.reason, rows[0]![check.reason] ? "present" : "none");
        diagnostic.record("durable.snapshot", "none");
        found = checks.some(check => rows[0]![check.reason]);
      } else {
        const rows = await tx.execute<{ blocked: boolean }>(sql`SELECT ${sql.join(checks.map(check => sql`EXISTS (${check.query})`), sql` OR `)} AS blocked`);
        if (rows.length !== 1 || typeof rows[0]?.blocked !== "boolean") return undefined;
        found = rows[0].blocked;
      }
      found ||= deadlineProof?.blocked ?? false;
      if (found && !diagnostic) return true;
      if (scheduledRoutines && !deadlines) {
        if (!owned()) return undefined;
        const schedule = await readIdleRoutineSchedule(tx, ownerId!, now());
        diagnostic?.record("routines.schedule", schedule.inspectionComplete === false ? "unknown" : schedule.blocked ? "present" : "none");
        if (schedule.blocked && !diagnostic) return true;
        found ||= schedule.blocked && schedule.inspectionComplete !== false;
        scheduledWake = schedule.scheduledWake;
      }
      if (scheduledIssueMonitors && !deadlines) {
        if (!scheduledRoutines || !owned()) return undefined;
        const schedule = await readIdleIssueSchedule(tx, ownerId!, now());
        diagnostic?.record("issues.schedule", schedule.inspectionComplete === false ? "unknown" : schedule.blocked ? "present" : "none");
        if (schedule.blocked && !diagnostic) return true;
        found ||= schedule.blocked && schedule.inspectionComplete !== false;
        scheduledWake = combineIdleSchedules(scheduledWake, schedule.scheduledWake, schedule.generation);
      }
      return found;
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
    if (blocked === undefined) {
      diagnostic?.record("durable.snapshot", "unknown");
      return report("unknown");
    }
    if (!sameQuietHold(before, getDrainStatus(), now())) {
      diagnostic?.record("inspection.hold", "unknown");
      return report("unknown");
    }
    if (blocked && !diagnostic) return report("present");
    if (!owned() || (!diagnostic && localBefore.active !== 0)) return report("unknown");
    let expectedGeneration = localBefore.generation;
    if (prepareBackup) {
      if (diagnostic) {
        diagnostic.record("backup.checkpoint", "not_checked");
      } else {
        if (!sameQuietHold(before, getDrainStatus(), now()) ||
            idleWorkSnapshot().generation !== expectedGeneration || idleWorkSnapshot().active !== 0) return report("unknown");
        // The runner owns exactly one tracked-work receipt through dump,
        // archive verification and fsync. Its start/finish are the only work
        // allowed during this scan. Any concurrent work invalidates the dump.
        if (!(await prepareBackup())) return report("unknown");
        expectedGeneration += 2;
      }
    }
    failureReason = "local.inspection";
    const local = await inspectLocalWork(diagnostic?.record);
    diagnostic?.record("local.inspection", local);
    const after = getDrainStatus();
    const localAfter = idleWorkSnapshot();
    if (!sameQuietHold(before, after, now()) || localAfter.active !== 0 ||
        expectedGeneration !== localAfter.generation) {
      diagnostic?.record("inspection.generation", "unknown");
      return report("unknown");
    }
    diagnostic?.record("inspection.generation", "none");
    if (diagnostic && (localFirst === "unknown" || local === "unknown" || pluginState === "unknown")) return report("unknown");
    if (diagnostic && (blocked || localFirst === "present" || pluginState === "present")) return report("present");
    const finalWake = deadlineProof ? deadlineProof.scheduledWake : scheduledWake;
    if (local === "none" && finalWake && Date.parse(finalWake.nextWakeAt) <= now()) {
      diagnostic?.record("inspection.hold", "unknown");
      return report("present");
    }
    // Legacy alarm kinds cannot be silently combined with a new ingress proof.
    // The negotiated deadline catalog supplies the composed v3 alarm separately.
    if (incomingProof && scheduledWake && !deadlineProof) return report("unknown");
    return report(local, scheduledWake);
  } catch {
    // Missing migrations, unknown state, malformed configuration, timeouts and
    // database failures never authorize stopping the application. Do not leak
    // SQL, configuration or tenant data through this control response.
    diagnostic?.record(failureReason, "unknown");
    return report("unknown");
  }
}
