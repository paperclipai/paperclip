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
  it("materializes Paperclip managed gateway tools into ctx.config.tools", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const request = JSON.parse(String(init?.body));
      if (url.endsWith("/mcp")) {
        if (request.method === "tools/list") {
          return new Response(JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            result: {
              tools: [{
                name: "read_workspace_file",
                description: "Read a workspace file.",
                inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
              }],
            },
          }), { status: 200 });
        }
        return new Response(JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result: { content: [{ type: "text", text: "README contents" }] },
        }), { status: 200 });
      }
      if (request.messages.length === 1) {
        expect(request.tools).toEqual([{
          type: "function",
          function: {
            name: "read_workspace_file",
            description: "Read a workspace file.",
            parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
          },
        }]);
        return new Response(JSON.stringify({
          choices: [{ message: {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "call-workspace-read", type: "function", function: {
              name: "read_workspace_file",
              arguments: '{"path":"README.md"}',
            } }],
          }, finish_reason: "tool_calls" }],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        choices: [{ message: { role: "assistant", content: "README contents" }, finish_reason: "stop" }],
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const invocation = context({
      config: { baseUrl: "http://127.0.0.1:11434", model: "qwen3:8b", prompt: "read README" },
      context: {
        paperclipManagedMcp: {
          managedMcpOnly: true,
          gateways: [{
            id: "gateway-1",
            name: "Paperclip tools",
            endpointPath: "http://paperclip.test/mcp",
            bearerToken: "run-token",
            tokenPrefix: "pcgw_",
          }],
        },
      },
    });

    const result = await execute(invocation);

    expect(invocation.config.tools).toEqual([{
      type: "function",
      function: expect.objectContaining({ name: "read_workspace_file" }),
    }]);
    expect(result.resultJson).toMatchObject({
      toolCalls: [{ id: "call-workspace-read", name: "read_workspace_file" }],
      toolResults: [{ toolCallId: "call-workspace-read", content: "README contents" }],
    });
  });

  it("discovers bound MCP tools, executes a model tool call, and feeds the actual result back", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/mcp")) {
        const request = JSON.parse(String(init?.body));
        if (request.method === "tools/list") {
          return new Response(JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            result: {
              tools: [{
                name: "read_only_lookup",
                description: "Read a value.",
                inputSchema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
              }],
            },
          }), { status: 200 });
        }
        expect(request).toMatchObject({
          method: "tools/call",
          params: { name: "read_only_lookup", arguments: { key: "answer" } },
        });
        return new Response(JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result: { content: [{ type: "text", text: "actual tool output" }] },
        }), { status: 200 });
      }

      const request = JSON.parse(String(init?.body));
      if (request.messages.length === 1) {
        expect(request.tools).toEqual([{
          type: "function",
          function: {
            name: "read_only_lookup",
            description: "Read a value.",
            parameters: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
          },
        }]);
        return new Response(JSON.stringify({
          choices: [{ message: {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "call-1", type: "function", function: {
              name: "read_only_lookup",
              arguments: '{"key":"answer"}',
            } }],
          }, finish_reason: "tool_calls" }],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        choices: [{ message: { role: "assistant", content: "actual tool output" }, finish_reason: "stop" }],
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await execute(context({
      config: { baseUrl: "http://127.0.0.1:11434", model: "qwen3:8b", prompt: "lookup" },
      runtimeMcp: {
        getServers: () => [{
          name: "Paperclip tools",
          url: "http://paperclip.test/mcp",
          token: "token",
          connectionId: "connection-1",
        }],
      },
    }));

    expect(result.summary).toBe("actual tool output");
    expect(result.resultJson).toMatchObject({
      tool_turns: 1,
      toolResults: [{ toolCallId: "call-1", content: "actual tool output" }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

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
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string).format).toBe("json");
    expect(result.resultJson?.structuredOutput).toEqual({ ok: true });
  });

  it("uses native tool-result messages and unwraps native JSON schemas", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        message: { role: "assistant", content: "", tool_calls: [
          { function: { name: "lookup", arguments: { city: "Chicago" } } },
        ] },
        done_reason: "tool_calls",
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: { role: "assistant", content: "ok" }, done: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await execute(context({
      config: {
        baseUrl: "http://127.0.0.1:11434", apiMode: "ollama", model: "qwen3:8b", prompt: "lookup",
        tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }],
        responseFormat: { type: "json_schema", json_schema: { name: "answer", schema: { type: "object", properties: { ok: { type: "boolean" } } } } },
      },
      context: { toolResults: [{ toolCallId: "call-1", content: "Chicago result" }] },
    }));

    const secondRequest = JSON.parse(fetchMock.mock.calls[1][1].body as string);
    expect(secondRequest.format).toEqual({ type: "object", properties: { ok: { type: "boolean" } } });
    expect(secondRequest.messages).toContainEqual({ role: "tool", content: "Chicago result" });
    expect(secondRequest.messages).not.toContainEqual(expect.objectContaining({ tool_call_id: expect.anything() }));
  });

  it("returns timeout and connection classifications instead of leaking transport errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(Object.assign(new Error("The operation was aborted"), { name: "AbortError" })));

    const result = await execute(context({ config: { baseUrl: "http://127.0.0.1:11434", model: "qwen3:8b", prompt: "hello", timeoutSec: 1 } }));
    expect(result.timedOut).toBe(true);
    expect(result.errorCode).toBe("timeout");
    expect(result.errorFamily).toBe("transient_upstream");
  });
});
