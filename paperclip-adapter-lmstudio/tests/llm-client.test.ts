import { describe, it, expect, vi, beforeEach } from "vitest";
import { callChatCompletion, streamChatCompletion } from "../src/server/llm-client.js";

describe("callChatCompletion", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("sends tools array and returns parsed message", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { role: "assistant", content: "Hello" } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await callChatCompletion({
      url: "http://localhost:1234",
      model: "gemma-4-31b-it",
      messages: [{ role: "user", content: "Hi" }],
      tools: [{ type: "function", function: { name: "test", description: "", parameters: { type: "object", properties: {} } } }],
      timeoutMs: 30000,
    });

    expect(result.message.content).toBe("Hello");
    expect(result.usage?.inputTokens).toBe(10);
    expect(result.usage?.outputTokens).toBe(5);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.tools).toHaveLength(1);
    expect(body.stream).toBe(false);
    expect(body.tool_choice).toBe("auto");
  });

  it("extracts tool_calls from response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: "call_1",
              type: "function",
              function: { name: "fs_read_file", arguments: '{"path":"a.txt"}' },
            }],
          },
        }],
      }),
    }));

    const result = await callChatCompletion({
      url: "http://localhost:1234",
      model: "m",
      messages: [],
      tools: [],
      timeoutMs: 30000,
    });

    expect(result.message.tool_calls).toHaveLength(1);
    expect(result.message.tool_calls![0].function.name).toBe("fs_read_file");
  });

  it("returns error on non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "boom",
    }));

    await expect(callChatCompletion({
      url: "http://localhost:1234",
      model: "m",
      messages: [],
      tools: [],
      timeoutMs: 30000,
    })).rejects.toThrow(/500/);
  });
});

describe("streamChatCompletion", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("streams tokens via onToken callback", async () => {
    const sseBody = 'data: {"choices":[{"delta":{"content":"He"}}]}\n\ndata: {"choices":[{"delta":{"content":"llo"}}]}\n\ndata: [DONE]\n\n';
    const mockBody = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(sseBody));
        controller.close();
      },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, body: mockBody }));

    const tokens: string[] = [];
    const fullText = await streamChatCompletion({
      url: "http://localhost:1234",
      model: "m",
      messages: [],
      timeoutMs: 30000,
      onToken: async (t) => { tokens.push(t); },
    });

    expect(tokens).toEqual(["He", "llo"]);
    expect(fullText).toBe("Hello");
  });
});
