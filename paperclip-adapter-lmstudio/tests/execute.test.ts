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
      url: "http://localhost:1234",
      defaultModel: "gemma-4-31b-it",
      timeoutMs: 30000,
      maxIterations: 5,
      ...overrides,
    },
    context: { paperclipApiUrl: "http://localhost:3100", ...context },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    onLog: async (_stream: string, chunk: string) => { logs.push(chunk); },
    authToken: "test-auth",
    logs,
  };
}

describe("execute (agent loop)", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("returns immediately when LLM returns text without tool_calls", async () => {
    const streamBody = 'data: {"choices":[{"delta":{"content":"Done"}}]}\n\ndata: [DONE]\n\n';
    const mockBody = new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode(streamBody)); c.close(); },
    });

    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { role: "assistant", content: "All done" } }],
          usage: { prompt_tokens: 5, completion_tokens: 2 },
        }),
      })
      .mockResolvedValueOnce({ ok: true, body: mockBody });
    vi.stubGlobal("fetch", fetchMock);

    const ctx = makeCtx();
    const result = await execute(ctx as any);

    expect(result.exitCode).toBe(0);
    expect(result.summary).toContain("Done");
  });

  it("executes tool_call and loops back", async () => {
    const streamBody = 'data: {"choices":[{"delta":{"content":"Finished"}}]}\n\ndata: [DONE]\n\n';
    const mockBody = new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode(streamBody)); c.close(); },
    });

    const fetchMock = vi.fn()
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
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "agent-1", name: "CEO" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { role: "assistant", content: "Got identity" } }],
        }),
      })
      .mockResolvedValueOnce({ ok: true, body: mockBody });
    vi.stubGlobal("fetch", fetchMock);

    const ctx = makeCtx();
    const result = await execute(ctx as any);

    expect(result.exitCode).toBe(0);
    expect(ctx.logs.some((l) => l.includes("paperclip_get_identity"))).toBe(true);
    expect(ctx.logs.some((l) => l.includes("tool_result"))).toBe(true);
  });

  it("stops at maxIterations", async () => {
    let callCount = 0;
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => {
      callCount++;
      return {
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{
                id: `call_${callCount}`,
                type: "function",
                function: { name: "paperclip_get_identity", arguments: "{}" },
              }],
            },
          }],
        }),
      };
    }));

    const ctx = makeCtx({ maxIterations: 3 });
    const result = await execute(ctx as any);

    expect(result.exitCode).toBe(1);
    expect(result.errorMessage).toContain("Max iterations");
  });

  it("returns error when no model configured", async () => {
    const ctx = makeCtx({ defaultModel: "" });
    const result = await execute(ctx as any);
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("no_model");
  });
});
