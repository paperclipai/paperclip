import { describe, it, expect, beforeEach } from "vitest";

// Reset module state between tests by reimporting
describe("trace-context", () => {
  // Note: OTel global state is process-wide; tests run in sequence to avoid
  // cross-test provider interference.
  it("extractTraceContext returns undefined when no span is active", async () => {
    const { extractTraceContext, initServerTracing } = await import("./trace-context.js");
    initServerTracing();
    expect(extractTraceContext()).toBeUndefined();
  });

  it("withHeartbeatSpan executes callback and returns result", async () => {
    const { withHeartbeatSpan } = await import("./trace-context.js");
    const result = await withHeartbeatSpan("run-1", "agent-1", { env: "test" }, async () => 42);
    expect(result).toBe(42);
  });

  it("withHeartbeatSpan propagates trace context inside callback", async () => {
    const { withHeartbeatSpan, extractTraceContext } = await import("./trace-context.js");
    let ctx: ReturnType<typeof extractTraceContext>;
    await withHeartbeatSpan("run-2", "agent-2", {}, async () => {
      ctx = extractTraceContext();
    });
    expect(ctx).toBeDefined();
    expect(ctx!.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(ctx!.traceId).not.toBe("00000000000000000000000000000000");
    expect(ctx!.spanId).toMatch(/^[0-9a-f]{16}$/);
  });

  it("withHeartbeatSpan re-throws errors and still ends span", async () => {
    const { withHeartbeatSpan } = await import("./trace-context.js");
    await expect(
      withHeartbeatSpan("run-3", "agent-3", {}, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });

  it("withIssueSpan executes callback and returns result", async () => {
    const { withIssueSpan } = await import("./trace-context.js");
    const result = await withIssueSpan("create", "issue-1", {}, async () => "done");
    expect(result).toBe("done");
  });

  it("withIssueSpan propagates trace context inside callback", async () => {
    const { withIssueSpan, extractTraceContext } = await import("./trace-context.js");
    let ctx: ReturnType<typeof extractTraceContext>;
    await withIssueSpan("update", "issue-2", {}, async () => {
      ctx = extractTraceContext();
    });
    expect(ctx).toBeDefined();
    expect(ctx!.traceId).toMatch(/^[0-9a-f]{32}$/);
  });

  it("initServerTracing is idempotent — multiple calls do not throw", async () => {
    const { initServerTracing } = await import("./trace-context.js");
    expect(() => {
      initServerTracing();
      initServerTracing();
      initServerTracing();
    }).not.toThrow();
  });
});
