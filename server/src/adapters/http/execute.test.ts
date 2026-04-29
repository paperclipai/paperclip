import { afterEach, describe, expect, it, vi } from "vitest";
import { execute } from "./execute.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("http adapter execute", () => {
  it("reports configured request timeout as timed_out", async () => {
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
        timeoutMs: 1,
      },
      context: {},
      onLog: async () => {},
    });

    expect(result.timedOut).toBe(true);
    expect(result.errorCode).toBe("timeout");
    expect(result.errorMessage).toContain("timed out after 1ms");
  });

  it("applies run-rate guard with default limit (max 10 runs per 60s)", async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockResolvedValue(new Response("{}", { status: 200 }));

    // Clear the module-level history before test
    const httpModule = await import("./execute.js");
    (httpModule as any).httpAgentCallHistory.clear();

    const commonCtx = {
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
      },
      context: {},
      onLog: async () => {},
    };

    // Run sequentially to avoid parallel timestamp issues
    for (let i = 0; i < 10; i++) {
      const result = await execute(commonCtx);
      expect(result.exitCode).toBe(0);
    }

    // 11th call should trip the guard
    const result = await execute(commonCtx);
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("run_guard_rate_limit");
    expect(result.errorMessage).toContain("rate limit");
    expect(result.errorMessage).toContain("invocations in 60s");
    expect(result.errorMessage).toContain("max 10");
  });

  it("respects custom maxRunsPer60s limit", async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockResolvedValue(new Response("{}", { status: 200 }));

    // Clear the module-level history before test
    const httpModule = await import("./execute.js");
    (httpModule as any).httpAgentCallHistory.clear();

    const commonCtx = {
      runId: "run-1",
      agent: {
        id: "agent-2",
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
        paperclipRunGuard: {
          maxRunsPer60s: 3,
        },
      },
      context: {},
      onLog: async () => {},
    };

    // Run sequentially to avoid parallel timestamp issues
    for (let i = 0; i < 3; i++) {
      const result = await execute(commonCtx);
      expect(result.exitCode).toBe(0);
    }

    // 4th call should trip the guard
    const result = await execute(commonCtx);
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("run_guard_rate_limit");
    expect(result.errorMessage).toContain("rate limit");
    expect(result.errorMessage).toContain("invocations in 60s");
    expect(result.errorMessage).toContain("max 3");
  });

  it("respects guard enabled: false", async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockResolvedValue(new Response("{}", { status: 200 }));

    // Clear the module-level history before test
    const httpModule = await import("./execute.js");
    (httpModule as any).httpAgentCallHistory.clear();

    const commonCtx = {
      runId: "run-1",
      agent: {
        id: "agent-3",
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
        paperclipRunGuard: {
          enabled: false,
        },
      },
      context: {},
      onLog: async () => {},
    };

    // Run sequentially to avoid parallel timestamp issues
    const results = [];
    for (let i = 0; i < 15; i++) {
      results.push(await execute(commonCtx));
    }

    // All should succeed
    expect(results.every(r => r.exitCode === 0)).toBe(true);
    expect(results.every(r => r.errorCode === undefined)).toBe(true);
  });
});
