import type {
  NativeRunEvent,
  NativeRunIdentity,
  NativeRunResult,
} from "./types.js";
import type {
  PrpEvent,
  PrpStructuredRunResult,
  PrpTerminalState,
} from "../protocol/replay-contract.js";
import type { PersistedNativeSession } from "./native-session-backend.js";

export interface OpenControlPlaneRunInput {
  identity: NativeRunIdentity;
  backendKind: "runner" | "remote" | "mock";
  sourceInstanceId?: string;
}

export interface AppendedEventReceipt {
  cursor: number;
  highestContiguousSourceSeq: number;
  disposition: "committed" | "duplicate";
}

export interface AppendControlPlaneEventOptions {
  /**
   * Cancellation is a durability boundary: an aborted append must settle
   * without committing before it rejects.
   */
  signal: AbortSignal;
}

export interface CheckpointControlPlaneSessionOptions {
  /**
   * Cancellation is a durability boundary: once aborted, checkpoint work
   * must settle without committing a new snapshot.
   */
  signal: AbortSignal;
}

export interface ReplayControlPlaneEventsInput {
  runId: string;
  sourceInstanceId: string;
  afterSourceSeq: number;
  limit: number;
}

export interface ReplayedControlPlaneEvents {
  events: PrpEvent[];
  highestContiguousSourceSeq: number;
}

export interface FinalizeControlPlaneOperationOptions {
  /**
   * Finalization cancellation is a durability boundary. Once aborted, a
   * mutating operation must settle without committing new durable state.
   */
  signal: AbortSignal;
}

export interface CompleteControlPlaneRunInput {
  result: PrpStructuredRunResult;
  terminal: PrpTerminalState;
  turnId?: string | null;
  callerResultId?: string | null;
  callerDedupeKey?: string | null;
}

/**
 * The only control-plane surface the standalone runner may call.
 *
 * Production Paperclip implements this port in a later integration phase. The
 * runner package never imports the server, UI, or database that sits behind it.
 */
export interface ControlPlanePort {
  openRun(input: OpenControlPlaneRunInput): Promise<void>;
  loadSessionCheckpoint?(): Promise<PersistedNativeSession | null>;
  checkpointSession?(
    snapshot: PersistedNativeSession,
    options?: CheckpointControlPlaneSessionOptions,
  ): Promise<void>;
  appendEvent(
    event: NativeRunEvent | PrpEvent,
    options?: AppendControlPlaneEventOptions,
  ): Promise<AppendedEventReceipt>;
  replayEvents(
    input: ReplayControlPlaneEventsInput,
    options?: FinalizeControlPlaneOperationOptions,
  ): Promise<ReplayedControlPlaneEvents>;
  completeRun(
    result: NativeRunResult | CompleteControlPlaneRunInput,
    options?: FinalizeControlPlaneOperationOptions,
  ): Promise<void>;
}
