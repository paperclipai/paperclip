import { createHash } from "node:crypto";
import {
  DARK_FACTORY_PROJECTION_SOURCE,
  DARK_FACTORY_TRUTH_SOURCE,
  PROJECTION_AUTHORITATIVE,
  PROJECTION_DISCLAIMER,
  RUNTIME_OBSERVATION_SOURCE,
  type BreakerState,
  type FailureClass,
  type MockJournalCursor,
  type MockProviderHealth,
  type MockRehydrateReceipt,
  type MockRunAttemptMetadata,
  type MockRuntimeProjection,
  type ProjectionStatus,
  type ProviderHealthState,
} from "./runtime-contract.js";

function stableHex(input: string, length = 12): string {
  return createHash("sha256").update(input).digest("hex").slice(0, length);
}

function stableInt(input: string, modulo: number): number {
  return Number.parseInt(stableHex(input, 8), 16) % modulo;
}

function isoFromOffset(input: string, minutesOffset = 0): string {
  const now = Math.floor(Date.now() / 1000) * 1000;
  const boundedMinutes = stableInt(input, 60) + minutesOffset;
  return new Date(now - boundedMinutes * 60_000).toISOString();
}

function issuePrefix(issueId: string): string {
  return issueId.replace(/[^a-zA-Z0-9-]/g, "").slice(0, 8).padEnd(8, "0");
}

function linkedRunIdFor(issueId: string): string {
  return `df-run-${issuePrefix(issueId)}`;
}

function projectionStatusFor(issueId: string): ProjectionStatus {
  const normalized = issueId.toLowerCase();
  if (normalized.includes("stale")) return "stale";
  if (normalized.includes("blocked")) return "blocked";
  if (normalized.includes("approval")) return "needs_approval";
  if (normalized.includes("degraded")) return "degraded";
  return (["current", "degraded", "blocked", "needs_approval"] as const)[stableInt(`${issueId}:status`, 4)];
}

function breakerFor(issueId: string): BreakerState {
  const normalized = issueId.toLowerCase();
  if (normalized.includes("open") || normalized.includes("blocked")) return "open";
  if (normalized.includes("half")) return "half_open";
  return (["closed", "half_open", "open"] as const)[stableInt(`${issueId}:breaker`, 3)];
}

function providerStateFor(issueId: string, breakerState: BreakerState): ProviderHealthState {
  const normalized = issueId.toLowerCase();
  if (normalized.includes("fallback")) return "fallback";
  if (breakerState === "open") return "blocked";
  if (breakerState === "half_open") return "degraded";
  return "available";
}

function failureClassFor(issueId: string): FailureClass {
  const normalized = issueId.toLowerCase();
  if (normalized.includes("fallback")) return "provider_unavailable";
  if (normalized.includes("blocked")) return "runtime_blocked";
  return (["none", "transient_provider", "provider_unavailable", "quota_exceeded", "runtime_blocked"] as const)[stableInt(`${issueId}:failure`, 5)];
}

function reasonsFor(status: ProjectionStatus): Pick<MockRuntimeProjection, "staleReason" | "degradedReason" | "blockedReason"> {
  return {
    staleReason: status === "stale" ? "journal_cursor_lag_detected" : null,
    degradedReason: status === "degraded" || status === "stale" ? "projection_lag_exceeds_mock_threshold" : null,
    blockedReason: status === "blocked" ? "provider_breaker_open_for_projection" : null,
  };
}

export function getMockJournalCursor(issueId: string): MockJournalCursor {
  const runId = linkedRunIdFor(issueId);
  const lastJournalSequenceNo = 100 + stableInt(`${issueId}:cursor`, 900);
  const journalRef = `dark-factory://journal/${runId}#${lastJournalSequenceNo}`;
  return {
    source: DARK_FACTORY_PROJECTION_SOURCE,
    truthSource: DARK_FACTORY_TRUTH_SOURCE,
    authoritative: PROJECTION_AUTHORITATIVE,
    cursorId: `df-cursor-${issuePrefix(issueId)}`,
    runId,
    journalCursor: journalRef,
    lastSequenceNo: lastJournalSequenceNo,
    lastJournalSequenceNo,
    journalRef,
    sourceJournalRef: journalRef,
    monotonic: true,
    gapDetected: false,
    cursorMonotonicity: {
      previousSequenceNo: Math.max(0, lastJournalSequenceNo - 1),
      currentSequenceNo: lastJournalSequenceNo,
      direction: "non_decreasing",
    },
  };
}

export function getMockProviderHealth(issueId: string): MockProviderHealth {
  const breakerState = breakerFor(issueId);
  const providerState = providerStateFor(issueId, breakerState);
  return {
    source: DARK_FACTORY_PROJECTION_SOURCE,
    truthSource: DARK_FACTORY_TRUTH_SOURCE,
    authoritative: PROJECTION_AUTHORITATIVE,
    observationSource: RUNTIME_OBSERVATION_SOURCE,
    providerRole: "primary_execution",
    modelRole: "execution_model",
    modelSelection: {
      policy: "role_based_runtime_selection",
      protocolMustSpecifyConcreteModel: false,
      configuredModelName: null,
    },
    providerState,
    breakerState,
    degraded: providerState === "degraded" || providerState === "fallback",
    blocked: providerState === "blocked",
    fallbackTriggered: providerState === "fallback",
    degradedReason: providerState === "degraded" ? "mock_half_open_probe_required" : providerState === "fallback" ? "mock_fallback_policy_triggered" : null,
    blockedReason: providerState === "blocked" ? "mock_provider_breaker_open" : null,
    fallbackReason: providerState === "fallback" ? "mock_primary_provider_unavailable" : null,
    lastUpdatedAt: isoFromOffset(`${issueId}:health`, 3),
    lastSuccessAt: breakerState === "open" ? null : isoFromOffset(`${issueId}:success`, -20),
    lastFailureAt: breakerState === "closed" ? null : isoFromOffset(`${issueId}:failure`, -7),
    openReason: breakerState === "open" ? "mock_provider_timeout_threshold" : null,
    cooldownUntil: breakerState === "open" ? isoFromOffset(`${issueId}:cooldown`, -30) : null,
  };
}

export function getMockRuntimeProjection(issueId: string): MockRuntimeProjection {
  const status = projectionStatusFor(issueId);
  const cursor = getMockJournalCursor(issueId);
  const health = getMockProviderHealth(issueId);
  const linkedRunId = cursor.runId;
  const callbackReceiptId = `df-callback-${issuePrefix(issueId)}-${cursor.lastSequenceNo}`;
  const reasons = reasonsFor(status);
  return {
    source: DARK_FACTORY_PROJECTION_SOURCE,
    truthSource: DARK_FACTORY_TRUTH_SOURCE,
    authoritative: PROJECTION_AUTHORITATIVE,
    disclaimer: PROJECTION_DISCLAIMER,
    issueId,
    runId: linkedRunId,
    linkedRunId,
    journalCursor: cursor.journalCursor,
    journalCursorMetadata: cursor,
    lastSequenceNo: cursor.lastSequenceNo,
    projectionStatus: status,
    callbackReceiptId,
    ...reasons,
    fallbackTriggered: health.fallbackTriggered,
    terminalStateAdvanced: false,
    projectionId: `df-projection-${issuePrefix(issueId)}`,
    sourceJournalRef: cursor.sourceJournalRef,
    projectionJson: {
      issueId,
      runId: linkedRunId,
      cursor: cursor.journalCursor,
      status,
    },
    callbackReceipt: {
      receiptId: callbackReceiptId,
      status: "observed",
      terminalStateAdvanced: false,
      idempotencyKey: `${linkedRunId}:${cursor.lastSequenceNo}`,
    },
    flags: {
      degraded: status === "degraded" || status === "stale",
      blocked: status === "blocked",
      needsApproval: status === "needs_approval",
      stale: status === "stale",
    },
    lastUpdatedAt: isoFromOffset(issueId),
  };
}

export function getMockRunAttemptMetadata(issueId: string): MockRunAttemptMetadata {
  const health = getMockProviderHealth(issueId);
  const failureClass = failureClassFor(issueId);
  return {
    source: DARK_FACTORY_PROJECTION_SOURCE,
    truthSource: DARK_FACTORY_TRUTH_SOURCE,
    authoritative: PROJECTION_AUTHORITATIVE,
    providerRole: "primary_execution",
    modelRole: "execution_model",
    failureClass,
    retryable: failureClass === "transient_provider" || failureClass === "provider_unavailable" || failureClass === "quota_exceeded",
    fallbackTriggered: health.fallbackTriggered || failureClass === "provider_unavailable",
    terminalStateAdvanced: false,
    attemptIndex: 1 + stableInt(`${issueId}:attempt`, 3),
    circuitBreakerState: health.breakerState,
    degradedMode: health.degraded,
  };
}

export function createMockRehydrateRequest(
  issueId: string,
  input: { reason?: string | null; idempotencyKey?: string | null } = {},
): MockRehydrateReceipt {
  const projection = getMockRuntimeProjection(issueId);
  const idempotencyKey = input.idempotencyKey?.trim() || `${projection.runId}:rehydrate-request`;
  const receiptId = `df-rehydrate-${stableHex(`${issueId}:${idempotencyKey}`, 16)}`;
  return {
    source: DARK_FACTORY_PROJECTION_SOURCE,
    truthSource: DARK_FACTORY_TRUTH_SOURCE,
    authoritative: PROJECTION_AUTHORITATIVE,
    disclaimer: PROJECTION_DISCLAIMER,
    issueId,
    runId: projection.runId,
    linkedRunId: projection.linkedRunId,
    journalCursor: projection.journalCursorMetadata,
    lastSequenceNo: projection.lastSequenceNo,
    projectionStatus: projection.projectionStatus,
    callbackReceiptId: receiptId,
    staleReason: projection.staleReason,
    degradedReason: projection.degradedReason,
    blockedReason: projection.blockedReason,
    requestedAt: isoFromOffset(`${issueId}:rehydrate`, 5),
    requestSemantics: "receipt_only_not_terminal_success",
    requestKind: "rehydrate_projection",
    terminalStateAdvanced: false,
    doesClaimTerminalSuccess: false,
    receipt: {
      receiptId,
      status: "requested",
      terminalStateAdvanced: false,
      idempotencyKey,
      reason: input.reason?.trim() || "operator_requested_projection_refresh",
    },
  };
}
