import { describe, expect, it } from "vitest";
import {
  ADAPTER_PROCESS_LOST_NO_PID_ERROR_CODE,
  PROCESS_LOST_ERROR_CODE,
  buildHeartbeatRunStopMetadata,
  buildProcessLossMessage,
  classifyProcessLossErrorCode,
  isProcessLostFamilyErrorCode,
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

  // LET-436: When a tracked-local adapter (e.g. hermes_local) bypasses the
  // server-utils `onSpawn` callback, Paperclip never persists the child pid
  // or process group. The reaper used to fall back to the generic
  // "Process lost -- server may have restarted" message which masked the
  // real cause (missing adapter metadata) and produced a high-volume
  // "process_lost" flood that was indistinguishable from real OS-level
  // process death.
  describe("process loss classification (LET-436)", () => {
    it("classifies missing pid AND process group as adapter_process_lost_no_pid", () => {
      expect(
        classifyProcessLossErrorCode({ processPid: null, processGroupId: null }),
      ).toBe(ADAPTER_PROCESS_LOST_NO_PID_ERROR_CODE);
    });

    it("classifies a recorded pid as the canonical process_lost code", () => {
      expect(
        classifyProcessLossErrorCode({ processPid: 4242, processGroupId: null }),
      ).toBe(PROCESS_LOST_ERROR_CODE);
    });

    it("classifies a recorded process group (no pid) as process_lost", () => {
      expect(
        classifyProcessLossErrorCode({ processPid: null, processGroupId: 4242 }),
      ).toBe(PROCESS_LOST_ERROR_CODE);
    });

    it("produces a distinct, operator-visible message when adapter metadata is missing", () => {
      const message = buildProcessLossMessage({
        processPid: null,
        processGroupId: null,
      });
      expect(message).not.toContain("server may have restarted");
      expect(message.toLowerCase()).toContain("adapter");
      expect(message.toLowerCase()).toMatch(/pid|process group|metadata/);
    });

    it("preserves the canonical 'child pid no longer running' message when pid is known", () => {
      const message = buildProcessLossMessage({
        processPid: 4242,
        processGroupId: null,
      });
      expect(message).toContain("4242");
      expect(message.toLowerCase()).toContain("no longer running");
    });

    it("preserves the descendant-only message when the process group survived", () => {
      const message = buildProcessLossMessage(
        { processPid: 100, processGroupId: 200 },
        { descendantOnly: true },
      );
      expect(message).toContain("100");
      expect(message).toContain("200");
      expect(message.toLowerCase()).toContain("descendant");
    });

    it("treats both process_lost and adapter_process_lost_no_pid as the process-loss family", () => {
      expect(isProcessLostFamilyErrorCode(PROCESS_LOST_ERROR_CODE)).toBe(true);
      expect(isProcessLostFamilyErrorCode(ADAPTER_PROCESS_LOST_NO_PID_ERROR_CODE)).toBe(true);
      expect(isProcessLostFamilyErrorCode("adapter_failed")).toBe(false);
      expect(isProcessLostFamilyErrorCode(null)).toBe(false);
      expect(isProcessLostFamilyErrorCode(undefined)).toBe(false);
      expect(isProcessLostFamilyErrorCode("")).toBe(false);
    });

    it("routes adapter_process_lost_no_pid through the stop-reason inference", () => {
      const metadata = buildHeartbeatRunStopMetadata({
        adapterType: "hermes_local",
        adapterConfig: {},
        outcome: "failed",
        errorCode: ADAPTER_PROCESS_LOST_NO_PID_ERROR_CODE,
        errorMessage: "Process metadata missing",
      });
      expect(metadata.stopReason).toBe(ADAPTER_PROCESS_LOST_NO_PID_ERROR_CODE);
    });
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
