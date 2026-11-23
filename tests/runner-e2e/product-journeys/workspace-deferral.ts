type RecordValue = Record<string, unknown>;
const object = (value: unknown): RecordValue => value !== null && typeof value === "object" && !Array.isArray(value)
  ? value as RecordValue : {};
const nativeRecoveryTerminalCauses = new Set([
  "native_provider_runtime_missing", "native_provider_model_rejected", "native_provider_approval_required",
  "native_event_replay_conflict", "runner_remote_provider_artifact_incompatible",
  "runner_remote_provider_verification_unavailable", "native_provider_terminal_failed",
  "native_current_wake_comments_unread", "native_current_wake_comments_changed_after_read",
  "native_session_cleanup_quarantined", "native_adopted_runner_authentication_timeout", "native_provider_usage_limit",
  "native_permission_declined", "native_session_retry_exhausted",
]);

function hasProviderUsage(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value !== "object" || Array.isArray(value)) return true;
  return Object.entries(value).some(([key, entry]) => {
    if (entry == null) return false;
    if (["inputTokens", "cachedInputTokens", "outputTokens", "totalTokens", "costUsd", "costUsdExact"].includes(key)) return entry !== 0;
    if (key === "accountingReceiptReady") return entry !== true;
    // Assigned before provider dispatch; identifies the accounting scope, not usage.
    if (key === "ledgerScope") return typeof entry !== "object" || Array.isArray(entry);
    return true;
  });
}

export function isPendingNativeRecovery(run: RecordValue, deadlineAt: number): boolean {
  const execution = object(run.execution);
  const finishedAt = typeof run.finishedAt === "string" ? Date.parse(run.finishedAt) : NaN;
  const retryAt = typeof execution.retryAt === "string" ? Date.parse(execution.retryAt) : NaN;
  return run.runtimeMode === "native" && run.status === "failed" && run.nativePhase === "retryable_failure" &&
    typeof run.errorCode === "string" && run.errorCode.trim().length > 0 && execution.cause === run.errorCode &&
    !nativeRecoveryTerminalCauses.has(run.errorCode) &&
    typeof run.nativeIssueId === "string" && run.nativeIssueId === object(run.contextSnapshot).issueId &&
    (run.issueId == null || run.issueId === run.nativeIssueId) &&
    (execution.phase === "retry_scheduled" || execution.phase === "reconnecting") && execution.recoveryOwner === "agent" &&
    Number.isInteger(execution.attempt) && Number(execution.attempt) >= 1 &&
    execution.maxAttempts === 3 && Number(execution.attempt) < execution.maxAttempts && execution.successorRunId === null &&
    Number.isFinite(finishedAt) && Number.isFinite(retryAt) && Number.isFinite(deadlineAt) &&
    retryAt > finishedAt && retryAt <= deadlineAt;
}

/** Admission may set startedAt before selecting a runtime. Only this explicit
 * control-plane receipt, without contradictory provider evidence, proves no turn
 * ran. A legacy default alone is never proof of either execution or nonexecution. */
export function isProviderUnstartedWorkspaceDeferral(run: RecordValue): boolean {
  const result = object(run.resultJson);
  const recovery = object(result.executionRecovery);
  const cancellation = object(result.cancellation);
  const profile = object(run.runnerProfileJson);
  return run.status === "cancelled" && run.errorCode === "workspace_busy" &&
    recovery.kind === "workspace_wait" && recovery.providerWorkStarted === false &&
    cancellation.source === "control_plane" && cancellation.expected === true && object(cancellation.initiator).type === "system" &&
    run.runtimeMode === "legacy" && run.runtimeModeResolvedAt === null &&
    ["nativeIssueId", "nativeSessionId", "nativePhase", "runnerInstanceId", "processPid", "processGroupId", "processStartedAt",
      "sessionIdAfter", "externalRunId", "exitCode", "signal", "logStore", "logRef", "lastOutputAt", "lastOutputStream"].every(key => run[key] == null) &&
    run.lastOutputSeq === 0 &&
    (run.lastOutputBytes == null || run.lastOutputBytes === 0) &&
    profile.nativeExecutionInput == null && profile.sessionCheckpoint == null &&
    !hasProviderUsage(run.usageJson) && (run.costUsd == null || run.costUsd === 0) &&
    ["costUsd", "costUsdExact", "cost_usd", "total_cost_usd"].every(key => result[key] == null || result[key] === 0);
}
