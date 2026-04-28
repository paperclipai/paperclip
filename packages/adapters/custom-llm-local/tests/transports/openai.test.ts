import { afterEach, describe, expect, it, vi } from "vitest";
import { callOpenAiChatCompletions } from "../../src/transports/openai-chat-completions.js";
import type { CustomLlmLocalConfig } from "../../src/schema.js";

const onLog = vi.fn(async () => undefined);

function config(overrides: Partial<CustomLlmLocalConfig> = {}): CustomLlmLocalConfig {
  return {
    model: "or-llama-4-scout",
    baseUrl: "http://127.0.0.1:8317/v1",
    apiKeyEnv: "CLIPROXY_API_KEY",
    transport: "openai_chat_completions",
    timeoutSec: 30,
    graceSec: 1,
    instructionsFilePath: null,
    extraHeaders: {},
    modelAlias: null,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function call(
  signal = new AbortController().signal,
  overrides: Partial<CustomLlmLocalConfig> = {},
  apiKey = "secret-key",
) {
  return callOpenAiChatCompletions({
    config: config(overrides),
    apiKey,
    systemPrompt: "system rules",
    userPrompt: "hello",
    onLog,
    signal,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  onLog.mockClear();
});

describe("callOpenAiChatCompletions", () => {
  it("sends a buffered chat completions request with Authorization bearer header", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        model: "upstream-model",
        choices: [{ message: { content: "pong" }, finish_reason: "stop" }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await call();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8317/v1/chat/completions");
    expect(init.headers).toMatchObject({ Authorization: "Bearer secret-key" });
    expect(JSON.parse(init.body as string)).toEqual({
      model: "or-llama-4-scout",
      stream: false,
      messages: [
        { role: "system", content: "system rules" },
        { role: "user", content: "hello" },
      ],
    });
  });

  it("omits Authorization when no API key is configured", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        model: "upstream-model",
        choices: [{ message: { content: "pong" }, finish_reason: "stop" }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await call(undefined, {}, "");

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.headers).not.toHaveProperty("Authorization");
  });

  it("parses assistant content and usage from the response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          model: "upstream-model",
          choices: [{ message: { content: "pong" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
        }),
      ),
    );

    await expect(call()).resolves.toMatchObject({
      exitCode: 0,
      timedOut: false,
      model: "upstream-model",
      usage: { inputTokens: 11, outputTokens: 7 },
      resultJson: { text: "pong", finishReason: "stop" },
    });
  });

  it("maps 401 responses to AUTH_FAILED", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: "unauthorized" }, 401)));

    await expect(call()).resolves.toMatchObject({ errorCode: "AUTH_FAILED", exitCode: 1 });
  });

  it("maps ECONNREFUSED fetch failures to ENDPOINT_UNREACHABLE", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:1")));

    await expect(call()).resolves.toMatchObject({ errorCode: "ENDPOINT_UNREACHABLE", exitCode: 1 });
  });

  it("maps aborted requests to TIMEOUT", async () => {
    const controller = new AbortController();
    controller.abort();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("AbortError: The operation was aborted")));

    await expect(call(controller.signal)).resolves.toMatchObject({ errorCode: "TIMEOUT", timedOut: true });
  });
});
