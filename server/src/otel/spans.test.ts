import { describe, it, expect, vi } from "vitest";
import {
  withHeartbeatSpan,
  withToolCallSpan,
  withApprovalSpan,
  withCostEventSpan,
  getTraceContextHeaders,
  recordAdapterResult,
} from "./spans.js";

// Without an OTel SDK configured, all spans are no-ops.
// These tests verify the wrapper functions execute correctly
// and propagate return values and errors without an active tracer.

describe("otel/spans", () => {
  describe("withHeartbeatSpan", () => {
    it("executes the callback and returns its result", async () => {
      const result = await withHeartbeatSpan(
        { runId: "run-1", agentId: "agent-1" },
        async () => "done",
      );
      expect(result).toBe("done");
    });

    it("propagates errors from the callback", async () => {
      await expect(
        withHeartbeatSpan(
          { runId: "run-1", agentId: "agent-1" },
          async () => { throw new Error("test error"); },
        ),
      ).rejects.toThrow("test error");
    });
  });

  describe("withToolCallSpan", () => {
    it("executes the callback and returns its result", async () => {
      const result = await withToolCallSpan(
        { toolName: "test-tool" },
        async () => ({ output: "hello" }),
      );
      expect(result).toEqual({ output: "hello" });
    });
  });

  describe("withApprovalSpan", () => {
    it("wraps approval transitions", async () => {
      const result = await withApprovalSpan(
        "approval.submit",
        { "approval.type": "merge" },
        async () => true,
      );
      expect(result).toBe(true);
    });
  });

  describe("withCostEventSpan", () => {
    it("wraps cost event recording", async () => {
      const result = await withCostEventSpan(
        { provider: "anthropic", model: "claude-3", costCents: 5, billingType: "metered_api" },
        async () => ({ id: "event-1" }),
      );
      expect(result).toEqual({ id: "event-1" });
    });
  });

  describe("getTraceContextHeaders", () => {
    it("returns empty headers when no active span", () => {
      const headers = getTraceContextHeaders();
      expect(headers).toEqual({});
    });
  });

  describe("recordAdapterResult", () => {
    it("handles missing optional fields without throwing", () => {
      // Create a minimal mock span
      const mockSpan = {
        setAttributes: vi.fn(),
      };
      expect(() => {
        recordAdapterResult(mockSpan as any, {});
      }).not.toThrow();
    });
  });
});
