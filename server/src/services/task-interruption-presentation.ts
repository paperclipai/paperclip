import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { agents, agentWakeupRequests, approvals, companies, heartbeatRuns, issueApprovals, issueRecoveryActions,
  issues, issueTreeHoldMembers, issueTreeHolds, projects, type Db } from "@paperclipai/db";
import { unionAll } from "drizzle-orm/pg-core";
import type { TaskInterruptionPresentation } from "@paperclipai/shared";
import { isAiAuthenticationBlocked } from "./ai-auth-failure.js";
import { readSystemRecovery } from "./system-recovery-state.js";
import { PROJECT_ACCESS_DENIED } from "./project-access-denial.js";
import { authorizationService } from "./authorization.js";
import { taskWorkspaceProjectRequirements } from "./task-workspace-access.js";

type ProjectionIssue = Pick<typeof issues.$inferSelect, "id" | "companyId" | "status" | "assigneeAgentId" | "projectId">;
type ProjectionRun = Pick<typeof heartbeatRuns.$inferSelect,
  "id" | "status" | "scheduledRetryAt" | "errorCode" | "livenessState" | "resultJson"> &
  Partial<Pick<typeof heartbeatRuns.$inferSelect, "agentId" | "error">>;
type ProjectionState = {
  run?: ProjectionRun;
  action?: typeof issueRecoveryActions.$inferSelect;
  wait?: { id: string; requestedAt: Date };
  agent?: Pick<typeof agents.$inferSelect, "status" | "pauseReason">;
  projectAccessAllowed?: boolean;
  projectAccessProjectId?: string | null;
  workspaceSelectionAvailable?: boolean;
  project?: Pick<typeof projects.$inferSelect, "pausedAt" | "pauseReason">;
  company?: Pick<typeof companies.$inferSelect, "status" | "pauseReason">;
  paused: boolean;
  approval: boolean;
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
  if (!run) return null;
  const system = readSystemRecovery(action?.evidence);
  const base: TaskInterruptionPresentation = { intentId: wait?.id ?? null, responsibility: "system",
    state: "resolved", nextRetryAt: null, canRetry: false, userAction: null,
    sourceRunIds: [run.id], observedRunId: run.id };
  if (["done", "cancelled"].includes(issue.status) || (run.status === "succeeded" && !wait)) return base;
  const userAction = !issue.assigneeAgentId ? "assign_agent" : input.approval || run.errorCode === "native_provider_approval_required" ? "approval"
    : isAiAuthenticationBlocked(run) ? "reconnect"
      : run.errorCode === "native_provider_model_rejected" ? "choose_model"
      : [agent?.pauseReason, project?.pauseReason, company?.pauseReason].some(reason => reason === "budget" || reason === "budget_exceeded")
        ? "budget" : input.paused || project?.pausedAt || agent?.status === "paused" || company?.status === "paused" ? "resume" : null;
  if (userAction) return { ...base, responsibility: "user", state: "waiting_for_user", userAction };
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
  const retryAt = system?.nextAttemptAt ?? run.scheduledRetryAt?.getTime();
  if (retryAt && retryAt > now) return { ...base, state: "retry_scheduled",
    nextRetryAt: new Date(retryAt).toISOString(), canRetry: true };
  const activeObservation = action?.evidence.systemRecoveryActiveAt;
  if (system?.state === "running" && typeof activeObservation === "number" &&
      activeObservation > now - 45_000) return { ...base, state: "working" };
  if (wait && wait.requestedAt.getTime() > now - 10_000 && system?.state !== "exhausted")
    return { ...base, state: "working" };
  return { ...base, state: "failed", canRetry: true, ...(projectAccess ? { projectAccess } : {}) };
}

/** Batch list reads rather than doing seven queries per row. Keep run logs and
 * large result bodies out of this projection; only authentication evidence is
 * needed for the typed reconnect action. */
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
  const agentIds = selected.flatMap(issue => issue.assigneeAgentId ? [issue.assigneeAgentId] : []);
  const projectIds = selected.flatMap(issue => issue.projectId ? [issue.projectId] : []);
  const [runs, waits, agentRows, projectRows, pauseRows, approvalRows, companyRows] = await Promise.all([
    db.select({ issueId: requestedIssueId, id: heartbeatRuns.id, status: heartbeatRuns.status,
      agentId: heartbeatRuns.agentId,
      error: sql<string | null>`case when ${heartbeatRuns.errorCode} = 'setup_failed'
        and ${heartbeatRuns.error} = 'Project is outside this low-trust boundary.' then ${heartbeatRuns.error} else null end`,
      errorCode: heartbeatRuns.errorCode, livenessState: heartbeatRuns.livenessState, scheduledRetryAt: heartbeatRuns.scheduledRetryAt,
      resultJson: sql<Record<string, unknown>>`jsonb_build_object('configurationIncomplete', ${heartbeatRuns.resultJson}->'configurationIncomplete',
        'projectAccessDenied', ${heartbeatRuns.resultJson}->'projectAccessDenied')`,
    }).from(requested).innerJoinLateral(latestRuns, sql`true`).innerJoin(heartbeatRuns, and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, latestRuns.id)))
      .orderBy(requestedIssueId),
    db.selectDistinctOn([wakeIssue], { issueId: wakeIssue, id: agentWakeupRequests.id, requestedAt: agentWakeupRequests.requestedAt })
      .from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, companyId), inArray(wakeIssue, ids),
        eq(agentWakeupRequests.status, "deferred_issue_execution"), eq(agentWakeupRequests.requestedByActorType, "user")))
      .orderBy(wakeIssue, desc(agentWakeupRequests.requestedAt)),
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
  const runMap = byIssue(runs), waitMap = byIssue(waits);
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
  for (const issue of selected) {
    const required = requirements.get(issue.id);
    const denied = required?.projectIds.filter(projectId => currentAccess.get(`${issue.assigneeAgentId}:${projectId}`) !== true);
    result.set(issue.id, projectTaskInterruption(issue, {
      run: runMap.get(issue.id), action: actionMap.get(issue.id), wait: waitMap.get(issue.id),
      projectAccessAllowed: denied?.length === 0,
      projectAccessProjectId: denied?.includes(issue.projectId ?? "") ? issue.projectId : null,
      workspaceSelectionAvailable: required?.available ?? false,
      agent: agentMap.get(issue.assigneeAgentId ?? ""), project: projectMap.get(issue.projectId ?? ""),
      company: companyRows[0], paused: pauses.has(issue.id), approval: approvalsSet.has(issue.id),
    }));
  }
  return result;
}

export async function taskInterruptionPresentation(db: Db, issue: ProjectionIssue) {
  return (await taskInterruptionPresentations(db, issue.companyId, [issue])).get(issue.id) ?? null;
}
