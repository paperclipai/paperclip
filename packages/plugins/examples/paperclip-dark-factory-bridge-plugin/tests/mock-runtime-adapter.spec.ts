import { describe, expect, it } from "vitest";
import {
  DARK_FACTORY_PROJECTION_SOURCE,
  DARK_FACTORY_TRUTH_SOURCE,
  PROJECTION_AUTHORITATIVE,
  RUNTIME_OBSERVATION_SOURCE,
  parseRuntimeContractSnapshot,
} from "../src/runtime-contract.js";
import {
  createMockRehydrateRequest,
  getMockJournalCursor,
  getMockProviderHealth,
  getMockRunAttemptMetadata,
  getMockRuntimeProjection,
} from "../src/mock-runtime-adapter.js";

describe("Dark Factory deterministic mock runtime adapter", () => {
  it("exports a stable runtime contract snapshot", () => {
    const snapshot = parseRuntimeContractSnapshot({
      source: DARK_FACTORY_PROJECTION_SOURCE,
      authoritative: PROJECTION_AUTHORITATIVE,
      truthSource: DARK_FACTORY_TRUTH_SOURCE,
      observationSource: RUNTIME_OBSERVATION_SOURCE,
    });

    expect(snapshot).toEqual({
      source: "dark-factory-projection",
      authoritative: false,
      truthSource: "dark-factory-journal",
      observationSource: "runtime_observation",
    });
  });

  it("returns deterministic provider health with projection-only truth boundaries", () => {
    const issueId = "issue-provider-open";
    const first = getMockProviderHealth(issueId);
    const second = getMockProviderHealth(issueId);

    expect(second).toEqual(first);
    expect(first).toMatchObject({
      source: "dark-factory-projection",
      authoritative: false,
      truthSource: "dark-factory-journal",
      observationSource: "runtime_observation",
      providerRole: "primary_execution",
      modelRole: "execution_model",
      modelSelection: {
        policy: "role_based_runtime_selection",
        protocolMustSpecifyConcreteModel: false,
        configuredModelName: null,
      },
    });
    expect(["available", "degraded", "blocked", "fallback"]).toContain(first.providerState);
    expect(["closed", "open", "half_open"]).toContain(first.breakerState);
    expect(first.fallbackTriggered).toBe(first.providerState === "fallback");
  });

  it("returns deterministic run projection metadata without claiming authority", () => {
    const projection = getMockRuntimeProjection("stale-blocked-issue");

    expect(projection).toMatchObject({
      source: "dark-factory-projection",
      authoritative: false,
      truthSource: "dark-factory-journal",
      issueId: "stale-blocked-issue",
      linkedRunId: "df-run-stale-bl",
      projectionStatus: "stale",
      staleReason: "journal_cursor_lag_detected",
      terminalStateAdvanced: false,
    });
    expect(projection.journalCursor).toMatch(/^dark-factory:\/\/journal\/df-run-stale-bl#/);
    expect(projection.lastSequenceNo).toBeGreaterThanOrEqual(100);
    expect(projection.callbackReceiptId).toMatch(/^df-callback-stale-bl-/);
    expect(projection.fallbackTriggered).toBeTypeOf("boolean");
  });

  it("returns bounded run-attempt metadata and never advances terminal state", () => {
    const attempt = getMockRunAttemptMetadata("issue-attempt-fallback");

    expect(attempt).toMatchObject({
      source: "dark-factory-projection",
      authoritative: false,
      truthSource: "dark-factory-journal",
      providerRole: "primary_execution",
      modelRole: "execution_model",
      terminalStateAdvanced: false,
    });
    expect(["none", "transient_provider", "provider_unavailable", "quota_exceeded", "runtime_blocked"]).toContain(attempt.failureClass);
    expect(attempt.retryable).toBeTypeOf("boolean");
    expect(attempt.fallbackTriggered).toBeTypeOf("boolean");
  });

  it("keeps journal cursor monotonicity metadata and Dark Factory Journal truth source", () => {
    const cursor = getMockJournalCursor("issue-cursor-monotonic");
    const repeated = getMockJournalCursor("issue-cursor-monotonic");

    expect(repeated).toEqual(cursor);
    expect(cursor).toMatchObject({
      source: "dark-factory-projection",
      authoritative: false,
      truthSource: "dark-factory-journal",
      monotonic: true,
      gapDetected: false,
    });
    expect(cursor.lastSequenceNo).toBe(cursor.lastJournalSequenceNo);
    expect(cursor.sourceJournalRef).toBe(cursor.journalCursor);
  });

  it("creates deterministic rehydrate receipts as request/intention only", () => {
    const input = { reason: "operator replay", idempotencyKey: "same-key" };
    const first = createMockRehydrateRequest("issue-rehydrate", input);
    const second = createMockRehydrateRequest("issue-rehydrate", input);
    const different = createMockRehydrateRequest("issue-rehydrate", { ...input, idempotencyKey: "other-key" });

    expect(second).toEqual(first);
    expect(different.receipt.receiptId).not.toEqual(first.receipt.receiptId);
    expect(first).toMatchObject({
      source: "dark-factory-projection",
      authoritative: false,
      truthSource: "dark-factory-journal",
      requestSemantics: "receipt_only_not_terminal_success",
      requestKind: "rehydrate_projection",
      terminalStateAdvanced: false,
      doesClaimTerminalSuccess: false,
      receipt: {
        status: "requested",
        terminalStateAdvanced: false,
        idempotencyKey: "same-key",
        reason: "operator replay",
      },
    });
  });
});
