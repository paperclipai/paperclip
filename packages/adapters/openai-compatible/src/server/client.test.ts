import { describe, expect, it, vi } from "vitest";
import { normalizeOpenAiCompatibleApiUrl } from "../index.js";
import {
  createChatCompletion,
  isContextLengthError,
  OpenAiCompatibleRequestError,
  parseChatCompletionResponse,
} from "./client.js";

describe("normalizeOpenAiCompatibleApiUrl", () => {
  it("normalizes base and full endpoint URLs", () => {
    expect(normalizeOpenAiCompatibleApiUrl(" https://openrouter.ai/api/v1/ ")).toBe("https://openrouter.ai/api/v1");
    expect(normalizeOpenAiCompatibleApiUrl("https://api.example.com/v1/chat/completions?x=1")).toBe("https://api.example.com/v1");
    expect(normalizeOpenAiCompatibleApiUrl("http://localhost:11434/v1")).toBe("http://localhost:11434/v1");
    expect(normalizeOpenAiCompatibleApiUrl("ftp://example.com")).toBeNull();
    expect(normalizeOpenAiCompatibleApiUrl("not a url")).toBeNull();
  });
});

describe("parseChatCompletionResponse", () => {
  it("extracts text, reasoning, tool calls, and usage", () => {
    const parsed = parseChatCompletionResponse({
      model: "provider/model",
      choices: [{
        finish_reason: "tool_calls",
        message: {
          content: [{ type: "text", text: "Checking." }],
          reasoning_content: "hmm",
          tool_calls: [
            { id: "c1", type: "function", function: { name: "paperclip_api_request", arguments: '{"method":"GET"}' } },
            { type: "function", function: { name: "load_skill", arguments: { name: "paperclip" } } },
            { id: "bad", function: {} },
          ],
        },
      }],
      usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 40 } },
    });
    expect(parsed).toEqual({
      content: "Checking.",
      reasoning: "hmm",
      finishReason: "tool_calls",
      model: "provider/model",
      toolCalls: [
        { id: "c1", type: "function", function: { name: "paperclip_api_request", arguments: '{"method":"GET"}' } },
        { id: "call_1", type: "function", function: { name: "load_skill", arguments: '{"name":"paperclip"}' } },
      ],
      usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 40 },
    });
  });

  it("throws on error payloads and missing choices", () => {
    expect(() => parseChatCompletionResponse({ error: { message: "bad model" } })).toThrow(/bad model/);
    expect(() => parseChatCompletionResponse({ choices: [] })).toThrow(/choices/);
  });
});

describe("createChatCompletion", () => {
  it("posts to {apiUrl}/chat/completions with bearer auth", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "hello" } }] }), { status: 200 }),
    );
    const result = await createChatCompletion({
      apiUrl: "https://api.example.com/v1",
      apiKey: "sk-test",
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 8,
      extraHeaders: { "HTTP-Referer": "https://paperclip.ing" },
      timeoutMs: 5000,
      fetchImpl,
    });
    expect(result.content).toBe("hello");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.example.com/v1/chat/completions");
    expect(init.headers).toMatchObject({ authorization: "Bearer sk-test", "HTTP-Referer": "https://paperclip.ing" });
    expect(JSON.parse(String(init.body))).toEqual({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      stream: false,
      max_tokens: 8,
    });
  });

  it("surfaces provider error messages and classifies context errors", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: "This model's maximum context length is 8192 tokens" } }), { status: 400 }),
    );
    const error = await createChatCompletion({
      apiUrl: "https://api.example.com/v1",
      apiKey: "",
      model: "m",
      messages: [],
      timeoutMs: 5000,
      fetchImpl,
    }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(OpenAiCompatibleRequestError);
    expect((error as Error).message).toBe("Provider returned HTTP 400: This model's maximum context length is 8192 tokens");
    expect(isContextLengthError(error)).toBe(true);
    expect(isContextLengthError(new OpenAiCompatibleRequestError("Provider returned HTTP 401: bad key", { status: 401 }))).toBe(false);
  });
});
