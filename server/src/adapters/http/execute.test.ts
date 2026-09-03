import { afterEach, describe, expect, it, vi } from "vitest";
import { CONNECTION_INTENT_AGENT_GUIDANCE } from "@paperclipai/shared";
import { execute } from "./execute.js";
import type { AdapterExecutionContext } from "../types.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    text: async () => JSON.stringify(body),
  };
}

// The tree runs with noUncheckedIndexedAccess, so reach into the recorded fetch
// calls through guards rather than asserting the tuple shape.
function fetchCall(mock: { mock: { calls: unknown[][] } }, index: number) {
  const call = mock.mock.calls[index];
  if (!call) throw new Error(`expected a fetch call at index ${index}`);
  return { url: String(call[0]), init: call[1] as RequestInit | undefined };
}

function requestBody(mock: { mock: { calls: unknown[][] } }, index = 0): Record<string, unknown> {
  const { init } = fetchCall(mock, index);
  if (!init?.body) throw new Error(`fetch call ${index} carried no body`);
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

function buildContext(
  config: Record<string, unknown>,
  overrides: Partial<AdapterExecutionContext> = {},
): AdapterExecutionContext {
  return {
    runId: "run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Agent",
      adapterType: "http",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config,
    context: {},
    onLog: async () => {},
    ...overrides,
  } as AdapterExecutionContext;
}

// A poll block that finishes on the first attempt, so the tests never sleep for
// the 2000ms default.
const FAST_POLL = {
  enabled: true,
  urlTemplate: "https://runtime.test/runs/{{run_id}}",
  intervalMs: 0,
  maxAttempts: 3,
};

describe("http adapter execute", () => {
  it("delivers the complete runtime connection descriptor and shared guidance", async () => {
    const onDispatch = vi.fn();
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(onDispatch).toHaveBeenCalledOnce();
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body.paperclipRuntimeTools).toEqual({
        version: 1,
        guidance: CONNECTION_INTENT_AGENT_GUIDANCE,
        mcpEndpoint: "https://paperclip.test/mcp/runtime-tools",
        rest: {
          connectionsSearch: "https://paperclip.test/runtime-tools/connections/search",
          connectionRequest: "https://paperclip.test/runtime-tools/connections/request",
        },
        bearerToken: "run-token",
        expiresAt: "2026-08-26T15:00:00.000Z",
        tools: ["connections_search", "connection_request"],
      });
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await execute({
      runId: "run-1",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Agent",
        adapterType: "http",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: { url: "https://example.test/webhook" },
      context: {},
      runtimeTools: {
        version: 1,
        guidance: CONNECTION_INTENT_AGENT_GUIDANCE,
        mcpEndpoint: "https://paperclip.test/mcp/runtime-tools",
        rest: {
          connectionsSearch: "https://paperclip.test/runtime-tools/connections/search",
          connectionRequest: "https://paperclip.test/runtime-tools/connections/request",
        },
        bearerToken: "run-token",
        expiresAt: "2026-08-26T15:00:00.000Z",
        tools: ["connections_search", "connection_request"],
      },
      onLog: async () => {},
      onDispatch,
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(onDispatch).toHaveBeenCalledOnce();
  });

  it("reports configured request timeout as timed_out", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        });
      })),
    );

    const result = await execute(buildContext({
      url: "https://example.test/webhook",
      timeoutMs: 1,
    }));

    expect(result.timedOut).toBe(true);
    expect(result.errorCode).toBe("timeout");
    expect(result.errorMessage).toContain("timed out after 1ms");
  });

  it("renders payload template strings with run context", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);

    await execute(buildContext(
      {
        url: "https://example.test/webhook",
        payloadTemplate: { input: "Work issue {{ context.issueId }} for {{ agent.name }}" },
      },
      { context: { issueId: "issue-42" } },
    ));

    const body = requestBody(fetchMock);
    expect(body.input).toBe("Work issue issue-42 for Agent");
  });

  it("leaves non-string payload values untouched", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);

    await execute(buildContext({
      url: "https://example.test/webhook",
      payloadTemplate: { timeout_sec: 120, stream: false, tags: ["a", "{{ runId }}"] },
    }));

    const body = requestBody(fetchMock);
    expect(body.timeout_sec).toBe(120);
    expect(body.stream).toBe(false);
    expect(body.tags).toEqual(["a", "run-1"]);
  });

  it("does not leak the full agent record into the payload", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);

    await execute(buildContext({
      url: "https://example.test/webhook",
      payloadTemplate: { leak: "{{ agent }}" },
      // A credential of the kind adapterConfig legitimately carries.
      apiKey: "super-secret",
    }));

    const leak = String(requestBody(fetchMock).leak);
    expect(leak).not.toContain("super-secret");
    expect(leak).not.toContain("adapterConfig");
  });

  it("preserves fire-and-forget behavior when no poll block is configured", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ run_id: "remote-1" }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await execute(buildContext({ url: "https://example.test/webhook" }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe("HTTP POST https://example.test/webhook");
    expect(result.resultJson).toBeUndefined();
  });

  it("polls to a terminal status and captures output, usage and cost", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ run_id: "remote-1" }))
      .mockResolvedValueOnce(jsonResponse({ status: "running" }))
      .mockResolvedValueOnce(jsonResponse({
        status: "completed",
        output: "the brief",
        usage: { input_tokens: 10, output_tokens: 4 },
        cost_usd: 0.41,
        model: "anthropic/claude-sonnet-4",
      }));
    vi.stubGlobal("fetch", fetchMock);

    const logs: Array<[string, string]> = [];
    const result = await execute(buildContext(
      {
        url: "https://example.test/webhook",
        poll: { ...FAST_POLL, costUsdPath: "cost_usd", modelPath: "model" },
      },
      { onLog: async (stream, chunk) => { logs.push([stream, chunk]); } },
    ));

    expect(result.exitCode).toBe(0);
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 4 });
    expect(result.costUsd).toBe(0.41);
    expect(result.model).toBe("anthropic/claude-sonnet-4");
    expect(logs.some(([stream, chunk]) => stream === "stdout" && chunk === "the brief")).toBe(true);
    // The poll URL must render its double-brace placeholder.
    expect(fetchCall(fetchMock, 1).url).toBe("https://runtime.test/runs/remote-1");
  });

  it("uses a status line as the summary by default", async () => {
    vi.stubGlobal("fetch", vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ run_id: "remote-1" }))
      .mockResolvedValueOnce(jsonResponse({ status: "completed", output: "the brief" })));

    const result = await execute(buildContext({
      url: "https://example.test/webhook",
      poll: FAST_POLL,
    }));

    expect(result.summary).toContain("run remote-1 (completed)");
    expect(result.summary).not.toBe("the brief");
  });

  it("promotes captured output to the summary when outputAsSummary is set", async () => {
    vi.stubGlobal("fetch", vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ run_id: "remote-1" }))
      .mockResolvedValueOnce(jsonResponse({ status: "completed", output: "  the brief  " })));

    const result = await execute(buildContext({
      url: "https://example.test/webhook",
      poll: { ...FAST_POLL, outputAsSummary: true },
    }));

    expect(result.summary).toBe("the brief");
  });

  it("does not promote output to the summary on a failed remote run", async () => {
    vi.stubGlobal("fetch", vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ run_id: "remote-1" }))
      .mockResolvedValueOnce(jsonResponse({ status: "failed", output: "partial junk" })));

    const result = await execute(buildContext({
      url: "https://example.test/webhook",
      poll: { ...FAST_POLL, outputAsSummary: true },
    }));

    expect(result.exitCode).toBe(1);
    expect(result.summary).toContain("run remote-1 (failed)");
    expect(result.errorMessage).toContain("failed");
  });

  it("throws when polling is enabled but the invoke response carries no run id", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ nope: true })));

    await expect(execute(buildContext({
      url: "https://example.test/webhook",
      poll: FAST_POLL,
    }))).rejects.toThrow(/no run id at path "run_id"/);
  });

  it("reports a poll timeout when no attempt returns a usable response", async () => {
    vi.stubGlobal("fetch", vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ run_id: "remote-1" }))
      .mockResolvedValue(jsonResponse({}, false, 503)));

    const result = await execute(buildContext({
      url: "https://example.test/webhook",
      poll: { ...FAST_POLL, maxAttempts: 2 },
    }));

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(1);
    expect(result.errorMessage).toContain("Polled 2 times");
  });
});
