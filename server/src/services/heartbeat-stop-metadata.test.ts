import { describe, expect, it } from "vitest";
import {
  BILLING_LIMIT_ERROR_CODE,
  buildHeartbeatRunStopMetadata,
  isBillingLimitErrorMessage,
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

  describe("billing/spending-limit error detection", () => {
    it("detects workspace monthly spending limit exhausted message", () => {
      expect(isBillingLimitErrorMessage("workspace monthly spending limit exhausted")).toBe(true);
      expect(isBillingLimitErrorMessage("Workspace monthly spending limit of $160 exhausted")).toBe(true);
      expect(isBillingLimitErrorMessage("adapter_failed: workspace monthly spending limit exhausted")).toBe(true);
    });

    it("detects billing limit and credit exhaustion variants", () => {
      expect(isBillingLimitErrorMessage("billing limit exhausted")).toBe(true);
      expect(isBillingLimitErrorMessage("credit balance insufficient")).toBe(true);
      expect(isBillingLimitErrorMessage("quota exhausted for this period")).toBe(true);
      expect(isBillingLimitErrorMessage("billing threshold exceeded")).toBe(true);
    });

    it("does not false-positive on non-billing errors", () => {
      expect(isBillingLimitErrorMessage("Adapter failed: connection refused")).toBe(false);
      expect(isBillingLimitErrorMessage("Timed out after 45s")).toBe(false);
      expect(isBillingLimitErrorMessage("session not found")).toBe(false);
      expect(isBillingLimitErrorMessage(null)).toBe(false);
      expect(isBillingLimitErrorMessage(undefined)).toBe(false);
      expect(isBillingLimitErrorMessage("")).toBe(false);
    });

    it("classifies billing-limit failures as billing_limit_exhausted stop reason", () => {
      expect(
        buildHeartbeatRunStopMetadata({
          adapterType: "opencode_local",
          adapterConfig: {},
          outcome: "failed",
          errorCode: null,
          errorMessage: "workspace monthly spending limit exhausted",
        }).stopReason,
      ).toBe("billing_limit_exhausted");
    });

    it("does not classify non-billing adapter failures as billing_limit_exhausted", () => {
      expect(
        buildHeartbeatRunStopMetadata({
          adapterType: "opencode_local",
          adapterConfig: {},
          outcome: "failed",
          errorCode: null,
          errorMessage: "connection refused",
        }).stopReason,
      ).toBe("adapter_failed");
    });

    it("exports the canonical billing limit error code constant", () => {
      expect(BILLING_LIMIT_ERROR_CODE).toBe("billing_limit_exhausted");
    });
  });
});
