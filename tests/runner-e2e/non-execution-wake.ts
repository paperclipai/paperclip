import { createHash } from "node:crypto";

/** A queued parent wake can be suppressed while its child still runs. This is
 * not a provider failure: admission never started. Keep it in the evidence. */
export function isBlockedUnstartedWake(run: Record<string, unknown>) {
  return run.status === "cancelled" && run.errorCode === "issue_dependencies_blocked" && run.startedAt === null;
}

/** The dispatch gate retired an obsolete assignment before any provider work. */
export function isReassignedUnstartedWake(run: {
  status?: unknown; errorCode?: unknown; startedAt?: unknown; nativeIssueId?: unknown;
  resultJson?: Record<string, unknown>;
}) {
  return run.status === "cancelled" && run.errorCode === "issue_assignee_changed" && run.startedAt === null
    && run.nativeIssueId == null && run.resultJson?.stopReason === "issue_assignee_changed"
    && run.resultJson.timeoutSource === "stale_queued_run_gate" && run.resultJson.timeoutFired === false;
}

/** A terminal issue may make a queued wake obsolete before provider admission. */
export function isTerminalUnstartedWake(
  run: Record<string, unknown>,
  tasks: Array<{ id: string; status?: unknown }>,
) {
  const context = run.contextSnapshot;
  const issueId = context && typeof context === "object" && "issueId" in context ? context.issueId : undefined;
  return run.status === "cancelled" && run.errorCode === "issue_terminal_status" &&
    run.startedAt === null && tasks.some(task =>
      task.id === issueId && ["done", "cancelled"].includes(String(task.status)),
    );
}

type Row = Record<string, unknown>;
const object = (value: unknown): Row | null => value !== null && typeof value === "object" && !Array.isArray(value)
  ? value as Row : null;
const uuid = (value: unknown): value is string => typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const time = (value: unknown) => typeof value === "string" ? Date.parse(value) : Number.NaN;
const keys = (value: Row, expected: string[]) => Object.keys(value).sort().join(",") === expected.sort().join(",");
const one = (value: unknown, expected: unknown) => Array.isArray(value) && value.length === 1 && value[0] === expected;

export interface ChatAdmissionWait {
  runId: string;
  kind: "pre_dispatch_execution_wait";
  companyId: string;
  agentId: string;
  issueId: string;
  recoveryActionId: string;
  wakeupRequestId: string;
  commentId: string;
}

export function classifyPreDispatchExecutionWait(run: unknown, events: unknown): ChatAdmissionWait | null {
  const row = object(run), context = object(row?.contextSnapshot), result = object(row?.resultJson);
  const wait = object(result?.executionWait);
  if (!row || !context || !result || !wait || !Array.isArray(events) || events.length !== 1) return null;
  for (const field of ["id", "companyId", "agentId", "wakeupRequestId"]) if (!uuid(row[field])) return null;
  if (!uuid(context.issueId) || !uuid(context.wakeCommentId) || !uuid(wait.recoveryActionId) ||
      wait.issueId !== context.issueId || row.issueId !== context.issueId ||
      context.source !== "issue.comment" || context.wakeReason !== "issue_commented" ||
      !one(context.wakeCommentIds, context.wakeCommentId)) return null;
  if (row.runtimeMode !== "legacy" || row.status !== "cancelled" ||
      row.invocationSource !== "on_demand" || row.triggerDetail !== "manual" ||
      row.errorCode !== "execution_reconciliation_required" || row.runnerProfileJson !== null ||
      !keys(result, ["stopReason", "timeoutSource", "timeoutFired", "timeoutConfigured", "effectiveTimeoutSec", "executionWait"]) ||
      !keys(wait, ["issueId", "recoveryActionId"]) || result.stopReason !== row.errorCode ||
      result.timeoutSource !== "stale_queued_run_gate" || result.timeoutFired !== false ||
      result.timeoutConfigured !== false || result.effectiveTimeoutSec !== 0 ||
      row.nextEventSeq !== 2 || row.logCompressed !== false ||
      !(row.sessionIdBefore === null || (typeof row.sessionIdBefore === "string" && row.sessionIdBefore.length > 0)) ||
      !Number.isFinite(time(row.createdAt)) || !Number.isFinite(time(row.finishedAt)) ||
      time(row.finishedAt) < time(row.createdAt)) return null;
  for (const field of ["startedAt", "runtimeModeResolvedAt", "runtimeModeReason", "runtimeModeResolverVersion",
    "runnerInstanceId", "nativeSessionId", "nativeIssueId", "driverKind", "driverVersion", "completionContractId",
    "completionContractSha256", "nativePhase", "sessionIdAfter", "controllerBootId",
    "controllerLeaseExpiresAt", "executionStage", "processPid", "processGroupId", "processStartedAt", "logStore",
    "logRef", "logBytes", "logSha256", "stdoutExcerpt", "stderrExcerpt", "usageJson", "exitCode", "signal", "externalRunId"])
    if (row[field] !== null) return null;
  const event = object(events[0]), payload = object(event?.payload);
  if (!event || !payload || event.seq !== 1 || event.runId !== row.id || event.companyId !== row.companyId ||
      event.agentId !== row.agentId || event.eventType !== "lifecycle" || event.stream !== "system" || event.level !== "warn" ||
      typeof row.error !== "string" || !row.error || event.message !== row.error ||
      !keys(payload, ["issueId", "recoveryActionId"]) || payload.issueId !== wait.issueId ||
      payload.recoveryActionId !== wait.recoveryActionId) return null;
  for (const field of ["sourceInstanceId", "sourceEventId", "sourceSeq", "sourcePayloadSha256", "protocolSchemaVersion"])
    if (event[field] !== null) return null;
  return { runId: String(row.id), kind: "pre_dispatch_execution_wait", companyId: String(row.companyId),
    agentId: String(row.agentId), issueId: context.issueId, recoveryActionId: wait.recoveryActionId,
    wakeupRequestId: String(row.wakeupRequestId), commentId: context.wakeCommentId };
}

export function chatProviderRuns<T extends { id: string; contextSnapshot?: Record<string, unknown>; resultJson?: Record<string, unknown> }>(
  runs: T[], admissionWaits: readonly ChatAdmissionWait[] = [],
) {
  const waiting = new Set(admissionWaits.map(wait => wait.runId));
  return runs.filter(run => run.contextSnapshot?.conversationReset !== true &&
    run.resultJson?.conversationReset !== true && !waiting.has(run.id));
}

export function verifyChatAdmissionWaitCoverage(input: {
  runs: unknown[]; runEvidence: unknown[]; comments: unknown[]; issue: unknown;
  companyId: string; agentId: string; stoppedRunId: string | undefined;
  recoverySources: Array<{ runId: string; recoveryActionId: string; response: unknown }>;
}): ChatAdmissionWait[] {
  function require(condition: unknown, code: string): asserts condition {
    if (!condition) throw new Error(`Chat admission wait: ${code}`);
  }
  const rows = input.runs.map(object), issue = object(input.issue);
  require(rows.every(Boolean) && issue, "missing_rows");
  require(new Set(rows.map(row => row!.id)).size === rows.length, "duplicate_rows");
  const candidates = rows.filter(row => row!.errorCode === "execution_reconciliation_required");
  require(candidates.length <= 1, "repeated_admission");
  if (!candidates.length) return [];
  require(issue.companyId === input.companyId && issue.assigneeAgentId === input.agentId &&
    issue.conversationSessionGeneration === 1, "issue_scope");
  const stopped = rows.find(row => row!.id === input.stoppedRunId), cancellation = object(object(stopped?.resultJson)?.nativeCancellation);
  require(stopped && stopped.runtimeMode === "native" && stopped.status === "cancelled" &&
    stopped.companyId === input.companyId && stopped.agentId === input.agentId && stopped.nativeIssueId === issue.id &&
    cancellation?.schema === "paperclip.native-cancellation.v1" && cancellation.runId === stopped.id &&
    cancellation.companyId === input.companyId && cancellation.issueId === issue.id && cancellation.scope === "run" &&
    cancellation.reasonCode === "cancellation_run_only" && cancellation.dispatchState === "acknowledged" &&
    cancellation.dispatched === true, "stopped_native_source");
  const waits: ChatAdmissionWait[] = [];
  for (const row of candidates) {
    const evidence = input.runEvidence.map(object).filter(value => value?.runId === row!.id);
    require(evidence.length === 1 && evidence[0]!.log === null &&
      evidence[0]!.logOmissionReason === "pre_dispatch_execution_wait", "complete_event_receipt");
    const wait = classifyPreDispatchExecutionWait(row, evidence[0]!.events);
    require(wait && wait.companyId === input.companyId && wait.agentId === input.agentId && wait.issueId === issue.id, "wait_scope");
    const comment = input.comments.map(object).filter(value => value?.id === wait.commentId);
    require(comment.length === 1 && comment[0]!.companyId === input.companyId && comment[0]!.issueId === issue.id &&
      comment[0]!.body === "/new" && comment[0]!.authorType === "user" && comment[0]!.deletedAt === null &&
      typeof comment[0]!.authorUserId === "string" && comment[0]!.authorUserId &&
      comment[0]!.authorAgentId === null && comment[0]!.createdByRunId === null &&
      row!.responsibleUserId === comment[0]!.authorUserId && time(stopped.finishedAt) < time(comment[0]!.createdAt) &&
      time(comment[0]!.createdAt) <= time(row!.createdAt), "saved_human_new");
    if (row!.sessionIdBefore !== null) {
      const seed = rows.filter(value => value!.runtimeMode === "native" && value!.status === "succeeded" &&
        object(value!.contextSnapshot)?.conversationSessionGeneration !== 1);
      require(seed.length === 1 && seed[0]!.sessionIdAfter === row!.sessionIdBefore &&
        stopped.sessionIdBefore === row!.sessionIdBefore, "historical_session_hint");
    }
    const reset = rows.filter(value => object(value!.contextSnapshot)?.conversationReset === true);
    require(reset.length === 1, "single_authored_reset");
    const resetContext = object(reset[0]!.contextSnapshot)!;
    require(reset[0]!.status === "succeeded" && resetContext.wakeCommentId === wait.commentId &&
      resetContext.commentId === wait.commentId && resetContext.conversationSessionGeneration === 1 &&
      object(reset[0]!.resultJson)?.conversationReset === true && issue.conversationBoundaryCommentId === wait.commentId &&
      time(row!.finishedAt) <= time(reset[0]!.startedAt), "same_saved_reset");
    const sources = input.recoverySources.filter(value => value.runId === stopped.id && value.recoveryActionId === wait.recoveryActionId);
    require(sources.length === 1, "selected_recovery");
    const response = object(sources[0]!.response), actions = response?.actions;
    require(Array.isArray(actions) && actions.length === 1, "exact_recovery_action");
    const action = object(actions[0]), facts = object(action?.evidence), recovery = object(facts?.systemRecovery),
      preservation = object(facts?.workspaceRecovery), automatic = object(facts?.automaticRecovery),
      authorization = object(facts?.explicitUserContinuation), inspection = object(response?.sourceInspection);
    require(action?.id === wait.recoveryActionId && action.companyId === input.companyId && action.sourceIssueId === issue.id &&
      action.status === "resolved" && action.outcome === "cancelled" && Number.isFinite(time(action.resolvedAt)) &&
      action.fingerprint === `native-workspace:${stopped.id}` && facts?.runId === stopped.id &&
      automatic?.policy === "preserve_without_replay_v1" && automatic.replay === "explicit_user_continuation" && automatic.runId === stopped.id &&
      authorization && authorization.previousRunId === stopped.id && authorization.commentId === wait.commentId &&
      authorization.actorId === comment[0]!.authorUserId && authorization.runId === reset[0]!.id &&
      authorization.queuedCommentRequestId === wait.wakeupRequestId &&
      authorization.commentBodyHash === createHash("sha256").update("/new").digest("hex") &&
      recovery?.schema === "paperclip.system-recovery.v1" && recovery.sourceRunId === stopped.id && recovery.state === "complete" &&
      recovery.phase === "reconcile_effects" && Array.isArray(recovery.preservationOperationIds) && recovery.preservationOperationIds.length > 0 &&
      recovery.preservationOperationIds.every(uuid) && new Set(recovery.preservationOperationIds).size === recovery.preservationOperationIds.length &&
      preservation?.schema === "paperclip.workspace-recovery.v1" && preservation.runId === stopped.id && preservation.status === "recovered" &&
      inspection?.schema === "paperclip.workspace-source-inspection.v1" && inspection.actionId === wait.recoveryActionId &&
      inspection.runId === stopped.id && inspection.scope === "recorded_source_identity" && inspection.status === "verified", "preserved_native_source");
    waits.push(wait);
  }
  const providers = chatProviderRuns(rows as Array<Row & { id: string }>, waits);
  require(providers.length === 3 && providers.every(row => row.runtimeMode === "native" && row.companyId === input.companyId && row.agentId === input.agentId &&
      row.nativeIssueId === issue.id && object(row.contextSnapshot)?.issueId === issue.id) &&
    providers.filter(row => row.status === "cancelled").length === 1 && providers.filter(row => row.status === "succeeded").length === 2, "three_native_providers");
  const fresh = providers.filter(row => row.status === "succeeded" && object(row.contextSnapshot)?.conversationSessionGeneration === 1);
  require(fresh.length === 1 && fresh[0]!.sessionIdBefore === null &&
    time(fresh[0]!.startedAt) >= time(rows.find(row => object(row!.contextSnapshot)?.conversationReset === true)!.finishedAt), "fresh_native_after_reset");
  return waits;
}
