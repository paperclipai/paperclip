import { STORAGE_UNAVAILABLE_WAIT_RETRY_REASON } from "../storage/storage-unavailable.js";
import { AGENT_DIRECTORY_WAIT_RETRY_REASON, INTERRUPTED_PREPARATION_RETRY_REASON } from "./execution-recovery-attempt.js";
import { boundSetupCommandFailure, readSetupCommandFailure } from "./workspace-setup-command-failure.js";
import { and, desc, eq, inArray, isNull, not, notInArray, sql, type SQL } from "drizzle-orm";
import { unidentifiedLocalLaunchRefusals } from "./native-local-process-stop.js";
import { nativeSessionCleanupBlock } from "../vendor/paperclip-runner/index.js";
import { agents, agentWakeupRequests, approvals, chatActions, companies, environmentLeases, heartbeatRuns, issueApprovals, issueRecoveryActions,
  issues, issueTreeHoldMembers, issueTreeHolds, nativeRunFinalizations, projects, type Db } from "@paperclipai/db";
import { unionAll } from "drizzle-orm/pg-core";
import { EXECUTION_RECONCILIATION_CAUSES, HEARTBEAT_RUN_STATUSES, readProviderFailure, type TaskInterruptionPresentation } from "@paperclipai/shared";
import { captureTaskInterruptionFailure } from "../sentry.js";
import { isAiAuthenticationBlocked } from "./ai-auth-failure.js";
import { readSystemRecovery } from "./system-recovery-state.js";
import { RECOVERY_CONTINUATION_DELIVERY_BOUND_MS, recoveryContinuationHeldSince } from "./recovery-continuation-pacing.js";
import { PROJECT_ACCESS_DENIED } from "./project-access-denial.js";
import { authorizationService } from "./authorization.js";
import { taskWorkspaceProjectRequirements } from "./task-workspace-access.js";
import { isAcknowledgedNativeStop } from "./acknowledged-native-stop.js";
import { createRunSecretRedactionRegistry } from "./run-secret-redaction.js";
import { instanceSettingsService } from "./instance-settings.js";
import { redactCurrentUserText } from "../log-redaction.js";
import { logger } from "../middleware/logger.js";
import { canonicalExecutionUuid } from "./execution-identity.js";
import { chatActionDeadline } from "./chat-action-work.js";
import { NATIVE_CLEANUP_SETTLING_MESSAGE, NATIVE_SESSION_CLEANUP_QUARANTINED } from "./native-runtime/completed-turn-cleanup.js";
import { isQueuedDependencyWait } from "./run-cancellation.js";
import { heldRetryOffersRetry } from "./task-retry-eligibility.js";
import { exhaustedNativeFinalizationCondition, savedResultRetryPendingCondition } from "./native-runtime/exhausted-finalization-retry.js";
import { AI_CONNECTION_BUSY_RETRY_REASON, AI_CONNECTION_POOL_WAIT_RETRY_REASON, RUNNER_REVISION_WAIT_RETRY_REASON,
  WORKSPACE_BUSY_RETRY_REASON } from "../modules/run-dispatch/index.js";

// These scheduled runs wait for a shared resource; none records a failed
// attempt. Their dispatcher re-checks the resource, so the run can stay
// scheduled past its retry time. Retry cannot free the resource either.
const resourceWaitRetryReasons = new Set<string>([WORKSPACE_BUSY_RETRY_REASON, AI_CONNECTION_BUSY_RETRY_REASON,
  AI_CONNECTION_POOL_WAIT_RETRY_REASON, RUNNER_REVISION_WAIT_RETRY_REASON, STORAGE_UNAVAILABLE_WAIT_RETRY_REASON,
  AGENT_DIRECTORY_WAIT_RETRY_REASON]);

// A due same-run resume dispatches within seconds; past this, offer Retry.
const NATIVE_RESUME_DISPATCH_GRACE_MS = 2 * 60_000;
// A queued-message Interrupt waits for the stopped run's cleanup before its
// successor starts. Past this, a hand-off that never started offers Retry.
const QUEUED_INTERRUPT_HANDOFF_GRACE_MS = 5 * 60_000;
const QUEUED_INPUT_DISPATCH_GRACE_MS = 2 * 60_000;
const AUTOMATIC_DISPOSITION_GRACE_MS = 2 * 60_000;

type ProjectionIssue = Pick<typeof issues.$inferSelect, "id" | "companyId" | "status" | "assigneeAgentId" | "projectId">;
type ProjectionRun = Pick<typeof heartbeatRuns.$inferSelect,
  "id" | "status" | "scheduledRetryAt" | "errorCode" | "livenessState" | "resultJson"> &
  Partial<Pick<typeof heartbeatRuns.$inferSelect, "agentId" | "error" | "companyId" | "nativeIssueId" | "runtimeMode" | "startedAt"
    | "scheduledRetryReason" | "createdAt" | "finishedAt" | "processPid" | "processGroupId">> & {
  /** Due time of the native coordinator's own same-run resume, if one is pending. */
  nativeResumeAt?: Date | null;
  /** When the native coordinator saved this run's terminal failure, if it did. */
  nativeFailedAt?: Date | null;
  /** A succeeded native run whose accepted result ran out of finalization retries; Retry applies it again. */
  nativeFinalizationRetry?: boolean;
  /** A saved-result Retry of this succeeded run is still being applied. */
  nativeFinalizationRetryPending?: boolean;
  /** The configured model id the provider rejected (native_provider_model_rejected only). */
  rejectedModel?: string | null;
  /** A cleanup-gate refusal after this run's own provider turn completed; its work is saved. */
  completedTurnCleanup?: boolean;
};
type ProjectionWait = { id: string; requestedAt: Date; sourceRunId?: string | null; executionWaitReason?: string | null;
  preparationStatus?: string | null; preparationRetryAt?: number | string | null; preparationUpdatedAt?: Date | null;
  /** When the user pressed Interrupt to deliver this queued message now. */
  queuedInterruptRequestedAt?: string | null;
  queuedComment?: boolean };
type ProjectionState = {
  run?: ProjectionRun;
  action?: typeof issueRecoveryActions.$inferSelect;
  wait?: ProjectionWait;
  retryWait?: ProjectionWait;
  /** The pending queued message this run was interrupted for, if any. */
  interruptWait?: ProjectionWait;
  agent?: Pick<typeof agents.$inferSelect, "status" | "pauseReason">;
  projectAccessAllowed?: boolean;
  projectAccessProjectId?: string | null;
  workspaceSelectionAvailable?: boolean;
  project?: Pick<typeof projects.$inferSelect, "pausedAt" | "pauseReason">;
  company?: Pick<typeof companies.$inferSelect, "status" | "pauseReason">;
  paused: boolean;
  approval: boolean;
  /** A board-owned workspace-owner fence on this run that no automatic proof has released. */
  ownerStopRequired?: boolean;
  unidentifiedLaunchConfirmable?: boolean;
  /** The latest wake for a task with no run yet, when admission refused it. */
  admissionWait?: { id: string; status: string; reason: string | null; agentId: string };
  retryDependencies?: RetryDependencies;
  /** The task waits on unresolved blocker tasks, a wait that does not depend on its last run. */
  waitingOnBlockers?: boolean;
  waitingOnOpenSubtasks?: boolean;
  /** A live owner is settling this run's session cleanup gate: an unreleased
   * remote environment, or a scheduled close in this process. Without one,
   * nothing settles the gate by itself, so Retry is the way forward. */
  cleanupSettling?: boolean;
  /** The fresh-continuation fallback is continuing this run's task (recorded,
   * not yet started) or will check it again at `nextCheckAt`. */
  freshContinuation?: { state: "continuing" } | { state: "scheduled"; nextCheckAt: number };
  automaticDispositionAt?: number;
};

// A task read reports the change that made a task fail, not every later read of
// retained history. The delivery cache is process-local, so a restart or another
// replica would otherwise resend each old failure whenever a list shows it.
const TASK_INTERRUPTION_REPORT_WINDOW_MS = 60 * 60_000;

/** Latest saved fact that can move a task into the failed state, if known. The
 * recovery row's update time covers recovery that newly fails on an old run:
 * each saved recovery transition stamps it, while activity heartbeats do not.
 * The native resume due time and terminal finalization cover a same-run resume
 * that lapses or is exhausted on an old run. */
export function taskInterruptionChangedAt(input: Pick<ProjectionState, "run" | "action" | "wait" | "retryWait">): number | null {
  const { run, wait, action } = input;
  const retryWait = input.retryWait ?? wait;
  const preparationFailedAt = retryWait?.preparationStatus === "failed" || retryWait?.preparationStatus === "cancelled"
    ? retryWait.preparationUpdatedAt : null;
  const times: unknown[] = [run?.finishedAt ?? run?.createdAt, run?.scheduledRetryAt, run?.nativeResumeAt, run?.nativeFailedAt,
    wait?.requestedAt, retryWait?.requestedAt, action?.updatedAt, preparationFailedAt].map(value => value?.getTime());
  times.push(readSystemRecovery(action?.evidence)?.nextAttemptAt,
    retryWait?.preparationRetryAt == null ? null : Number(retryWait.preparationRetryAt));
  const known = times.filter((time): time is number => typeof time === "number" && Number.isFinite(time));
  return known.length ? Math.max(...known) : null;
}

function boundedJsonString(value: SQL, limit: number) {
  return sql<string | null>`case when jsonb_typeof(${value}) = 'string' then left(${value} #>> '{}', ${limit}) else null end`;
}

/** Projected reason for a budget.blocked refusal caused by unpriced usage. */
export const UNPRICED_USAGE_WAIT = "accounting.unpriced_usage";
/** Admission's unpriced-usage refusal text (budgets.ts). Only this fixed
 * phrase is matched; the stored message itself is never displayed. */
const unpricedUsageWait = (reason: SQL, message: SQL) =>
  sql<string | null>`case when ${reason} = 'budget.blocked' and ${message} like '%recorded usage has no reliable price%'
    then ${UNPRICED_USAGE_WAIT} else ${reason} end`;

// Persisted wait messages can contain diagnostics. Ordinary task views expose
// only these stable categories, never arbitrary payloads or source identifiers.
const retryWaitMessages: Record<string, string> = {
  workspace_repair_required: "Retry is waiting for Paperclip to recover the saved files. Your message is saved.",
  remote_cleanup: "Retry is waiting for the previous environment to stop. Your message is saved.",
  local_cleanup: "Retry is waiting for the previous execution to finish cleanup. Your message is saved.",
  cleanup_pending: "Retry is waiting for the previous execution to finish cleanup. Your message is saved.",
  execution_settling: "Retry is waiting for the previous execution to stop. Your message is saved.",
  controller_settling: "Retry is waiting for the previous execution to finish recovery. Your message is saved.",
  process_identity_missing: "Retry is waiting for Paperclip to verify that the previous execution stopped. Your message is saved.",
  process_running: "Retry is waiting for the previous execution to stop. Your message is saved.",
  execution_active: "Retry is waiting for the current run to finish. Your message is saved.",
  decision_pending: "Retry is waiting for a pending approval or question to be resolved. Your message is saved.",
  "budget.blocked": "Retry is waiting for the budget to allow new work. Check Costs for unrecorded or unpriced usage.",
  // Admission records an unpriced-usage refusal as budget.blocked; the
  // projection shows it as the accounting matter it is.
  [UNPRICED_USAGE_WAIT]: "Retry is waiting because recorded usage has no price. Check Costs, or allow unpriced usage in the budget policy. Your message is saved.",
  finalizing_saved_result: "Paperclip is finishing the saved result before Retry can continue.",
  // Another click cannot release a copyback owner that stopped without reporting.
  // Retry starts a new recovery generation; the agent does not repeat its work.
  saved_work_recovery_failed: "Saving the agent's files failed. Retry to try again; the agent will not repeat its work.",
  saved_work_recovery_refused: "Paperclip refused to recover the saved files because a safety check on them cannot pass. "
    + "Retry runs the same check again and succeeds only after Paperclip is updated. The agent's result is saved, and the agent will not repeat its work.",
  workspace_owner_stop_required: "Retry is waiting until Paperclip confirms that the previous server stopped saving files. The agent's result and your Retry are saved.",
  cleanup_quarantined: NATIVE_CLEANUP_SETTLING_MESSAGE,
  cancelled_by_operator: "This attempt was stopped. Send a new message to continue from saved work.",
  // A new click replaces a Retry declined for its requester's access with a
  // fresh attempt under the clicker's access, so Retry stays available.
  retry_authority_denied: "Retry could not start with the requesting user's access. Press Retry to start it with yours.",
  previous_execution_unverified: "Retry can't continue because Paperclip can't confirm that the previous attempt stopped before it started work. Your message is saved.",
  // An edited saved message can never be replayed; only new input continues.
  retry_source_changed: "Retry cannot continue because its saved message changed. Send a new message to continue from saved work.",
};

const UNIDENTIFIED_RUNNER_STOP_MESSAGE = "Paperclip can't confirm that the previous run stopped. The server restarted after it started the agent but before it recorded the agent's process. "
  + "If no agent is still working on this task, a board operator can confirm that it stopped, and your Retry starts right away. Your message is saved.";

type RetryDependencies = { count: number; blocked: boolean; cancelled: boolean; savingFilesOnly: boolean };

function dependencyRetryWaitMessage(dependencies: RetryDependencies): string {
  if (dependencies.cancelled) return "Retry is waiting on a cancelled task this one depends on. Remove or replace that dependency to continue. Your Retry is saved.";
  if (dependencies.blocked) return "Retry is waiting on a blocked task this one depends on. Retry or unblock it; this task continues when it is done. Your Retry is saved.";
  if (dependencies.savingFilesOnly) return "Retry is waiting for a finished task this one depends on to save its files. Your Retry is saved.";
  return "Retry is waiting for the tasks this one depends on to finish. Your Retry is saved.";
}

// A task that never started can wait for a temporary admission hold. The
// assigned-task liveness sweep admits it once the hold clears; no Retry needed.
const admissionWaitMessages: Record<string, string> = {
  "budget.blocked": "Waiting for the budget to allow new work. The task starts automatically when it does.",
  [UNPRICED_USAGE_WAIT]: "Waiting because recorded usage has no price. Check Costs, or allow unpriced usage in the budget policy.",
};

/** Recognize old persisted failures without displaying arbitrary run error text. */
function deniedProjectId(issue: ProjectionIssue, run?: ProjectionRun): string | null | undefined {
  const historical = run?.errorCode === "setup_failed" && run.error === "Project is outside this low-trust boundary.";
  if (!run || run.status !== "failed" || run.agentId !== issue.assigneeAgentId
      || (run.errorCode !== PROJECT_ACCESS_DENIED && !historical)) return undefined;
  const detail = run.resultJson?.projectAccessDenied;
  return detail && typeof detail === "object" && "projectId" in detail && typeof detail.projectId === "string"
    ? detail.projectId : null;
}

/** Presentation never grants authority. Dispatch repeats all gates under its
 * locks. The same projection is used in detail, lists and attention surfaces.
 * A native run refused by the cleanup gate offers no Retry only while a live
 * owner settles that gate. Without one, the task Retry (explicit continuation)
 * proves the old session stopped and continues in a fresh session. */
export function projectTaskInterruption(issue: ProjectionIssue, input: ProjectionState, now = Date.now()): TaskInterruptionPresentation | null {
  const presentation = projectTaskInterruptionState(issue, input, now);
  if (!presentation?.canRetry || input.run?.errorCode !== NATIVE_SESSION_CLEANUP_QUARANTINED || !input.cleanupSettling)
    return presentation;
  return { ...presentation, canRetry: false };
}

function projectTaskInterruptionState(issue: ProjectionIssue, input: ProjectionState, now: number): TaskInterruptionPresentation | null {
  const { run, wait, action, agent, project, company } = input;
  const retryWait = input.retryWait ?? wait;
  if (!run) {
    const admission = input.admissionWait;
    if (!admission || admission.status !== "skipped" || !Object.hasOwn(admissionWaitMessages, admission.reason ?? "")
        || issue.status !== "todo" || admission.agentId !== issue.assigneeAgentId) return null;
    const waiting: TaskInterruptionPresentation = { intentId: admission.id, responsibility: "system", state: "working",
      nextRetryAt: null, canRetry: false, userAction: null, sourceRunIds: [], observedRunId: null };
    // Budget pauses, ordinary pauses and approvals wait on a person; only an
    // accounting hold settles by itself. Admission records all of them as budget.blocked.
    const userAction = !issue.assigneeAgentId ? "assign_agent" : input.approval ? "approval"
      : [agent?.pauseReason, project?.pauseReason, company?.pauseReason].some(reason => reason === "budget" || reason === "budget_exceeded")
        ? "budget" : input.paused || project?.pausedAt || agent?.status === "paused" || company?.status === "paused" ? "resume" : null;
    if (userAction) return { ...waiting, responsibility: "user", state: "waiting_for_user", userAction };
    return { ...waiting, retryWait: { reason: admission.reason!, message: admissionWaitMessages[admission.reason!] } };
  }
  const system = readSystemRecovery(action?.evidence);
  const base: TaskInterruptionPresentation = { intentId: wait?.id ?? null, responsibility: "system",
    state: "resolved", nextRetryAt: null, canRetry: false, userAction: null,
    sourceRunIds: [run.id], observedRunId: run.id };
  if (["done", "cancelled"].includes(issue.status)) return base;
  // Retry took effect: the saved result is being applied again.
  if (run.status === "succeeded" && run.nativeFinalizationRetryPending)
    return { ...base, state: "working", recoveryStep: "finishing_recovery" };
  if (run.status === "succeeded" && !wait && !run.nativeFinalizationRetry) return base;
  const providerFailure = run.status === "failed" || run.status === "scheduled_retry"
    ? readProviderFailure(run.resultJson?.providerFailure) : null;
  if (providerFailure) base.providerFailure = providerFailure;
  if (["failed", "scheduled_retry"].includes(run.status) && run.errorCode === "workspace_validation_failed"
      && typeof run.error === "string" && run.error.trim()) base.workspaceFailure = { message: run.error };
  // A scheduled retry carries its setup_failed predecessor's cause; it has no error code of its own.
  const setupFailure = run.status === "failed" && run.errorCode === "setup_failed" ? readSetupCommandFailure(run.resultJson, run.error)
    : run.status === "scheduled_retry" ? readSetupCommandFailure(run.resultJson, null) : null;
  if (setupFailure) base.setupFailure = setupFailure;
  const userAction = !issue.assigneeAgentId ? "assign_agent" : input.approval || run.errorCode === "native_provider_approval_required" ? "approval"
    : isAiAuthenticationBlocked(run) ? "reconnect"
      : run.errorCode === "native_provider_model_rejected" ? "choose_model"
      : [agent?.pauseReason, project?.pauseReason, company?.pauseReason].some(reason => reason === "budget" || reason === "budget_exceeded")
        ? "budget" : input.paused || project?.pausedAt || agent?.status === "paused" || company?.status === "paused" ? "resume" : null;
  if (userAction) return { ...base, responsibility: "user", state: "waiting_for_user", userAction,
    ...(userAction === "choose_model" && run.rejectedModel ? { rejectedModel: run.rejectedModel } : {}) };
  // The previous controller cannot confirm its own stop. Name the one board
  // action instead of showing the fenced run as working (RC-47).
  if (input.ownerStopRequired) return { ...base, responsibility: "user", state: "waiting_for_user", userAction: "confirm_owner_stop" };
  // The task's existing dependency UI owns this wait. Keep actual recovery and
  // Retry preparation failures authoritative; this does not change admission.
  if (!action && !retryWait?.preparationStatus && isQueuedDependencyWait(run)) return base;
  // Intentional Stop is not an unsuccessful attempt. This is presentation only;
  // physical containment and pending cleanup keep their execution-side gates.
  if (!wait && run.runtimeMode === "native" && run.companyId === issue.companyId && run.nativeIssueId === issue.id
      && isAcknowledgedNativeStop({ ...run, companyId: run.companyId, nativeIssueId: run.nativeIssueId })) return base;
  // A queued-message Interrupt stops this run to deliver that exact message.
  // The stop is the user's intent and the message starts next, so show the
  // hand-off as working, not as a failed attempt.
  // Newer queued input can follow it, so match the recorded queue, not the latest wait.
  const interruptWait = input.interruptWait ?? wait;
  const interruptAt = Date.parse(interruptWait?.queuedInterruptRequestedAt ?? "");
  if (interruptWait && run.status === "cancelled" && run.resultJson?.queuedCommentInterruptQueueId === interruptWait.id
      && Number.isFinite(interruptAt) && now - interruptAt < QUEUED_INTERRUPT_HANDOFF_GRACE_MS
      && !(retryWait?.sourceRunId === run.id && retryWait.preparationStatus) && system?.state !== "exhausted")
    return { ...base, intentId: interruptWait.id, state: "working" };
  if (["running", "queued"].includes(run.status)) return { ...base, state: "working" };
  // Paperclip is continuing the task by itself: no failed attempt and no Retry.
  if (input.freshContinuation?.state === "continuing") return { ...base, state: "working", canRetry: false };
  if (input.freshContinuation?.state === "scheduled" && input.freshContinuation.nextCheckAt > now)
    return { ...base, state: "retry_scheduled", nextRetryAt: new Date(input.freshContinuation.nextCheckAt).toISOString(), canRetry: false };
  if (input.automaticDispositionAt !== undefined && ["failed", "timed_out", "interrupted", "cancelled"].includes(run.status)
      && now - Math.max(input.automaticDispositionAt, run.finishedAt?.getTime() ?? 0) < AUTOMATIC_DISPOSITION_GRACE_MS)
    return { ...base, state: "working", canRetry: false };
  const deniedProject = deniedProjectId(issue, run);
  let projectAccess: TaskInterruptionPresentation["projectAccess"];
  if (deniedProject !== undefined) {
    // Permissions cannot repair a stale or unavailable workspace selection.
    if (input.workspaceSelectionAvailable === false) return { ...base, state: "failed" };
    const ready = input.projectAccessAllowed === true;
    const projectId = input.projectAccessProjectId === undefined ? deniedProject : input.projectAccessProjectId;
    projectAccess = { agentId: run.agentId!, projectId: projectId === issue.projectId ? projectId : null, ready };
    if (!ready) return { ...base, responsibility: "user", state: "waiting_for_user",
      userAction: "project_access", projectAccess };
  }
  const recoveryStep: TaskInterruptionPresentation["recoveryStep"] = !system ? undefined
    : system.phase === "verify_execution" ? "checking_previous_run"
      : system.phase === "preserve_files" ? "saving_previous_files" : "finishing_recovery";
  const activeObservation = action?.evidence.systemRecoveryActiveAt;
  const recoveryRunning = system?.state === "running" && typeof activeObservation === "number"
    && activeObservation > now - 45_000;
  const recoveryScheduled = Boolean(system?.nextAttemptAt && system.nextAttemptAt > now);
  const preparationDeadline = retryWait?.preparationRetryAt == null ? NaN : Number(retryWait.preparationRetryAt);
  // A pending Retry preparation is already a Retry; never offer another one.
  const preparationPending = retryWait?.sourceRunId === run.id && Boolean(retryWait.preparationStatus)
    && ["issued", "processing"].includes(retryWait.preparationStatus!) && Number.isFinite(preparationDeadline);
  if (retryWait?.sourceRunId === run.id && retryWait.preparationStatus) {
    const deadline = preparationDeadline;
    const pending = preparationPending;
    // Saved-work recovery gates a pending preparation, so it names the wait.
    // Failed or cancelled preparation stays authoritative.
    if (pending && !recoveryRunning && !recoveryScheduled)
      return { ...base, state: "retry_scheduled", nextRetryAt: new Date(deadline).toISOString() };
    if (!pending) return { ...base, state: "failed", canRetry: retryWait.preparationStatus !== "cancelled" };
  }
  if (run.status === "scheduled_retry" && resourceWaitRetryReasons.has(run.scheduledRetryReason ?? "") && !system)
    return { ...base, state: "working" };
  if (run.status === "scheduled_retry" && run.scheduledRetryReason === INTERRUPTED_PREPARATION_RETRY_REASON && !system
      && (!run.scheduledRetryAt || now - run.scheduledRetryAt.getTime() < NATIVE_RESUME_DISPATCH_GRACE_MS))
    return { ...base, state: "working" };
  // The native coordinator resumes this same run by itself. A manual Retry
  // would race it, so show the resume until it is due and briefly while its
  // dispatch runs. A resume that never ran falls through to one Retry.
  const nativeResumeAt = run.nativeResumeAt?.getTime();
  const retryAt = system?.nextAttemptAt ?? nativeResumeAt ?? run.scheduledRetryAt?.getTime();
  if (run.runtimeMode === "native" && run.errorCode === "native_governed_wait_settlement_pending") {
    const settling = recoveryRunning || Boolean(retryAt && now - retryAt < NATIVE_RESUME_DISPATCH_GRACE_MS);
    return { ...base, state: settling ? "working" : "failed", canRetry: false,
      retryWait: { reason: "governed_wait_settlement", message: settling
        ? "Your work is saved. Paperclip is finishing shutdown."
        : "Paperclip couldn’t confirm shutdown. Your work is saved; continuation is paused." } };
  }
  if (retryAt && retryAt > now) return { ...base, state: "retry_scheduled",
    nextRetryAt: new Date(retryAt).toISOString(), canRetry: !preparationPending && !nativeResumeAt && run.status !== "scheduled_retry",
    ...(system?.nextAttemptAt && recoveryStep ? { recoveryStep } : {}) };
  if (nativeResumeAt && !system && now - nativeResumeAt < NATIVE_RESUME_DISPATCH_GRACE_MS)
    return { ...base, state: "working" };
  if (recoveryRunning) return { ...base, state: "working", ...(recoveryStep ? { recoveryStep } : {}) };
  const dependencies = input.retryDependencies;
  if (retryWait?.sourceRunId === run.id && !retryWait.executionWaitReason && !retryWait.preparationStatus && dependencies?.count)
    return { ...base, intentId: retryWait.id, state: "working",
      retryWait: { reason: "dependency_blocked", message: dependencyRetryWaitMessage(dependencies) } };
  if (retryWait?.sourceRunId === run.id && retryWait.executionWaitReason === "process_identity_missing"
      && input.unidentifiedLaunchConfirmable)
    return { ...base, responsibility: "user", state: "waiting_for_user", canRetry: false, userAction: "confirm_run_stopped",
      retryWait: { reason: "process_identity_missing", message: UNIDENTIFIED_RUNNER_STOP_MESSAGE } };
  if (retryWait?.sourceRunId === run.id && retryWait.executionWaitReason) {
    const reason = Object.hasOwn(retryWaitMessages, retryWait.executionWaitReason) ? retryWait.executionWaitReason : "execution_recovery";
    // Keep the latest input receipt so message submission can settle independently.
    return { ...base, state: "failed",
      canRetry: heldRetryOffersRetry(reason, input.cleanupSettling), retryWait: { reason,
      message: retryWaitMessages[reason] ?? "Retry is waiting for execution checks. Your message is saved." } };
  }
  const queuedDuringRun = Boolean(wait && run.status === "succeeded" && (["todo", "in_progress", "in_review"].includes(issue.status)
      || (issue.status === "blocked" && input.waitingOnOpenSubtasks && !wait.sourceRunId && wait.queuedComment)) && run.finishedAt && wait.requestedAt.getTime() <= run.finishedAt.getTime()
    && now - run.finishedAt.getTime() < QUEUED_INPUT_DISPATCH_GRACE_MS);
  if (wait && (wait.requestedAt.getTime() > now - 10_000 || queuedDuringRun) && system?.state !== "exhausted")
    return { ...base, state: "working" };
  if (run.errorCode === NATIVE_SESSION_CLEANUP_QUARANTINED) {
    // The provider turn completed and its work is saved; only shutdown of the
    // old session is unproven, and that settles by itself. A task that waits on
    // its blockers shows that wait, not a failed attempt. Without such a wait a
    // missing task disposition stays visible.
    if (run.completedTurnCleanup && input.waitingOnBlockers) return base;
    // Waiting is honest only while something settles the gate. Otherwise
    // Retry proves the old session stopped and continues from saved work.
    if (!input.cleanupSettling) return { ...base, state: "failed", canRetry: true };
    return { ...base, state: "failed", canRetry: false,
      retryWait: { reason: "cleanup_quarantined", message: NATIVE_CLEANUP_SETTLING_MESSAGE } };
  }
  return { ...base, state: "failed", canRetry: true, ...(projectAccess ? { projectAccess } : {}) };
}

/** Tasks whose cleanup-gated run still has a live owner settling the gate: a
 * remote environment not yet released (its termination receipt retires the
 * gate), or a scheduled close in this process. An operator-required gate or a
 * gate lost with a restarted process has no owner. */
async function quarantineCleanupSettling(db: Db, companyId: string,
  entries: Array<{ issueId: string; run: { id: string; nativeIssueId?: string | null } }>): Promise<Set<string>> {
  const settling = new Set<string>();
  if (!entries.length) return settling;
  const unreleased = new Set((await db.select({ runId: environmentLeases.heartbeatRunId }).from(environmentLeases).where(and(
    eq(environmentLeases.companyId, companyId), inArray(environmentLeases.heartbeatRunId, entries.map(entry => entry.run.id)),
    isNull(environmentLeases.releasedAt), sql`${environmentLeases.provider} is distinct from 'local'`,
  ))).map(row => row.runId));
  for (const { issueId, run } of entries) {
    if (unreleased.has(run.id) || nativeSessionCleanupBlock({ companyId, issueId: run.nativeIssueId ?? issueId }) === "pending")
      settling.add(issueId);
  }
  return settling;
}

/** A scheduled retry has no outcome yet, so its provider failure is read from
 * the predecessor it retries: the countdown keeps its reason.
 * Batch list reads rather than doing seven queries per row. Keep run logs and
 * large result bodies out of this projection. */
export async function taskInterruptionPresentations(db: Db, companyId: string, input: ProjectionIssue[]) {
  const selected = input.filter(issue => issue.companyId === companyId);
  const result = new Map<string, TaskInterruptionPresentation | null>();
  if (!selected.length) return result;
  const ids = selected.map(issue => issue.id);
  const requested = sql`unnest(${sql.param([...new Set(ids)])}::text[]) as requested_interruption_issues(requested_issue_id)`;
  const requestedIssueId = sql<string>`"requested_interruption_issues"."requested_issue_id"`;
  const requestedUuid = sql<string>`case when ${requestedIssueId} ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then ${requestedIssueId}::uuid else null end`;
  const legacyIssue = sql<string>`${heartbeatRuns.contextSnapshot}->>'issueId'`;
  const candidate = (condition: ReturnType<typeof and>) => db.select({ id: heartbeatRuns.id, createdAt: heartbeatRuns.createdAt })
    .from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId), condition))
    .orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id)).limit(1);
  const candidates = unionAll(
    candidate(eq(heartbeatRuns.nativeIssueId, requestedUuid)),
    candidate(and(isNull(heartbeatRuns.nativeIssueId), eq(heartbeatRuns.issueId, requestedUuid))),
    candidate(and(isNull(heartbeatRuns.nativeIssueId), isNull(heartbeatRuns.issueId), eq(legacyIssue, requestedIssueId))),
  ).as("interruption_run_candidates");
  const latestRuns = db.select({ id: candidates.id }).from(candidates)
    .orderBy(desc(candidates.createdAt), desc(candidates.id)).limit(1).as("latest_interruption_runs");
  const wakeIssue = sql<string>`${agentWakeupRequests.payload}->>'issueId'`;
  const isRetryWait = sql<boolean>`coalesce(jsonb_typeof(${agentWakeupRequests.payload}#>'{taskRetry,sourceRunId}') = 'string', false)`;
  const agentIds = selected.flatMap(issue => issue.assigneeAgentId ? [issue.assigneeAgentId] : []);
  const projectIds = selected.flatMap(issue => issue.projectId ? [issue.projectId] : []);
  const startingIssueIds = selected.filter(issue => issue.status === "todo" && issue.assigneeAgentId).map(issue => issue.id);
  const [runs, waits, agentRows, projectRows, pauseRows, approvalRows, companyRows, admissionWaits] = await Promise.all([
    db.select({ issueId: requestedIssueId, id: heartbeatRuns.id, status: heartbeatRuns.status,
      createdAt: heartbeatRuns.createdAt, finishedAt: heartbeatRuns.finishedAt, agentId: heartbeatRuns.agentId, companyId: heartbeatRuns.companyId,
      nativeIssueId: heartbeatRuns.nativeIssueId, runtimeMode: heartbeatRuns.runtimeMode, startedAt: heartbeatRuns.startedAt,
      processPid: heartbeatRuns.processPid, processGroupId: heartbeatRuns.processGroupId,
      agentAdapter: agents.adapterType,
      error: sql<string | null>`case when ${heartbeatRuns.errorCode} = 'setup_failed'
        and ${heartbeatRuns.error} = 'Project is outside this low-trust boundary.'
        or ${heartbeatRuns.errorCode} = 'workspace_validation_failed'
        -- A setup command failure recorded before setupCommandFailure existed: only its fixed message shape.
        or ${heartbeatRuns.errorCode} = 'setup_failed'
          and ${heartbeatRuns.error} ~ '^(Execution workspace provision|Workspace seed|Runtime provision) command "'
        then ${heartbeatRuns.error} else null end`,
      errorCode: heartbeatRuns.errorCode, livenessState: heartbeatRuns.livenessState, scheduledRetryAt: heartbeatRuns.scheduledRetryAt,
      // The model this run asked the provider for; configuration, not provider text.
      // Saved fields only, so quarantines written by earlier releases read the same.
      completedTurnCleanup: sql<boolean>`coalesce(${heartbeatRuns.runtimeMode} = 'native' and ${heartbeatRuns.status} = 'failed'
        and ${heartbeatRuns.errorCode} = ${NATIVE_SESSION_CLEANUP_QUARANTINED}
        and ${heartbeatRuns.runnerProfileJson}#>>'{sessionCheckpoint,identity,runId}' = ${heartbeatRuns.id}::text
        and ${heartbeatRuns.runnerProfileJson}#>>'{sessionCheckpoint,terminal,turnTerminalState}' = 'completed'
        and coalesce(jsonb_typeof(${heartbeatRuns.runnerProfileJson}#>'{sessionCheckpoint,activeTurnId}'), 'null') = 'null', false)`,
      rejectedModel: sql<string | null>`case when ${heartbeatRuns.errorCode} = 'native_provider_model_rejected'
        then ${boundedJsonString(sql`${heartbeatRuns.runnerProfileJson}->'nativeExecutionInput'->'provider'->'model'`, 200)} end`,
      scheduledRetryReason: heartbeatRuns.scheduledRetryReason,
      // Candidate only: the coordinator also pushes nextAttemptAt forward while
      // it defers an ineligible run. The scheduler's own admission check below
      // decides whether this resume is real.
      nativeResumeAt: sql<Date | null>`(select ${nativeRunFinalizations.nextAttemptAt} from ${nativeRunFinalizations}
        where ${nativeRunFinalizations.companyId} = ${heartbeatRuns.companyId} and ${nativeRunFinalizations.runId} = ${heartbeatRuns.id}
          and ${heartbeatRuns.runtimeMode} = 'native' and ${heartbeatRuns.status} = 'failed'
          and ${nativeRunFinalizations.resultId} is null and ${nativeRunFinalizations.phase} = 'retryable_failure'
          and ${heartbeatRuns.contextSnapshot}->'nativeQuestionCancellation' is null
          and ${heartbeatRuns.runnerProfileJson}->'legacyWorkspaceRecoveryMigration' is null)`.mapWith(value => value == null ? null : new Date(value)),
      nativeFailedAt: sql<Date | null>`(select ${nativeRunFinalizations.updatedAt} from ${nativeRunFinalizations}
        where ${nativeRunFinalizations.companyId} = ${heartbeatRuns.companyId} and ${nativeRunFinalizations.runId} = ${heartbeatRuns.id}
          and ${nativeRunFinalizations.phase} = 'terminal_failure')`.mapWith(value => value == null ? null : new Date(value)),
      nativeFinalizationRetry: exhaustedNativeFinalizationCondition(),
      nativeFinalizationRetryPending: savedResultRetryPendingCondition(),
      // The run whose resultJson supplied providerFailure. A scheduled retry
      // shows its predecessor's reason, so redaction must use that run's registry.
      providerFailureRunId: sql<string>`case when ${heartbeatRuns.resultJson}->'providerFailure' is null
        and ${heartbeatRuns.status} = 'scheduled_retry' and ${heartbeatRuns.retryOfRunId} is not null
        then ${heartbeatRuns.retryOfRunId} else ${heartbeatRuns.id} end`,
      // The run whose resultJson supplied setupCommandFailure (a scheduled retry shows its predecessor's).
      setupFailureRunId: sql<string>`case when ${heartbeatRuns.resultJson}->'setupCommandFailure' is null
        and ${heartbeatRuns.status} = 'scheduled_retry' and ${heartbeatRuns.retryOfRunId} is not null
        then ${heartbeatRuns.retryOfRunId} else ${heartbeatRuns.id} end`,
      resultJson: sql<Record<string, unknown>>`jsonb_build_object('configurationIncomplete', ${heartbeatRuns.resultJson}->'configurationIncomplete',
        'stopReason', ${boundedJsonString(sql`${heartbeatRuns.resultJson}->'stopReason'`, 80)},
        'timeoutSource', ${boundedJsonString(sql`${heartbeatRuns.resultJson}->'timeoutSource'`, 80)},
        'timeoutFired', coalesce(${heartbeatRuns.resultJson}->'timeoutFired' = 'true'::jsonb, false),
        'projectAccessDenied', ${heartbeatRuns.resultJson}->'projectAccessDenied',
        'cancelledByActorType', ${boundedJsonString(sql`${heartbeatRuns.resultJson}->'cancelledByActorType'`, 32)},
        'cancelledByUserId', ${boundedJsonString(sql`${heartbeatRuns.resultJson}->'cancelledByUserId'`, 160)},
        'queuedCommentInterruptQueueId', ${boundedJsonString(sql`${heartbeatRuns.resultJson}->'queuedCommentInterruptQueueId'`, 160)},
        'nativeCancellation', jsonb_build_object(
          'schema', ${boundedJsonString(sql`${heartbeatRuns.resultJson}->'nativeCancellation'->'schema'`, 64)},
          'runId', ${boundedJsonString(sql`${heartbeatRuns.resultJson}->'nativeCancellation'->'runId'`, 160)},
          'companyId', ${boundedJsonString(sql`${heartbeatRuns.resultJson}->'nativeCancellation'->'companyId'`, 160)},
          'issueId', ${boundedJsonString(sql`${heartbeatRuns.resultJson}->'nativeCancellation'->'issueId'`, 160)},
          'scope', ${boundedJsonString(sql`${heartbeatRuns.resultJson}->'nativeCancellation'->'scope'`, 32)},
          'reasonCode', ${boundedJsonString(sql`${heartbeatRuns.resultJson}->'nativeCancellation'->'reasonCode'`, 64)},
          'dispatchState', ${boundedJsonString(sql`${heartbeatRuns.resultJson}->'nativeCancellation'->'dispatchState'`, 32)},
          'dispatched', coalesce(${heartbeatRuns.resultJson}->'nativeCancellation'->'dispatched' = 'true'::jsonb, false),
          'intentAuditId', ${boundedJsonString(sql`${heartbeatRuns.resultJson}->'nativeCancellation'->'intentAuditId'`, 160)},
          'acknowledgementAuditId', ${boundedJsonString(sql`${heartbeatRuns.resultJson}->'nativeCancellation'->'acknowledgementAuditId'`, 160)}),
        'providerFailure', coalesce(${heartbeatRuns.resultJson}->'providerFailure', case when ${heartbeatRuns.status} = 'scheduled_retry'
          then (select predecessor.result_json->'providerFailure' from ${heartbeatRuns} predecessor
            where predecessor.company_id = ${heartbeatRuns.companyId} and predecessor.id = ${heartbeatRuns.retryOfRunId}) end),
        'setupCommandFailure', coalesce(${heartbeatRuns.resultJson}->'setupCommandFailure', case when ${heartbeatRuns.status} = 'scheduled_retry'
          then (select predecessor.result_json->'setupCommandFailure' from ${heartbeatRuns} predecessor
            where predecessor.company_id = ${heartbeatRuns.companyId} and predecessor.id = ${heartbeatRuns.retryOfRunId}
              and predecessor.error_code = 'setup_failed') end))`,
    }).from(requested).innerJoinLateral(latestRuns, sql`true`).innerJoin(heartbeatRuns, and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, latestRuns.id)))
      .leftJoin(agents, and(eq(agents.companyId, heartbeatRuns.companyId), eq(agents.id, heartbeatRuns.agentId)))
      .orderBy(requestedIssueId),
    // Keep at most two candidates per task: latest Retry and latest other input.
    // A new message must not hide an existing Retry's admission explanation.
    db.selectDistinctOn([wakeIssue, isRetryWait], { issueId: wakeIssue, id: agentWakeupRequests.id, requestedAt: agentWakeupRequests.requestedAt,
      requestedByActorId: agentWakeupRequests.requestedByActorId,
      sourceRunId: boundedJsonString(sql`${agentWakeupRequests.payload}#>'{taskRetry,sourceRunId}'`, 160),
      executionWaitReason: boundedJsonString(sql`to_jsonb(${unpricedUsageWait(sql`${agentWakeupRequests.payload}#>>'{executionWait,reason}'`,
        sql`${agentWakeupRequests.payload}#>>'{executionWait,message}'`)})`, 80),
      preparationStatus: chatActions.status, preparationRetryAt: chatActionDeadline("failed_run_retry"),
      preparationUpdatedAt: chatActions.updatedAt,
      queuedComment: sql<boolean>`coalesce(jsonb_typeof(${agentWakeupRequests.payload}->'commentId') = 'string'
        or jsonb_array_length(case when jsonb_typeof(${agentWakeupRequests.payload}#>'{_paperclipWakeContext,wakeCommentIds}') = 'array'
          then ${agentWakeupRequests.payload}#>'{_paperclipWakeContext,wakeCommentIds}' end) > 0, false)` })
      .from(agentWakeupRequests).leftJoin(chatActions, and(eq(chatActions.companyId, agentWakeupRequests.companyId),
        eq(chatActions.id, canonicalExecutionUuid(sql`${agentWakeupRequests.payload}#>>'{taskRetry,chatActionId}'`)),
        eq(chatActions.kind, "failed_run_retry"), sql`${chatActions.payload}->>'taskRetryIntentId' = ${agentWakeupRequests.id}::text`,
        sql`${chatActions.payload}->>'issueId' = ${wakeIssue}`,
        sql`${chatActions.payload}->>'agentId' = ${agentWakeupRequests.agentId}::text`,
        sql`${chatActions.payload}->>'failedRunId' = ${agentWakeupRequests.payload}#>>'{taskRetry,sourceRunId}'`,
        inArray(chatActions.status, ["issued", "processing", "failed", "cancelled"])))
      .where(and(eq(agentWakeupRequests.companyId, companyId), inArray(wakeIssue, ids),
        eq(agentWakeupRequests.status, "deferred_issue_execution"), eq(agentWakeupRequests.requestedByActorType, "user")))
      .orderBy(wakeIssue, isRetryWait, desc(agentWakeupRequests.requestedAt), desc(agentWakeupRequests.id)),
    agentIds.length ? db.select({ id: agents.id, status: agents.status, pauseReason: agents.pauseReason }).from(agents)
      .where(and(eq(agents.companyId, companyId), inArray(agents.id, agentIds))) : [],
    projectIds.length ? db.select({ id: projects.id, pausedAt: projects.pausedAt, pauseReason: projects.pauseReason }).from(projects)
      .where(and(eq(projects.companyId, companyId), inArray(projects.id, projectIds))) : [],
    db.select({ issueId: issueTreeHoldMembers.issueId }).from(issueTreeHoldMembers).innerJoin(issueTreeHolds, and(
      eq(issueTreeHolds.companyId, issueTreeHoldMembers.companyId), eq(issueTreeHolds.id, issueTreeHoldMembers.holdId)))
      .where(and(eq(issueTreeHoldMembers.companyId, companyId), inArray(issueTreeHoldMembers.issueId, ids),
        eq(issueTreeHolds.status, "active"), eq(issueTreeHolds.mode, "pause"))),
    db.select({ issueId: issueApprovals.issueId }).from(issueApprovals).innerJoin(approvals, and(
      eq(approvals.companyId, issueApprovals.companyId), eq(approvals.id, issueApprovals.approvalId)))
      .where(and(eq(issueApprovals.companyId, companyId), inArray(issueApprovals.issueId, ids),
        inArray(approvals.status, ["pending", "revision_requested"]))),
    db.select({ status: companies.status, pauseReason: companies.pauseReason }).from(companies).where(eq(companies.id, companyId)),
    // Only consulted for tasks without a run: the latest wake says whether admission refused it.
    startingIssueIds.length ? db.selectDistinctOn([wakeIssue], { issueId: wakeIssue, id: agentWakeupRequests.id,
      status: agentWakeupRequests.status, reason: unpricedUsageWait(sql`${agentWakeupRequests.reason}`, sql`${agentWakeupRequests.error}`),
      agentId: agentWakeupRequests.agentId })
      .from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, companyId), inArray(wakeIssue, startingIssueIds)))
      .orderBy(wakeIssue, desc(agentWakeupRequests.requestedAt), desc(agentWakeupRequests.id)) : [],
  ]);
  // Advertise a pending resume only when the scheduler would admit it, using
  // its own check, so the task never hides Retry behind a deferred candidate
  // and never offers Retry beside a resume that will run. Rare rows only.
  // Candidates are failed native runs inside an active coordinator retry, so
  // there are few. Their rows load in three batched reads; admission itself
  // runs a few bounded reads per candidate, four at a time.
  const resumeCandidates = runs.filter(run => run.nativeResumeAt);
  if (resumeCandidates.length) {
    const { readNativeSessionResumptionAgent } = await import("./native-runtime/native-session-resumption-admission.js");
    const candidateIds = resumeCandidates.map(run => run.id);
    const [fullRuns, coordinators] = await Promise.all([
      db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId), inArray(heartbeatRuns.id, candidateIds))),
      db.select().from(nativeRunFinalizations).where(and(eq(nativeRunFinalizations.companyId, companyId),
        inArray(nativeRunFinalizations.runId, candidateIds))),
    ]);
    const issueIds = [...new Set(fullRuns.flatMap(run => run.nativeIssueId ? [run.nativeIssueId] : []))];
    const issueRows = issueIds.length ? await db.select().from(issues).where(and(eq(issues.companyId, companyId),
      inArray(issues.id, issueIds))) : [];
    const runById = new Map(fullRuns.map(run => [run.id, run]));
    const coordinatorByRun = new Map(coordinators.map(row => [row.runId, row]));
    const issueById = new Map(issueRows.map(row => [row.id, row]));
    for (let start = 0; start < resumeCandidates.length; start += 4) {
      await Promise.all(resumeCandidates.slice(start, start + 4).map(async candidate => {
        const run = runById.get(candidate.id);
        const issue = run?.nativeIssueId ? issueById.get(run.nativeIssueId) : undefined;
        const coordinator = coordinatorByRun.get(candidate.id);
        const admitted = run && issue && coordinator
          && await readNativeSessionResumptionAgent(db, { issue, run, coordinator }).catch(() => null);
        if (!admitted) candidate.nativeResumeAt = null;
      }));
    }
  }
  // A queued-message Interrupt records its queue on the stopped run. Newer
  // input can hide that wake from the latest-wait read, so load it by id.
  const interruptQueueId = (run: typeof runs[number]) => {
    const id = run.status === "cancelled" ? run.resultJson?.queuedCommentInterruptQueueId : null;
    return typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id) ? id : null;
  };
  const interruptQueueIds = runs.flatMap(run => interruptQueueId(run) ?? []);
  const interruptWaits = interruptQueueIds.length ? await db.select({ issueId: wakeIssue, id: agentWakeupRequests.id,
    requestedAt: agentWakeupRequests.requestedAt,
    queuedInterruptRequestedAt: boundedJsonString(sql`${agentWakeupRequests.payload}#>'{queuedCommentInterrupt,requestedAt}'`, 40) })
    .from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, companyId), inArray(agentWakeupRequests.id, interruptQueueIds),
      eq(agentWakeupRequests.status, "deferred_issue_execution"), eq(agentWakeupRequests.requestedByActorType, "user"))) : [];
  const interruptWaitById = new Map(interruptWaits.map(wait => [wait.id, wait]));
  const runIds = runs.map(run => run.id);
  const actions = runIds.length ? await db.selectDistinctOn([issueRecoveryActions.sourceIssueId]).from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.companyId, companyId), inArray(issueRecoveryActions.sourceIssueId, ids),
    inArray(sql`${issueRecoveryActions.evidence}->>'runId'`, runIds),
    sql`${issueRecoveryActions.evidence} ? 'systemRecovery'`,
  )).orderBy(issueRecoveryActions.sourceIssueId, desc(issueRecoveryActions.createdAt)) : [];
  // The fresh-continuation fallback's records for these runs.
  const freshRows = runIds.length ? await db.select({ issueId: issueRecoveryActions.sourceIssueId,
    runId: sql<string>`${issueRecoveryActions.evidence}->>'runId'`,
    delivery: sql<string | null>`${issueRecoveryActions.evidence}->>'continuationDelivery'`,
    recorded: sql<boolean>`${issueRecoveryActions.evidence} ? 'freshContinuation'`,
    evidence: sql<Record<string, unknown>>`jsonb_build_object('freshContinuation', ${issueRecoveryActions.evidence}->'freshContinuation')`,
    resolvedAt: issueRecoveryActions.resolvedAt, updatedAt: issueRecoveryActions.updatedAt,
    checkKind: sql<string | null>`${issueRecoveryActions.evidence}#>>'{freshContinuationCheck,kind}'`,
    nextCheckAt: sql<string | null>`${issueRecoveryActions.evidence}#>>'{freshContinuationCheck,nextCheckAt}'` })
    .from(issueRecoveryActions).where(and(eq(issueRecoveryActions.companyId, companyId), inArray(issueRecoveryActions.sourceIssueId, ids),
      inArray(sql`${issueRecoveryActions.evidence}->>'runId'`, runIds),
      sql`(${issueRecoveryActions.evidence} ? 'freshContinuationSettlement' or ${issueRecoveryActions.evidence} ? 'freshContinuationCheck')`)) : [];
  const freshContinuationFor = (issueId: string, runId: string | undefined): ProjectionState["freshContinuation"] => {
    const rows = freshRows.filter(row => row.issueId === issueId && row.runId === runId);
    // Only the primary record (it carries `freshContinuation`) says whether a
    // continuation is still on its way; holds coalesced into it never do.
    if (rows.some(row => row.recorded && (row.delivery === "not_requested" || (row.delivery === "pending"
      && Date.now() - recoveryContinuationHeldSince(row) < RECOVERY_CONTINUATION_DELIVERY_BOUND_MS)))) return { state: "continuing" };
    const scheduled = rows.filter(row => ["exact_recovery_pending", "backoff"].includes(row.checkKind ?? "") && row.nextCheckAt)
      .map(row => Number(row.nextCheckAt)).sort((a, b) => a - b)[0];
    return scheduled ? { state: "scheduled", nextCheckAt: scheduled } : undefined;
  };
  const dispositionRows = runIds.length ? await db.select({ issueId: issueRecoveryActions.sourceIssueId,
    runId: sql<string>`${issueRecoveryActions.evidence}->>'runId'`, updatedAt: issueRecoveryActions.updatedAt })
    .from(issueRecoveryActions).where(and(eq(issueRecoveryActions.companyId, companyId),
      inArray(issueRecoveryActions.sourceIssueId, ids), inArray(sql`${issueRecoveryActions.evidence}->>'runId'`, runIds),
      inArray(issueRecoveryActions.status, ["active", "escalated"]), eq(issueRecoveryActions.ownerType, "system"),
      inArray(issueRecoveryActions.cause, [...EXECUTION_RECONCILIATION_CAUSES]), isNull(issueRecoveryActions.ownerUserId),
      sql`not (${issueRecoveryActions.evidence} ?| array['systemRecovery', 'executionReconciliation', 'freshContinuation',
        'freshContinuationCheck', 'ownerGoneAttestation', 'explicitUserContinuation'])`)) : [];
  const automaticDispositionAt = new Map<string, number>();
  if (dispositionRows.length) {
    const { isPersonOwnedFailureCode } = await import("./fresh-continuation-fallback.js");
    for (const row of dispositionRows) {
      const run = runs.find(candidate => candidate.issueId === row.issueId && candidate.id === row.runId);
      if (!run || isPersonOwnedFailureCode(run.errorCode)) continue;
      automaticDispositionAt.set(row.issueId, Math.max(automaticDispositionAt.get(row.issueId) ?? 0, row.updatedAt.getTime()));
    }
  }
  const ownerStops = runIds.length ? await db.select({ issueId: issueRecoveryActions.sourceIssueId,
    runId: sql<string>`${issueRecoveryActions.evidence}->>'runId'` }).from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.companyId, companyId), inArray(issueRecoveryActions.sourceIssueId, ids),
    eq(issueRecoveryActions.cause, "native_workspace_finalization_owner_unverified"), eq(issueRecoveryActions.ownerType, "board"),
    inArray(issueRecoveryActions.status, ["active", "escalated"]),
    inArray(sql`${issueRecoveryActions.evidence}->>'runId'`, runIds),
    sql`${issueRecoveryActions.evidence}->'workspaceOwnerStop' is null`,
    sql`coalesce(${issueRecoveryActions.evidence}#>>'{workspaceOwnerRecovery,state}', '') <> 'resuming'`,
  )) : [];
  const ownerStopRequired = new Set(ownerStops.map(row => `${row.issueId}:${row.runId}`));
  const byIssue = <T extends { issueId: string }>(rows: T[]) => new Map(rows.map(row => [row.issueId, row]));
  const runMap = byIssue(runs), waitMap = new Map<string, typeof waits[number]>();
  // A Retry belongs to the run it observed. New conversation work supersedes
  // that authority, even before dispatch retires the old receipt. Retained
  // ordinary input is independent and must still be shown as waiting.
  const currentWaits = waits.filter(wait => !wait.sourceRunId || wait.sourceRunId === runMap.get(wait.issueId)?.id);
  const decisionWaits = currentWaits.filter(wait => wait.executionWaitReason === "decision_pending");
  if (decisionWaits.length) {
    const { pendingContinuationDecisionWaits } = await import("./explicit-native-continuation.js");
    const held = await pendingContinuationDecisionWaits(db, companyId, decisionWaits.flatMap(wait => wait.requestedByActorId
      ? [{ id: wait.id, issueId: wait.issueId, actorId: wait.requestedByActorId, taskRetrySourceRunId: wait.sourceRunId }] : []));
    for (const wait of decisionWaits) if (!held.has(wait.id)) wait.executionWaitReason = null;
  }
  const retryWaitMap = byIssue(currentWaits.filter(wait => wait.sourceRunId));
  const retryIssueIds = [...retryWaitMap.keys()];
  const retryDependencyMap = new Map<string, RetryDependencies>();
  if (retryIssueIds.length) {
    const { issueService } = await import("./issues.js");
    const readiness = await issueService(db).listDependencyReadiness(companyId, retryIssueIds);
    const blockerIds = [...new Set([...readiness.values()].flatMap(row => row.unresolvedBlockerIssueIds))];
    const statusRows = blockerIds.length ? await db.select({ id: issues.id, status: issues.status }).from(issues)
      .where(and(eq(issues.companyId, companyId), inArray(issues.id, blockerIds))) : [];
    const statusById = new Map(statusRows.map(row => [row.id, row.status]));
    for (const [waitingIssueId, row] of readiness) {
      const ids = [...new Set(row.unresolvedBlockerIssueIds)];
      if (!ids.length) continue;
      const statuses = ids.map(id => statusById.get(id));
      const saving = new Set(row.pendingFinalizeBlockerIssueIds);
      retryDependencyMap.set(waitingIssueId, { count: ids.length,
        blocked: statuses.includes("blocked"), cancelled: statuses.includes("cancelled"),
        savingFilesOnly: ids.every(id => saving.has(id)) });
    }
  }
  // A completed turn refused only by the cleanup gate shows the task's own
  // blocker wait. Read readiness for those tasks only.
  const settledIssueIds = [...runMap.values()].filter(run => run.completedTurnCleanup).map(run => run.issueId);
  const waitingOnBlockers = new Set<string>();
  if (settledIssueIds.length) {
    const { issueService } = await import("./issues.js");
    const readiness = await issueService(db).listDependencyReadiness(companyId, settledIssueIds);
    for (const [waitingIssueId, row] of readiness)
      if (row.unresolvedBlockerIssueIds.length) waitingOnBlockers.add(waitingIssueId);
  }
  const parentIds = selected.filter(issue => issue.status === "blocked" && runMap.get(issue.id)?.status === "succeeded"
    && currentWaits.some(wait => wait.issueId === issue.id && wait.queuedComment)).map(issue => issue.id);
  const waitingOnOpenSubtasks = new Set(parentIds.length ? (await db.selectDistinct({ parentId: issues.parentId }).from(issues)
    .where(and(eq(issues.companyId, companyId), inArray(issues.parentId, parentIds), notInArray(issues.status, ["done", "cancelled"]))))
    .flatMap(row => row.parentId ? [row.parentId] : []) : []);
  for (const wait of currentWaits) {
    const current = waitMap.get(wait.issueId);
    if (!current || wait.requestedAt > current.requestedAt ||
        (wait.requestedAt.getTime() === current.requestedAt.getTime() && wait.id > current.id)) waitMap.set(wait.issueId, wait);
  }
  // Recheck current authority, including standard trust, root-issue grants and
  // project policy. Do not reuse the failed run's frozen policy for a new retry.
  // Only denied tasks need these reads; deduplicate projects and batch per agent.
  // A task's organizational project can differ from its retained source. Old
  // failures did not record the denied project, and even typed failures can
  // become obsolete after a workspace selection changes.
  const deniedIssues = selected.filter(issue => issue.assigneeAgentId && !["done", "cancelled"].includes(issue.status)
    && deniedProjectId(issue, runMap.get(issue.id)) !== undefined);
  const requirements = await taskWorkspaceProjectRequirements(db, companyId, deniedIssues.map(issue => issue.id));
  const deniedByAgent = new Map<string, Set<string>>();
  for (const issue of deniedIssues) {
    const ids = deniedByAgent.get(issue.assigneeAgentId!) ?? new Set<string>();
    for (const projectId of requirements.get(issue.id)?.projectIds ?? []) ids.add(projectId);
    if (ids.size) deniedByAgent.set(issue.assigneeAgentId!, ids);
  }
  const currentAccess = new Map<string, boolean>();
  const authorization = authorizationService(db);
  for (const [agentId, ids] of deniedByAgent) {
    const projectIds = [...ids];
    const decisions = await authorization.decideReads({ type: "agent", agentId, companyId, source: "agent_key" },
      projectIds.map(projectId => ({ type: "project" as const, companyId, projectId })));
    projectIds.forEach((projectId, index) => currentAccess.set(`${agentId}:${projectId}`, decisions[index]?.allowed === true));
  }
  const actionMap = new Map(actions.map(action => [action.sourceIssueId, action]));
  const interruptWaitFor = (issueId: string) => {
    const run = runMap.get(issueId);
    const wait = run ? interruptWaitById.get(interruptQueueId(run) ?? "") : undefined;
    return wait?.issueId === issueId ? wait : undefined;
  };
  const agentMap = new Map(agentRows.map(agent => [agent.id, agent]));
  const projectMap = new Map(projectRows.map(project => [project.id, project]));
  const pauses = new Set(pauseRows.map(row => row.issueId)), approvalsSet = new Set(approvalRows.map(row => row.issueId));
  const admissionWaitMap = byIssue(admissionWaits);
  const launchWaits = [...retryWaitMap].flatMap(([issueId, wait]) => {
    const run = runMap.get(issueId);
    return run && wait.sourceRunId === run.id && wait.executionWaitReason === "process_identity_missing" ? [{ issueId, run }] : [];
  });
  const launchRefusals = await unidentifiedLocalLaunchRefusals(db, launchWaits.map(entry => entry.run));
  const cleanupSettling = await quarantineCleanupSettling(db, companyId,
    [...runMap].flatMap(([issueId, run]) => run.errorCode === NATIVE_SESSION_CLEANUP_QUARANTINED ? [{ issueId, run }] : []));
  const confirmableLaunches = new Set(launchWaits.filter(entry => launchRefusals.get(entry.run.id) === null).map(entry => entry.issueId));
  const now = Date.now();
  for (const issue of selected) {
    const required = requirements.get(issue.id);
    const denied = required?.projectIds.filter(projectId => currentAccess.get(`${issue.assigneeAgentId}:${projectId}`) !== true);
    const facts = { run: runMap.get(issue.id), action: actionMap.get(issue.id), wait: waitMap.get(issue.id),
      retryWait: retryWaitMap.get(issue.id) };
    const presentation = projectTaskInterruption(issue, { ...facts,
      freshContinuation: freshContinuationFor(issue.id, facts.run?.id),
      automaticDispositionAt: automaticDispositionAt.get(issue.id),
      interruptWait: interruptWaitFor(issue.id),
      projectAccessAllowed: denied?.length === 0,
      projectAccessProjectId: denied?.includes(issue.projectId ?? "") ? issue.projectId : null,
      workspaceSelectionAvailable: required?.available ?? false,
      agent: agentMap.get(issue.assigneeAgentId ?? ""), project: projectMap.get(issue.projectId ?? ""),
      company: companyRows[0], paused: pauses.has(issue.id), approval: approvalsSet.has(issue.id),
      ownerStopRequired: ownerStopRequired.has(`${issue.id}:${facts.run?.id}`),
      unidentifiedLaunchConfirmable: confirmableLaunches.has(issue.id),
      admissionWait: admissionWaitMap.get(issue.id),
      retryDependencies: retryDependencyMap.get(issue.id),
      waitingOnBlockers: waitingOnBlockers.has(issue.id),
      waitingOnOpenSubtasks: waitingOnOpenSubtasks.has(issue.id),
      cleanupSettling: cleanupSettling.has(issue.id),
    }, now);
    result.set(issue.id, presentation);
    const run = facts.run;
    const runStatus = HEARTBEAT_RUN_STATUSES.find(status => status === run?.status);
    const changedAt = taskInterruptionChangedAt(facts);
    if (presentation?.responsibility === "system" && presentation.state === "failed" && run && runStatus
        && (changedAt === null || changedAt > now - TASK_INTERRUPTION_REPORT_WINDOW_MS)) {
      captureTaskInterruptionFailure({ companyId, taskId: issue.id, agentId: run.agentId,
        runId: run.id, runStatus, intentId: presentation.intentId, runErrorCode: run.errorCode ?? null,
        agentAdapter: run.agentAdapter ?? "unknown" });
    }
  }
  const offered = [...result].flatMap(([issueId, presentation]) => presentation?.canRetry ? [issueId] : []);
  if (offered.length) {
    const { executionBlockerPredicate, getExecutionBlocker, restoreHoldPredicate, restoreHoldReleasedForCurrentOwnerPredicate } =
      await import("./execution-blocker.js");
    const held = await db.selectDistinct({ issueId: issueRecoveryActions.sourceIssueId }).from(issueRecoveryActions).where(and(
      eq(issueRecoveryActions.companyId, companyId), inArray(issueRecoveryActions.sourceIssueId, offered),
      executionBlockerPredicate(), not(restoreHoldReleasedForCurrentOwnerPredicate()), restoreHoldPredicate()));
    for (const { issueId } of held) {
      const blocker = await getExecutionBlocker(db, companyId, issueId);
      const presentation = result.get(issueId);
      if (!presentation || !blocker || blocker.canRetry) continue;
      presentation.canRetry = false;
      if (!presentation.retryWait && blocker.workspaceRecovery && blocker.workspaceRecovery.status !== "recovered")
        presentation.retryWait = { reason: "workspace_repair_required", message: retryWaitMessages.workspace_repair_required! };
    }
  }
  // Redact each explanation with the registry of the run that recorded it: the
  // workspace failure is the observed run's, while a scheduled retry's provider
  // failure may be its predecessor's.
  const disclosures = [...result.entries()].flatMap(([issueId, presentation]) =>
    (presentation?.providerFailure || presentation?.workspaceFailure || presentation?.setupFailure) && presentation.observedRunId
      ? [{ id: presentation.observedRunId, providerFailureRunId: runMap.get(issueId)?.providerFailureRunId ?? presentation.observedRunId,
        setupFailureRunId: runMap.get(issueId)?.setupFailureRunId ?? presentation.observedRunId,
        providerFailure: presentation.providerFailure, workspaceFailure: presentation.workspaceFailure,
        setupFailure: presentation.setupFailure, presentation }] : []);
  if (disclosures.length) {
    try {
      const [redacted, settings] = await Promise.all([
        createRunSecretRedactionRegistry(db).redactForRuns(companyId, disclosures.flatMap(({ id, providerFailureRunId, setupFailureRunId, providerFailure, workspaceFailure, setupFailure }) => [
          { id: providerFailureRunId, providerFailure, workspaceFailure: undefined, setupFailure: undefined },
          { id, providerFailure: undefined, workspaceFailure, setupFailure: undefined },
          { id: setupFailureRunId, providerFailure: undefined, workspaceFailure: undefined, setupFailure },
        ])),
        instanceSettingsService(db).getGeneral(),
      ]);
      const safe = disclosures.map((_, index) => ({ providerFailure: redacted[3 * index]?.providerFailure,
        workspaceFailure: redacted[3 * index + 1]?.workspaceFailure, setupFailure: redacted[3 * index + 2]?.setupFailure }));
      const safeMessage = (value: unknown) => typeof value === "string"
        ? [...redactCurrentUserText(value, { enabled: settings.censorUsernameInLogs })].slice(0, 4000).join("") : "";
      disclosures.forEach(({ presentation }, index) => {
        if (presentation.providerFailure) {
          const value = safe[index]?.providerFailure;
          const failure = readProviderFailure({ ...value, message: safeMessage(value?.message) });
          if (failure) presentation.providerFailure = failure;
          else delete presentation.providerFailure;
        }
        if (presentation.workspaceFailure) {
          const message = safeMessage(safe[index]?.workspaceFailure?.message);
          if (message.trim()) presentation.workspaceFailure = { message };
          else delete presentation.workspaceFailure;
        }
        if (presentation.setupFailure) {
          const value = safe[index]?.setupFailure;
          // Redact the whole text, then shorten: the output keeps its final lines, not a head slice.
          const whole = (text: unknown) => typeof text === "string" ? redactCurrentUserText(text, { enabled: settings.censorUsernameInLogs }) : "";
          const command = whole(value?.command), message = whole(value?.message);
          const failure = value && command.trim() && message.trim()
            ? boundSetupCommandFailure({ ...value, command, output: value.output == null ? null : whole(value.output) || null, message })
            : null;
          if (failure) presentation.setupFailure = failure;
          else delete presentation.setupFailure;
        }
      });
    } catch {
      for (const { presentation } of disclosures) {
        delete presentation.providerFailure;
        delete presentation.workspaceFailure;
        delete presentation.setupFailure;
      }
      logger.warn({ companyId, runCount: disclosures.length }, "Could not redact run failure display; explanations omitted");
    }
  }
  return result;
}

export async function taskInterruptionPresentation(db: Db, issue: ProjectionIssue) {
  return (await taskInterruptionPresentations(db, issue.companyId, [issue])).get(issue.id) ?? null;
}
