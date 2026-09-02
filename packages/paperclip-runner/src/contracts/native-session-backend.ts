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
  HarnessThreadLineageEntry,
  NativeRuntimeContextCapabilities,
  PersistedHarnessProviderIdentity,
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
  providerRecoveryPolicy?:
    | "same_session_only"
    | "allow_replacement_after_governed_wait"
    | "allow_replacement_after_resume_failure";
  cursor?: string | null;
  semanticResult?: PrpStructuredRunResult | null;
  terminal?: PrpTerminalState | null;
  activeTurnId?: string | null;
  terminalTurns?: PersistedHarnessTurnTerminal[];
  /** Durable at-most-once marker for a resultless terminal recovery turn. */
  dispositionOnlyRecoveryConsumed?: boolean;
  dispositionOnlyRecoveryTurnId?: string | null;
  pendingRuntimeRequests?: HarnessRuntimeRequest[];
  lineage?: HarnessThreadLineageEntry[];
}

export interface NativeSessionRecoveryResult {
  recovered: boolean;
  session?: NativeSession;
  reason?: string;
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

export interface NativeSession {
  identity(): NativeRunIdentity;
  capabilities(): Promise<NativeSessionCapabilities>;
  attachRun?(input: { identity: NativeRunIdentity }): Promise<void>;
  events(input?: { afterCursor?: string | null }): AsyncIterable<PrpEvent>;
  startTurn(input: {
    message: NativeUserMessage;
    requestedCollaborationMode?: "default" | "plan";
  }): Promise<{ turnId: string; effectiveCollaborationMode?: "default" | "plan" }>;
  steer?(input: { turnId: string; message: NativeUserMessage; correlationId?: string }): Promise<void>;
  interrupt?(input: { turnId?: string; reason?: string }): Promise<void>;
  /** Commit cancellation synchronously; the returned promise owns cleanup only. */
  cancel?(input: { reason: string; signal: AbortSignal }): NativeSessionCancellation;
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
  result(): Promise<{
    result: PrpStructuredRunResult;
    terminal: PrpTerminalState;
    turnId: string | null;
  } | null>;
  usage?(): Promise<Record<string, unknown> | null>;
  snapshot(options?: NativeSessionSnapshotOptions): Promise<PersistedNativeSession>;
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
