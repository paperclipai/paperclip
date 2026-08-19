import { describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { execute } from "./execute.js";

function context(overrides: Partial<AdapterExecutionContext> = {}): AdapterExecutionContext {
  return {
    runId: "run-1",
    agent: { id: "agent-1", companyId: "company-1", name: "Ollama", adapterType: "ollama_local", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: { baseUrl: "http://127.0.0.1:11434", model: "qwen3:8b", prompt: "hello" },
    context: {},
    onLog: vi.fn(async () => {}),
    ...overrides,
  };
}

describe("ollama_local execute", () => {
  it("round-trips multiple tool calls and supplied tool results", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { role: "assistant", content: null, tool_calls: [
          { id: "call-1", type: "function", function: { name: "one", arguments: '{"x":1}' } },
          { id: "call-2", type: "function", function: { name: "two", arguments: '{"y":2}' } },
        ] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 4, completion_tokens: 2 },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { role: "assistant", content: "finished" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 8, completion_tokens: 3 },
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await execute(context({
      config: {
        baseUrl: "http://127.0.0.1:11434",
        model: "qwen3:8b",
        prompt: "hello",
        tools: [
          { type: "function", function: { name: "one", parameters: { type: "object" } } },
          { type: "function", function: { name: "two", parameters: { type: "object" } } },
        ],
      },
      context: { toolResults: [
        { toolCallId: "call-1", name: "one", content: "one-result" },
        { toolCallId: "call-2", name: "two", content: "two-result" },
      ] },
    }));

    expect(result.summary).toBe("finished");
    expect(result.resultJson).toMatchObject({ toolCalls: [
      { id: "call-1", name: "one", arguments: { x: 1 } },
      { id: "call-2", name: "two", arguments: { y: 2 } },
    ] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body as string).messages).toEqual(expect.arrayContaining([
      { role: "tool", tool_call_id: "call-1", content: "one-result" },
      { role: "tool", tool_call_id: "call-2", content: "two-result" },
    ]));
  });

  it("assembles streaming tokens and parses structured JSON output", async () => {
    const onLog = vi.fn(async () => {});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      "data: {\"choices\":[{\"delta\":{\"content\":\"{\\\"ok\\\":\"}}]}\n\n" +
      "data: {\"choices\":[{\"delta\":{\"content\":\"true}\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":2,\"completion_tokens\":3}}\n\n" +
      "data: [DONE]\n\n",
      { status: 200, headers: { "content-type": "text/event-stream" } },
    )));

    const result = await execute(context({
      onLog,
      config: { baseUrl: "http://127.0.0.1:11434", model: "qwen3:8b", prompt: "json", stream: true,
        responseFormat: { type: "json_object" } },
    }));

    expect(result.resultJson?.structuredOutput).toEqual({ ok: true });
    expect(onLog).toHaveBeenCalledWith("stdout", '{"ok":');
    expect(onLog).toHaveBeenCalledWith("stdout", "true}");
  });

  it("supports native Ollama NDJSON streaming and native JSON format", async () => {
    const onLog = vi.fn(async () => {});
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      '{"message":{"role":"assistant","content":"{"}}\n' +
      '{"message":{"role":"assistant","content":"\\\"ok\\\":true}"},"done":true}\n',
      { status: 200, headers: { "content-type": "application/x-ndjson" } },
    ));
    vi.stubGlobal("fetch", fetchMock);

    const result = await execute(context({
      onLog,
      config: { baseUrl: "http://127.0.0.1:11434", apiMode: "ollama", model: "qwen3:8b", prompt: "json", stream: true,
        responseFormat: { type: "json_object" } },
    }));

    expect(fetchMock.mock.calls[0][0]).toBe("http://127.0.0.1:11434/api/chat");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string).format).toBe("json_object");
    expect(result.resultJson?.structuredOutput).toEqual({ ok: true });
  });

  it("returns timeout and connection classifications instead of leaking transport errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(Object.assign(new Error("The operation was aborted"), { name: "AbortError" })));

    const result = await execute(context({ config: { baseUrl: "http://127.0.0.1:11434", model: "qwen3:8b", prompt: "hello", timeoutSec: 1 } }));
    expect(result.timedOut).toBe(true);
    expect(result.errorCode).toBe("timeout");
    expect(result.errorFamily).toBe("transient_upstream");
  });
});
