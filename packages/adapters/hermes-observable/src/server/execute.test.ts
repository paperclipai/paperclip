import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execute } from "./execute.js";

const cliFallbackExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    summary: "cli fallback",
    resultJson: { fallback: true },
  })),
);

vi.mock("hermes-paperclip-adapter/server", () => ({
  execute: cliFallbackExecute,
  detectModel: async () => ({ model: "anthropic/claude-sonnet-4", provider: "anthropic" }),
  resolveProvider: ({ explicitProvider, detectedProvider, model }: any) => ({
    provider: explicitProvider && explicitProvider !== "auto" ? explicitProvider : detectedProvider ?? "auto",
    resolvedFrom: model ? "model" : "default",
  }),
}));

function createSseResponse(chunks: string[], headers: Record<string, string> = {}): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      ...headers,
    },
  });
}

function createJsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

function baseContext() {
  const logs: Array<{ stream: "stdout" | "stderr"; chunk: string }> = [];
  return {
    ctx: {
      runId: "run-1",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Hermes Observable",
        adapterType: "hermes_observable",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: "issue-1",
      },
      config: {
        cwd: "/tmp/workspace",
        hermesApiBaseUrl: "http://127.0.0.1:8000",
        timeoutSec: 30,
        heartbeatSec: 60,
      },
      context: {
        issueId: "issue-1",
        taskId: "issue-1",
        wakeReason: "issue_assigned",
        paperclipWake: {
          reason: "issue_assigned",
          issue: {
            id: "issue-1",
            identifier: "SAMA-41",
            title: "Create adapter",
            status: "in_progress",
          },
        },
      },
      onLog: async (stream: "stdout" | "stderr", chunk: string) => {
        logs.push({ stream, chunk });
      },
      onMeta: async () => {},
      authToken: "local-agent-jwt",
    },
    logs,
  };
}

describe("hermes observable execute", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    cliFallbackExecute.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("streams responses SSE into structured Paperclip log events", async () => {
    const { ctx, logs } = baseContext();

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(createJsonResponse({
        features: {
          responses_streaming: true,
          chat_completions_streaming: true,
          tool_progress_events: true,
        },
      }))
      .mockResolvedValueOnce(createSseResponse([
        'event: response.created\ndata: {"response":{"id":"resp_1"}}\n\n',
        'event: response.output_item.added\ndata: {"item":{"type":"function_call","name":"search_query","call_id":"call_1","arguments":"{\\"q\\":\\"test\\"}"}}\n\n',
        'event: response.output_text.delta\ndata: {"delta":"Working..."}\n\n',
        'event: response.output_item.done\ndata: {"item":{"type":"function_call","name":"search_query","call_id":"call_1"}}\n\n',
        'event: response.output_item.added\ndata: {"item":{"type":"function_call_output","call_id":"call_1","output":[{"type":"input_text","text":"done"}],"status":"completed"}}\n\n',
        'event: response.completed\ndata: {"response":{"id":"resp_1","usage":{"input_tokens":12,"output_tokens":8},"output":[{"type":"message","content":[{"type":"output_text","text":"Working...done"}]}]}}\n\n',
      ], {
        "X-Hermes-Session-Id": "session-1",
        "X-Hermes-Session-Key": "paperclip:company-1:agent-1:issue-1",
      }));

    vi.stubGlobal("fetch", fetchMock);

    const result = await execute(ctx as any);

    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe("Working...done");
    expect(result.sessionParams).toMatchObject({
      conversation: "paperclip:company-1:agent-1:issue-1",
      sessionId: "session-1",
      lastResponseId: "resp_1",
    });

    const stdout = logs.filter((entry) => entry.stream === "stdout").map((entry) => entry.chunk);
    expect(stdout.join("")).toContain('"type":"hermes_observable.init"');
    expect(stdout.join("")).toContain('"type":"hermes_observable.tool_call"');
    expect(stdout.join("")).toContain('"type":"hermes_observable.tool_result"');
    expect(stdout.join("")).toContain('"type":"hermes_observable.result"');
  });

  it("falls back to chat completions streaming when responses support is unavailable", async () => {
    const { ctx, logs } = baseContext();

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(createJsonResponse({
        features: {
          responses_streaming: false,
          chat_completions_streaming: true,
          tool_progress_events: true,
        },
      }))
      .mockResolvedValueOnce(createSseResponse([
        'data: {"choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n',
        'event: hermes.tool.progress\ndata: {"tool":"terminal","toolCallId":"call_1","status":"running","input":{"cmd":"pwd"}}\n\n',
        'data: {"choices":[{"index":0,"delta":{"content":"hello"},"finish_reason":null}]}\n\n',
        'event: hermes.tool.progress\ndata: {"tool":"terminal","toolCallId":"call_1","status":"completed","output":"ok"}\n\n',
        'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":4,"completion_tokens":3}}\n\n',
        'data: [DONE]\n\n',
      ], {
        "X-Hermes-Session-Id": "chat-session-1",
      }));

    vi.stubGlobal("fetch", fetchMock);

    const result = await execute(ctx as any);

    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe("hello");
    expect(logs.map((entry) => entry.chunk).join("")).toContain("responses streaming unavailable");
    expect(logs.map((entry) => entry.chunk).join("")).toContain('"type":"hermes_observable.tool_result"');
  });

  it("uses CLI fallback only when the API is unreachable and allowCliFallback is enabled", async () => {
    const { ctx, logs } = baseContext();
    ctx.config = {
      ...ctx.config,
      allowCliFallback: true,
    } as any;

    const fetchMock = vi.fn().mockRejectedValue(new TypeError("connect ECONNREFUSED"));
    vi.stubGlobal("fetch", fetchMock);

    const result = await execute(ctx as any);

    expect(cliFallbackExecute).toHaveBeenCalledTimes(1);
    expect(result.summary).toBe("cli fallback");
    expect(logs.map((entry) => entry.chunk).join("")).toContain("falling back to legacy hermes CLI");
  });
});
