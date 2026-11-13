import type { ProviderFailure } from "./provider-failure.generated.js";
import type { DurableRecoveryIdentity } from "./durable-recovery.js";
import type { NativeRunRuntimeGrant } from "./runtime-context.js";
import type {
  NativeRunIdentity,
  NativeSessionCapabilities,
  NativeUserMessage,
} from "./types.js";
import type {
  PrpEvent,
  PrpStructuredRunResult,
  PrpTerminalState,
} from "../protocol/replay-contract.js";
import type {
  DownloadRunnerAttachment,
  HarnessRuntimeRequest,
  HarnessRuntimeRequestHandoff,
  HarnessRuntimeRequestResolution,
  HarnessGoalOperation,
  HarnessSessionRecoveryResult,
  HarnessThreadGoal,
  HarnessThreadLineageEntry,
  NativeRuntimeContextCapabilities,
  PersistedHarnessProviderIdentity,
  PersistedHarnessSession,
  PersistedHarnessTurnTerminal,
  CancelledTurnSettlement,
} from "./harness-driver.js";

export interface NativeSessionBackendDescriptor {
  kind: "runner" | "remote" | "mock";
  name: string;
  version: string;
  capabilities: NativeSessionCapabilities;
  runtimeContextCapabilities?: NativeRuntimeContextCapabilities;
}

export interface OpenNativeSessionInput {
  identity: NativeRunIdentity;
  workingDirectory?: string;
  /**
   * When present, aborts provider bootstrap if the caller's recovery deadline
   * expires. Backends own cleanup for work that has not returned a session yet.
   */
  signal?: AbortSignal;
}

export interface NativeSessionRecoveryOptions {
  normalizeReplayPayload?(payload: PrpEvent["payload"]): PrpEvent["payload"];
  /** Abort provider recovery and release any not-yet-returned provider state. */
  signal: AbortSignal;
}

export interface PersistedNativeSession {
  backendKind: NativeSessionBackendDescriptor["kind"];
  driverKind?: string | null;
  sessionId: string;
  identity: NativeRunIdentity;
  providerSessionId?: string | null;
  /** Tagged provider-owned identity required for safe driver recovery. */
  providerIdentity?: PersistedHarnessProviderIdentity;
  workingDirectory?: string;
  codexUsageBaseline?: PersistedHarnessSession["codexUsageBaseline"];
  providerRecoveryPolicy?:
    | "same_session_only"
    | "allow_replacement_after_governed_wait"
    | "allow_replacement_after_resume_failure";
  cursor?: string | null;
  semanticResult?: PrpStructuredRunResult | null;
  terminal?: PrpTerminalState | null;
  activeTurnId?: string | null;
  terminalTurns?: PersistedHarnessTurnTerminal[];
  /** Control-plane disposition bound to the exact committed tool event. It is
   * independent of the interaction's later answer and proves no provider terminal. */
  governedWait?: { sourceEvent: PrpEvent; result: PrpStructuredRunResult; settlement?: CancelledTurnSettlement };

  /** At-most-once marker for resultless disposition repair or restart continuation. */
  dispositionOnlyRecoveryConsumed?: boolean;
  dispositionOnlyRecoveryTurnId?: string | null;
  pendingRuntimeRequests?: HarnessRuntimeRequest[];
  goal?: HarnessThreadGoal | null;
  lineage?: HarnessThreadLineageEntry[];
}

export interface NativeSessionRecoveryResult {
  recovered: boolean;
  session?: NativeSession;
  reason?: string;
  failureClass?: HarnessSessionRecoveryResult["failureClass"];
  resumeStateUnavailable?: HarnessSessionRecoveryResult["resumeStateUnavailable"];
  runnerExitConfirmed?: HarnessSessionRecoveryResult["runnerExitConfirmed"];
}

/** Runner-owned cause: the process was restored, but its active turn was lost. */
export const NATIVE_RESTART_INTERRUPTION_CODE = "provider_turn_lost_on_restore";

export function isNativeRestartInterruption(error: unknown): boolean {
  if (!error || typeof error !== "object" || Array.isArray(error)) return false;
  const failure = error as Record<string, unknown>;
  return failure.code === NATIVE_RESTART_INTERRUPTION_CODE && failure.recoverable === true;
}

const RESTART_CONTINUATION_DRIVER_KINDS: ReadonlySet<string> = new Set(["codex_app_server", "acpx_runtime", "opencode_server"]);

/** The terminal fingerprint survives a crash between interruption and continuation. */
export function nativeRestartInterruptedTurnId(snapshot: Pick<PersistedNativeSession,
  "driverKind" | "activeTurnId" | "semanticResult" | "terminalTurns" | "dispositionOnlyRecoveryConsumed" | "pendingRuntimeRequests" | "goal"
>): string | null {
  // Runnerd records this cause for Codex app-server and ACPX sessions after
  // proving the old provider lifetime ended and restoring the conversation.
  // A lost continuation re-arms the driver's marker before it is checkpointed,
  // so a consumed marker here still means the allowance is used.
  if (!RESTART_CONTINUATION_DRIVER_KINDS.has(snapshot.driverKind ?? "") || snapshot.activeTurnId != null ||
      snapshot.semanticResult != null || snapshot.dispositionOnlyRecoveryConsumed ||
      snapshot.goal != null || snapshot.pendingRuntimeRequests?.length) return null;
  const terminal = Array.isArray(snapshot.terminalTurns) ? snapshot.terminalTurns.at(-1) : null;
  if (!terminal || typeof terminal.fingerprint !== "string" || !terminal.turnId) return null;
  try {
    const fingerprint = JSON.parse(terminal.fingerprint);
    return fingerprint?.terminalState === "failed" && fingerprint.result === null &&
      isNativeRestartInterruption(fingerprint.error) ? terminal.turnId : null;
  } catch { return null; }
}

export function nativeRestartContinuationInFlight(snapshot: Pick<PersistedNativeSession,
  "activeTurnId" | "terminalTurns"
>): boolean {
  const activeTurnId = snapshot.activeTurnId;
  if (typeof activeTurnId !== "string" || !activeTurnId) return false;
  const last = Array.isArray(snapshot.terminalTurns) ? snapshot.terminalTurns.at(-1) : null;
  if (!last || typeof last.fingerprint !== "string" || !last.turnId || last.turnId === activeTurnId) return false;
  try {
    const fingerprint = JSON.parse(last.fingerprint);
    return fingerprint?.terminalState === "failed" && fingerprint.result === null &&
      isNativeRestartInterruption(fingerprint.error);
  } catch { return false; }
}

/**
 * Cancellation is a synchronous authority transition followed by passive
 * provider cleanup. Once `cancel` returns, the provider session must no longer
 * be able to publish accepted output or acquire new mutation authority for the
 * cancelled turn. Cleanup may stop processes or transports, but it must not
 * perform durable control-plane mutations.
 */
export interface NativeSessionCancellation {
  cleanup: Promise<void>;
  terminalDrainTimeoutMs?: number;
}

export interface NativeSessionSnapshotOptions {
  /** Stop provider snapshot work that outlives the execution deadline. */
  signal: AbortSignal;
}

/** A dispatched operation may have taken effect, but has no proven result. */
export class SemanticToolOutcomeUnknownError extends Error {
  readonly code = "semantic_tool_outcome_unknown";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SemanticToolOutcomeUnknownError";
  }
}

export function isSemanticToolOutcomeUnknownError(error: unknown): error is SemanticToolOutcomeUnknownError {
  // Match across the server's vendored and source-mode runtime boundaries.
  return error instanceof Error && "code" in error && error.code === "semantic_tool_outcome_unknown";
}

/** The exact close owner has torn down its controller without proving suspension. */
export class NativeSessionCloseUnrecoverableError extends Error {
  readonly code = "native_session_close_unrecoverable";

  constructor(
    readonly settlement?: Record<string, unknown>,
    /** Exact durable results exist for every admitted Core tool callback. */
    readonly semanticToolsSettled = false,
  ) {
    super(
      "provider_transport_failed: runner did not durably suspend before checkpoint",
    );
    this.name = "NativeSessionCloseUnrecoverableError";
  }
}

/** The provider recovery deadline ended a recovery that was still waiting on its Runner. */
export class NativeProviderRecoveryDeadlineError extends Error {
  readonly code = "native_provider_recovery_deadline";

  constructor(readonly timeoutMs: number) {
    super(`native session provider recovery timed out after ${timeoutMs}ms`);
    this.name = "NativeProviderRecoveryDeadlineError";
  }
}

export function isNativeProviderRecoveryDeadlineError(error: unknown): error is NativeProviderRecoveryDeadlineError {
  return error instanceof Error && "code" in error && error.code === "native_provider_recovery_deadline";
}

/** An authenticated, exactly bound runner event failed permanent integrity checks. */
export class NativeSessionProtocolIntegrityError extends Error {
  readonly code = "native_event_replay_conflict";
  readonly recovery = "operator_required";

  constructor(
    readonly reason:
      | "semantic_input_digest_mismatch"
      | "source_event_replay_conflict"
      | "runner_event_commit_stalled",
    readonly detail?: string,
  ) {
    super(
      reason === "semantic_input_digest_mismatch"
        ? "native_event_replay_conflict: authenticated runner semantic input failed integrity validation; automatic recovery is stopped."
        : reason === "runner_event_commit_stalled"
          ? `native_event_replay_conflict: runner_event_commit_stalled: runner events kept failing to commit without progress (last cause: ${detail ?? "unknown"}); automatic recovery is stopped.`
          : "native_event_replay_conflict: authenticated runner event conflicts with committed history; automatic recovery is stopped.",
    );
    this.name = "NativeSessionProtocolIntegrityError";
  }
}

/** Admission is blocked by a retained owner that has no safe automatic close retry. */
export class NativeSessionCleanupQuarantinedError extends Error {
  readonly code = "native_session_cleanup_quarantined";
  readonly recovery = "operator_required";

  constructor() {
    super(
      "native_session_cleanup_quarantined: the previous session is still shutting down; Paperclip finishes the cleanup automatically and the saved work is kept.",
    );
    this.name = "NativeSessionCleanupQuarantinedError";
  }
}

export interface NativeSession {
  identity(): NativeRunIdentity;
  capabilities(): Promise<NativeSessionCapabilities>;
  downloadAttachment?: DownloadRunnerAttachment;
  /** completionContract is the attaching run's own contract; a retained session must not keep the prior run's. */
  attachRun?(input: { identity: NativeRunIdentity; currentRunGrant?: NativeRunRuntimeGrant; completionContract?: { revision: string; criterionIds: readonly string[] } }): Promise<void>;
  beginRunAttachment?(input: { identity: NativeRunIdentity }): boolean;
  /** Return the confirmed released source, or false when active use was not released. */
  release?(): Promise<DurableRecoveryIdentity | false>;
  /** Relinquish controller authority without suspending provider execution. */
  detachControllerForRestart?(): Promise<void>;
  events(input?: { afterCursor?: string | null }): AsyncIterable<PrpEvent>;
  startTurn(input: {
    message: NativeUserMessage;
    /** Set by orchestration only after successful provider-session recovery. */
    continuation?: true;
    requestedCollaborationMode?: "default" | "plan";
    /** OpenCode/OpenRouter only. Applies to this turn, never subsequent turns. */
    reasoningMode?: "default" | "disabled";
    /**
     * Run the provider's own context compaction as this turn instead of
     * submitting `message`. Only for a resumed session with prior context.
     */
    compact?: true;
    /** Last context occupancy Paperclip recorded before a compaction turn. */
    contextTokensBefore?: number;
  }): Promise<{
    turnId: string;
    effectiveCollaborationMode?: "default" | "plan";
    /**
     * This restart continuation borrowed the driver's one-shot disposition
     * marker. If it completes without a result the driver returns the marker,
     * and orchestration may send one disposition request in the same attempt.
     */
    borrowedDispositionMarker?: true;
  }>;
  steer?(input: {
    mode?: "steer" | "follow_up";
    turnId: string;
    message: NativeUserMessage;
    correlationId?: string;
  }): Promise<void>;
  interrupt?(input: { turnId?: string; reason?: string }): Promise<void>;
  /** Revoke publication synchronously while the control plane journals a wait.
   * Does not interrupt the provider; cancel owns the subsequent passive cleanup. */
  revokeTurnPublication?(): void;
  /** Commit cancellation synchronously; the returned promise owns cleanup only. */
  cancel?(input: {
    reason: string;
    signal: AbortSignal;
    failureCleanup?: boolean;
  }): NativeSessionCancellation;
  settleCancelledTurn?(input: { turnId: string; reason: string }): Promise<CancelledTurnSettlement | null>;
  resolveRuntimeRequest?(input: {
    commandId?: string;
    requestId: string;
    turnId: string;
    resolution: HarnessRuntimeRequestResolution;
  }): Promise<void>;
  handoffRuntimeRequest?(input: {
    requestId: string;
    turnId: string;
    reason: "durable_handoff";
    /**
     * Revokes durable mutation authority when event consumption fails. The
     * method must commit synchronously before returning; its returned promise
     * owns provider cleanup only and must not mutate durable request state.
     */
    signal: AbortSignal;
  }): HarnessRuntimeRequestHandoff;
  goal?(input: HarnessGoalOperation): Promise<HarnessThreadGoal | null>;
  result(): Promise<{
    result: PrpStructuredRunResult;
    terminal: PrpTerminalState;
    turnId: string | null;
  } | null>;
  usage?(): Promise<Record<string, unknown> | null>;
  snapshot(
    options?: NativeSessionSnapshotOptions,
  ): Promise<PersistedNativeSession>;
  /**
   * Idempotently stop provider work and release every pending `events().next()`
   * before this promise resolves. Implementations must settle every promise
   * previously returned by the session (including interrupt, cancel, handoff,
   * and iterator teardown). The runtime bounds its wait for a broken provider,
   * revokes that session's mutation authority, removes it from reuse, and keeps
   * observing late cleanup so a contract violation cannot defeat a run timeout
   * or become an unhandled rejection.
   */
  close(input: { reason: string }): Promise<void>;
}

/** Normalized control-plane boundary shared by runner and hosted backends. */
export interface NativeSessionBackend {
  /** Existing task rules at user-message priority, for prepared native envelopes. */
  readonly preparedTaskConstraints?: readonly string[];
  descriptor(): Promise<NativeSessionBackendDescriptor>;
  openSession(input: OpenNativeSessionInput): Promise<NativeSession>;
  /** Open a fresh provider session after an explicitly governed continuity break. */
  openReplacementSession?(
    input: OpenNativeSessionInput,
    previous: PersistedNativeSession,
  ): Promise<NativeSession>;
  recoverSession?(
    snapshot: PersistedNativeSession,
    options: NativeSessionRecoveryOptions,
  ): Promise<NativeSessionRecoveryResult>;
}

/** Same-session recovery is forbidden here, and the runner proved that the
 * saved provider session cannot be restored by its build. Retrying the same
 * run cannot succeed. */
export class NativeProviderStateIncompatibleError extends Error {
  readonly code = "native_provider_state_incompatible";
  constructor(reason: string) {
    super(`native_session_recovery_failed: ${reason}`);
    this.name = "NativeProviderStateIncompatibleError";
  }
}

/** The saved provider session still owns a side-effecting call without a
 * recorded result. A replacement session could repeat or lose that action, so
 * the run stops for an operator and the saved state stays intact. */
export class NativeProviderSideEffectPendingError extends Error {
  readonly code = "native_provider_side_effect_pending";
  constructor(reason: string) {
    super(`native_session_recovery_failed: ${reason}`);
    this.name = "NativeProviderSideEffectPendingError";
  }
}

export class NativeGovernedWaitSettlementPendingError extends Error {
  readonly code = "native_governed_wait_settlement_pending";
  constructor(options?: ErrorOptions) {
    super("The waiting state is saved; confirming shutdown of the previous execution is still pending.", options);
    this.name = "NativeGovernedWaitSettlementPendingError";
  }
}

/** A provider failed terminal is not a missing completion proposal. */
export class NativeProviderTerminalFailure extends Error {
  readonly code = "native_provider_terminal_failed";
  declare readonly providerFailure?: ProviderFailure;
  constructor(readonly providerCode: string, readonly recoverable: boolean, message = "Provider session ended with a failed terminal",
    providerFailure?: ProviderFailure | null) {
    super(message);
    this.name = "NativeProviderTerminalFailure";
    if (providerFailure) Object.defineProperty(this, "providerFailure", { value: providerFailure, enumerable: false });
  }
}
