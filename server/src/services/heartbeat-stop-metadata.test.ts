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

  it("keeps adapter_quarantined stop reason distinct from adapter_failed (CLI-156)", () => {
    // CLI-156 acceptance criterion: dashboards must NOT collapse the quarantine
    // state back into plain adapter_failed.
    const metadata = buildHeartbeatRunStopMetadata({
      adapterType: "copilot_local",
      adapterConfig: {},
      outcome: "failed",
      errorCode: "adapter_quarantined",
      errorMessage: "adapter copilot_local is quarantined",
    });
    expect(metadata.stopReason).toBe("adapter_quarantined");

    // Other failed runs still classify as adapter_failed.
    expect(
      buildHeartbeatRunStopMetadata({
        adapterType: "copilot_local",
        adapterConfig: {},
        outcome: "failed",
        errorCode: "adapter_failed",
        errorMessage: "boom",
      }).stopReason,
    ).toBe("adapter_failed");
  });
});
