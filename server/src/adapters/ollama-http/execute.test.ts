import { afterEach, describe, expect, it, vi } from "vitest";
import { execute } from "./execute.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("ollama_http adapter execute", () => {
  it("auto-selects a coding model from /api/tags and returns the chat response", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          models: [
            { name: "qwen3-coder:32b" },
            { name: "llama3.2:3b" },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          message: { content: "Fallback finished the task." },
          prompt_eval_count: 123,
          eval_count: 45,
        }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const result = await execute({
      runId: "run-1",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Engineer",
        adapterType: "ollama_http",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        baseUrl: "https://ollama.example.test",
        modelPreference: "coding",
      },
      context: {},
      onLog: async () => {},
    });

    expect(result.errorMessage ?? null).toBeNull();
    expect(result.model).toBe("qwen3-coder:32b");
    expect(result.summary).toBe("Fallback finished the task.");
    expect(result.usage).toEqual({ inputTokens: 123, outputTokens: 45 });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, secondCall] = fetchMock.mock.calls;
    expect(secondCall?.[0]).toBeInstanceOf(URL);
    const requestInit = secondCall?.[1] as RequestInit;
    expect(requestInit.method).toBe("POST");
    expect(JSON.parse(String(requestInit.body))).toMatchObject({
      model: "qwen3-coder:32b",
      stream: true,
    });
  });

  it("aggregates native Ollama streaming chat chunks by default", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          models: [
            { name: "devstral-small-2:24b-cloud" },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => [
          JSON.stringify({ message: { role: "assistant", content: "Streaming " }, done: false }),
          JSON.stringify({ message: { role: "assistant", content: "kept Cloudflare alive." }, done: false }),
          JSON.stringify({ done: true, prompt_eval_count: 11, eval_count: 7 }),
          "",
        ].join("\n"),
      });
    vi.stubGlobal("fetch", fetchMock);

    const result = await execute({
      runId: "run-stream",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Engineer",
        adapterType: "ollama_http",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        baseUrl: "https://ollama.example.test",
        modelPreference: "coding",
      },
      context: {},
      onLog: async () => {},
    });

    expect(result.errorMessage ?? null).toBeNull();
    expect(result.summary).toBe("Streaming kept Cloudflare alive.");
    expect(result.usage).toEqual({ inputTokens: 11, outputTokens: 7 });
    expect(result.resultJson).toMatchObject({
      stream: true,
      streamChunkCount: 3,
      response: "Streaming kept Cloudflare alive.",
    });
    expect(JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body))).toMatchObject({
      stream: true,
    });
  });

  it("reports chat timeouts as timed_out", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: URL, init?: RequestInit) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        });
      })),
    );

    const result = await execute({
      runId: "run-2",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Engineer",
        adapterType: "ollama_http",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        baseUrl: "https://ollama.example.test",
        model: "qwen3-coder:32b",
        timeoutMs: 1,
      },
      context: {},
      onLog: async () => {},
    });

    expect(result.timedOut).toBe(true);
    expect(result.errorCode).toBe("timeout");
    expect(result.errorFamily).toBe("transient_upstream");
    expect(result.errorMessage).toContain("timed out after 1ms");
  });

  it("marks Cloudflare 524 chat responses as transient upstream failures with retry timing", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-06T15:44:20.000Z"));
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 524,
        text: async () => JSON.stringify({
          status: 524,
          title: "Error 524: A timeout occurred",
          retryable: true,
          retry_after: 120,
        }),
      }),
    );

    const result = await execute({
      runId: "run-524",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Engineer",
        adapterType: "ollama_http",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        baseUrl: "https://ollama.example.test",
        model: "devstral-small-2:24b-cloud",
      },
      context: {},
      onLog: async () => {},
    });

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("ollama_http_request_failed");
    expect(result.errorFamily).toBe("transient_upstream");
    expect(result.retryNotBefore).toBe("2026-05-06T15:46:20.000Z");
    expect(result.resultJson).toMatchObject({
      status: 524,
      errorFamily: "transient_upstream",
      retryNotBefore: "2026-05-06T15:46:20.000Z",
      selectedModel: "devstral-small-2:24b-cloud",
    });
  });

  it("retries the next ranked auto-selected model when the first one times out", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          models: [
            { name: "qwen3-coder:32b" },
            { name: "qwen3-coder:14b" },
          ],
        }),
      })
      .mockImplementationOnce((_url: URL, init?: RequestInit) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        });
      }))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          message: { content: "Recovered on the second model." },
          prompt_eval_count: 77,
          eval_count: 21,
        }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const result = await execute({
      runId: "run-3",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Engineer",
        adapterType: "ollama_http",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        baseUrl: "https://ollama.example.test",
        modelPreference: "coding",
        timeoutMs: 1,
      },
      context: {},
      onLog: async () => {},
    });

    expect(result.errorMessage ?? null).toBeNull();
    expect(result.model).toBe("qwen3-coder:14b");
    expect(result.summary).toBe("Recovered on the second model.");
    expect(result.resultJson).toMatchObject({
      selectedModel: "qwen3-coder:14b",
      candidateModels: ["qwen3-coder:32b", "qwen3-coder:14b"],
      attemptedModels: [
        {
          model: "qwen3-coder:32b",
          timedOut: true,
        },
        {
          model: "qwen3-coder:14b",
          ok: true,
          status: 200,
        },
      ],
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body))).toMatchObject({
      model: "qwen3-coder:32b",
      stream: true,
    });
    expect(JSON.parse(String((fetchMock.mock.calls[2]?.[1] as RequestInit).body))).toMatchObject({
      model: "qwen3-coder:14b",
      stream: true,
    });
  });
});