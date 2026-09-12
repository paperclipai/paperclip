import { afterEach, describe, expect, it, vi } from "vitest";
import { CONNECTION_INTENT_AGENT_GUIDANCE } from "@paperclipai/shared";
import { execute } from "./execute.js";

const guardedFetchMock = vi.hoisted(() => vi.fn());

vi.mock("./remote-fetch.js", () => ({
  guardedHttpAdapterFetch: guardedFetchMock,
}));

afterEach(() => {
  guardedFetchMock.mockReset();
  vi.useRealTimers();
});

function mockNeverResolvingFetch(): void {
  guardedFetchMock.mockImplementation(
    (_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(new DOMException("Aborted", "AbortError"));
      });
    }),
  );
}

function buildTimeoutContext(timeoutConfig: Record<string, unknown>): Parameters<typeof execute>[0] {
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
    config: {
      url: "https://example.test/webhook",
      ...timeoutConfig,
    },
    context: {},
    onLog: async () => {},
  };
}

describe("http adapter execute", () => {
  it("delivers the complete runtime connection descriptor and shared guidance", async () => {
    const onDispatch = vi.fn();
    guardedFetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
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

    expect(guardedFetchMock).toHaveBeenCalledOnce();
    expect(onDispatch).toHaveBeenCalledOnce();
  });

  it("reports configured request timeout as timed_out", async () => {
    mockNeverResolvingFetch();

    const result = await execute(buildTimeoutContext({ timeoutMs: 1 }));

    expect(result.timedOut).toBe(true);
    expect(result.errorCode).toBe("timeout");
    expect(result.errorMessage).toContain("timed out after 1ms");
  });

  it("arms the timeout from the documented timeoutSec field", async () => {
    vi.useFakeTimers();
    mockNeverResolvingFetch();

    const pending = execute(buildTimeoutContext({ timeoutSec: 2 }));
    await vi.advanceTimersByTimeAsync(2000);
    const result = await pending;

    expect(result.timedOut).toBe(true);
    expect(result.errorCode).toBe("timeout");
    expect(result.errorMessage).toContain("timed out after 2000ms");
  });

  it("falls through to timeoutSec when timeoutMs carries no number", async () => {
    vi.useFakeTimers();
    mockNeverResolvingFetch();

    const pending = execute(buildTimeoutContext({ timeoutMs: null, timeoutSec: 2 }));
    await vi.advanceTimersByTimeAsync(2000);
    const result = await pending;

    expect(result.timedOut).toBe(true);
    expect(result.errorMessage).toContain("timed out after 2000ms");
  });

  it("prefers timeoutMs when both timeout fields are present", async () => {
    vi.useFakeTimers();
    mockNeverResolvingFetch();

    const pending = execute(buildTimeoutContext({ timeoutMs: 1000, timeoutSec: 9 }));
    await vi.advanceTimersByTimeAsync(1000);
    const result = await pending;

    expect(result.timedOut).toBe(true);
    expect(result.errorMessage).toContain("timed out after 1000ms");
  });

  it("arms no timeout when neither timeout field is set", async () => {
    guardedFetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      expect(init?.signal).toBeUndefined();
      return new Response(null, { status: 204 });
    });

    const result = await execute(buildTimeoutContext({}));

    expect(result.timedOut).toBe(false);
    expect(guardedFetchMock).toHaveBeenCalledOnce();
  });
});
