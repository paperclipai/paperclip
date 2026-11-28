import { describe, expect, it } from "vitest";
import { resolveAdapterExecutionTargetTimeout } from "@paperclipai/adapter-utils/execution-target";
import {
  buildHeartbeatRunStopMetadata,
  mergeHeartbeatRunStopMetadata,
  resolveHeartbeatRunTimeoutPolicy,
} from "./heartbeat-stop-metadata.js";
import { MAX_HTTP_TIMEOUT_MS } from "../adapters/http/timeout.js";

describe("heartbeat stop metadata", () => {
  it("keeps local coding adapters at no timeout by default", () => {
    for (const adapterType of [
      "codex_local",
      "claude_local",
      "cursor",
      "gemini_local",
      "opencode_local",
      "pi_local",
      "process",
    ]) {
      expect(resolveHeartbeatRunTimeoutPolicy(adapterType, {})).toEqual({
        effectiveTimeoutSec: 0,
        timeoutConfigured: false,
        timeoutSource: "default",
      });
    }
  });

  it("records configured timeout policy and timeout stop reason", () => {
    const metadata = buildHeartbeatRunStopMetadata({
      adapterType: "codex_local",
      adapterConfig: { timeoutSec: 45 },
      outcome: "timed_out",
      errorCode: "timeout",
      errorMessage: "Timed out after 45s",
    });

    expect(metadata).toEqual({
      effectiveTimeoutSec: 45,
      timeoutConfigured: true,
      timeoutSource: "config",
      stopReason: "timeout",
      timeoutFired: true,
    });
  });

  it("resolves the http timeout policy from the documented timeoutSec field", () => {
    expect(resolveHeartbeatRunTimeoutPolicy("http", { timeoutSec: 2 })).toEqual({
      effectiveTimeoutSec: 2,
      effectiveTimeoutMs: 2000,
      timeoutConfigured: true,
      timeoutSource: "config",
    });
  });

  it("prefers timeoutMs over timeoutSec for the http adapter", () => {
    expect(resolveHeartbeatRunTimeoutPolicy("http", { timeoutMs: 1000, timeoutSec: 9 })).toEqual({
      effectiveTimeoutSec: 1,
      effectiveTimeoutMs: 1000,
      timeoutConfigured: true,
      timeoutSource: "config",
    });
  });

  it("keeps the http adapter at no timeout when neither field is set", () => {
    expect(resolveHeartbeatRunTimeoutPolicy("http", {})).toEqual({
      effectiveTimeoutSec: 0,
      effectiveTimeoutMs: 0,
      timeoutConfigured: false,
      timeoutSource: "default",
    });
  });

  it("keeps the http policy in step with the timeout the adapter arms", () => {
    // `adapterConfig` holds arbitrary JSON, so the `timeoutMs` alias can be
    // present and carry no number. The adapter then falls back to `timeoutSec`,
    // and the recorded policy has to follow it rather than report no timeout.
    expect(resolveHeartbeatRunTimeoutPolicy("http", { timeoutMs: null, timeoutSec: 5 })).toEqual({
      effectiveTimeoutSec: 5,
      effectiveTimeoutMs: 5000,
      timeoutConfigured: true,
      timeoutSource: "config",
    });
  });

  it("records no http timeout for a value the adapter cannot use", () => {
    expect(resolveHeartbeatRunTimeoutPolicy("http", { timeoutMs: "1000" })).toEqual({
      effectiveTimeoutSec: 0,
      effectiveTimeoutMs: 0,
      timeoutConfigured: false,
      timeoutSource: "config",
    });
  });

  it("holds an oversized http timeout at the same ceiling the adapter uses", () => {
    expect(resolveHeartbeatRunTimeoutPolicy("http", { timeoutSec: 3_000_000_000 })).toEqual({
      effectiveTimeoutSec: MAX_HTTP_TIMEOUT_MS / 1000,
      effectiveTimeoutMs: MAX_HTTP_TIMEOUT_MS,
      timeoutConfigured: true,
      timeoutSource: "config",
    });
  });

  it.each([
    { target: "sandbox", configured: undefined, seconds: 14400, source: "sandbox_default", explicit: false },
    { target: "sandbox", configured: 0, seconds: 14400, source: "sandbox_default", explicit: false },
    { target: "sandbox", configured: 90, seconds: 90, source: "configured", explicit: true },
    { target: "sandbox", configured: 0.5, seconds: 0.5, source: "configured", explicit: true },
    { target: "sandbox", configured: -1, seconds: 0, source: "configured", explicit: true },
    { target: "local", configured: 0, seconds: 0, source: "unlimited", explicit: false },
  ])("retains the resolved $target timeout for config $configured", ({ target, configured, seconds, source, explicit }) => {
    const adapterExecutionTimeout = resolveAdapterExecutionTargetTimeout(
      target === "sandbox" ? { kind: "remote", transport: "sandbox", remoteCwd: "/workspace" } : { kind: "local" },
      configured,
    );
    const result = mergeHeartbeatRunStopMetadata(
      { adapterExecutionTimeout, summary: "retained", executionCancellation: { state: "unconfirmed" } },
      buildHeartbeatRunStopMetadata({
        adapterType: "claude_local", adapterConfig: { timeoutSec: configured }, outcome: "timed_out",
      }),
    );
    expect(result).toMatchObject({
      effectiveTimeoutSec: seconds, timeoutSource: source, timeoutConfigured: explicit,
      stopReason: "timeout", timeoutFired: true, summary: "retained",
      executionCancellation: { state: "unconfirmed" },
    });
  });

  it.each([
    null, [], { timeoutSec: 90 }, { timeoutSec: "90", source: "configured" },
    { timeoutSec: -1, source: "configured" }, { timeoutSec: Infinity, source: "configured" },
    { timeoutSec: 90, source: "unknown" }, { timeoutSec: 90, source: "unlimited" },
    { timeoutSec: 0, source: "sandbox_default" },
  ])("falls back to config for an invalid adapter resolution: %j", (adapterExecutionTimeout) => {
    expect(mergeHeartbeatRunStopMetadata(
      { adapterExecutionTimeout },
      buildHeartbeatRunStopMetadata({ adapterType: "claude_local", adapterConfig: { timeoutSec: 45 }, outcome: "failed" }),
    )).toMatchObject({ effectiveTimeoutSec: 45, timeoutConfigured: true, timeoutSource: "config", timeoutFired: false });
  });

  it("keeps the HTTP millisecond policy internally consistent", () => {
    expect(mergeHeartbeatRunStopMetadata(
      { adapterExecutionTimeout: { timeoutSec: 90, source: "configured" } },
      buildHeartbeatRunStopMetadata({ adapterType: "http", adapterConfig: { timeoutMs: 2500 }, outcome: "failed" }),
    )).toMatchObject({ effectiveTimeoutSec: 2.5, effectiveTimeoutMs: 2500, timeoutSource: "config", timeoutFired: false });
  });

  it("distinguishes budget cancellation from manual cancellation", () => {
    expect(
      buildHeartbeatRunStopMetadata({
        adapterType: "codex_local",
        adapterConfig: {},
        outcome: "cancelled",
        errorCode: "cancelled",
        errorMessage: "Cancelled due to budget pause",
      }).stopReason,
    ).toBe("budget_paused");

    expect(
      buildHeartbeatRunStopMetadata({
        adapterType: "codex_local",
        adapterConfig: {},
        outcome: "cancelled",
        errorCode: "cancelled",
        errorMessage: "Cancelled by control plane",
      }).stopReason,
    ).toBe("cancelled");
  });

  it("records graceful interruption separately from failure", () => {
    expect(
      buildHeartbeatRunStopMetadata({
        adapterType: "codex_local",
        adapterConfig: {},
        outcome: "interrupted",
        errorCode: "server_shutdown_interrupted",
        errorMessage: "Interrupted by graceful server shutdown",
      }).stopReason,
    ).toBe("interrupted");
  });

  it("normalizes max-turn exhaustion stop reasons", () => {
    expect(
      buildHeartbeatRunStopMetadata({
        adapterType: "claude_local",
        adapterConfig: {},
        outcome: "failed",
        errorCode: "turn_limit_exhausted",
        errorMessage: "turn limit reached",
      }).stopReason,
    ).toBe("max_turns_exhausted");

    const merged = mergeHeartbeatRunStopMetadata(
      { stopReason: "turn_limit_exhausted" },
      buildHeartbeatRunStopMetadata({
        adapterType: "claude_local",
        adapterConfig: {},
        outcome: "failed",
        errorCode: "adapter_failed",
      }),
    );
    expect(merged.stopReason).toBe("max_turns_exhausted");
  });

  it("prioritizes succeeded outcome over inconsistent max-turn error metadata", () => {
    expect(
      buildHeartbeatRunStopMetadata({
        adapterType: "claude_local",
        adapterConfig: {},
        outcome: "succeeded",
        errorCode: "max_turns_exhausted",
      }).stopReason,
    ).toBe("completed");
  });

  it("preserves existing result fields when merging stop metadata", () => {
    const result = mergeHeartbeatRunStopMetadata(
      { summary: "done" },
      buildHeartbeatRunStopMetadata({
        adapterType: "openclaw_gateway",
        adapterConfig: {},
        outcome: "succeeded",
      }),
    );

    expect(result).toMatchObject({
      summary: "done",
      stopReason: "completed",
      effectiveTimeoutSec: 120,
      timeoutConfigured: true,
      timeoutSource: "default",
      timeoutFired: false,
    });
  });
});
