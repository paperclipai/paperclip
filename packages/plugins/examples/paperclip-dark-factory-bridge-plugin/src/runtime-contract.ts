export const DARK_FACTORY_PROJECTION_SOURCE = "dark-factory-projection" as const;
export const DARK_FACTORY_TRUTH_SOURCE = "dark-factory-journal" as const;
export const RUNTIME_OBSERVATION_SOURCE = "runtime_observation" as const;
export const PROJECTION_AUTHORITATIVE = false as const;
export const PROJECTION_DISCLAIMER = "Projection only — Dark Factory Journal remains truth source" as const;

export type ProjectionStatus = "current" | "degraded" | "blocked" | "needs_approval" | "stale";
export type ProviderHealthState = "available" | "degraded" | "blocked" | "fallback";
export type BreakerState = "closed" | "open" | "half_open";
export type FailureClass = "none" | "transient_provider" | "provider_unavailable" | "quota_exceeded" | "runtime_blocked";

export type RuntimeContractSnapshot = {
  source: typeof DARK_FACTORY_PROJECTION_SOURCE;
  authoritative: typeof PROJECTION_AUTHORITATIVE;
  truthSource: typeof DARK_FACTORY_TRUTH_SOURCE;
  observationSource: typeof RUNTIME_OBSERVATION_SOURCE;
};

export type ProjectionBoundary = {
  source: typeof DARK_FACTORY_PROJECTION_SOURCE;
  authoritative: typeof PROJECTION_AUTHORITATIVE;
  truthSource: typeof DARK_FACTORY_TRUTH_SOURCE;
};

export type MockJournalCursor = ProjectionBoundary & {
  cursorId: string;
  runId: string;
  journalCursor: string;
  lastSequenceNo: number;
  lastJournalSequenceNo: number;
  journalRef: string;
  sourceJournalRef: string;
  monotonic: true;
  gapDetected: boolean;
  cursorMonotonicity: {
    previousSequenceNo: number;
    currentSequenceNo: number;
    direction: "non_decreasing";
  };
};

export type MockRuntimeProjection = ProjectionBoundary & {
  disclaimer: typeof PROJECTION_DISCLAIMER;
  issueId: string;
  runId: string;
  linkedRunId: string;
  journalCursor: string;
  journalCursorMetadata: MockJournalCursor;
  lastSequenceNo: number;
  projectionStatus: ProjectionStatus;
  callbackReceiptId: string;
  staleReason: string | null;
  degradedReason: string | null;
  blockedReason: string | null;
  fallbackTriggered: boolean;
  terminalStateAdvanced: false;
  projectionId: string;
  sourceJournalRef: string;
  projectionJson: {
    issueId: string;
    runId: string;
    cursor: string;
    status: ProjectionStatus;
  };
  callbackReceipt: {
    receiptId: string;
    status: "observed";
    terminalStateAdvanced: false;
    idempotencyKey: string;
  };
  flags: {
    degraded: boolean;
    blocked: boolean;
    needsApproval: boolean;
    stale: boolean;
  };
  lastUpdatedAt: string;
};

export type MockProviderHealth = ProjectionBoundary & {
  observationSource: typeof RUNTIME_OBSERVATION_SOURCE;
  providerRole: "primary_execution";
  modelRole: "execution_model";
  modelSelection: {
    policy: "role_based_runtime_selection";
    protocolMustSpecifyConcreteModel: false;
    configuredModelName: null;
  };
  providerState: ProviderHealthState;
  breakerState: BreakerState;
  degraded: boolean;
  blocked: boolean;
  fallbackTriggered: boolean;
  degradedReason: string | null;
  blockedReason: string | null;
  fallbackReason: string | null;
  lastUpdatedAt: string;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  openReason: string | null;
  cooldownUntil: string | null;
};

export type MockRunAttemptMetadata = ProjectionBoundary & {
  providerRole: "primary_execution";
  modelRole: "execution_model";
  failureClass: FailureClass;
  retryable: boolean;
  fallbackTriggered: boolean;
  terminalStateAdvanced: false;
  attemptIndex: number;
  circuitBreakerState: BreakerState;
  degradedMode: boolean;
};

export type MockRehydrateReceipt = ProjectionBoundary & {
  disclaimer: typeof PROJECTION_DISCLAIMER;
  issueId: string;
  runId: string;
  linkedRunId: string;
  journalCursor: MockJournalCursor;
  lastSequenceNo: number;
  projectionStatus: ProjectionStatus;
  callbackReceiptId: string;
  staleReason: string | null;
  degradedReason: string | null;
  blockedReason: string | null;
  requestedAt: string;
  requestSemantics: "receipt_only_not_terminal_success";
  requestKind: "rehydrate_projection";
  terminalStateAdvanced: false;
  doesClaimTerminalSuccess: false;
  receipt: {
    receiptId: string;
    status: "requested";
    terminalStateAdvanced: false;
    idempotencyKey: string;
    reason: string;
  };
};

export function parseRuntimeContractSnapshot(value: unknown): RuntimeContractSnapshot {
  if (!value || typeof value !== "object") {
    throw new Error("runtime contract snapshot must be an object");
  }
  const candidate = value as Partial<RuntimeContractSnapshot>;
  if (candidate.source !== DARK_FACTORY_PROJECTION_SOURCE) throw new Error("invalid projection source");
  if (candidate.authoritative !== PROJECTION_AUTHORITATIVE) throw new Error("runtime projection must not be authoritative");
  if (candidate.truthSource !== DARK_FACTORY_TRUTH_SOURCE) throw new Error("invalid truth source");
  if (candidate.observationSource !== RUNTIME_OBSERVATION_SOURCE) throw new Error("invalid observation source");
  return {
    source: DARK_FACTORY_PROJECTION_SOURCE,
    authoritative: PROJECTION_AUTHORITATIVE,
    truthSource: DARK_FACTORY_TRUTH_SOURCE,
    observationSource: RUNTIME_OBSERVATION_SOURCE,
  };
}
