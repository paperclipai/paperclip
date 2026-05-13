import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { execute } from "./execute.js";

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));

vi.stubGlobal("fetch", fetchMock);

function makeContext(
  configOverrides: Record<string, unknown> = {},
  contextOverrides: Record<string, unknown> = {},
): AdapterExecutionContext & { logs: string[] } {
  const logs: string[] = [];
  return {
    runId: "run-test",
    agent: { id: "agent-1", name: "TestAgent", adapterType: "kilocode_gateway", adapterConfig: {} } as never,
    runtime: {} as never,
    config: {
      apiKey: "test-api-key",
      model: "anthropic/claude-sonnet-4.5",
      stream: false,
      ...configOverrides,
    },
    context: {
      userMessage: "Hello, world",
      ...contextOverrides,
    },
    onLog: async (_stream: "stdout" | "stderr", chunk: string) => { logs.push(chunk); },
    logs,
  } as never;
}

function makeJsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
    body: null,
  } as unknown as Response;
}

function makeTextResponse(text: string, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    json: async () => { throw new Error("not json"); },
    body: null,
  } as unknown as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.KILO_API_KEY;
});

describe("execute — no API key", () => {
  it("returns error when no apiKey in config and no env var", async () => {
    const ctx = makeContext({ apiKey: "" });
    const result = await execute(ctx as never);
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("kilocode_gateway_no_api_key");
  });

  it("reads apiKey from KILO_API_KEY env var", async () => {
    process.env.KILO_API_KEY = "env-api-key";
    fetchMock.mockResolvedValueOnce(
      makeJsonResponse({
        model: "anthropic/claude-sonnet-4.5",
        choices: [{ message: { role: "assistant", content: "Hi" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    );
    const ctx = makeContext({ apiKey: "", model: "anthropic/claude-sonnet-4.5", stream: false });
    const result = await execute(ctx as never);
    expect(result.exitCode).toBe(0);
    const call = fetchMock.mock.calls[0];
    expect(call[1].headers.Authorization).toBe("Bearer env-api-key");
  });
});

describe("execute — HTTP errors", () => {
  it.each([
    [400, "kilocode_gateway_bad_request"],
    [401, "kilocode_gateway_unauthorized"],
    [402, "kilocode_gateway_payment_required"],
    [403, "kilocode_gateway_forbidden"],
    [429, "kilocode_gateway_rate_limited"],
    [500, "kilocode_gateway_server_error"],
    [502, "kilocode_gateway_bad_gateway"],
    [503, "kilocode_gateway_service_unavailable"],
  ])("maps HTTP %i to errorCode %s", async (status, expectedCode) => {
    fetchMock.mockResolvedValueOnce(makeTextResponse("error details", status));
    const ctx = makeContext();
    const result = await execute(ctx as never);
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe(expectedCode);
  });
});

describe("execute — non-streaming", () => {
  it("returns content and token usage on success", async () => {
    fetchMock.mockResolvedValueOnce(
      makeJsonResponse({
        model: "anthropic/claude-sonnet-4.5",
        choices: [{ message: { role: "assistant", content: "Hello there!" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 20, completion_tokens: 8 },
      }),
    );

    const ctx = makeContext({ stream: false });
    const result = await execute(ctx as never);

    expect(result.exitCode).toBe(0);
    expect(ctx.logs).toContain("Hello there!");
    expect(result.usage?.inputTokens).toBe(20);
    expect(result.usage?.outputTokens).toBe(8);
    expect(result.model).toBe("anthropic/claude-sonnet-4.5");
    expect(result.provider).toBe("kilocode");
  });

  it("sends correct request body", async () => {
    fetchMock.mockResolvedValueOnce(
      makeJsonResponse({
        model: "openai/gpt-4o",
        choices: [{ message: { role: "assistant", content: "Done" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 2 },
      }),
    );

    const ctx = makeContext({
      apiKey: "my-key",
      model: "openai/gpt-4o",
      temperature: 0.5,
      maxTokens: 1024,
      stream: false,
    });

    await execute(ctx as never);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.kilo.ai/api/gateway/chat/completions");
    expect(init.headers).toMatchObject({
      Authorization: "Bearer my-key",
      "Content-Type": "application/json",
    });

    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("openai/gpt-4o");
    expect(body.temperature).toBe(0.5);
    expect(body.max_tokens).toBe(1024);
    expect(body.stream).toBe(false);
  });

  it("respects custom baseUrl", async () => {
    fetchMock.mockResolvedValueOnce(
      makeJsonResponse({
        choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    );

    const ctx = makeContext({ baseUrl: "https://custom.kilo.example/api/gateway", stream: false });
    await execute(ctx as never);

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://custom.kilo.example/api/gateway/chat/completions");
  });
});

describe("execute — streaming", () => {
  function makeStreamResponse(chunks: string[]): Response {
    const encoder = new TextEncoder();
    let i = 0;
    const body = {
      getReader: () => ({
        read: async () => {
          if (i >= chunks.length) return { done: true, value: undefined };
          return { done: false, value: encoder.encode(chunks[i++]) };
        },
      }),
    };
    return {
      ok: true,
      status: 200,
      body,
    } as unknown as Response;
  }

  it("streams SSE chunks and accumulates usage", async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{"content":" world"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":15,"completion_tokens":6}}\n\n',
      "data: [DONE]\n\n",
    ];

    fetchMock.mockResolvedValueOnce(makeStreamResponse(chunks));

    const ctx = makeContext({ stream: true });
    const result = await execute(ctx as never);

    expect(result.exitCode).toBe(0);
    expect(ctx.logs).toContain("Hello");
    expect(ctx.logs).toContain(" world");
    expect(result.usage?.inputTokens).toBe(15);
    expect(result.usage?.outputTokens).toBe(6);
  });
});
