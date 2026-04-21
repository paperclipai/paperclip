import { describe, expect, it } from "vitest";
import {
  ADAPTER_FAILURE_REASONS,
  classifyAdapterFailure,
} from "./adapter-failure-reasons.js";

describe("classifyAdapterFailure", () => {
  it("classifies the CLI-66 fault shape as adapter_missing_command", () => {
    const result = classifyAdapterFailure(
      new Error("Process adapter missing command"),
      "copilot_local",
    );

    expect(result.adapterFailureReason).toBe("adapter_missing_command");
    expect(result.countsTowardBreaker).toBe(true);
    // Operator/UI surface is preserved — do not regress claude_auth_required
    // style CTAs for unrelated fault categories.
    expect(result.surfaceErrorCode).toBe("adapter_failed");
  });

  it("classifies missing HTTP url as adapter_missing_url", () => {
    const result = classifyAdapterFailure(
      new Error("HTTP adapter missing url"),
      "http",
    );
    expect(result.adapterFailureReason).toBe("adapter_missing_url");
    expect(result.countsTowardBreaker).toBe(true);
  });

  it("classifies probe timeouts as adapter_probe_timeout", () => {
    const err = Object.assign(new Error("The operation was aborted."), {
      name: "AbortError",
    });
    const result = classifyAdapterFailure(err, "http");
    expect(result.adapterFailureReason).toBe("adapter_probe_timeout");
    expect(result.countsTowardBreaker).toBe(true);
  });

  it("classifies HTTP status errors as adapter_http_error", () => {
    const result = classifyAdapterFailure(
      new Error("HTTP invoke failed with status 502"),
      "http",
    );
    expect(result.adapterFailureReason).toBe("adapter_http_error");
    expect(result.countsTowardBreaker).toBe(true);
  });

  it("classifies ENOENT spawn failures as adapter_spawn_failed", () => {
    const err = Object.assign(new Error("spawn copilot ENOENT"), {
      code: "ENOENT",
    });
    const result = classifyAdapterFailure(err, "copilot_local");
    expect(result.adapterFailureReason).toBe("adapter_spawn_failed");
    expect(result.countsTowardBreaker).toBe(true);
  });

  it("classifies claude-style auth errors with auth surface code", () => {
    const result = classifyAdapterFailure(
      new Error("Claude credentials not found, please run claude login"),
      "claude_local",
    );
    expect(result.adapterFailureReason).toBe("adapter_auth_failed");
    // UI CTA at ui/src/pages/AgentDetail.tsx keys off claude_auth_required —
    // classification MUST preserve that surface.
    expect(result.surfaceErrorCode).toBe("claude_auth_required");
    expect(result.countsTowardBreaker).toBe(true);
  });

  it("falls back to adapter_unknown_error for opaque errors but still counts", () => {
    const result = classifyAdapterFailure(
      new Error("something odd happened"),
      "copilot_local",
    );
    expect(result.adapterFailureReason).toBe("adapter_unknown_error");
    // Default behaviour MUST preserve fleet protection (CLI-75): unknown
    // adapter-thrown failures still count toward the breaker.
    expect(result.countsTowardBreaker).toBe(true);
  });

  it("never collapses quarantined runs into breaker counters", () => {
    // The quarantine reason is emitted by the breaker itself when it refuses
    // a run; it is NOT an adapter failure and must not feed back into trip
    // accounting (would cause infinite trip loops).
    expect(ADAPTER_FAILURE_REASONS.adapter_quarantined.countsTowardBreaker).toBe(false);
    expect(ADAPTER_FAILURE_REASONS.adapter_quarantined.surfaceErrorCode).toBe("adapter_quarantined");
  });

  it("does not count mid-run timeouts toward the breaker", () => {
    expect(ADAPTER_FAILURE_REASONS.adapter_mid_run_timeout.countsTowardBreaker).toBe(false);
  });

  it("handles non-Error thrown values gracefully", () => {
    expect(classifyAdapterFailure("Process adapter missing command", "process").adapterFailureReason).toBe(
      "adapter_missing_command",
    );
    expect(classifyAdapterFailure(undefined, "process").adapterFailureReason).toBe("adapter_unknown_error");
    expect(classifyAdapterFailure(null, "process").adapterFailureReason).toBe("adapter_unknown_error");
  });
});
