export const DURABLE_RECOVERY_FAULTS = [
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

export type DurableRecoveryFault = (typeof DURABLE_RECOVERY_FAULTS)[number];

export interface DurableRecoveryIdentity {
  runnerInstanceId: string;
  environmentLeaseId: string;
  runId: string;
  normalizedSessionId: string;
  turnId: string;
  itemId: string;
}

export interface DurableRecoveryStoredEvent {
  sourceSeq: number;
  sourceEventId: string;
  priority: 0 | 1 | 2;
  eventType: string;
  itemId?: string;
  envelope: Record<string, unknown>;
  byteSize: number;
}

export interface DurableRecoveryProcessedCommand {
  commandId: string;
  controllerSeq: number;
  commandDigest: string;
  status: "completed" | "failed" | "rejected";
  logicalEffectCount: number;
  result: Record<string, unknown>;
}

export interface DurableRecoveryRunnerState extends DurableRecoveryIdentity {
  schema: "paperclip.runner.durable.state.v1";
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
  outbox: DurableRecoveryStoredEvent[];
  processedCommands: Record<string, DurableRecoveryProcessedCommand>;
  compactedCommandFilter: string;
  compactedCommandCount: number;
  diagnostics: string[];
  backpressure: boolean;
  recoverableFailure: string | null;
  unrecoverableOutcome: string | null;
  harnessGeneration: number;
  stopAfterFlush: boolean;
}

export interface DurableRecoveryCoreCommand {
  schema: "paperclip.prp.command.v1";
  commandId: string;
  controllerSeq: number;
  type: string;
  issuedAt: string;
  payload: Record<string, unknown>;
  status: "pending" | "completed" | "failed" | "rejected";
  result: Record<string, unknown> | null;
}

export interface DurableRecoveryCommittedEvent {
  sourceSeq: number;
  sourceEventId: string;
  eventType: string;
  priority: 0 | 1 | 2;
  envelope: Record<string, unknown>;
  deliveryCount: number;
  logicalEffectCount: number;
}

export interface DurableRecoveryDiagnostics {
  schema: "paperclip.runner.durable.diagnostics.v1";
  fault: DurableRecoveryFault;
  connection: {
    state: string;
    connectionCount: number;
    reconnectCount: number;
    leaseId: string | null;
    leaseExpiresAt: string | null;
  };
  identity: DurableRecoveryIdentity;
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
  committedEvents: DurableRecoveryCommittedEvent[];
}

export interface DurableRecoveryRunTrace {
  schema: "paperclip.runner.durable.trace.v1";
  diagnostics: DurableRecoveryDiagnostics;
  runnerState: DurableRecoveryRunnerState;
  commands: DurableRecoveryCoreCommand[];
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
