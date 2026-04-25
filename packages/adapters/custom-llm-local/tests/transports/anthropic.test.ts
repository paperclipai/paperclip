import { afterEach, describe, expect, it, vi } from "vitest";
import { callAnthropicMessages } from "../../src/transports/anthropic-messages.js";
import type { CustomLlmLocalConfig } from "../../src/schema.js";

const onLog = vi.fn(async () => undefined);

function config(overrides: Partial<CustomLlmLocalConfig> = {}): CustomLlmLocalConfig {
  return {
    model: "anthropic/claude-sonnet-4-6",
    baseUrl: "http://127.0.0.1:8317/v1",
    apiKeyEnv: "CLIPROXY_API_KEY",
    transport: "anthropic_messages",
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

async function call(signal = new AbortController().signal, overrides: Partial<CustomLlmLocalConfig> = {}) {
  return callAnthropicMessages({
    config: config(overrides),
    apiKey: "secret-key",
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

describe("callAnthropicMessages", () => {
  it("sends a Messages request with system, x-api-key, and anthropic-version", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        model: "upstream-model",
        content: [{ type: "text", text: "pong" }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await call();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8317/v1/messages");
    expect(init.headers).toMatchObject({
      "x-api-key": "secret-key",
      "anthropic-version": "2023-06-01",
    });
    expect(JSON.parse(init.body as string)).toEqual({
      model: "anthropic/claude-sonnet-4-6",
      max_tokens: 8192,
      system: "system rules",
      messages: [{ role: "user", content: "hello" }],
    });
  });

  it("parses text content and usage from the response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          model: "upstream-model",
          content: [{ type: "text", text: "pong" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 13, output_tokens: 5 },
        }),
      ),
    );

    await expect(call()).resolves.toMatchObject({
      exitCode: 0,
      timedOut: false,
      model: "upstream-model",
      usage: { inputTokens: 13, outputTokens: 5 },
      resultJson: { text: "pong", finishReason: "end_turn" },
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
