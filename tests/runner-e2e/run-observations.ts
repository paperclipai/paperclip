export interface ObservableRunState {
  status?: string | null;
  errorCode?: string | null;
}

export interface ObservableRunEvent {
  eventType?: string;
  payload?: Record<string, unknown> | null;
}

export interface ObservableProviderSessionRun {
  id: string;
  sessionIdBefore?: string | null;
  sessionIdAfter?: string | null;
  contextSnapshot?: Record<string, unknown> | null;
}

export interface ObservableMatcherResult {
  matcher: {
    kind?: string;
    expected?: unknown;
    count?: unknown;
  };
  passed: boolean;
}

export interface ObservableInteraction {
  kind?: string | null;
  status?: string | null;
  payload?: unknown;
}

export interface OpenRouterHelloTerminalVarianceObservation {
  suiteId: string;
  profileId: string;
  taskId: string;
  expectedMarker: string;
  finalRunMessage: string;
  allAgentMessages: string;
  semanticSummary: unknown;
  issueStatus: string;
  runStatuses: readonly string[];
  matcherResults: readonly ObservableMatcherResult[];
  invariantFailures: readonly string[];
}

export function acceptedPlanSessionResetFailures(
  provider: "codex" | "opencode" | "acpx",
  previousSessionId: string | null | undefined,
  current: ObservableProviderSessionRun,
): string[] | null {
  const context = record(current.contextSnapshot);
  const acceptedPlanReset =
    context.forceFreshSession === true &&
    context.workspaceRefreshReason === "accepted_plan_confirmation" &&
    context.source === "issue.interaction.accept" &&
    context.interactionStatus === "accepted";
  if (!acceptedPlanReset) return null;

  const failures: string[] = [];
  if (current.sessionIdBefore) {
    failures.push(
      `expected accepted Plan run ${current.id} to start without a prior provider session`,
    );
  }
  if (
    previousSessionId &&
    current.sessionIdAfter &&
    current.sessionIdAfter === previousSessionId
  ) {
    failures.push(
      `expected accepted Plan run ${current.id} to rotate the ${provider} provider session`,
    );
  }
  return failures;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function isNonExecutingReviewFenceRun(run: ObservableRunState) {
  return (
    run.status === "cancelled" &&
    run.errorCode === "issue_continuation_waiting_on_review"
  );
}

export function hasTerminalMalformedPlanConfirmation(input: {
  runs: readonly ObservableRunState[];
  interactions: readonly ObservableInteraction[];
  minimumRunCount: number;
}) {
  if (
    input.runs.length < input.minimumRunCount ||
    !input.runs.every((run) => run.status === "succeeded")
  ) {
    return false;
  }

  return input.interactions.some((interaction) => {
    if (
      interaction.kind !== "request_confirmation" ||
      interaction.status !== "pending"
    ) {
      return false;
    }
    const target = record(record(interaction.payload).target);
    return !(
      target.type === "issue_document" &&
      target.key === "plan" &&
      typeof target.revisionId === "string" &&
      target.revisionId.trim().length > 0
    );
  });
}

function normalizeMessage(value: string) {
  return value
    .replace(/\r\n/g, "\n")
    .replace(/\\_/g, "_")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function countOccurrences(value: string, expected: string) {
  if (!expected) return 0;
  let count = 0;
  let cursor = 0;
  while (cursor <= value.length - expected.length) {
    const index = value.indexOf(expected, cursor);
    if (index < 0) break;
    count += 1;
    cursor = index + expected.length;
  }
  return count;
}

export function isOpenRouterDeepSeekHelloTerminalVariance(
  observation: OpenRouterHelloTerminalVarianceObservation,
) {
  const marker = normalizeMessage(observation.expectedMarker);
  const finalRunMessage = normalizeMessage(observation.finalRunMessage);
  const allAgentMessages = normalizeMessage(observation.allAgentMessages);
  const failedMatchers = observation.matcherResults.filter(
    (result) => !result.passed,
  );
  const hasExpectedExactFailure = failedMatchers.some(
    (result) =>
      result.matcher.kind === "message_exact" &&
      result.matcher.expected === observation.expectedMarker,
  );
  const hasExpectedOccurrenceFailure = failedMatchers.some(
    (result) =>
      result.matcher.kind === "message_occurrences" &&
      result.matcher.expected === observation.expectedMarker &&
      result.matcher.count === 1,
  );

  return (
    observation.suiteId === "openrouter-model-breadth" &&
    observation.profileId === "openrouter-deepseek-deepseek-v4-flash-0731" &&
    observation.taskId === "hello-complete" &&
    observation.issueStatus === "done" &&
    observation.runStatuses.length === 1 &&
    observation.runStatuses[0] === "succeeded" &&
    observation.semanticSummary === observation.expectedMarker &&
    finalRunMessage.length > 0 &&
    countOccurrences(finalRunMessage, marker) === 0 &&
    countOccurrences(allAgentMessages, marker) === 0 &&
    observation.invariantFailures.length === 0 &&
    failedMatchers.length === 2 &&
    hasExpectedExactFailure &&
    hasExpectedOccurrenceFailure
  );
}

export function isControlPlaneGovernedResponseWait(
  events: readonly ObservableRunEvent[],
) {
  const accepted = events.filter(
    (event) => event.eventType === "run.result.accepted",
  );
  if (accepted.length !== 1) return false;
  const envelope = record(accepted[0]?.payload?.prpEvent);
  const result = record(record(envelope.payload).result);
  const continuation = record(result.continuation);
  const idempotencyKey = continuation.idempotencyKey;
  if (
    typeof idempotencyKey !== "string" ||
    !idempotencyKey.startsWith("interaction-response:")
  ) {
    return false;
  }
  const interactionId = idempotencyKey.slice("interaction-response:".length);
  if (!interactionId) return false;
  const interactionRef = `interaction:${interactionId}`;
  const hasEvidence =
    Array.isArray(result.evidence) &&
    result.evidence.some((value) => record(value).ref === interactionRef);
  const hasInteractionArtifact =
    Array.isArray(result.artifacts) &&
    result.artifacts.some((value) => {
      const artifact = record(value);
      return (
        artifact.kind === "issue_thread_interaction" &&
        artifact.ref === interactionRef
      );
    });
  return (
    envelope.schema === "paperclip.prp.event.v1" &&
    envelope.eventType === "run.result.accepted" &&
    envelope.sourceKind === "control_plane" &&
    result.schema === "paperclip.run_result.v1" &&
    result.reportedWorkDisposition === "yielded" &&
    continuation.kind === "response_wake" &&
    hasEvidence &&
    hasInteractionArtifact
  );
}

export function providerSessionContinuityFailures(
  provider: "codex" | "opencode",
  runs: readonly ObservableProviderSessionRun[],
): string[] {
  const failures: string[] = [];
  for (let index = 0; index < runs.length; index += 1) {
    const current = runs[index]!;
    const currentSessionId = current.sessionIdAfter;
    if (!currentSessionId) {
      failures.push(
        `expected ${provider} run ${current.id} to record provider session identity`,
      );
      continue;
    }
    if (index === 0) continue;

    const previousSessionId = runs[index - 1]?.sessionIdAfter;
    const acceptedPlanResetFailures = acceptedPlanSessionResetFailures(
      provider,
      previousSessionId,
      current,
    );
    if (acceptedPlanResetFailures) {
      failures.push(...acceptedPlanResetFailures);
      continue;
    }

    if (!previousSessionId || currentSessionId !== previousSessionId) {
      failures.push(
        `expected ${provider} to preserve its provider session for run ${current.id}`,
      );
      continue;
    }
    if (
      current.sessionIdBefore &&
      current.sessionIdBefore !== previousSessionId
    ) {
      failures.push(
        `expected ${provider} run ${current.id} to resume provider session ${previousSessionId}`,
      );
    }
  }
  return failures;
}

export function numberedPlanStepCount(body: string | null | undefined) {
  return (body ?? "").split(/\r?\n/).filter((line) => {
    const normalized = line
      .replaceAll("**", "")
      .replaceAll("__", "")
      .replaceAll("`", "");
    return /^\s*(?:#{1,6}\s*)?(?:[-*+]\s*)?(?:step\s+)?\d+(?:[.)]|\s*[-—:])(?:\s|$)/i.test(
      normalized,
    );
  }).length;
}
