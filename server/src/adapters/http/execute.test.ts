import { afterEach, describe, expect, it, vi } from "vitest";
import { execute, resolveHeaderTemplates } from "./execute.js";

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

  it("rejects malformed persisted header values", async () => {
    await expect(execute({
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
        headers: { "X-Invalid": 12 },
      },
      context: {},
      onLog: async () => {},
    })).rejects.toThrow(/HTTP header X-Invalid must be a string/);
  });

  it("rejects raw persisted sensitive header values", async () => {
    await expect(execute({
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
        headers: { Authorization: "Bearer raw-token" },
      },
      context: {},
      onLog: async () => {},
    })).rejects.toThrow(/Sensitive HTTP header Authorization must use an env reference/);
  });
});

describe("HTTP adapter header templates", () => {
  it("resolves env references in header values", () => {
    expect(
      resolveHeaderTemplates(
        { Authorization: "Bearer ${env:BRIDGE_TOKEN}", "X-Agent": "florence" },
        { BRIDGE_TOKEN: "token-from-env" },
      ),
    ).toEqual({
      Authorization: "Bearer token-from-env",
      "X-Agent": "florence",
    });
  });

  it("fails closed when a referenced env value is missing", () => {
    expect(() => resolveHeaderTemplates({ Authorization: "Bearer ${env:BRIDGE_TOKEN}" }, {})).toThrow(
      /HTTP header references missing environment variable: BRIDGE_TOKEN/,
    );
  });
});
