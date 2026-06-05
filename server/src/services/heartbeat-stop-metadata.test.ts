import { describe, expect, it } from "vitest";
import {
  buildHeartbeatRunStopMetadata,
  mergeHeartbeatRunStopMetadata,
  resolveHeartbeatRunTimeoutPolicy,
} from "./heartbeat-stop-metadata.js";

describe("heartbeat stop metadata", () => {
  it("keeps local coding adapters at no timeout by default", () => {
    for (const adapterType of [
      "codex_local",
      "claude_local",
      "cursor",
      "gemini_local",
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

  it("applies the 900s opencode_local platform default to new agents (HNT-2743)", () => {
    // HNT-2743 changes the opencode_local adapter's effective timeout
    // default from 0 (unbounded) to 900s, so a freshly created agent
    // reports the same stall guardrail the HNT-2664 per-agent rollout
    // applied without needing a per-agent override. `timeoutSource` must
    // be "default" — not "config" — because no explicit adapterConfig
    // override is present.
    expect(resolveHeartbeatRunTimeoutPolicy("opencode_local", {})).toEqual({
      effectiveTimeoutSec: 900,
      timeoutConfigured: true,
      timeoutSource: "default",
    });
  });

  it("preserves an explicit opencode_local opt-out of zero", () => {
    // Agents that explicitly set `adapterConfig.timeoutSec: 0` are opting
    // out of the platform default. The metadata must report the explicit
    // override as "config" so operators can distinguish a deliberate
    // unbounded run from a freshly created agent that just hasn't been
    // tuned yet.
    expect(
      resolveHeartbeatRunTimeoutPolicy("opencode_local", { timeoutSec: 0 }),
    ).toEqual({
      effectiveTimeoutSec: 0,
      timeoutConfigured: false,
      timeoutSource: "config",
    });
  });

  it("honors an explicit opencode_local override above the platform default", () => {
    expect(
      resolveHeartbeatRunTimeoutPolicy("opencode_local", { timeoutSec: 1800 }),
    ).toEqual({
      effectiveTimeoutSec: 1800,
      timeoutConfigured: true,
      timeoutSource: "config",
    });
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
