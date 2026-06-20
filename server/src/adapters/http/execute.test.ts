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

  it("returns http_error with body for non-2xx responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string) =>
        Promise.resolve({
          ok: false,
          status: 403,
          text: () => Promise.resolve('{"error":"Insufficient permissions"}'),
        }),
      ),
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
      },
      context: {},
      onLog: async () => {},
    });

    expect(result.errorCode).toBe("http_error");
    expect(result.errorMessage).toContain("403");
    expect(result.errorMessage).toContain("Insufficient permissions");
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBeNull();
  });

  it("returns network_error for transport failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string) => Promise.reject(new TypeError("Failed to fetch"))),
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
      },
      context: {},
      onLog: async () => {},
    });

    expect(result.errorCode).toBe("network_error");
    expect(result.errorMessage).toContain("transport error");
    expect(result.errorMessage).toContain("Failed to fetch");
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBeNull();
  });
});
