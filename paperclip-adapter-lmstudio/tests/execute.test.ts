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
      // Primary probe (GET /v1/models) — added for fallback feature
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: [{ id: "m" }] }),
      })
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
      // Primary probe (GET /v1/models) — added for fallback feature
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: [{ id: "m" }] }),
      })
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
    const fetchMock = vi.fn()
      // Primary probe (GET /v1/models) — added for fallback feature
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: [{ id: "m" }] }),
      })
      .mockImplementation(async () => {
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
      });
    vi.stubGlobal("fetch", fetchMock);

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

describe("execute (post-run guard)", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("auto-closes checked-out issue as blocked when LLM forgets status update", async () => {
    const streamBody = 'data: {"choices":[{"delta":{"content":"Done"}}]}\n\ndata: [DONE]\n\n';
    const mockStream = new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode(streamBody)); c.close(); },
    });

    const fetchMock = vi.fn()
      // Primary probe (GET /v1/models) — added for fallback feature
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: [{ id: "m" }] }),
      })
      // LLM turn 1: checkout issue
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
                function: { name: "paperclip_checkout_issue", arguments: '{"issueId":"issue-1"}' },
              }],
            },
          }],
        }),
      })
      // Tool execution: checkout succeeds
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) })
      // LLM turn 2: just a comment, no status update
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{
                id: "call_2",
                type: "function",
                function: { name: "paperclip_add_comment", arguments: '{"issueId":"issue-1","body":"did the work"}' },
              }],
            },
          }],
        }),
      })
      // Tool execution: comment succeeds
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) })
      // LLM turn 3: final text answer (no tool calls)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { role: "assistant", content: "All done!" } }],
        }),
      })
      // Streaming final answer
      .mockResolvedValueOnce({ ok: true, body: mockStream })
      // POST-RUN GUARD: auto-call paperclip_update_issue
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) });

    vi.stubGlobal("fetch", fetchMock);

    const ctx = makeCtx();
    const result = await execute(ctx as any);

    expect(result.exitCode).toBe(0);

    // Verify the post-run guard made an auto-update call
    const lastCall = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
    expect(lastCall[0]).toContain("/api/issues/issue-1");
    expect(lastCall[1].method).toBe("PATCH");
    const body = JSON.parse(lastCall[1].body);
    expect(body.status).toBe("blocked");
    expect(body.comment).toContain("post-run guard");
  });

  it("does NOT trigger guard when LLM properly calls paperclip_update_issue", async () => {
    const streamBody = 'data: {"choices":[{"delta":{"content":"Done"}}]}\n\ndata: [DONE]\n\n';
    const mockStream = new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode(streamBody)); c.close(); },
    });

    const fetchMock = vi.fn()
      // Primary probe (GET /v1/models) — added for fallback feature
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: [{ id: "m" }] }),
      })
      // LLM turn 1: checkout
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
                function: { name: "paperclip_checkout_issue", arguments: '{"issueId":"issue-1"}' },
              }],
            },
          }],
        }),
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) })
      // LLM turn 2: update issue to done
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{
                id: "call_2",
                type: "function",
                function: { name: "paperclip_update_issue", arguments: '{"issueId":"issue-1","status":"done","comment":"ok"}' },
              }],
            },
          }],
        }),
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) })
      // LLM turn 3: final text
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { role: "assistant", content: "Task done" } }],
        }),
      })
      .mockResolvedValueOnce({ ok: true, body: mockStream });

    vi.stubGlobal("fetch", fetchMock);

    const ctx = makeCtx();
    const result = await execute(ctx as any);

    expect(result.exitCode).toBe(0);

    // Total fetch calls should be 7 (1 probe + 3 LLM turns + 2 tool calls + 1 stream), NOT 8 (no guard)
    expect(fetchMock).toHaveBeenCalledTimes(7);
  });
});
