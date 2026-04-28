import { afterEach, describe, expect, it, vi } from "vitest";
import { execute } from "./execute.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("http adapter execute", () => {
  // ── CLI-202 regression: adapter failure error messages ─────────────────────

  it("throws when url is missing from config", async () => {
    await expect(execute({
      runId: "run-1",
      agent: { id: "a", companyId: "c", name: "A", adapterType: "http", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: {},
      context: {},
      onLog: async () => {},
    })).rejects.toThrow("HTTP adapter missing url");
  });

  it("throws when the remote responds with a non-2xx status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response("Bad Gateway", { status: 502 }),
    ));

    await expect(execute({
      runId: "run-2",
      agent: { id: "a", companyId: "c", name: "A", adapterType: "http", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { url: "https://example.test/hook" },
      context: {},
      onLog: async () => {},
    })).rejects.toThrow("HTTP invoke failed with status 502");
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
});
