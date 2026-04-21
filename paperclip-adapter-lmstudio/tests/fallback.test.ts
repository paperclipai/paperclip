import { describe, it, expect, vi, beforeEach } from "vitest";
import { execute } from "../src/server/execute.js";

function makeCtx(overrides: Record<string, unknown> = {}, context: Record<string, unknown> = {}) {
  const logs: string[] = [];
  return {
    runId: "run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Test Agent",
      adapterType: "lmstudio_local",
      adapterConfig: {},
    },
    config: {
      url: "http://primary:1234",
      defaultModel: "big",
      fallbackUrl: "http://fallback:1234",
      fallbackModel: "small",
      probeTimeoutMs: 200,
      timeoutMs: 5000,
      maxIterations: 3,
      ...overrides,
    },
    context: { paperclipApiUrl: "http://localhost:3100", ...context },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    onLog: async (_stream: string, chunk: string) => { logs.push(chunk); },
    authToken: "test-auth",
    logs,
  };
}

// Helper: find a logged JSON event by kind + text-substring
function findEvent(logs: string[], kind: string, textSubstr: string): unknown {
  for (const line of logs) {
    try {
      const obj = JSON.parse(line.trim());
      if (obj.kind === kind && typeof obj.text === "string" && obj.text.includes(textSubstr)) {
        return obj;
      }
    } catch { /* not JSON */ }
  }
  return null;
}

const streamBody = () => {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(c) {
      c.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Done"}}]}\n\ndata: [DONE]\n\n'));
      c.close();
    },
  });
};

const okModelsResponse = () => ({
  ok: true,
  status: 200,
  json: async () => ({ data: [{ id: "m" }] }),
});

const connRefused = () => Object.assign(new Error("refused"), { cause: { code: "ECONNREFUSED" } });
const abortErr = () => Object.assign(new Error("aborted"), { name: "AbortError" });

describe("execute — fallback behavior", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("uses primary when primary probe ok (no meta event)", async () => {
    const fetchMock = vi.fn()
      // Primary probe (GET /v1/models)
      .mockResolvedValueOnce(okModelsResponse())
      // LLM turn 1: final text
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { role: "assistant", content: "All done" } }],
        }),
      })
      // Stream repeat
      .mockResolvedValueOnce({ ok: true, body: streamBody() });
    vi.stubGlobal("fetch", fetchMock);

    const ctx = makeCtx();
    const result = await execute(ctx as any);

    expect(result.exitCode).toBe(0);
    expect(findEvent(ctx.logs, "system", "Fallback aktiv")).toBeNull();
    // All LLM calls went to primary
    const primaryHits = fetchMock.mock.calls.filter(([url]) => String(url).startsWith("http://primary"));
    expect(primaryHits.length).toBeGreaterThanOrEqual(2);
  });

  it("falls back and posts meta event when primary probe fails", async () => {
    const fetchMock = vi.fn()
      // Primary probe fails
      .mockRejectedValueOnce(connRefused())
      // Fallback probe ok
      .mockResolvedValueOnce(okModelsResponse())
      // LLM turn 1 on fallback: final text
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { role: "assistant", content: "All done" } }],
        }),
      })
      // Stream repeat on fallback
      .mockResolvedValueOnce({ ok: true, body: streamBody() });
    vi.stubGlobal("fetch", fetchMock);

    const ctx = makeCtx();
    const result = await execute(ctx as any);

    expect(result.exitCode).toBe(0);
    expect(findEvent(ctx.logs, "system", "Fallback aktiv")).not.toBeNull();
    // Final calls went to fallback
    const fallbackHits = fetchMock.mock.calls.filter(([url]) =>
      String(url).startsWith("http://fallback"),
    );
    expect(fallbackHits.length).toBeGreaterThanOrEqual(2);
  });

  it("fails cleanly when primary probe fails and no fallback configured", async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(connRefused());
    vi.stubGlobal("fetch", fetchMock);

    const ctx = makeCtx({ fallbackUrl: "" });
    const result = await execute(ctx as any);

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("llm_unreachable");
    expect(result.errorMessage).toContain("primary");
    expect(result.errorMessage).toContain("ECONNREFUSED");
  });

  it("fails cleanly when both primary and fallback probes fail", async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(connRefused())
      .mockRejectedValueOnce(abortErr());
    vi.stubGlobal("fetch", fetchMock);

    const ctx = makeCtx();
    const result = await execute(ctx as any);

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("llm_unreachable");
    expect(result.errorMessage).toContain("primary");
    expect(result.errorMessage).toContain("fallback");
  });

  it("switches to fallback mid-call on network error", async () => {
    const fetchMock = vi.fn()
      // Primary probe ok
      .mockResolvedValueOnce(okModelsResponse())
      // LLM turn 1 on primary: connection drops mid-call
      .mockRejectedValueOnce(connRefused())
      // LLM turn 1 retry on fallback: final text
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { role: "assistant", content: "Recovered" } }],
        }),
      })
      // Stream repeat on fallback
      .mockResolvedValueOnce({ ok: true, body: streamBody() });
    vi.stubGlobal("fetch", fetchMock);

    const ctx = makeCtx();
    const result = await execute(ctx as any);

    expect(result.exitCode).toBe(0);
    expect(findEvent(ctx.logs, "system", "Fallback aktiv")).not.toBeNull();
  });

  it("sticky: once on fallback, stays on fallback for rest of heartbeat", async () => {
    const fetchMock = vi.fn()
      // Primary probe fails
      .mockRejectedValueOnce(connRefused())
      // Fallback probe ok
      .mockResolvedValueOnce(okModelsResponse())
      // LLM turn 1 on fallback: tool call
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{
                id: "call_1",
                type: "function",
                function: { name: "paperclip_get_identity", arguments: "{}" },
              }],
            },
          }],
        }),
      })
      // Tool call to paperclip API (not LM Studio)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: "agent-1", name: "CEO" }) })
      // LLM turn 2 on fallback: final text
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { role: "assistant", content: "Done" } }],
        }),
      })
      // Stream repeat on fallback
      .mockResolvedValueOnce({ ok: true, body: streamBody() });
    vi.stubGlobal("fetch", fetchMock);

    const ctx = makeCtx();
    const result = await execute(ctx as any);

    expect(result.exitCode).toBe(0);

    // Count meta events — should be exactly ONE, not per-call
    const metaCount = ctx.logs.filter((l) => {
      try {
        const o = JSON.parse(l.trim());
        return o.kind === "system" && typeof o.text === "string" && o.text.includes("Fallback aktiv");
      } catch { return false; }
    }).length;
    expect(metaCount).toBe(1);

    // Every LM-Studio call (probe of primary failed, everything else) went to fallback
    const lmStudioCalls = fetchMock.mock.calls
      .map(([u]) => String(u))
      .filter((u) => u.includes(":1234/"));
    const primaryAfterProbe = lmStudioCalls.slice(1).filter((u) => u.startsWith("http://primary"));
    expect(primaryAfterProbe.length).toBe(0);
  });

  it("uses primaryModel name on fallback when fallbackModel is empty", async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(connRefused())
      .mockResolvedValueOnce(okModelsResponse())
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { role: "assistant", content: "Done" } }],
        }),
      })
      .mockResolvedValueOnce({ ok: true, body: streamBody() });
    vi.stubGlobal("fetch", fetchMock);

    const ctx = makeCtx({ fallbackModel: "" });
    const result = await execute(ctx as any);

    expect(result.exitCode).toBe(0);
    // The POST body for LLM call on fallback should use primary's model name "big"
    const llmCallWithBody = fetchMock.mock.calls.find(
      ([url, init]) => String(url).includes("http://fallback") && init?.method === "POST",
    );
    expect(llmCallWithBody).toBeDefined();
    const body = JSON.parse(llmCallWithBody![1].body);
    expect(body.model).toBe("big");
  });

  it("does not switch to fallback for non-failover errors (e.g. malformed response)", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(okModelsResponse())
      // LLM returns 500 — this is "unknown" kind, should not trigger fallback
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        text: async () => "server error",
      });
    vi.stubGlobal("fetch", fetchMock);

    const ctx = makeCtx();
    const result = await execute(ctx as any);

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("llm_error");
    // No fallback attempt — no meta event
    expect(findEvent(ctx.logs, "system", "Fallback aktiv")).toBeNull();
  });
});
