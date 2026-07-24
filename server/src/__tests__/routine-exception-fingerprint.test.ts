import { describe, expect, it, vi } from "vitest";
import {
  createRoutineExceptionEvaluatorRegistry,
  createRoutineExceptionFingerprint,
} from "../services/routine-exception-evaluation.ts";

describe("routine exception fingerprints", () => {
  it("uses only evaluator, contract, root-cause code, and affected resource", () => {
    const common = {
      evaluatorId: "pol.runtime-source-of-truth.v1",
      evaluatorContractVersion: "pol.runtime-source-of-truth.v1",
      affectedResource: "paper-runtime",
    };
    const first = createRoutineExceptionFingerprint({
      ...common,
      rootCauseCode: "HEARTBEAT_STALE",
    });
    const retry = createRoutineExceptionFingerprint({
      ...common,
      rootCauseCode: "HEARTBEAT_STALE",
    });

    expect(retry).toBe(first);
  });

  it("keeps distinct critical root causes separate", () => {
    const common = {
      evaluatorId: "pol.runtime-source-of-truth.v1",
      evaluatorContractVersion: "pol.runtime-source-of-truth.v1",
      affectedResource: "paper-runtime",
    };

    expect(createRoutineExceptionFingerprint({ ...common, rootCauseCode: "HEARTBEAT_STALE" }))
      .not.toBe(createRoutineExceptionFingerprint({ ...common, rootCauseCode: "BOOT_COMMIT_MISMATCH" }));
  });
});

describe("routine exception evaluator registry", () => {
  const routineId = "11111111-1111-4111-8111-111111111111";
  const revisionId = "22222222-2222-4222-8222-222222222222";
  const companyId = "33333333-3333-4333-8333-333333333333";

  function input(overrides: Record<string, unknown> = {}) {
    return {
      schemaVersion: 1,
      run: {
        id: "44444444-4444-4444-8444-444444444444",
        companyId,
        routineId,
        routineRevisionId: revisionId,
        triggerId: null,
        source: "api",
        triggeredAt: "2026-07-24T00:00:00.000Z",
        idempotencyKey: null,
      },
      binding: {
        enabled: true,
        companyId,
        routineId,
        routineRevisionId: revisionId,
        evaluatorId: "pol.runtime-source-of-truth.v1",
        evaluatorContractVersion: "pol.runtime-source-of-truth.v1",
        inputSchemaVersion: 1,
        typedConfig: {},
        allowedCapabilityIds: [
          "service-config.read:pol-runtime-binding",
          "http.get:pol-runtime",
          "sqlite.readonly:pol-runtime-db",
          "process.exec:runtime-watchdog-classifier",
        ],
      },
      triggerPayload: null,
      openExceptions: [],
      ...overrides,
    };
  }

  it("rejects changed routine revisions before invoking a capability", async () => {
    let calls = 0;
    const registry = createRoutineExceptionEvaluatorRegistry({
      capabilityBroker: { invoke: async () => { calls += 1; return {}; } },
    });
    const value = input();
    value.binding.routineRevisionId = "55555555-5555-4555-8555-555555555555";

    await expect(registry.evaluate(value)).rejects.toThrow("ROUTINE_REVISION_MISMATCH");
    expect(calls).toBe(0);
  });

  it("fails closed when a registered evaluator requests an undeclared capability", async () => {
    const registry = createRoutineExceptionEvaluatorRegistry({
      capabilityBroker: { invoke: async () => ({}) },
    });
    const value = input();
    value.binding.allowedCapabilityIds = ["service-config.read:pol-runtime-binding"];

    const evaluation = await registry.evaluate(value);
    expect(evaluation.result).toMatchObject({
      outcome: "UNVERIFIABLE",
      rootCauseCode: "CAPABILITY_DENIED",
    });
  });

  it("rejects routine-authored module, command, and URL configuration", async () => {
    const registry = createRoutineExceptionEvaluatorRegistry({
      capabilityBroker: { invoke: async () => ({}) },
    });
    for (const typedConfig of [
      { module: "./dynamic-evaluator.js" },
      { command: "powershell.exe" },
      { url: "https://example.test/evaluate" },
    ]) {
      const value = input();
      value.binding.typedConfig = typedConfig;
      await expect(registry.evaluate(value)).rejects.toThrow("EVALUATOR_CONFIG_INVALID");
    }
  });

  it("accepts a strict PASS result and records non-forgeable provenance", async () => {
    const registry = createRoutineExceptionEvaluatorRegistry({
      serverCommit: "abc123",
      capabilityBroker: {
        invoke: async (capabilityId) => capabilityId === "process.exec:runtime-watchdog-classifier"
          ? {
              schemaVersion: 1,
              outcome: "PASS",
              severity: null,
              rootCauseCode: null,
              affectedResource: "pol-runtime:fixture",
              summary: "All deterministic checks passed",
              evidence: [{
                key: "runtime",
                source: "fixture",
                observedAt: "2026-07-24T00:00:00.000Z",
                valueDigest: "a".repeat(64),
              }],
              recoveredFingerprints: [],
              closureCandidates: [],
              retryClass: "NONE",
            }
          : {},
      },
    });

    const evaluation = await registry.evaluate(input());
    expect(evaluation.result.outcome).toBe("PASS");
    expect(evaluation.provenance).toMatchObject({
      evaluatorId: "pol.runtime-source-of-truth.v1",
      serverCommit: "abc123",
      attemptCount: 1,
    });
    expect(evaluation.provenance.capabilityIdsUsed).toHaveLength(4);
  });

  it("turns malformed output and evaluator crashes into stable UNVERIFIABLE results", async () => {
    const malformed = createRoutineExceptionEvaluatorRegistry({
      capabilityBroker: {
        invoke: async (capabilityId) =>
          capabilityId === "process.exec:runtime-watchdog-classifier" ? { outcome: "PASS" } : {},
      },
    });
    expect((await malformed.evaluate(input())).result.rootCauseCode).toBe("RESULT_SCHEMA_INVALID");

    const crashed = createRoutineExceptionEvaluatorRegistry({
      capabilityBroker: {
        invoke: async (capabilityId) => {
          if (capabilityId === "process.exec:runtime-watchdog-classifier") throw new Error("classifier crashed");
          return {};
        },
      },
    });
    expect((await crashed.evaluate(input())).result.rootCauseCode).toBe("EVALUATOR_CRASH");
  });

  it("retries only a declared transient read once", async () => {
    let classifierCalls = 0;
    const registry = createRoutineExceptionEvaluatorRegistry({
      capabilityBroker: {
        invoke: async (capabilityId) => {
          if (capabilityId !== "process.exec:runtime-watchdog-classifier") return {};
          classifierCalls += 1;
          if (classifierCalls === 1) {
            return {
              schemaVersion: 1,
              outcome: "UNVERIFIABLE",
              severity: "high",
              rootCauseCode: "TRANSIENT_RUNTIME_READ",
              affectedResource: "pol-runtime:fixture",
              summary: "retryable read",
              evidence: [],
              recoveredFingerprints: [],
              closureCandidates: [],
              retryClass: "TRANSIENT_READ",
            };
          }
          return {
            schemaVersion: 1,
            outcome: "PASS",
            severity: null,
            rootCauseCode: null,
            affectedResource: "pol-runtime:fixture",
            summary: "recovered read",
            evidence: [{
              key: "runtime",
              source: "fixture",
              observedAt: "2026-07-24T00:00:00.000Z",
              valueDigest: "e".repeat(64),
            }],
            recoveredFingerprints: [],
            closureCandidates: [],
            retryClass: "NONE",
          };
        },
      },
    });

    const evaluation = await registry.evaluate(input());
    expect(evaluation.result.outcome).toBe("PASS");
    expect(evaluation.provenance.attemptCount).toBe(2);
    expect(classifierCalls).toBe(2);
  });

  it("aborts a timed-out evaluator and fails closed", async () => {
    vi.useFakeTimers();
    try {
      const registry = createRoutineExceptionEvaluatorRegistry({
        capabilityBroker: {
          invoke: async () => new Promise(() => {}),
        },
      });
      const pending = registry.evaluate(input());
      await vi.advanceTimersByTimeAsync(40_001);
      expect((await pending).result.rootCauseCode).toBe("EVALUATOR_TIMEOUT");
    } finally {
      vi.useRealTimers();
    }
  });
});
