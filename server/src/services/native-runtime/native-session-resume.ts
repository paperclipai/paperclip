import type {
  NativeExecutionInput,
  PersistedNativeSession,
} from "../../vendor/paperclip-runner/index.js";
import { parseNativeExecutionInput } from "../../vendor/paperclip-runner/index.js";

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function isNativeSessionId(value: unknown): value is string {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function sameProvider(
  previous: NativeExecutionInput["provider"],
  current: NativeExecutionInput["provider"],
): boolean {
  return JSON.stringify(previous) === JSON.stringify(current);
}

/**
 * Rebind a completed prior run's provider checkpoint to a new heartbeat run.
 * The provider/driver session identity is retained, while every per-turn and
 * per-event field is reset so the new run starts one clean turn via resume.
 */
export function rebindNativeSessionCheckpoint(input: {
  previousRun: {
    id: string;
    companyId: string;
    agentId: string;
    nativeSessionId: string | null;
    runnerProfileJson: unknown;
  };
  currentExecution: NativeExecutionInput;
}): PersistedNativeSession | null {
  const previousProfile = record(input.previousRun.runnerProfileJson);
  const rawCheckpoint = record(previousProfile.sessionCheckpoint);
  const checkpointIdentity = record(rawCheckpoint.identity);
  const current = input.currentExecution;
  const normalizedSessionId = current.session.normalizedSessionId;
  if (
    !isNativeSessionId(normalizedSessionId)
    || input.previousRun.companyId !== current.binding.companyId
    || input.previousRun.agentId !== current.binding.agentId
    || input.previousRun.nativeSessionId !== normalizedSessionId
    || typeof rawCheckpoint.sessionId !== "string"
    || checkpointIdentity.runId !== input.previousRun.id
    || checkpointIdentity.companyId !== current.binding.companyId
    || checkpointIdentity.issueId !== current.binding.issueId
    || checkpointIdentity.agentId !== current.binding.agentId
    || checkpointIdentity.sessionId !== normalizedSessionId
  ) return null;

  let previousExecution: NativeExecutionInput;
  try {
    previousExecution = parseNativeExecutionInput(previousProfile.nativeExecutionInput);
  } catch {
    return null;
  }
  if (
    previousExecution.binding.runId !== input.previousRun.id
    || previousExecution.binding.companyId !== current.binding.companyId
    || previousExecution.binding.issueId !== current.binding.issueId
    || previousExecution.binding.agentId !== current.binding.agentId
    || previousExecution.session.normalizedSessionId !== normalizedSessionId
    || previousExecution.session.driverKind !== current.session.driverKind
    || previousExecution.workspace.cwd !== current.workspace.cwd
    || ("executionMode" in previousExecution ? previousExecution.executionMode : "default")
      !== ("executionMode" in current ? current.executionMode : "default")
    || !sameProvider(previousExecution.provider, current.provider)
    || previousExecution.schema !== current.schema
    || ("runtimeContext" in previousExecution && "runtimeContext" in current
      && previousExecution.runtimeContext.aggregateDigest !== current.runtimeContext.aggregateDigest)
  ) return null;

  const priorSemanticResult = record(rawCheckpoint.semanticResult);
  const priorContinuation = record(priorSemanticResult.continuation);
  const providerRecoveryPolicy =
    priorSemanticResult.reportedWorkDisposition === "yielded"
    && priorContinuation.kind === "response_wake"
      ? "allow_replacement_after_governed_wait" as const
      : "allow_replacement_after_resume_failure" as const;

  return {
    ...(structuredClone(rawCheckpoint) as unknown as PersistedNativeSession),
    identity: {
      runId: current.binding.runId,
      sessionId: normalizedSessionId,
      companyId: current.binding.companyId,
      issueId: current.binding.issueId,
      agentId: current.binding.agentId,
    },
    cursor: null,
    semanticResult: null,
    terminal: null,
    activeTurnId: null,
    terminalTurns: [],
    pendingRuntimeRequests: [],
    providerRecoveryPolicy,
  };
}
