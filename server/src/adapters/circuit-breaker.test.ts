import { describe, expect, it } from "vitest";
import {
  advancePastReTripGrace,
  advanceToHalfOpen,
  buildCircuitKey,
  getCircuitExecutionDecision,
  getCircuitState,
  getEffectiveThreshold,
  recordCircuitExecutionFailure,
  recordCircuitExecutionSuccess,
  resetAllCircuits,
} from "./circuit-breaker.js";

describe("circuit-breaker", () => {
  it("trips from Closed to Open after the threshold is reached within the failure window", () => {
    resetAllCircuits();
    const adapterConfig = { command: "missing-binary" };
    const first = getCircuitExecutionDecision({ adapterType: "process", adapterConfig });

    expect(first.action).toBe("execute");
    expect(first.key).toBeTruthy();

    recordCircuitExecutionFailure({
      key: first.key,
      adapterType: "process",
      adapterConfig,
      adapterFailureReason: "adapter_missing_command",
      now: new Date("2026-01-01T00:00:00.000Z"),
    });
    recordCircuitExecutionFailure({
      key: first.key,
      adapterType: "process",
      adapterConfig,
      adapterFailureReason: "adapter_missing_command",
      now: new Date("2026-01-01T00:00:01.000Z"),
    });
    const state = recordCircuitExecutionFailure({
      key: first.key,
      adapterType: "process",
      adapterConfig,
      adapterFailureReason: "adapter_missing_command",
      now: new Date("2026-01-01T00:00:02.000Z"),
    });

    expect(state?.state).toBe("Open");
    expect(
      getCircuitExecutionDecision({
        adapterType: "process",
        adapterConfig,
        now: new Date("2026-01-01T00:00:03.000Z"),
      }).action,
    ).toBe("defer");
  });

  it("moves from Open to Half-Open and then back to Closed on a successful probe", () => {
    resetAllCircuits();
    const adapterConfig = { command: "missing-binary" };
    const key = buildCircuitKey({ adapterType: "process", adapterConfig });

    for (let i = 0; i < 3; i += 1) {
      recordCircuitExecutionFailure({
        key,
        adapterType: "process",
        adapterConfig,
        adapterFailureReason: "adapter_missing_command",
        now: new Date(`2026-01-01T00:00:0${i}.000Z`),
      });
    }

    advanceToHalfOpen(key);
    expect(
      getCircuitExecutionDecision({
        adapterType: "process",
        adapterConfig,
        now: new Date("2026-01-01T00:05:03.000Z"),
      }).action,
    ).toBe("probe");

    const closed = recordCircuitExecutionSuccess({
      key,
      adapterType: "process",
      adapterConfig,
      probe: true,
      now: new Date("2026-01-01T00:05:04.000Z"),
    });

    expect(closed?.state).toBe("Closed");
  });

  it("re-opens immediately when a Half-Open probe fails with adapter_probe_timeout", () => {
    resetAllCircuits();
    const adapterConfig = { url: "http://localhost:3100" };
    const key = buildCircuitKey({ adapterType: "http", adapterConfig });

    for (let i = 0; i < 3; i += 1) {
      recordCircuitExecutionFailure({
        key,
        adapterType: "http",
        adapterConfig,
        adapterFailureReason: "adapter_protocol_error",
        now: new Date(`2026-01-01T00:00:0${i}.000Z`),
      });
    }

    advanceToHalfOpen(key);
    const reopened = recordCircuitExecutionFailure({
      key,
      adapterType: "http",
      adapterConfig,
      adapterFailureReason: "adapter_probe_timeout",
      probe: true,
      now: new Date("2026-01-01T00:05:00.000Z"),
    });

    expect(reopened?.state).toBe("Open");
    expect(reopened?.lastFailureReason).toBe("adapter_probe_timeout");
  });

  it("uses config fingerprint keys for process/http adapters and module keys for shared adapters", () => {
    resetAllCircuits();

    const processKeyA = buildCircuitKey({
      adapterType: "process",
      adapterConfig: { command: "a" },
    });
    const processKeyB = buildCircuitKey({
      adapterType: "process",
      adapterConfig: { command: "b" },
    });
    const sharedKeyA = buildCircuitKey({
      adapterType: "claude_local",
      adapterConfig: { model: "sonnet" },
    });
    const sharedKeyB = buildCircuitKey({
      adapterType: "claude_local",
      adapterConfig: { model: "opus" },
    });

    expect(processKeyA).not.toBe(processKeyB);
    expect(sharedKeyA).toBe("claude_local:module");
    expect(sharedKeyA).toBe(sharedKeyB);
  });

  it("halves the threshold during the re-trip grace window and resets it after a stable Closed period", () => {
    resetAllCircuits();
    const adapterConfig = { command: "missing-binary" };
    const key = buildCircuitKey({ adapterType: "process", adapterConfig });

    expect(getEffectiveThreshold(key)).toBe(3);
    for (let i = 0; i < 3; i += 1) {
      recordCircuitExecutionFailure({
        key,
        adapterType: "process",
        adapterConfig,
        adapterFailureReason: "adapter_missing_command",
        now: new Date(`2026-01-01T00:00:0${i}.000Z`),
      });
    }

    advanceToHalfOpen(key);
    recordCircuitExecutionSuccess({
      key,
      adapterType: "process",
      adapterConfig,
      probe: true,
      now: new Date("2026-01-01T00:05:00.000Z"),
    });

    expect(getEffectiveThreshold(key, new Date("2026-01-01T00:05:01.000Z"))).toBe(2);
    advancePastReTripGrace(key);
    expect(getEffectiveThreshold(key)).toBe(3);
  });

  it("keeps the circuit Closed in shadow mode while still tracking breaker-counting failures", () => {
    resetAllCircuits();
    const adapterConfig = {
      command: "missing-binary",
      circuitBreaker: {
        shadowMode: true,
      },
    };
    const decision = getCircuitExecutionDecision({
      adapterType: "process",
      adapterConfig,
    });

    for (let i = 0; i < 3; i += 1) {
      recordCircuitExecutionFailure({
        key: decision.key,
        adapterType: "process",
        adapterConfig,
        adapterFailureReason: "adapter_missing_command",
        now: new Date(`2026-01-01T00:00:0${i}.000Z`),
      });
    }

    const state = getCircuitState(decision.key!);
    expect(state?.state).toBe("Closed");
    expect(state?.shadowMode).toBe(true);
  });
});
