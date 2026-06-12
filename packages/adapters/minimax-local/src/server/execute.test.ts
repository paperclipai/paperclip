import { beforeEach, describe, expect, it, vi } from "vitest";
import { execute } from "./execute.js";

describe("minimax_local execute", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.MINIMAX_API_KEY;
    delete process.env.MINIMAX_API_KEY_FILE;
  });

  it("strips think blocks and reports usage", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        id: "chatcmpl-1",
        object: "chat.completion",
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: "<think>hidden</think>\nVisible answer",
            },
          },
        ],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 7,
        },
      }),
    } as Response);

    const logs: Array<{ stream: string; chunk: string }> = [];
    const result = await execute({
      runId: "run-1",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "MiniMax",
        adapterType: "minimax_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        env: { MINIMAX_API_KEY: "test-key" },
      },
      context: {},
      onLog: async (stream, chunk) => {
        logs.push({ stream, chunk });
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe("Visible answer");
    expect(result.model).toBe("MiniMax-M3");
    expect(result.usage).toEqual({
      inputTokens: 12,
      outputTokens: 7,
      cachedInputTokens: 0,
    });
    expect(logs).toEqual([
      { stream: "stdout", chunk: "Visible answer\n" },
    ]);
  });

  it("returns a structured error on API failure", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 402,
      json: async () => ({
        error: {
          type: "insufficient_balance_error",
          message: "Insufficient balance",
        },
      }),
    } as Response);

    const logs: Array<{ stream: string; chunk: string }> = [];
    const result = await execute({
      runId: "run-2",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "MiniMax",
        adapterType: "minimax_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        env: { MINIMAX_API_KEY: "test-key" },
      },
      context: {},
      onLog: async (stream, chunk) => {
        logs.push({ stream, chunk });
      },
    });

    expect(result.exitCode).toBe(402);
    expect(result.errorCode).toBe("http_402");
    expect(result.errorMessage).toBe("Insufficient balance");
    expect(logs[0]).toEqual({ stream: "stderr", chunk: "Insufficient balance\n" });
  });
});
