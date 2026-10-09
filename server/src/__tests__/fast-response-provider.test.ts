import { describe, expect, it, vi } from "vitest";
import type { AiConnectionMetadata } from "@paperclipai/shared";
import {
  fastResponsePrompt,
  fastResponseReceipt,
  runFastResponseProvider,
} from "../services/fast-response-provider.js";
const ack =
  "I’ll check the settings panel’s border styling and work on the fix.";
const chatResponse = () => ({
  id: "receipt-1",
  model: "openai/gpt-oss-120b",
  created: 1,
  choices: [
    {
      index: 0,
      finish_reason: "stop",
      message: { role: "assistant", content: ack },
    },
  ],
  usage: {
    prompt_tokens: 100,
    completion_tokens: 15,
    total_tokens: 115,
    cost: 0.00001,
  },
});
const response = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
const input = (metadata: AiConnectionMetadata) => ({
  metadata,
  model: "test-model",
  credential: "fixture-key",
  prompt: fastResponsePrompt({ agentName: "Alex", message: "Fix the border" }),
  signal: AbortSignal.timeout(3000),
});
const connections: AiConnectionMetadata[] = [
  ...(["openrouter", "openai", "anthropic", "google", "xai"] as const).map(
    (provider) => ({ provider, method: "api_key" as const }),
  ),
  {
    provider: "anthropic",
    method: "api_key",
    routing: {
      kind: "bedrock",
      protocol: "bedrock",
      region: "us-west-2",
      auth: "bearer",
      models: [],
    },
  },
  ...(["chat", "responses", "messages"] as const).map((protocol) => ({
    provider: "openai" as const,
    method: "api_key" as const,
    routing: {
      kind: "gateway" as const,
      protocol,
      baseUrl: "https://gateway.example/v1",
      auth: "bearer" as const,
      models: [],
    },
  })),
  {
    provider: "openai",
    method: "api_key",
    routing: {
      kind: "local",
      protocol: "chat",
      baseUrl: "http://localhost:8080/v1",
      auth: "none",
      models: [],
    },
  },
  ...(["responses", "messages"] as const).map((protocol) => ({
    provider: "openrouter" as const,
    method: "api_key" as const,
    routing: {
      kind: "openrouter" as const,
      protocol,
      auth: "bearer" as const,
      models: [],
    },
  })),
];
describe("fast response provider", () => {
  it("bounds unicode input and drops old context first", () => {
    const prompt = fastResponsePrompt({
      agentName: "Alex",
      message: "🦄".repeat(10000),
      recent: ["OLD-CONTEXT".repeat(1000)],
    });
    expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(4096);
    expect(prompt).not.toContain("OLD-CONTEXT");
    expect(prompt).toContain("[truncated]");
  });
  it("bounds escaped metadata and multibyte attachment names without losing the current request", () => {
    const prompt = fastResponsePrompt({
      agentName: "\u0001".repeat(100),
      title: "🦄".repeat(200),
      attachments: Array(5).fill("\u0001".repeat(80)),
      message: "Fix the border",
      recent: ["old".repeat(2000)],
    });
    expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(4096);
    expect(prompt).toContain("Fix the border");
  });
  it("calls OpenRouter through the SDK with latency routing and records the charge", async () => {
    const fetch = vi.fn(async () => response(chatResponse()));
    const result = await runFastResponseProvider(
      input({ provider: "openrouter", method: "api_key" }),
      { fetch },
    );
    expect(result.text).toBe(ack);
    expect(result.receipt).toMatchObject({
      inputTokens: 100,
      outputTokens: 15,
      costStatus: "reported",
      costCents: "0.0010000",
    });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({
      model: "test-model",
      max_tokens: 256,
      provider: { sort: "latency" },
    });
    expect(body.tools).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([
    [
      {
        provider: "openai",
        method: "api_key",
        routing: {
          kind: "gateway",
          protocol: "chat",
          baseUrl: "https://gateway.example/v1",
          auth: "bearer",
          models: [],
        },
      },
      "https://gateway.example/v1/chat/completions",
      "Bearer fixture-key",
    ],
    [
      {
        provider: "openai",
        method: "api_key",
        routing: {
          kind: "local",
          protocol: "chat",
          baseUrl: "http://localhost:8080/v1",
          auth: "none",
          models: [],
        },
      },
      "http://localhost:8080/v1/chat/completions",
      null,
    ],
  ] as const)(
    "honors saved chat endpoint/auth %j",
    async (metadata, expectedUrl, auth) => {
      const fetch = vi.fn(async () => response(chatResponse()));
      const result = await runFastResponseProvider(
        input(metadata as AiConnectionMetadata),
        { fetch },
      );
      expect(result.text).toBe(ack);
      const [url, init] = fetch.mock.calls[0] as unknown as [
        string,
        RequestInit,
      ];
      expect(url).toBe(expectedUrl);
      expect(new Headers(init.headers).get("authorization")).toBe(auth);
    },
  );
  it.each([
    [
      { provider: "openai", method: "api_key" },
      "https://api.openai.com/v1/responses",
    ],
    [{ provider: "xai", method: "api_key" }, "https://api.x.ai/v1/responses"],
    [
      {
        provider: "openai",
        method: "api_key",
        routing: {
          kind: "openrouter",
          protocol: "responses",
          auth: "bearer",
          models: [],
        },
      },
      "https://openrouter.ai/api/v1/responses",
    ],
    [
      {
        provider: "openai",
        method: "api_key",
        routing: {
          kind: "gateway",
          protocol: "responses",
          baseUrl: "https://gateway.example/v1",
          auth: "bearer",
          models: [],
        },
      },
      "https://gateway.example/v1/responses",
    ],
  ] as const)("supports Responses %j", async (metadata, url) => {
    const fetch = vi.fn(async () =>
      response({
        id: "resp_1",
        object: "response",
        created_at: 1,
        model: "test-model",
        status: "completed",
        output: [
          {
            type: "message",
            id: "msg_1",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: ack, annotations: [] }],
          },
        ],
        usage: { input_tokens: 100, output_tokens: 15, total_tokens: 115 },
      }),
    );
    const result = await runFastResponseProvider(
      input(metadata as AiConnectionMetadata),
      { fetch },
    );
    expect(result.text).toBe(ack);
    expect(result.receipt).toMatchObject({
      inputTokens: 100,
      outputTokens: 15,
    });
    const [actual, init] = fetch.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(actual).toBe(url);
    expect(new Headers(init.headers).get("authorization")).toBe(
      "Bearer fixture-key",
    );
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: "test-model",
      max_output_tokens: 256,
    });
  });
  it.each([
    [
      { provider: "anthropic", method: "api_key" },
      "https://api.anthropic.com/v1/messages",
      "x-api-key",
      "fixture-key",
    ],
    [
      {
        provider: "anthropic",
        method: "api_key",
        routing: {
          kind: "openrouter",
          protocol: "messages",
          auth: "bearer",
          models: [],
        },
      },
      "https://openrouter.ai/api/v1/messages",
      "authorization",
      "Bearer fixture-key",
    ],
    [
      {
        provider: "anthropic",
        method: "api_key",
        routing: {
          kind: "gateway",
          protocol: "messages",
          baseUrl: "https://messages.example/v1",
          auth: "bearer",
          models: [],
        },
      },
      "https://messages.example/v1/messages",
      "authorization",
      "Bearer fixture-key",
    ],
  ] as const)("supports Messages %j", async (metadata, url, header, key) => {
    const fetch = vi.fn(async () =>
      response({
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "test-model",
        content: [{ type: "text", text: ack }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: 15 },
      }),
    );
    const result = await runFastResponseProvider(
      input(metadata as AiConnectionMetadata),
      { fetch },
    );
    expect(result.text).toBe(ack);
    expect(result.receipt).toMatchObject({
      inputTokens: 100,
      outputTokens: 15,
    });
    const [actual, init] = fetch.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(actual).toBe(url);
    expect(new Headers(init.headers).get(header)).toBe(key);
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: "test-model",
      max_tokens: 256,
    });
  });
  it("supports Google generation and auth", async () => {
    const fetch = vi.fn(async () =>
      response({
        candidates: [
          {
            content: { role: "model", parts: [{ text: ack }] },
            finishReason: "STOP",
            index: 0,
          },
        ],
        usageMetadata: {
          promptTokenCount: 100,
          candidatesTokenCount: 15,
          totalTokenCount: 115,
        },
      }),
    );
    const result = await runFastResponseProvider(
      input({ provider: "google", method: "api_key" }),
      { fetch },
    );
    expect(result.text).toBe(ack);
    expect(result.receipt).toMatchObject({
      inputTokens: 100,
      outputTokens: 15,
    });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/test-model:generateContent",
    );
    expect(new Headers(init.headers).get("x-goog-api-key")).toBe("fixture-key");
    expect(JSON.parse(String(init.body)).generationConfig.maxOutputTokens).toBe(
      256,
    );
  });
  it("supports Bedrock region, bearer key and Converse", async () => {
    const fetch = vi.fn(async () =>
      response({
        output: { message: { role: "assistant", content: [{ text: ack }] } },
        stopReason: "end_turn",
        usage: { inputTokens: 100, outputTokens: 15, totalTokens: 115 },
        metrics: { latencyMs: 50 },
      }),
    );
    const result = await runFastResponseProvider(
      input({
        provider: "anthropic",
        method: "api_key",
        routing: {
          kind: "bedrock",
          protocol: "bedrock",
          region: "us-west-2",
          auth: "bearer",
          models: [],
        },
      }),
      { fetch },
    );
    expect(result.text).toBe(ack);
    expect(result.receipt).toMatchObject({
      inputTokens: 100,
      outputTokens: 15,
    });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      "https://bedrock-runtime.us-west-2.amazonaws.com/model/test-model/converse",
    );
    expect(new Headers(init.headers).get("authorization")).toBe(
      "Bearer fixture-key",
    );
    expect(JSON.parse(String(init.body)).inferenceConfig.maxTokens).toBe(256);
  });
  it.each(connections)(
    "aborts once without inventing a billing outcome for %j",
    async (metadata) => {
      const controller = new AbortController();
      const fetch = vi.fn(async () => {
        controller.abort();
        throw new DOMException("aborted", "AbortError");
      });
      const result = await runFastResponseProvider(
        { ...input(metadata), signal: controller.signal },
        { fetch },
      );
      expect(result).toMatchObject({
        errorCode: "timeout",
        receipt: { costStatus: "unpriced" },
      });
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );
  it.each(connections)(
    "never retries provider rejection or retains error bodies for %j",
    async (metadata) => {
      const fetch = vi.fn(
        async () =>
          new Response(
            JSON.stringify({ error: { message: "SECRET provider input" } }),
            { status: 401, headers: { "content-type": "application/json" } },
          ),
      );
      const result = await runFastResponseProvider(input(metadata), { fetch });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(result.errorCode).toBe("provider_auth_failed");
      expect(result.noProviderWork).toBe(true);
      expect(JSON.stringify(result)).not.toContain("SECRET");
    },
  );
  it("rejects long output without discarding its charge", async () => {
    const body = chatResponse();
    body.choices[0].message.content = "x".repeat(321);
    const result = await runFastResponseProvider(
      input({ provider: "openrouter", method: "api_key" }),
      { fetch: async () => response(body) },
    );
    expect(result.text).toBeUndefined();
    expect(result.errorCode).toBe("invalid_output");
    expect(result.receipt.costStatus).toBe("reported");
  });
  it("does not invent a price", () => {
    expect(fastResponseReceipt({ usage: { inputTokens: 5 } })).toMatchObject({
      inputTokens: 5,
      costCents: null,
      costStatus: "unpriced",
    });
  });
});
