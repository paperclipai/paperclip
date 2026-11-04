type Row = Record<string, any>;
export const DEPENDENCY_IDLE_MS = 10_000;
export const TASK_DEPENDENCY_RESUME_CHECKS = [
  "dependency-browser-created-and-linked", "dependency-unresolved-prevented-execution",
  "dependency-blocker-completed-by-board", "dependency-one-automatic-resume",
  "dependency-output-authored-by-run", "dependency-result-reopened",
  "dependency-history-preserved", "configured-model-and-environment",
] as const;

export interface DependencyScope {
  companyId: string; userId: string; agentId: string; environmentId: string; provider: string; model: string;
  blockerId: string; blockerIdentifier: string; blockerTitle: string; blockerDescription: string;
  dependentId: string; dependentTitle: string; prompt: string; reference: string; documentKey: string;
}
export interface DependencyPoint {
  observedAt: number; blocker: Row; dependent: Row;
  blockerRuns: Row[]; dependentRuns: Row[]; agentRuns: Row[]; activity: Row[];
  activityCoverage: { blocker: boolean; dependent: boolean; agent: boolean };
  document?: Row; revision?: Row; resultVisible?: boolean;
}
export interface DependencyEvidence {
  scope: DependencyScope; startingAgentRuns: Row[]; created: DependencyPoint; waiting: DependencyPoint[];
  releaseRequestedAt: number; released: DependencyPoint; finished: DependencyPoint; reopened: DependencyPoint;
}
const nonempty = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const date = (value: unknown) => typeof value === "string" ? Date.parse(value) : NaN;
const exactId = (rows: unknown, id: string) => Array.isArray(rows) && rows.length === 1 && rows[0] === id;
const runFacts = (run: Row) => JSON.stringify([run.id, run.companyId, run.agentId, dependencyRunIssueId(run), run.status,
  run.runtimeMode, run.nativePhase, run.invocationSource, run.triggerDetail, run.startedAt,
  run.contextSnapshot?.wakeReason, run.contextSnapshot?.source, run.contextSnapshot?.resolvedBlockerIssueId,
  run.contextSnapshot?.blockerIssueIds, run.contextSnapshot?.paperclipEnvironment?.id,
  run.runnerProfileJson?.nativeExecutionInput?.provider?.kind, run.runnerProfileJson?.nativeExecutionInput?.provider?.model]);
export function dependencyNewAgentRuns(runs: Row[], startingRuns: Row[]) {
  const priorIds = new Set(startingRuns.map(run => run.id));
  return runs.filter(run => !priorIds.has(run.id));
}
export function dependencyRunIssueId(run: Row) {
  const ids = [run.issueId, run.nativeIssueId, run.contextSnapshot?.issueId, run.contextSnapshot?.taskId].filter(value => value != null);
  return ids.length && ids.every(nonempty) && new Set(ids).size === 1 ? ids[0] as string : undefined;
}
export function dependencyOutputMatches(body: unknown, scope: Pick<DependencyScope, "reference" | "blockerIdentifier">) {
  if (typeof body !== "string") return false;
  const text = body.trim(), json = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(text)?.[1] ?? text;
  try {
    const value = JSON.parse(json);
    return Boolean(value && !Array.isArray(value) && Object.keys(value).sort().join(",") === "blockerIdentifier,reference"
      && value.reference === scope.reference && value.blockerIdentifier === scope.blockerIdentifier);
  } catch { return false; }
}

export function gradeTaskDependencyResume(value: DependencyEvidence | undefined) {
  const fail = () => TASK_DEPENDENCY_RESUME_CHECKS.map(id => ({ id, passed: false }));
  if (!value?.scope || !Array.isArray(value.startingAgentRuns) || !value.created || !Array.isArray(value.waiting) || value.waiting.length < 2
    || !value.released || !value.finished || !value.reopened) return fail();
  const { scope: s, startingAgentRuns, created, waiting, released, finished, reopened } = value;
  const points = [created, ...waiting, released, finished, reopened];
  if (Object.values(s).some(item => !nonempty(item)) || s.blockerId === s.dependentId || s.prompt.includes(s.reference)
    || !s.blockerDescription.includes(s.reference)
    || points.some(p => !p?.blocker || !p.dependent || !Number.isFinite(p.observedAt)
      || [p.blockerRuns, p.dependentRuns, p.agentRuns, p.activity].some(rows => !Array.isArray(rows)))) return fail();
  const startingIds = startingAgentRuns.map(run => run.id);
  const historyComplete = startingIds.every(nonempty) && new Set(startingIds).size === startingIds.length
    && startingAgentRuns.every(run => run.companyId === s.companyId && run.agentId === s.agentId
      && ["succeeded", "failed", "cancelled", "timed_out"].includes(run.status)
      && ![s.blockerId, s.dependentId].includes(dependencyRunIssueId(run) ?? ""))
    && points.every(p => new Set(p.agentRuns.map(run => run.id)).size === p.agentRuns.length
      && p.agentRuns.every(run => nonempty(run.id) && run.companyId === s.companyId && run.agentId === s.agentId)
      && startingAgentRuns.every(prior => p.agentRuns.some(run => runFacts(run) === runFacts(prior))));
  const newRuns = (point: DependencyPoint) => dependencyNewAgentRuns(point.agentRuns, startingAgentRuns);
  const scoped = historyComplete && points.every(p => p.blocker.id === s.blockerId && p.dependent.id === s.dependentId
    && p.blocker.companyId === s.companyId && p.dependent.companyId === s.companyId
    && p.blocker.title === s.blockerTitle && p.dependent.title === s.dependentTitle
    && p.blocker.description === s.blockerDescription && p.dependent.description === s.prompt
    && p.blocker.createdByUserId === s.userId && p.dependent.createdByUserId === s.userId
    && !p.blocker.createdByAgentId && !p.dependent.createdByAgentId
    && p.blocker.assigneeUserId === s.userId && p.blocker.assigneeAgentId === null);
  const linked = scoped && [created.blocker, created.dependent].every(task => task.status === "todo")
    && created.dependent.assigneeUserId === s.userId && created.dependent.assigneeAgentId === null
    && [created.blockerRuns, created.dependentRuns, newRuns(created)].every(rows => rows.length === 0)
    && points.slice(1).every(p => p.dependent.assigneeAgentId === s.agentId && p.dependent.assigneeUserId === null
      && exactId(p.dependent.blockedByIssueIds, s.blockerId));
  const held = linked && waiting.every(p => p.blocker.status === "todo" && p.dependent.status === "blocked"
    && !p.dependent.executionRunId && !p.dependent.checkoutRunId
    && [p.blockerRuns, p.dependentRuns, newRuns(p)].every(rows => rows.length === 0))
    && waiting.every((p, index) => index === 0 || p.observedAt >= waiting[index - 1]!.observedAt)
    && waiting[waiting.length - 1]!.observedAt - waiting[0]!.observedAt >= DEPENDENCY_IDLE_MS
    && waiting[0]!.observedAt >= created.observedAt
    && Number.isFinite(value.releaseRequestedAt) && value.releaseRequestedAt >= waiting[waiting.length - 1]!.observedAt
    && released.observedAt >= value.releaseRequestedAt && finished.observedAt >= released.observedAt && reopened.observedAt >= finished.observedAt;
  const completedByBoard = held && [released, finished, reopened].every(p => p.blocker.status === "done"
    && Number.isFinite(date(p.blocker.completedAt)))
    && reopened.activity.filter(row => row.companyId === s.companyId && row.entityType === "issue"
      && row.entityId === s.blockerId && row.action === "issue.updated" && row.actorType === "user"
      && row.actorId === s.userId && row.details?.status === "done").length === 1;
  const run = finished.dependentRuns[0];
  const oneRun = completedByBoard && finished.dependent.status === "done" && reopened.dependent.status === "done"
    && !finished.dependent.executionRunId && !finished.dependent.checkoutRunId
    && !reopened.dependent.executionRunId && !reopened.dependent.checkoutRunId
    && finished.dependentRuns.length === 1 && reopened.dependentRuns.length === 1
    && newRuns(finished).length === 1 && newRuns(reopened).length === 1
    && nonempty(run?.id) && [reopened.dependentRuns[0], newRuns(finished)[0], newRuns(reopened)[0]].every(row => runFacts(row) === runFacts(run))
    && run.companyId === s.companyId && run.agentId === s.agentId && dependencyRunIssueId(run) === s.dependentId
    && run.status === "succeeded" && run.invocationSource === "automation" && run.triggerDetail === "system"
    && run.contextSnapshot?.wakeReason === "issue_blockers_resolved" && run.contextSnapshot?.source === "issue.blockers_resolved"
    && run.contextSnapshot?.resolvedBlockerIssueId === s.blockerId && exactId(run.contextSnapshot?.blockerIssueIds, s.blockerId)
    && Number.isFinite(date(run.startedAt)) && date(run.startedAt) >= date(released.blocker.completedAt);
  const boundRun = scoped && [run, reopened.dependentRuns[0], newRuns(finished)[0], newRuns(reopened)[0]].every(row =>
    nonempty(row?.id) && row.id === run?.id && row.companyId === s.companyId && row.agentId === s.agentId
    && dependencyRunIssueId(row) === s.dependentId);
  const runtime = boundRun && run?.runtimeMode === "native" && run.nativePhase === "committed"
    && run.runnerProfileJson?.nativeExecutionInput?.provider?.kind === s.provider
    && run.runnerProfileJson?.nativeExecutionInput?.provider?.model === s.model
    && run.contextSnapshot?.paperclipEnvironment?.id === s.environmentId;
  const documentMatches = (p: DependencyPoint) => p.document && p.revision
    && nonempty(p.document.id) && p.document.companyId === s.companyId && p.document.issueId === s.dependentId
    && p.document.key === s.documentKey && p.document.createdByAgentId === s.agentId && p.document.createdByUserId === null
    && p.document.latestRevisionId === p.revision.id && p.revision.documentId === p.document.id
    && p.revision.createdByAgentId === s.agentId && p.revision.createdByUserId === null && p.revision.createdByRunId === run?.id
    && dependencyOutputMatches(p.document.body, s) && dependencyOutputMatches(p.revision.body, s);
  const authored = boundRun && documentMatches(finished);
  const resultReopened = boundRun && documentMatches(reopened) && finished.document && reopened.resultVisible === true
    && reopened.document!.id === finished.document.id && reopened.document!.latestRevisionId === finished.document.latestRevisionId
    && reopened.document!.body === finished.document.body;
  const history = boundRun && points.every(p => p.blockerRuns.length === 0)
    && points.every(p => p.activityCoverage?.blocker === true && p.activityCoverage?.dependent === true && p.activityCoverage?.agent === true)
    && !reopened.activity.some(row => row.runId === run?.id
      && ["issue.created", "issue.child_created", "project.created", "agent.created", "agent.hire_created"].includes(row.action))
    && reopened.blocker.completedAt === released.blocker.completedAt;
  const values = [linked, held, completedByBoard, oneRun, authored, resultReopened, history, runtime];
  return TASK_DEPENDENCY_RESUME_CHECKS.map((id, index) => ({ id, passed: Boolean(values[index]) }));
}
