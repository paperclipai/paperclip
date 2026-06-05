import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { execute } from "./execute.js";

const fetchMock = vi.fn<typeof fetch>();

function makeContext(): AdapterExecutionContext {
  return {
    runId: "run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Ada",
      adapterType: "local",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config: {
      model: "qwen/qwen3-coder-30b",
      baseUrl: "http://localhost:1234/v1",
    },
    context: {
      paperclipTaskMarkdown: "Do the smallest useful thing.",
    },
    onLog: vi.fn(async () => {}),
    onMeta: vi.fn(async () => {}),
  };
}

describe("local adapter execute", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts chat completions and returns the assistant summary", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: "Done: local smoke passed." } }],
      usage: { prompt_tokens: 12, completion_tokens: 7 },
    }), { status: 200 }));

    const result = await execute(makeContext());

    expect(result).toMatchObject({
      exitCode: 0,
      provider: "local",
      biller: "local",
      model: "qwen/qwen3-coder-30b",
      summary: "Done: local smoke passed.",
      usage: { inputTokens: 12, outputTokens: 7 },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:1234/v1/chat/completions",
      expect.objectContaining({ method: "POST" }),
    );
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.model).toBe("qwen/qwen3-coder-30b");
  });

  it("returns an adapter failure when the endpoint rejects the request", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      error: { message: "model not loaded" },
    }), { status: 503 }));

    const result = await execute(makeContext());

    expect(result).toMatchObject({
      exitCode: 1,
      errorCode: "local_http_503",
      errorMessage: "Local inference returned HTTP 503",
    });
  });
});
