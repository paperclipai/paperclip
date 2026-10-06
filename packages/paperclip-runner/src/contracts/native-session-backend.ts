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
  HarnessRuntimeRequest,
  HarnessRuntimeRequestHandoff,
  HarnessRuntimeRequestResolution,
  HarnessGoalOperation,
  HarnessThreadGoal,
  HarnessThreadLineageEntry,
  NativeRuntimeContextCapabilities,
  PersistedHarnessProviderIdentity,
  PersistedHarnessSession,
  PersistedHarnessTurnTerminal,
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
}

/** Runner-owned cause: the process was restored, but its active turn was lost. */
export const NATIVE_RESTART_INTERRUPTION_CODE = "provider_turn_lost_on_restore";

export function isNativeRestartInterruption(error: unknown): boolean {
  if (!error || typeof error !== "object" || Array.isArray(error)) return false;
  const failure = error as Record<string, unknown>;
  return failure.code === NATIVE_RESTART_INTERRUPTION_CODE && failure.recoverable === true;
}

/** The terminal fingerprint survives a crash between interruption and continuation. */
export function nativeRestartInterruptedTurnId(snapshot: Pick<PersistedNativeSession,
  "driverKind" | "activeTurnId" | "semanticResult" | "terminalTurns" | "dispositionOnlyRecoveryConsumed" | "pendingRuntimeRequests" | "goal"
>): string | null {
  if (snapshot.driverKind !== "codex_app_server" || snapshot.activeTurnId != null ||
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

/**
 * Cancellation is a synchronous authority transition followed by passive
 * provider cleanup. Once `cancel` returns, the provider session must no longer
 * be able to publish accepted output or acquire new mutation authority for the
 * cancelled turn. Cleanup may stop processes or transports, but it must not
 * perform durable control-plane mutations.
 */
export interface NativeSessionCancellation {
  cleanup: Promise<void>;
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

  constructor(readonly settlement?: Record<string, unknown>) {
    super(
      "provider_transport_failed: runner did not durably suspend before checkpoint",
    );
    this.name = "NativeSessionCloseUnrecoverableError";
  }
}

/** An authenticated, exactly bound runner event failed permanent integrity checks. */
export class NativeSessionProtocolIntegrityError extends Error {
  readonly code = "native_event_replay_conflict";
  readonly recovery = "operator_required";

  constructor(
    readonly reason:
      | "semantic_input_digest_mismatch"
      | "source_event_replay_conflict",
  ) {
    super(
      reason === "semantic_input_digest_mismatch"
        ? "native_event_replay_conflict: authenticated runner semantic input failed integrity validation; automatic recovery is stopped."
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
      "native_session_cleanup_quarantined: prior session cleanup requires operator recovery; verify its retained process ownership and checkpoint before a controlled restart. Clearing a task session does not resolve this quarantine.",
    );
    this.name = "NativeSessionCleanupQuarantinedError";
  }
}

export interface NativeSession {
  identity(): NativeRunIdentity;
  capabilities(): Promise<NativeSessionCapabilities>;
  attachRun?(input: { identity: NativeRunIdentity }): Promise<void>;
  /** Relinquish controller authority without suspending provider execution. */
  detachControllerForRestart?(): Promise<void>;
  events(input?: { afterCursor?: string | null }): AsyncIterable<PrpEvent>;
  startTurn(input: {
    message: NativeUserMessage;
    /** Set by orchestration only after successful provider-session recovery. */
    continuation?: true;
    requestedCollaborationMode?: "default" | "plan";
  }): Promise<{
    turnId: string;
    effectiveCollaborationMode?: "default" | "plan";
  }>;
  steer?(input: {
    mode?: "steer" | "follow_up";
    turnId: string;
    message: NativeUserMessage;
    correlationId?: string;
  }): Promise<void>;
  interrupt?(input: { turnId?: string; reason?: string }): Promise<void>;
  /** Commit cancellation synchronously; the returned promise owns cleanup only. */
  cancel?(input: {
    reason: string;
    signal: AbortSignal;
  }): NativeSessionCancellation;
  resolveRuntimeRequest?(input: {
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

/** A provider failed terminal is not a missing completion proposal. */
export class NativeProviderTerminalFailure extends Error {
  readonly code = "native_provider_terminal_failed";
  constructor(readonly providerCode: string, readonly recoverable: boolean, message = "Provider session ended with a failed terminal") {
    super(message);
    this.name = "NativeProviderTerminalFailure";
  }
}
