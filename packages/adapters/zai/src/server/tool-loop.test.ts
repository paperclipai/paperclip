import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { z } from "zod";
import type { ToolDefinition } from "@paperclipai/mcp-server";
import { runZaiToolLoop } from "./tool-loop.js";
import type { ZaiChatResponse, ZaiStdoutEvent } from "../shared/types.js";

const baseRequest = {
  model: "glm-5.1",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeFakeTool(name: string, execute: (input: Record<string, unknown>) => Promise<unknown>): ToolDefinition {
  return {
    name,
    description: `fake ${name}`,
    schema: z.object({}).catchall(z.any()),
    execute: async (input) => ({ content: [{ type: "text" as const, text: JSON.stringify(await execute(input)) }] }),
  };
}

function makeChatResponse(opts: { content?: string | null; toolCalls?: Array<{ id: string; name: string; args: string }>; usage?: { p?: number; c?: number } }): ZaiChatResponse {
  return {
    id: "resp_test",
    model: "glm-5.1",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: opts.content ?? null,
          ...(opts.toolCalls && opts.toolCalls.length > 0
            ? {
                tool_calls: opts.toolCalls.map((c) => ({
                  id: c.id,
                  type: "function" as const,
                  function: { name: c.name, arguments: c.args },
                })),
              }
            : {}),
        },
        finish_reason: opts.toolCalls && opts.toolCalls.length > 0 ? "tool_calls" : "stop",
      },
    ],
    usage: {
      prompt_tokens: opts.usage?.p ?? 10,
      completion_tokens: opts.usage?.c ?? 5,
    },
  };
}

describe("runZaiToolLoop", () => {
  // Use a permissive type for the fetch spy since vi.spyOn's generic signature
  // doesn't play well with overloaded fetch types.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fetchSpy: any;
  let events: ZaiStdoutEvent[] = [];
  const onEvent = async (e: ZaiStdoutEvent) => {
    events.push(e);
  };
  const onLog = async () => {};

  beforeEach(() => {
    events = [];
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });
  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("returns immediately when the first response has no tool_calls", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(makeChatResponse({ content: "hello" })));
    const result = await runZaiToolLoop({
      baseUrl: "https://api.example.com/v1",
      apiKey: "k",
      baseRequest,
      initialMessages: [{ role: "user", content: "hi" }],
      maxTurns: 5,
      timeoutMs: 30_000,
      toolsByName: new Map(),
      streamFinalTurn: false,
      onEvent,
      onLog,
    });
    expect(result.exhausted).toBe(false);
    expect(result.turns).toBe(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result.totalUsage.inputTokens).toBe(10);
    expect(result.totalUsage.outputTokens).toBe(5);
  });

  it("dispatches tool_calls, appends tool messages, and re-calls Z.AI until clean", async () => {
    fetchSpy
      .mockResolvedValueOnce(
        jsonResponse(
          makeChatResponse({
            toolCalls: [{ id: "call_1", name: "doThing", args: '{"x":1}' }],
            usage: { p: 10, c: 2 },
          }),
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse(makeChatResponse({ content: "done", usage: { p: 20, c: 3 } })),
      );

    const tool = makeFakeTool("doThing", async (input) => ({ result: `got_x_${input.x}` }));
    const result = await runZaiToolLoop({
      baseUrl: "https://api.example.com/v1",
      apiKey: "k",
      baseRequest,
      initialMessages: [{ role: "user", content: "use the tool" }],
      maxTurns: 5,
      timeoutMs: 30_000,
      toolsByName: new Map([[tool.name, tool]]),
      streamFinalTurn: false,
      onEvent,
      onLog,
    });
    expect(result.exhausted).toBe(false);
    expect(result.turns).toBe(2);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(result.totalUsage.inputTokens).toBe(30);
    expect(result.totalUsage.outputTokens).toBe(5);

    const eventKinds = events.map((e) => e.kind);
    expect(eventKinds).toContain("tool_call");
    expect(eventKinds).toContain("tool_result");

    // The second fetch should have included the assistant tool_calls + tool result.
    const secondCall = fetchSpy.mock.calls[1] as [unknown, RequestInit];
    const body = JSON.parse(secondCall[1].body as string);
    const messages = body.messages;
    expect(messages).toHaveLength(3); // user + assistant(tool_calls) + tool
    expect(messages[1].role).toBe("assistant");
    expect(messages[1].tool_calls).toBeDefined();
    expect(messages[2].role).toBe("tool");
    expect(messages[2].tool_call_id).toBe("call_1");
    const parsedToolContent = JSON.parse(messages[2].content);
    expect(parsedToolContent.ok).toBe(true);
    expect(parsedToolContent.output).toEqual({ result: "got_x_1" });
  });

  it("feeds tool errors back to the model so it can recover", async () => {
    fetchSpy
      .mockResolvedValueOnce(
        jsonResponse(
          makeChatResponse({
            toolCalls: [{ id: "call_1", name: "broken", args: '{"x":1}' }],
          }),
        ),
      )
      .mockResolvedValueOnce(jsonResponse(makeChatResponse({ content: "recovered" })));

    const tool = makeFakeTool("broken", async () => {
      throw new Error("upstream 500");
    });
    const result = await runZaiToolLoop({
      baseUrl: "https://api.example.com/v1",
      apiKey: "k",
      baseRequest,
      initialMessages: [{ role: "user", content: "try the broken tool" }],
      maxTurns: 5,
      timeoutMs: 30_000,
      toolsByName: new Map([[tool.name, tool]]),
      streamFinalTurn: false,
      onEvent,
      onLog,
    });
    expect(result.exhausted).toBe(false);

    const secondBody = JSON.parse(((fetchSpy.mock.calls[1] as [unknown, RequestInit])[1].body) as string);
    const toolMessage = secondBody.messages[secondBody.messages.length - 1];
    expect(toolMessage.role).toBe("tool");
    const parsed = JSON.parse(toolMessage.content);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("tool_threw");
    expect(parsed.error.message).toContain("upstream 500");
  });

  it("marks exhausted when maxTurns is reached and tool_calls are still pending", async () => {
    fetchSpy.mockImplementation(async () =>
      jsonResponse(
        makeChatResponse({
          toolCalls: [{ id: "call_x", name: "doThing", args: "{}" }],
        }),
      ),
    );
    const tool = makeFakeTool("doThing", async () => ({ never: "settles" }));

    const result = await runZaiToolLoop({
      baseUrl: "https://api.example.com/v1",
      apiKey: "k",
      baseRequest,
      initialMessages: [{ role: "user", content: "infinite" }],
      maxTurns: 3,
      timeoutMs: 30_000,
      toolsByName: new Map([[tool.name, tool]]),
      streamFinalTurn: false,
      onEvent,
      onLog,
    });
    expect(result.exhausted).toBe(true);
    expect(result.turns).toBe(3);
    // The loop should have stopped *without* dispatching the final turn's tool calls.
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("throws ZaiHttpError on non-2xx response from Z.AI", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("bad request", { status: 400 }));
    await expect(
      runZaiToolLoop({
        baseUrl: "https://api.example.com/v1",
        apiKey: "k",
        baseRequest,
        initialMessages: [{ role: "user", content: "hi" }],
        maxTurns: 5,
        timeoutMs: 30_000,
        toolsByName: new Map(),
        streamFinalTurn: false,
        onEvent,
        onLog,
      }),
    ).rejects.toThrow(/Z\.AI HTTP 400/);
  });
});
