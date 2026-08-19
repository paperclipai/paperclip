import { afterEach, describe, expect, it, vi } from "vitest";
import { execute } from "./execute.js";
import type { AdapterExecutionContext } from "../types.js";

function makeContext(config: Record<string, unknown>): AdapterExecutionContext {
  return {
    runId: "run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Pilot",
      adapterType: "openai_compatible",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config: {
      baseUrl: "http://127.0.0.1:8080",
      model: "local-model",
      promptTemplate: "Issue: {{context.issue.identifier}}",
      ...config,
    },
    context: {
      issue: {
        identifier: "TST-1",
        title: "Synthetic task",
      },
    },
    onLog: vi.fn(async () => {}),
    onMeta: vi.fn(async () => {}),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("openai_compatible adapter execute", () => {
  it("captures assistant content from a synthetic OpenAI-compatible endpoint", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        model: "local-model",
        messages: [{ role: "user", content: "Issue: TST-1" }],
      });
      return new Response(JSON.stringify({
        choices: [{ message: { content: "Captured answer" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 7, completion_tokens: 3 },
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await execute(makeContext({}));

    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe("Captured answer");
    expect(result.resultJson).toMatchObject({
      summary: "Captured answer",
      result: "Captured answer",
      model: "local-model",
      finishReason: "stop",
    });
    expect(result.usage).toEqual({ inputTokens: 7, outputTokens: 3 });
  });

  it("reports request timeout as a failed closed timed-out run", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        });
      })),
    );

    const result = await execute(makeContext({ timeoutMs: 1 }));

    expect(result.timedOut).toBe(true);
    expect(result.errorCode).toBe("timeout");
    expect(result.errorMessage).toContain("timed out after 1ms");
  });

  it("fails closed on empty assistant content", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: "" }, finish_reason: "stop" }],
    }), { status: 200 })));

    const result = await execute(makeContext({}));

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("openai_compatible_empty_content");
    expect(result.resultJson?.error).toContain("no assistant content");
  });

  it("fails closed and cancels the response body on endpoint HTTP errors", async () => {
    const response = new Response("server unavailable", { status: 503 });
    const cancel = vi.spyOn(response.body!, "cancel").mockResolvedValue(undefined);
    vi.stubGlobal("fetch", vi.fn(async () => response));

    const result = await execute(makeContext({}));

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("openai_compatible_http_error");
    expect(result.errorMessage).toContain("HTTP 503");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("fails closed on network-level fetch errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("fetch failed");
    }));

    const result = await execute(makeContext({}));

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("openai_compatible_network_error");
    expect(result.resultJson?.error).toContain("network error");
  });

  it("fails closed on invalid endpoint JSON response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not json", { status: 200 })));

    const result = await execute(makeContext({}));

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("openai_compatible_invalid_response");
    expect(result.resultJson?.error).toContain("invalid JSON response");
  });

  it("fails closed on non-JSON structured output", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: "not json" }, finish_reason: "stop" }],
    }), { status: 200 })));

    const result = await execute(makeContext({ structuredOutput: true }));

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("openai_compatible_invalid_json");
    expect(result.resultJson).toMatchObject({ summary: "not json" });
  });

  it("strips reasoning_content and validates final JSON content", async () => {
    const log = vi.fn(async () => {});
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      choices: [{
        message: {
          reasoning_content: "private reasoning",
          content: "{\"ok\":true}",
        },
        finish_reason: "stop",
      }],
    }), { status: 200 })));

    const result = await execute({
      ...makeContext({ structuredOutput: true }),
      onLog: log,
    });

    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe("{\"ok\":true}");
    expect(result.resultJson).toMatchObject({
      hasReasoningContent: true,
      structuredOutput: { ok: true },
    });
    expect(JSON.stringify(result.resultJson)).not.toContain("private reasoning");
    expect(log).toHaveBeenCalledWith("stderr", expect.stringContaining("omitted reasoning_content"));
  });
});
