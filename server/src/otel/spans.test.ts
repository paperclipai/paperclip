import { describe, expect, it, vi } from "vitest";
import {
  withHeartbeatSpan,
  withToolCallSpan,
  withApprovalSpan,
  withCostEventSpan,
  withAdapterSpan,
  recordAdapterResult,
  getTraceContextHeaders,
} from "./spans.js";

// @opentelemetry/api returns no-op spans/tracers when no SDK is registered,
// so these tests verify the wrappers behave correctly (propagate return values,
// propagate errors, and don't throw) in the no-SDK scenario.

describe("otel span helpers (no-op mode)", () => {
  describe("withHeartbeatSpan", () => {
    it("returns the callback result", async () => {
      const result = await withHeartbeatSpan(
        { runId: "r1", agentId: "a1", agentName: "test" },
        async () => "done",
      );
      expect(result).toBe("done");
    });

    it("propagates errors from the callback", async () => {
      await expect(
        withHeartbeatSpan(
          { runId: "r1", agentId: "a1" },
          async () => { throw new Error("boom"); },
        ),
      ).rejects.toThrow("boom");
    });
  });

  describe("withToolCallSpan", () => {
    it("returns the callback result", async () => {
      const result = await withToolCallSpan(
        { toolName: "test-tool", agentId: "a1", runId: "r1" },
        async () => ({ pluginId: "p1", result: { content: "ok" } }),
      );
      expect(result).toEqual({ pluginId: "p1", result: { content: "ok" } });
    });

    it("propagates errors from the callback", async () => {
      await expect(
        withToolCallSpan(
          { toolName: "test-tool" },
          async () => { throw new Error("tool failed"); },
        ),
      ).rejects.toThrow("tool failed");
    });
  });

  describe("withApprovalSpan", () => {
    it("returns the callback result", async () => {
      const result = await withApprovalSpan(
        "approval.resolve",
        { "approval.id": "ap1" },
        async () => ({ applied: true }),
      );
      expect(result).toEqual({ applied: true });
    });
  });

  describe("withCostEventSpan", () => {
    it("returns the callback result", async () => {
      const result = await withCostEventSpan(
        { provider: "anthropic", model: "claude-3", costCents: 10, billingType: "metered" },
        async () => ({ id: "evt1" }),
      );
      expect(result).toEqual({ id: "evt1" });
    });
  });

  describe("withAdapterSpan", () => {
    it("returns the callback result and accepts recordAdapterResult", async () => {
      const result = await withAdapterSpan(
        { adapterType: "claude_local", agentId: "a1", runId: "r1" },
        async (span) => {
          recordAdapterResult(span, {
            provider: "anthropic",
            model: "claude-3-opus",
            inputTokens: 100,
            outputTokens: 50,
            costUsd: 0.01,
          });
          return "adapter-result";
        },
      );
      expect(result).toBe("adapter-result");
    });
  });

  describe("getTraceContextHeaders", () => {
    it("returns an object (empty when no active span)", () => {
      const headers = getTraceContextHeaders();
      expect(typeof headers).toBe("object");
    });
  });
});
