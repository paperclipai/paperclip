export interface AuthoritativeRunIssueExpectation {
  runId: string;
  companyId: string;
  agentId: string;
  issueId: string;
}

export interface AuthoritativeRunIssue {
  runId: string;
  issueId: string;
}

export function resolveAuthoritativeRunIssue(
  runValue: unknown,
  expected: AuthoritativeRunIssueExpectation,
): AuthoritativeRunIssue | null {
  const run = asRecord(runValue);
  const context = asRecord(run?.contextSnapshot);
  if (!run || !context) return null;
  if (
    run.id !== expected.runId ||
    run.companyId !== expected.companyId ||
    run.agentId !== expected.agentId ||
    run.invocationSource === "timer" ||
    typeof context.issueId !== "string" || context.issueId.length === 0 ||
    typeof context.taskId !== "string" || context.taskId.length === 0 ||
    context.issueId !== context.taskId ||
    context.issueId !== expected.issueId
  ) return null;
  return { runId: expected.runId, issueId: expected.issueId };
}

export interface ExpectedStageRun {
  companyId: string;
  issueId: string;
  agentId: string;
  stageId: string;
  stageType: "review" | "approval";
  reviewRoundId: string | null;
}

export interface ExpectedExecutorRun {
  companyId: string;
  issueId: string;
  agentId: string;
  wakeReason: "issue_assigned" | "execution_changes_requested";
  stageId?: string;
  reviewRoundId?: string | null;
}

export function matchesExecutorRun(runValue: unknown, expected: ExpectedExecutorRun): boolean {
  const run = asRecord(runValue);
  const context = asRecord(run?.contextSnapshot);
  const stage = asRecord(context?.executionStage);
  if (!run || !context) return false;
  const issueMatches = context.issueId === expected.issueId || context.taskId === expected.issueId;
  if (
    run.companyId !== expected.companyId ||
    run.agentId !== expected.agentId ||
    !issueMatches ||
    run.invocationSource === "timer"
  ) return false;
  if (expected.wakeReason === "execution_changes_requested") {
    return (
      context.source === "issue.execution_stage" &&
      context.wakeReason === expected.wakeReason &&
      stage?.wakeRole === "executor" &&
      stage?.stageId === expected.stageId &&
      (stage?.reviewRoundId ?? null) === (expected.reviewRoundId ?? null)
    );
  }
  return context.wakeReason === "issue_assigned" && context.source !== "issue.execution_stage";
}

export function executorRunSucceeded(runValue: unknown, expected: ExpectedExecutorRun): boolean {
  const run = asRecord(runValue);
  return Boolean(
    matchesExecutorRun(runValue, expected) &&
    run?.status === "succeeded" &&
    typeof run.finishedAt === "string" && run.finishedAt.length > 0,
  );
}

export function formatLifecycleTimeoutDiagnostics(input: {
  issue: unknown;
  expected: ExpectedStageRun | ExpectedExecutorRun;
  candidates: unknown[];
}): string {
  const issue = asRecord(input.issue);
  const state = asRecord(issue?.executionState);
  const candidates = input.candidates.map((candidateValue) => {
    const candidate = asRecord(candidateValue);
    const context = asRecord(candidate?.contextSnapshot);
    const stage = asRecord(context?.executionStage);
    return {
      id: candidate?.id ?? null,
      status: candidate?.status ?? null,
      startedAt: candidate?.startedAt ?? null,
      finishedAt: candidate?.finishedAt ?? null,
      createdAt: candidate?.createdAt ?? null,
      invocationSource: candidate?.invocationSource ?? null,
      source: context?.source ?? null,
      wakeReason: context?.wakeReason ?? null,
      wakeRole: stage?.wakeRole ?? null,
      stageId: stage?.stageId ?? null,
      stageType: stage?.stageType ?? null,
      reviewRoundId: stage?.reviewRoundId ?? null,
    };
  });
  return JSON.stringify({
    expected: input.expected,
    issue: {
      id: issue?.id ?? null,
      status: issue?.status ?? null,
      updatedAt: issue?.updatedAt ?? null,
      assigneeAgentId: issue?.assigneeAgentId ?? null,
      assigneeUserId: issue?.assigneeUserId ?? null,
      executionState: state,
      currentParticipant: state?.currentParticipant ?? null,
      returnAssignee: state?.returnAssignee ?? null,
      stageId: state?.currentStageId ?? null,
      stageType: state?.currentStageType ?? null,
      reviewRoundId: state?.reviewRoundId ?? null,
    },
    candidates,
  });
}

export interface AtomicReviewDecisionBinding {
  reviewerRunId: string;
  stageId: string;
  reviewRoundId: string | null;
  expectedUpdatedAt: string;
}

export function bindAtomicReviewDecision(
  issueValue: unknown,
  reviewerRunId: string,
  expected: ExpectedStageRun,
): AtomicReviewDecisionBinding | null {
  const issue = asRecord(issueValue);
  const state = asRecord(issue?.executionState);
  const participant = asRecord(state?.currentParticipant);
  if (
    !issue || !state || !participant ||
    issue.id !== expected.issueId ||
    issue.companyId !== expected.companyId ||
    issue.status !== "in_review" ||
    typeof issue.updatedAt !== "string" || issue.updatedAt.length === 0 ||
    state.status !== "pending" ||
    state.currentStageId !== expected.stageId ||
    state.currentStageType !== expected.stageType ||
    (state.reviewRoundId ?? null) !== expected.reviewRoundId ||
    participant.type !== "agent" || participant.agentId !== expected.agentId
  ) return null;
  return {
    reviewerRunId,
    stageId: expected.stageId,
    reviewRoundId: expected.reviewRoundId,
    expectedUpdatedAt: issue.updatedAt,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function matchesAuthoritativeStageRun(runValue: unknown, expected: ExpectedStageRun): boolean {
  const run = asRecord(runValue);
  if (!run) return false;
  if (
    run.companyId !== expected.companyId ||
    run.agentId !== expected.agentId ||
    run.status !== "running" ||
    run.finishedAt != null ||
    run.invocationSource === "timer"
  ) return false;

  const context = asRecord(run.contextSnapshot);
  const stage = asRecord(context?.executionStage);
  const participant = asRecord(stage?.currentParticipant);
  if (!context || !stage || !participant) return false;

  const wakeReason = expected.stageType === "approval"
    ? "execution_approval_requested"
    : "execution_review_requested";
  const wakeRole = expected.stageType === "approval" ? "approver" : "reviewer";
  const allowedActions = stage.allowedActions;

  return (
    context.issueId === expected.issueId &&
    context.taskId === expected.issueId &&
    context.source === "issue.execution_stage" &&
    context.wakeReason === wakeReason &&
    stage.wakeRole === wakeRole &&
    stage.stageId === expected.stageId &&
    stage.stageType === expected.stageType &&
    (stage.reviewRoundId ?? null) === expected.reviewRoundId &&
    participant.type === "agent" &&
    participant.agentId === expected.agentId &&
    Array.isArray(allowedActions) &&
    allowedActions.includes("approve") &&
    allowedActions.includes("request_changes")
  );
}
