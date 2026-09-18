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
  updatedAt?: string;
  assigneeAgentId?: string | null;
  parentId?: string | null;
  projectId?: string | null;
  executionRunId?: string | null;
  scheduledRetry?: unknown;
  activeRecoveryAction?: unknown;
  comments?: StoryComment[];
  interactions?: StoryInteraction[];
  activity?: StoryActivityRecord[];
  wakeDiagnostics?: StoryWakeDiagnostics;
  blockedTransitionAt?: string | null;
}
export interface StoryComment {
  id?: string;
  authorAgentId?: string | null;
  body?: unknown;
  createdAt?: string;
}
export interface StoryActivityRecord {
  action?: string;
  details?: unknown;
  createdAt?: string;
}
export interface StoryInteraction {
  id?: string;
  kind?: string;
  issueId?: string | null;
  status?: string;
  continuationPolicy?: string | null;
  resolverPolicy?: string | null;
  effectiveResolverPolicy?: string | null;
  addresseeAgentId?: string | null;
  resolvedByAgentId?: string | null;
  resolvedByRunId?: string | null;
  resolvedAt?: string | null;
  result?: Record<string, unknown> | null;
  payload?: Record<string, unknown> | null;
  createdAt?: string;
}

/** Select the accepted review card for the same child and lead after the initial handoff boundary. */
export function storyAcceptedAgentReview(
  child: StoryIssue | undefined,
  initialInteractionId: string | undefined,
  leadId: string,
  runs: StoryRun[],
): StoryInteraction | undefined {
  if (!child?.interactions?.length || !initialInteractionId) return undefined;
  const initial = child.interactions.find(
    (candidate) => candidate.id === initialInteractionId,
  );
  if (!initial) return undefined;
  const initialCreatedAt = Date.parse(initial.createdAt ?? "");
  return child.interactions
    .filter((candidate) => {
      const result = candidate.result;
      const target = candidate.payload?.target as
        | Record<string, unknown>
        | undefined;
      const revisionId = String(target?.revisionId ?? "");
      const reviewRun = runs.find(
        (run) => run.id === candidate.resolvedByRunId,
      );
      return (
        candidate.kind === "request_confirmation" &&
        target?.type === "custom" &&
        target?.key === "native_completion_review" &&
        candidate.issueId === child.id &&
        candidate.addresseeAgentId === leadId &&
        candidate.resolvedByAgentId === leadId &&
        candidate.status === "accepted" &&
        Number.isFinite(initialCreatedAt) &&
        Number.isFinite(Date.parse(candidate.createdAt ?? "")) &&
        Date.parse(candidate.createdAt ?? "") >= initialCreatedAt &&
        result?.version === 1 &&
        result?.outcome === "accepted" &&
        reviewRun?.status === "succeeded" &&
        reviewRun.agentId === leadId &&
        reviewRun.contextSnapshot?.nativeReviewInteractionId === candidate.id &&
        reviewRun.contextSnapshot?.nativeReviewDecisionId === revisionId &&
        revisionId.length > 0
      );
    })
    .sort((a, b) =>
      Date.parse(a.resolvedAt ?? "") - Date.parse(b.resolvedAt ?? ""),
    )[0];
}
export interface StoryWakeDiagnosticEvent {
  kind?: string;
  agentId?: string | null;
  reason?: string | null;
  status?: string;
  payload?: Record<string, unknown> | null;
}
export interface StoryWakeDiagnostics {
  events?: StoryWakeDiagnosticEvent[];
  blockerDiagnostics?: {
    readiness?: { unresolvedBlockerCount?: number | null } | null;
    blockers?: unknown[];
  };
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

export type StoryArtifactGradeMode = "base" | "separator" | "max-length";

/** Select the artifact oracle variant required by each workflow's actual case. */
export function artifactGradeModeForPhase(
  phase:
    | "hired-delivery"
    | "reused-delivery"
    | "delegated-delivery"
    | "reviewed-delivery"
    | "recovered-delivery",
): StoryArtifactGradeMode {
  switch (phase) {
    case "hired-delivery":
    case "reviewed-delivery":
      return "base";
    case "reused-delivery":
      return "separator";
    case "delegated-delivery":
    case "recovered-delivery":
      return "max-length";
  }
}

/** A review run is valid only after the lead run has completed. */
export function storyParentCompletionPrecedesReview(
  parentFinishedAt: string | null | undefined,
  reviewStartedAt: string | null | undefined,
  parentBlocked: boolean,
): boolean {
  if (reviewStartedAt) {
    return Boolean(
      parentFinishedAt &&
        Date.parse(parentFinishedAt) <= Date.parse(reviewStartedAt),
    );
  }
  return parentBlocked;
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

/** A terminal task is only ready for response assertions after its agent reply is visible. */
export function storyHasAgentReply(
  issue: StoryIssue | undefined,
  agentId: string,
  expectedText: string,
): boolean {
  return (
    issue?.comments?.some(
      (comment) =>
        comment.authorAgentId === agentId &&
        String(comment.body ?? "").includes(expectedText),
    ) ?? false
  );
}

const RUNNABLE_WAKE_STATUSES = new Set([
  "queued",
  "deferred_issue_execution",
  "claimed",
]);

/** A durable wake means an agent still has a recorded next action. */
export function storyHasPendingAgentWake(
  issue: StoryIssue | undefined,
  agentIds: string | readonly string[],
): boolean {
  const ids = new Set(typeof agentIds === "string" ? [agentIds] : agentIds);
  return (
    issue?.wakeDiagnostics?.events?.some(
      (event) =>
        event.kind === "wake_request" &&
        event.agentId != null &&
        ids.has(event.agentId) &&
        RUNNABLE_WAKE_STATUSES.has(String(event.status)),
    ) ?? false
  );
}

/** Any issue-scoped wake keeps the workflow actionable while it is being dispatched. */
export function storyHasPendingAgentWork(
  issues: StoryIssue[],
  agentIds: string | readonly string[],
): boolean {
  return issues.some((issue) => storyHasPendingAgentWake(issue, agentIds));
}

/** A blocked story is stranded only when no issue has a durable continuation wake. */
export function storyHasStrandedBlockedLeaf(
  issues: StoryIssue[],
  agentIds: string | readonly string[],
): boolean {
  return (
    issues.some((issue) => issue.status === "blocked") &&
    !storyHasPendingAgentWork(issues, agentIds)
  );
}

/**
 * A completed native review is a durable continuation trigger even when the
 * parent projection has not yet exposed the claimed wake. Keep the existing
 * workflow deadline; its timeout diagnostic identifies a missing continuation.
 */
export function storyHasDurableAgentReviewContinuation(
  issues: StoryIssue[],
  parentId: string,
  leadId: string,
  runs: StoryRun[],
): boolean {
  const parent = issues.find((issue) => issue.id === parentId);
  if (parent?.status !== "blocked") return false;
  const blockedAt = Date.parse(parent.blockedTransitionAt ?? "");
  const terminalWake = parent.wakeDiagnostics?.events?.some(
    (event) =>
      event.kind === "wake_request" &&
      event.agentId === leadId &&
      event.reason === "issue_blockers_resolved" &&
      ["completed", "failed", "cancelled"].includes(String(event.status)),
  );
  if (terminalWake) return false;
  return issues.some((child) =>
    child.parentId === parentId &&
    child.status === "done" &&
    (child.interactions?.some((interaction) => {
      const target = interaction.payload?.target as
        | Record<string, unknown>
        | undefined;
      const reviewRun = runs.find((run) => run.id === interaction.resolvedByRunId);
      return (
        interaction.kind === "request_confirmation" &&
        interaction.status === "accepted" &&
        interaction.issueId === child.id &&
        interaction.addresseeAgentId === leadId &&
        interaction.resolvedByAgentId === leadId &&
        interaction.result?.version === 1 &&
        interaction.result?.outcome === "accepted" &&
        Number.isFinite(blockedAt) &&
        Date.parse(interaction.resolvedAt ?? "") >= blockedAt &&
        target?.type === "custom" &&
        target?.key === "native_completion_review" &&
        reviewRun?.status === "succeeded" &&
        reviewRun.agentId === leadId
      );
    }) ?? false),
  );
}

/** Timeout evidence requires a stranded leaf with durable accepted-review evidence. */
export function storyReviewContinuationTimeoutDetail(
  issues: StoryIssue[],
  parentId: string,
  leadId: string,
  runs: StoryRun[],
  observableAgentIds: string | readonly string[],
): string | undefined {
  return (
    storyHasStrandedBlockedLeaf(issues, observableAgentIds) &&
    storyHasDurableAgentReviewContinuation(issues, parentId, leadId, runs)
  )
    ? "task is Blocked without an active continuation after accepted review"
    : undefined;
}

/** A pending interaction is agent-owned when its wake policy and wake request agree. */
export function storyHasPendingAgentReview(
  issue: StoryIssue | undefined,
  agentIds: string | readonly string[],
): boolean {
  return Boolean(
    issue?.interactions?.some((interaction) =>
      storyHasPendingAgentReviewForInteraction(issue, interaction, agentIds),
    ),
  );
}

/** Pending review is human-owned only when no matching agent review wake is runnable. */
export function storyHasPendingHumanInteraction(
  issue: StoryIssue | undefined,
  agentIds: string | readonly string[],
): boolean {
  const pendingInteraction = issue?.interactions?.some(
    (interaction) =>
      interaction.status === "pending" &&
      !storyHasPendingAgentReviewForInteraction(issue, interaction, agentIds),
  );
  return Boolean(
    pendingInteraction,
  );
}

function storyHasPendingAgentReviewForInteraction(
  issue: StoryIssue | undefined,
  interaction: StoryInteraction,
  agentIds: string | readonly string[],
): boolean {
  const ids = new Set(typeof agentIds === "string" ? [agentIds] : agentIds);
  if (
    interaction.status !== "pending" ||
    interaction.continuationPolicy !== "wake_assignee" ||
    interaction.resolverPolicy === "human_only" ||
    interaction.effectiveResolverPolicy === "human_only" ||
    !interaction.addresseeAgentId ||
    !ids.has(interaction.addresseeAgentId)
  )
    return false;
  const wakeEvents =
    issue?.wakeDiagnostics?.events?.filter(
      (event) =>
        event.kind === "wake_request" &&
        event.agentId === interaction.addresseeAgentId &&
        RUNNABLE_WAKE_STATUSES.has(String(event.status)),
    ) ?? [];
  const explicitlyBound = wakeEvents.some(
    (event) =>
      event.payload?.nativeReviewInteractionId === interaction.id,
  );
  if (explicitlyBound) return true;
  if (
    wakeEvents.some(
      (event) => event.payload?.nativeReviewInteractionId != null,
    )
  )
    return false;
  const sameAgentPendingCards =
    issue?.interactions?.filter(
      (candidate) =>
        candidate.status === "pending" &&
        candidate.continuationPolicy === "wake_assignee" &&
        candidate.resolverPolicy !== "human_only" &&
        candidate.effectiveResolverPolicy !== "human_only" &&
        candidate.addresseeAgentId === interaction.addresseeAgentId,
    ).length ?? 0;
  // The public v1 wake projection has no binding payload. With multiple cards
  // for one agent, conservatively refuse to attribute an unbound wake.
  return wakeEvents.length > 0 && sameAgentPendingCards === 1;
}

/** The public blocker projection is durable evidence of a dependency hold. */
export function storyIssueHasUnresolvedDependency(issue: StoryIssue): boolean {
  const readiness = issue.wakeDiagnostics?.blockerDiagnostics?.readiness;
  return (
    issue.status === "blocked" &&
    ((readiness?.unresolvedBlockerCount ?? 0) > 0 ||
      (issue.wakeDiagnostics?.blockerDiagnostics?.blockers?.length ?? 0) > 0)
  );
}

/** Status history remains observable after the scheduler clears the blocker. */
export function storyIssueHasBlockedTimeline(issue: StoryIssue): boolean {
  return storyIssueHasBlockedTimelineBefore(issue);
}

/** A blocker timeline entry is useful only when it predates the review card. */
export function storyIssueHasBlockedTimelineBefore(
  issue: StoryIssue,
  before?: string,
): boolean {
  return Boolean(
    issue.activity?.some((record) => {
      const action = String(record.action ?? "").toLowerCase();
      const details = (record.details ?? {}) as Record<string, unknown>;
      const changes = (details.changes ?? {}) as Record<string, unknown>;
      const statusChange = (changes.status ?? {}) as Record<string, unknown>;
      const recordAt = Date.parse(String(record.createdAt ?? ""));
      const beforeAt = before ? Date.parse(before) : Number.NaN;
      return (
        action === "issue.updated" &&
        Number.isFinite(recordAt) &&
        (!Number.isFinite(beforeAt) || recordAt <= beforeAt) &&
        (details.status === "blocked" ||
          details.toStatus === "blocked" ||
          statusChange.to === "blocked")
      );
    }),
  );
}

/** Native result evidence survives a fast transition past the blocked projection. */
export function storyRunReportsDependencyBlock(run: StoryRun): boolean {
  const result = run.resultJson?.nativeResult as
    | Record<string, unknown>
    | undefined;
  if (result?.reportedWorkDisposition !== "blocked") return false;
  const blocker = result.blocker as Record<string, unknown> | undefined;
  const reason = String(blocker?.reasonCode ?? "").toLowerCase();
  return reason.includes("depend");
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
