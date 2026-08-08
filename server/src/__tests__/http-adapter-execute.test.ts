import { describe, it, expect, vi, beforeEach } from "vitest";
import { execute } from "../adapters/http/execute.js";
import type { AdapterExecutionContext } from "../adapters/types.js";

function makeCtx(overrides: Partial<AdapterExecutionContext> = {}): AdapterExecutionContext {
  return {
    runId: "run-test-id-123",
    agent: { id: "agent-1", companyId: "company-1", name: "Test Agent", adapterType: "http", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: { url: "https://example.com/invoke", method: "POST" },
    context: {},
    onLog: vi.fn(),
    ...overrides,
  };
}

describe("http adapter execute", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
  });

  it("injects x-paperclip-run-id header with the correct runId", async () => {
    const ctx = makeCtx({ runId: "run-abc-456" });
    await execute(ctx);

    const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["x-paperclip-run-id"]).toBe("run-abc-456");
  });

  it("injects x-paperclip-run-id as empty string when runId is an empty string", async () => {
    // runId is typed string (non-optional). An empty string is the boundary case.
    // The header must be "" — not "undefined", not omitted.
    const ctx = makeCtx({ runId: "" });
    await execute(ctx);

    const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["x-paperclip-run-id"]).toBe("");
  });

  it("server-injected x-paperclip-run-id cannot be overridden by caller-supplied headers", async () => {
    // Our header is spread after config.headers, so it always wins.
    // This guarantees downstream services can trust the run ID for tracing.
    const ctx = makeCtx({
      runId: "run-real-id",
      config: {
        url: "https://example.com/invoke",
        headers: { "x-paperclip-run-id": "spoofed-id" },
      },
    });
    await execute(ctx);

    const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["x-paperclip-run-id"]).toBe("run-real-id");
  });
});
