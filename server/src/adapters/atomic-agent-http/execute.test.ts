import { afterEach, describe, expect, it, vi } from "vitest";
import { execute } from "./execute.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("atomic_agent_http execute", () => {
  it("returns assistant text and usage on success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "Shipped fix for login." } }],
            usage: { prompt_tokens: 10, completion_tokens: 20 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    const result = await execute({
      runId: "run-1",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Atomic",
        adapterType: "atomic_agent_http",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        baseUrl: "http://127.0.0.1:1337",
        model: "gemma-4-E4B-it-IQ4_XS",
        timeoutMs: 30_000,
      },
      context: { paperclipWake: null },
      onLog: async () => {},
    });

    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe("Shipped fix for login.");
    expect(result.resultJson?.summary).toBe("Shipped fix for login.");
    expect(result.usage).toMatchObject({
      inputTokens: 10,
      outputTokens: 20,
    });
    expect(result.model).toBe("gemma-4-E4B-it-IQ4_XS");
  });

  it("reports timeout", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        });
      })),
    );

    const result = await execute({
      runId: "run-1",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Atomic",
        adapterType: "atomic_agent_http",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        baseUrl: "http://127.0.0.1:1337",
        model: "m",
        timeoutMs: 1,
      },
      context: {},
      onLog: async () => {},
    });

    expect(result.timedOut).toBe(true);
    expect(result.errorCode).toBe("timeout");
  });
});
