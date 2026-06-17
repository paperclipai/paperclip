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
        // TEST-NET-1 (RFC 5737): a public literal IP that passes the SSRF guard
        // without a DNS lookup and never actually responds.
        url: "https://192.0.2.1/webhook",
        timeoutMs: 1,
      },
      context: {},
      onLog: async () => {},
    });

    expect(result.timedOut).toBe(true);
    expect(result.errorCode).toBe("timeout");
    expect(result.errorMessage).toContain("timed out after 1ms");
  });

  it("refuses to connect to a loopback target (SSRF guard)", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await expect(
      execute({
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
        config: { url: "http://127.0.0.1:8080/admin" },
        context: {},
        onLog: async () => {},
      }),
    ).rejects.toThrow(/private\/reserved address/);

    // The guard must short-circuit before any network call.
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
