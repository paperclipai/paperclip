export const PHASE3_FAULTS = [
  "none",
  "socket-drop",
  "lost-ack",
  "duplicate-command",
  "runner-restart",
  "harness-restart",
  "malformed-input",
  "lease-expiry",
  "storage-pressure",
  "drain",
  "revoke",
] as const;

export type Phase3Fault = (typeof PHASE3_FAULTS)[number];

export interface Phase3Identity {
  runnerInstanceId: string;
  environmentLeaseId: string;
  runId: string;
  normalizedSessionId: string;
  turnId: string;
  itemId: string;
}

export interface Phase3StoredEvent {
  sourceSeq: number;
  sourceEventId: string;
  priority: 0 | 1 | 2;
  eventType: string;
  itemId?: string;
  envelope: Record<string, unknown>;
  byteSize: number;
}

export interface Phase3ProcessedCommand {
  commandId: string;
  controllerSeq: number;
  commandDigest: string;
  status: "completed" | "failed" | "rejected";
  logicalEffectCount: number;
  result: Record<string, unknown>;
}

export interface Phase3RunnerState extends Phase3Identity {
  schema: "paperclip.runner.phase3.state.v1";
  lifecycle:
    | "connecting"
    | "ready"
    | "terminal"
    | "backpressure"
    | "draining"
    | "revoked"
    | "stopped"
    | "recoverable_failure"
    | "unrecoverable";
  nextSourceSeq: number;
  ackedSourceSeq: number;
  lastControllerCommandSeq: number;
  reconnectCount: number;
  maxOutboxBytes: number;
  peakOutboxBytes: number;
  outbox: Phase3StoredEvent[];
  processedCommands: Record<string, Phase3ProcessedCommand>;
  compactedCommandFilter: string;
  compactedCommandCount: number;
  diagnostics: string[];
  backpressure: boolean;
  recoverableFailure: string | null;
  unrecoverableOutcome: string | null;
  harnessGeneration: number;
  stopAfterFlush: boolean;
}

export interface Phase3CoreCommand {
  schema: "paperclip.prp.command.v1";
  commandId: string;
  controllerSeq: number;
  type: string;
  issuedAt: string;
  payload: Record<string, unknown>;
  status: "pending" | "completed" | "failed" | "rejected";
  result: Record<string, unknown> | null;
}

export interface Phase3CommittedEvent {
  sourceSeq: number;
  sourceEventId: string;
  eventType: string;
  priority: 0 | 1 | 2;
  envelope: Record<string, unknown>;
  deliveryCount: number;
  logicalEffectCount: number;
}

export interface Phase3Diagnostics {
  schema: "paperclip.runner.phase3.diagnostics.v1";
  fault: Phase3Fault;
  connection: {
    state: string;
    connectionCount: number;
    reconnectCount: number;
    leaseId: string | null;
    leaseExpiresAt: string | null;
  };
  identity: Phase3Identity;
  cursors: {
    runnerAckedSourceSeq: number;
    runnerNextSourceSeq: number;
    coreAckedSourceSeq: number;
    highestCommittedSourceSeq: number;
  };
  outbox: {
    events: number;
    bytes: number;
    peakBytes: number;
    maxBytes: number;
    backpressure: boolean;
    p0Committed: number;
    p0Lost: number;
  };
  commands: {
    issued: number;
    completed: number;
    rejected: number;
    logicalEffects: number;
    duplicateDeliveries: number;
  };
  recovery: {
    replayDeliveries: number;
    runnerRestarts: number;
    harnessRestarts: number;
    malformedFrames: number;
    freshBootstraps: number;
    outcome: "recovered" | "drained" | "revoked" | "unrecoverable";
    reason: string;
  };
  security: {
    bootstrapTicketPersisted: boolean;
    connectionLeaseTokenPersisted: boolean;
    secretLeakCount: number;
  };
  committedEvents: Phase3CommittedEvent[];
}

export interface Phase3RunTrace {
  schema: "paperclip.runner.phase3.trace.v1";
  diagnostics: Phase3Diagnostics;
  runnerState: Phase3RunnerState;
  commands: Phase3CoreCommand[];
  assertions: {
    stableIdentity: boolean;
    sourceCursorContinuous: boolean;
    oneLogicalEffectPerAcceptedCommand: boolean;
    noDuplicateLogicalEvents: boolean;
    p0Preserved: boolean;
    boundedStorage: boolean;
    secretsRedacted: boolean;
  };
}
