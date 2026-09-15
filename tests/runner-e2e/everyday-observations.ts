export interface StoryCheck {
  id: string;
  passed: boolean;
  detail: string;
}
export interface StoryIssue {
  id: string;
  companyId: string;
  title: string;
  status: string;
  identifier?: string | null;
  description?: string | null;
  createdAt?: string;
  assigneeAgentId?: string | null;
  parentId?: string | null;
  projectId?: string | null;
  executionRunId?: string | null;
  scheduledRetry?: unknown;
  activeRecoveryAction?: unknown;
}
export interface StoryRun {
  id: string;
  companyId: string;
  agentId: string;
  status: string;
  runtimeMode?: string;
  runnerInstanceId?: string | null;
  processPid?: number | null;
  processStartedAt?: string | null;
  nativeIssueId?: string | null;
  nativeSessionId?: string | null;
  contextSnapshot?: Record<string, unknown> | null;
  resultJson?: Record<string, unknown> | null;
  usageJson?: Record<string, unknown> | null;
  runnerProfileJson?: Record<string, unknown> | null;
  sessionIdAfter?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  retryOfRunId?: string | null;
  scheduledRetryReason?: string | null;
  runtimeModeResolvedAt?: string | null;
  lastOutputSeq?: number | null;
  errorCode?: string | null;
  error?: string | null;
}
export const isActiveStoryRun = (run: StoryRun) =>
  ["queued", "running", "scheduled_retry"].includes(run.status);
export function isStoryWorkspaceDeferral(run: StoryRun) {
  const recovery = run.resultJson?.executionRecovery as
    Record<string, unknown> | undefined;
  const startup = run.resultJson?.startupCancellation as
    Record<string, unknown> | undefined;
  const neverStartedRetry =
    run.errorCode === "cancelled" &&
    run.scheduledRetryReason === "workspace_busy" &&
    typeof run.retryOfRunId === "string" &&
    run.retryOfRunId.length > 0 &&
    run.startedAt === null &&
    run.runtimeModeResolvedAt === null &&
    run.lastOutputSeq === 0 &&
    !run.processStartedAt &&
    !run.sessionIdAfter &&
    !run.usageJson &&
    !run.runnerProfileJson?.nativeExecutionInput &&
    typeof startup?.requestedAt === "string" &&
    Number.isFinite(Date.parse(startup.requestedAt));
  return (
    run.status === "cancelled" &&
    ((run.errorCode === "workspace_busy" &&
      recovery?.providerWorkStarted === false) ||
      neverStartedRetry) &&
    !run.runnerInstanceId &&
    !run.nativeSessionId &&
    !run.processPid
  );
}
export function storyLifecycleChecks(input: {
  issues: StoryIssue[];
  runs: StoryRun[];
  parentId: string;
  leadId: string;
  allowedInterruptedRuns?: string[];
}): StoryCheck[] {
  const executed = input.runs.filter((r) => !isStoryWorkspaceDeferral(r));
  const allowed = new Set(input.allowedInterruptedRuns ?? []);
  const check = (id: string, passed: boolean, detail: string): StoryCheck => ({
    id,
    passed,
    detail,
  });
  return [
    check(
      "tasks-done",
      input.issues.length > 0 && input.issues.every((i) => i.status === "done"),
      "Every story task must reach Done.",
    ),
    check(
      "settled",
      !input.runs.some(isActiveStoryRun) &&
        !input.issues.some((i) => i.scheduledRetry || i.activeRecoveryAction),
      "No active runs or scheduled recovery remain.",
    ),
    check(
      "native-runtime",
      executed.length > 0 &&
        executed.every(
          (r) => r.runtimeMode === "native" && Boolean(r.runnerInstanceId),
        ),
      "All executions must prove native runtime and runner identity.",
    ),
    check(
      "successful-runs",
      executed.every((r) => r.status === "succeeded" || allowed.has(r.id)),
      "Only explicitly interrupted runs may have a non-success terminal state.",
    ),
    check(
      "bounded-work",
      input.runs.length <= 12,
      "No more than twelve executions, including child and recovery turns.",
    ),
    check(
      "parent-owned-by-lead",
      !executed.some(
        (r) =>
          (r.contextSnapshot?.issueId === input.parentId ||
            r.contextSnapshot?.taskId === input.parentId) &&
          r.agentId !== input.leadId,
      ),
      "A mentioned worker must not execute on the parent.",
    ),
  ];
}

/** A terminal first turn cannot satisfy a later queued request. */
export function storyRepliesConsumed(
  runs: StoryRun[],
  commentIds: string[],
): boolean {
  return commentIds.every((id) =>
    runs.some((run) => {
      if (run.status !== "succeeded" || isStoryWorkspaceDeferral(run))
        return false;
      const input = run.runnerProfileJson?.nativeExecutionInput as
        { task?: { prompt?: string } } | undefined;
      return input?.task?.prompt?.includes(id) === true;
    }),
  );
}

export function storyParentFinishedAfterChildren(
  runs: StoryRun[],
  parentId: string,
  leadId: string,
  childIds: string[],
): boolean {
  const scope = (r: StoryRun) =>
    r.nativeIssueId ?? r.contextSnapshot?.issueId ?? r.contextSnapshot?.taskId;
  const completed = runs.filter(
    (r) => r.status === "succeeded" && !isStoryWorkspaceDeferral(r),
  );
  const children = completed.filter((r) => childIds.includes(String(scope(r))));
  if (!children.length) return false;
  const lastChildFinish = Math.max(
    ...children.map((r) => Date.parse(r.finishedAt ?? "")),
  );
  return completed.some(
    (r) =>
      r.agentId === leadId &&
      scope(r) === parentId &&
      Date.parse(r.finishedAt ?? "") >= lastChildFinish,
  );
}
