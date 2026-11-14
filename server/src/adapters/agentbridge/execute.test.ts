import { afterEach, describe, expect, it, vi } from "vitest";
import { execute } from "./execute.js";

const guardedFetchMock = vi.hoisted(() => vi.fn());

vi.mock("../http/remote-fetch.js", () => ({
  guardedHttpAdapterFetch: guardedFetchMock,
}));

afterEach(() => {
  guardedFetchMock.mockReset();
});

function baseCtx(overrides: Record<string, unknown> = {}) {
  return {
    runId: "run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Agent",
      adapterType: "agentbridge",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config: { url: "http://localhost:5290" },
    context: { paperclipTaskMarkdown: "Do the task" },
    onLog: async () => {},
    ...overrides,
  } as any;
}

describe("agentbridge adapter execute", () => {
  it("posts the rendered prompt and maps usage, model and session id", async () => {
    const onDispatch = vi.fn();
    guardedFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://localhost:5290/v1/chat/completions");
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body.model).toBe("default-agent");
      expect(body.stream).toBe(false);
      expect((body.messages as Array<{ content: string }>)[0].content).toContain("Do the task");
      return new Response(
        JSON.stringify({
          model: "default-agent",
          session_id: "sess-1",
          choices: [{ message: { role: "assistant", content: "Done." } }],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 5,
            total_tokens: 15,
            prompt_tokens_details: { cached_tokens: 2 },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const result = await execute(baseCtx({ onDispatch }));

    expect(onDispatch).toHaveBeenCalledOnce();
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.provider).toBe("agentbridge");
    expect(result.model).toBe("default-agent");
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5, cachedInputTokens: 2 });
    expect(result.sessionParams).toEqual({ session_id: "sess-1" });
    expect(result.resultJson).toEqual({ content: "Done." });
  });

  it("forwards the configured llm_provider and bearer token", async () => {
    guardedFetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body.llm_provider).toBe("Zai");
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer secret");
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "ok" } }], usage: {} }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    await execute(
      baseCtx({ config: { url: "http://localhost:5290", llmProvider: "Zai", apiKey: "secret" } }),
    );
    expect(guardedFetchMock).toHaveBeenCalledOnce();
  });

  it("forwards the run-scoped connection tools in the request body", async () => {
    const runtimeTools = {
      version: 1,
      guidance: "use the connection tools",
      mcpEndpoint: "https://paperclip.test/mcp/runtime-tools",
      rest: {
        connectionsSearch: "https://paperclip.test/connections/search",
        connectionRequest: "https://paperclip.test/connections/request",
      },
      bearerToken: "run-token",
      expiresAt: "2026-01-01T00:00:00Z",
      tools: ["connections_search", "connection_request"] as const,
    };
    guardedFetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body.paperclipRuntimeTools).toEqual(runtimeTools);
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "ok" } }], usage: {} }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    await execute(baseCtx({ runtimeTools }));
    expect(guardedFetchMock).toHaveBeenCalledOnce();
  });

  it("omits paperclipRuntimeTools when the run has none", async () => {
    guardedFetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect("paperclipRuntimeTools" in body).toBe(false);
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "ok" } }], usage: {} }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    await execute(baseCtx());
    expect(guardedFetchMock).toHaveBeenCalledOnce();
  });

  it("reports a configured request timeout as timed_out", async () => {
    guardedFetchMock.mockImplementation(
      (_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        }),
    );

    const result = await execute(baseCtx({ config: { url: "http://localhost:5290", timeoutMs: 1 } }));

    expect(result.timedOut).toBe(true);
    expect(result.errorCode).toBe("timeout");
    expect(result.errorMessage).toContain("timed out after 1ms");
  });

  it("reports a cancelled run when the operator signal aborts", async () => {
    const runController = new AbortController();
    guardedFetchMock.mockImplementation(
      (_url: string, init?: RequestInit) => {
        // Simulate the operator stopping the run shortly after the request starts.
        setTimeout(() => runController.abort(), 5);
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        });
      },
    );

    const result = await execute(
      baseCtx({
        config: { url: "http://localhost:5290" },
        signal: runController.signal,
      }),
    );

    expect(result.timedOut).toBe(false);
    expect(result.errorCode).toBe("cancelled");
  });

  it("treats an empty assistant reply as a failure", async () => {
    guardedFetchMock.mockImplementation(
      async () =>
        new Response(JSON.stringify({ choices: [], usage: {} }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    const result = await execute(baseCtx());

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("empty_response");
  });
});
