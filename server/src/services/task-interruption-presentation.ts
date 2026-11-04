import { and, desc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { agents, agentWakeupRequests, approvals, chatActions, companies, heartbeatRuns, issueApprovals, issueRecoveryActions,
  issues, issueTreeHoldMembers, issueTreeHolds, projects, type Db } from "@paperclipai/db";
import { unionAll } from "drizzle-orm/pg-core";
import { HEARTBEAT_RUN_STATUSES, readProviderFailure, type TaskInterruptionPresentation } from "@paperclipai/shared";
import { captureTaskInterruptionFailure } from "../sentry.js";
import { isAiAuthenticationBlocked } from "./ai-auth-failure.js";
import { readSystemRecovery } from "./system-recovery-state.js";
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

type ProjectionIssue = Pick<typeof issues.$inferSelect, "id" | "companyId" | "status" | "assigneeAgentId" | "projectId">;
type ProjectionRun = Pick<typeof heartbeatRuns.$inferSelect,
  "id" | "status" | "scheduledRetryAt" | "errorCode" | "livenessState" | "resultJson"> &
  Partial<Pick<typeof heartbeatRuns.$inferSelect, "agentId" | "error" | "companyId" | "nativeIssueId" | "runtimeMode"
    | "createdAt" | "finishedAt">>;
type ProjectionWait = { id: string; requestedAt: Date; sourceRunId?: string | null; executionWaitReason?: string | null;
  preparationStatus?: string | null; preparationRetryAt?: number | string | null };
type ProjectionState = {
  run?: ProjectionRun;
  action?: typeof issueRecoveryActions.$inferSelect;
  wait?: ProjectionWait;
  retryWait?: ProjectionWait;
  agent?: Pick<typeof agents.$inferSelect, "status" | "pauseReason">;
  projectAccessAllowed?: boolean;
  projectAccessProjectId?: string | null;
  workspaceSelectionAvailable?: boolean;
  project?: Pick<typeof projects.$inferSelect, "pausedAt" | "pauseReason">;
  company?: Pick<typeof companies.$inferSelect, "status" | "pauseReason">;
  paused: boolean;
  approval: boolean;
};

// A task read reports the change that made a task fail, not every later read of
// retained history. The delivery cache is process-local, so a restart or another
// replica would otherwise resend each old failure whenever a list shows it.
const TASK_INTERRUPTION_REPORT_WINDOW_MS = 60 * 60_000;

/** Latest saved fact that can move a task into the failed state, if known. */
export function taskInterruptionChangedAt(input: Pick<ProjectionState, "run" | "action" | "wait" | "retryWait">): number | null {
  const { run, wait, action } = input;
  const retryWait = input.retryWait ?? wait;
  const times: unknown[] = [run?.finishedAt ?? run?.createdAt, run?.scheduledRetryAt, wait?.requestedAt, retryWait?.requestedAt]
    .map(value => value?.getTime());
  times.push(readSystemRecovery(action?.evidence)?.nextAttemptAt,
    retryWait?.preparationRetryAt == null ? null : Number(retryWait.preparationRetryAt));
  const known = times.filter((time): time is number => typeof time === "number" && Number.isFinite(time));
  return known.length ? Math.max(...known) : null;
}

function boundedJsonString(value: SQL, limit: number) {
  return sql<string | null>`case when jsonb_typeof(${value}) = 'string' then left(${value} #>> '{}', ${limit}) else null end`;
}

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
  finalizing_saved_result: "Paperclip is finishing the saved result before Retry can continue.",
  cleanup_quarantined: "Retry cannot continue this attempt. Send a new message after the previous execution has stopped.",
  cancelled_by_operator: "This attempt was stopped. Send a new message to continue from saved work.",
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
 * locks. The same projection is used in detail, lists and attention surfaces. */
export function projectTaskInterruption(issue: ProjectionIssue, input: ProjectionState, now = Date.now()): TaskInterruptionPresentation | null {
  const { run, wait, action, agent, project, company } = input;
  const retryWait = input.retryWait ?? wait;
  if (!run) return null;
  const system = readSystemRecovery(action?.evidence);
  const base: TaskInterruptionPresentation = { intentId: wait?.id ?? null, responsibility: "system",
    state: "resolved", nextRetryAt: null, canRetry: false, userAction: null,
    sourceRunIds: [run.id], observedRunId: run.id };
  if (["done", "cancelled"].includes(issue.status) || (run.status === "succeeded" && !wait)) return base;
  const providerFailure = run.status === "failed" || run.status === "scheduled_retry"
    ? readProviderFailure(run.resultJson?.providerFailure) : null;
  if (providerFailure) base.providerFailure = providerFailure;
  if (["failed", "scheduled_retry"].includes(run.status) && run.errorCode === "workspace_validation_failed"
      && typeof run.error === "string" && run.error.trim()) base.workspaceFailure = { message: run.error };
  const userAction = !issue.assigneeAgentId ? "assign_agent" : input.approval || run.errorCode === "native_provider_approval_required" ? "approval"
    : isAiAuthenticationBlocked(run) ? "reconnect"
      : run.errorCode === "native_provider_model_rejected" ? "choose_model"
      : [agent?.pauseReason, project?.pauseReason, company?.pauseReason].some(reason => reason === "budget" || reason === "budget_exceeded")
        ? "budget" : input.paused || project?.pausedAt || agent?.status === "paused" || company?.status === "paused" ? "resume" : null;
  if (userAction) return { ...base, responsibility: "user", state: "waiting_for_user", userAction };
  // Intentional Stop is not an unsuccessful attempt. This is presentation only;
  // physical containment and pending cleanup keep their execution-side gates.
  if (!wait && run.runtimeMode === "native" && run.companyId === issue.companyId && run.nativeIssueId === issue.id
      && isAcknowledgedNativeStop({ ...run, companyId: run.companyId, nativeIssueId: run.nativeIssueId })) return base;
  if (["running", "queued"].includes(run.status)) return { ...base, state: "working" };
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
  if (retryWait?.sourceRunId === run.id && retryWait.preparationStatus) {
    const deadline = retryWait.preparationRetryAt == null ? NaN : Number(retryWait.preparationRetryAt);
    if (["issued", "processing"].includes(retryWait.preparationStatus) && Number.isFinite(deadline))
      return { ...base, state: "retry_scheduled", nextRetryAt: new Date(deadline).toISOString() };
    return { ...base, state: "failed", canRetry: retryWait.preparationStatus !== "cancelled" };
  }
  const retryAt = system?.nextAttemptAt ?? run.scheduledRetryAt?.getTime();
  if (retryAt && retryAt > now) return { ...base, state: "retry_scheduled",
    nextRetryAt: new Date(retryAt).toISOString(), canRetry: true };
  const activeObservation = action?.evidence.systemRecoveryActiveAt;
  if (system?.state === "running" && typeof activeObservation === "number" &&
      activeObservation > now - 45_000) return { ...base, state: "working" };
  if (retryWait?.sourceRunId === run.id && retryWait.executionWaitReason) {
    const reason = Object.hasOwn(retryWaitMessages, retryWait.executionWaitReason) ? retryWait.executionWaitReason : "execution_recovery";
    // Keep the latest input receipt so message submission can settle independently.
    return { ...base, state: "failed",
      canRetry: !["cleanup_quarantined", "cancelled_by_operator"].includes(reason), retryWait: { reason,
      message: retryWaitMessages[reason] ?? "Retry is waiting for execution checks. Your message is saved." } };
  }
  if (wait && wait.requestedAt.getTime() > now - 10_000 && system?.state !== "exhausted")
    return { ...base, state: "working" };
  return { ...base, state: "failed", canRetry: true, ...(projectAccess ? { projectAccess } : {}) };
}

/** Batch list reads rather than doing seven queries per row. Keep run logs and
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
  const [runs, waits, agentRows, projectRows, pauseRows, approvalRows, companyRows] = await Promise.all([
    db.select({ issueId: requestedIssueId, id: heartbeatRuns.id, status: heartbeatRuns.status,
      createdAt: heartbeatRuns.createdAt, finishedAt: heartbeatRuns.finishedAt, agentId: heartbeatRuns.agentId, companyId: heartbeatRuns.companyId,
      nativeIssueId: heartbeatRuns.nativeIssueId, runtimeMode: heartbeatRuns.runtimeMode,
      agentAdapter: agents.adapterType,
      error: sql<string | null>`case when ${heartbeatRuns.errorCode} = 'setup_failed'
        and ${heartbeatRuns.error} = 'Project is outside this low-trust boundary.'
        or ${heartbeatRuns.errorCode} = 'workspace_validation_failed' then ${heartbeatRuns.error} else null end`,
      errorCode: heartbeatRuns.errorCode, livenessState: heartbeatRuns.livenessState, scheduledRetryAt: heartbeatRuns.scheduledRetryAt,
      resultJson: sql<Record<string, unknown>>`jsonb_build_object('configurationIncomplete', ${heartbeatRuns.resultJson}->'configurationIncomplete',
        'projectAccessDenied', ${heartbeatRuns.resultJson}->'projectAccessDenied',
        'cancelledByActorType', ${boundedJsonString(sql`${heartbeatRuns.resultJson}->'cancelledByActorType'`, 32)},
        'cancelledByUserId', ${boundedJsonString(sql`${heartbeatRuns.resultJson}->'cancelledByUserId'`, 160)},
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
        'providerFailure', ${heartbeatRuns.resultJson}->'providerFailure')`,
    }).from(requested).innerJoinLateral(latestRuns, sql`true`).innerJoin(heartbeatRuns, and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, latestRuns.id)))
      .leftJoin(agents, and(eq(agents.companyId, heartbeatRuns.companyId), eq(agents.id, heartbeatRuns.agentId)))
      .orderBy(requestedIssueId),
    // Keep at most two candidates per task: latest Retry and latest other input.
    // A new message must not hide an existing Retry's admission explanation.
    db.selectDistinctOn([wakeIssue, isRetryWait], { issueId: wakeIssue, id: agentWakeupRequests.id, requestedAt: agentWakeupRequests.requestedAt,
      sourceRunId: boundedJsonString(sql`${agentWakeupRequests.payload}#>'{taskRetry,sourceRunId}'`, 160),
      executionWaitReason: boundedJsonString(sql`${agentWakeupRequests.payload}#>'{executionWait,reason}'`, 80),
      preparationStatus: chatActions.status, preparationRetryAt: chatActionDeadline("failed_run_retry") })
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
  ]);
  const runIds = runs.map(run => run.id);
  const actions = runIds.length ? await db.selectDistinctOn([issueRecoveryActions.sourceIssueId]).from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.companyId, companyId), inArray(issueRecoveryActions.sourceIssueId, ids),
    inArray(sql`${issueRecoveryActions.evidence}->>'runId'`, runIds),
    sql`${issueRecoveryActions.evidence} ? 'systemRecovery'`,
  )).orderBy(issueRecoveryActions.sourceIssueId, desc(issueRecoveryActions.createdAt)) : [];
  const byIssue = <T extends { issueId: string }>(rows: T[]) => new Map(rows.map(row => [row.issueId, row]));
  const runMap = byIssue(runs), waitMap = new Map<string, typeof waits[number]>();
  const retryWaitMap = byIssue(waits.filter(wait => wait.sourceRunId));
  for (const wait of waits) {
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
  const agentMap = new Map(agentRows.map(agent => [agent.id, agent]));
  const projectMap = new Map(projectRows.map(project => [project.id, project]));
  const pauses = new Set(pauseRows.map(row => row.issueId)), approvalsSet = new Set(approvalRows.map(row => row.issueId));
  const now = Date.now();
  for (const issue of selected) {
    const required = requirements.get(issue.id);
    const denied = required?.projectIds.filter(projectId => currentAccess.get(`${issue.assigneeAgentId}:${projectId}`) !== true);
    const facts = { run: runMap.get(issue.id), action: actionMap.get(issue.id), wait: waitMap.get(issue.id),
      retryWait: retryWaitMap.get(issue.id) };
    const presentation = projectTaskInterruption(issue, { ...facts,
      projectAccessAllowed: denied?.length === 0,
      projectAccessProjectId: denied?.includes(issue.projectId ?? "") ? issue.projectId : null,
      workspaceSelectionAvailable: required?.available ?? false,
      agent: agentMap.get(issue.assigneeAgentId ?? ""), project: projectMap.get(issue.projectId ?? ""),
      company: companyRows[0], paused: pauses.has(issue.id), approval: approvalsSet.has(issue.id),
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
  const disclosures = [...result.values()].flatMap(presentation => (presentation?.providerFailure || presentation?.workspaceFailure) && presentation.observedRunId
    ? [{ id: presentation.observedRunId, providerFailure: presentation.providerFailure,
      workspaceFailure: presentation.workspaceFailure, presentation }] : []);
  if (disclosures.length) {
    try {
      const [safe, settings] = await Promise.all([
        createRunSecretRedactionRegistry(db).redactForRuns(companyId,
          disclosures.map(({ id, providerFailure, workspaceFailure }) => ({ id, providerFailure, workspaceFailure }))),
        instanceSettingsService(db).getGeneral(),
      ]);
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
      });
    } catch {
      for (const { presentation } of disclosures) {
        delete presentation.providerFailure;
        delete presentation.workspaceFailure;
      }
      logger.warn({ companyId, runCount: disclosures.length }, "Could not redact run failure display; explanations omitted");
    }
  }
  return result;
}

export async function taskInterruptionPresentation(db: Db, issue: ProjectionIssue) {
  return (await taskInterruptionPresentations(db, issue.companyId, [issue])).get(issue.id) ?? null;
}
