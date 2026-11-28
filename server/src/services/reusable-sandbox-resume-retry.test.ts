import { environmentResumeErrorData, JsonRpcCallError, PLUGIN_RPC_ERROR_CODES } from "@paperclipai/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import { readTransientEnvironmentProviderFailure } from "./environment-provider-unavailable-error.js";
import { retryTransientResumeCall, transientSandboxResumeFailure } from "./reusable-sandbox-resume-replacement.js";

const pluginRefusal = (provider: Error) => new JsonRpcCallError({ code: PLUGIN_RPC_ERROR_CODES.WORKER_ERROR,
  message: provider.message, data: environmentResumeErrorData(provider) });
const withFields = (message: string, fields: Record<string, unknown>) => Object.assign(new Error(message), fields);

describe("transientSandboxResumeFailure", () => {
  it.each([
    ["envelope HTTP 502", pluginRefusal(withFields("<html>502 Bad Gateway</html>", { statusCode: 502 })), true],
    ["envelope HTTP 520", pluginRefusal(withFields("unknown error", { statusCode: 520 })), true],
    ["envelope HTTP 429", pluginRefusal(withFields("slow down", { statusCode: 429 })), true],
    ["envelope HTTP 408", pluginRefusal(withFields("request timeout", { statusCode: 408 })), true],
    ["envelope HTTP 409", pluginRefusal(withFields("conflict", { statusCode: 409 })), false],
    ["envelope HTTP 404", pluginRefusal(withFields("missing", { statusCode: 404 })), false],
    ["envelope HTTP 501", pluginRefusal(withFields("not implemented", { statusCode: 501 })), false],
    ["envelope ENOTFOUND", pluginRefusal(withFields("getaddrinfo ENOTFOUND api", { code: "ENOTFOUND" })), false],
    ["envelope ECONNRESET", pluginRefusal(withFields("socket closed", { code: "ECONNRESET" })), true],
    ["envelope EAI_AGAIN", pluginRefusal(withFields("dns", { code: "EAI_AGAIN" })), true],
    ["envelope ABORT_ERR", pluginRefusal(withFields("aborted", { code: "ABORT_ERR" })), false],
    ["envelope CONNECTION_FAILED", pluginRefusal(withFields("connect failed", { code: "CONNECTION_FAILED" })), true],
    ["plugin RPC deadline", new JsonRpcCallError({ code: PLUGIN_RPC_ERROR_CODES.TIMEOUT, message: "deadline" }), true],
    ["plugin worker error without evidence", new JsonRpcCallError({ code: PLUGIN_RPC_ERROR_CODES.WORKER_ERROR, message: "requested directory does not match" }), false],
    ["direct status 503", withFields("unavailable", { status: 503 }), true],
    ["direct errno ETIMEDOUT", withFields("connect", { code: "ETIMEDOUT" }), true],
    ["direct errno ENOTFOUND", withFields("dns", { code: "ENOTFOUND" }), false],
    ["sandbox state transition", new Error("Sandbox state change in progress"), true],
    ["deterministic startup timeout text", new Error("retained sandbox startup timed out"), false],
    ["deterministic readiness text", new Error("Sandbox failed to become ready within the timeout period"), false],
    ["transport phrase", new Error("socket hang up"), true],
    ["rate limit phrase", new Error("Rate limited by provider"), true],
  ] as const)("classifies %s for a first acquisition", (_name, error, transient) => {
    expect(transientSandboxResumeFailure(error)).toBe(transient);
  });

  it.each([
    ["envelope ENOTFOUND", pluginRefusal(withFields("dns", { code: "ENOTFOUND" })), true],
    ["envelope EAI_AGAIN", pluginRefusal(withFields("dns", { code: "EAI_AGAIN" })), true],
    ["direct errno ENOTFOUND", withFields("dns", { code: "ENOTFOUND" }), true],
    ["envelope ABORT_ERR", pluginRefusal(withFields("aborted", { code: "ABORT_ERR" })), false],
    ["envelope HTTP 501", pluginRefusal(withFields("not implemented", { statusCode: 501 })), false],
    ["envelope HTTP 520", pluginRefusal(withFields("gateway", { statusCode: 520 })), true],
  ] as const)("classifies %s for a reattach to a host this run already reached", (_name, error, transient) => {
    expect(transientSandboxResumeFailure(error, "known_host")).toBe(transient);
  });

  it.each([
    ...[400, 401, 403, 404, 408, 409, 422, 425, 429, 500, 501, 502, 503, 504, 505, 520, 524, 529, 599].map(statusCode => ({ statusCode })),
    ...["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "EAI_AGAIN", "ENETUNREACH", "ENOTFOUND", "ABORT_ERR",
      "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET", "CONNECTION_FAILED", "EACCES"].map(code => ({ code })),
  ])("agrees with the lease acquisition policy for %j", fields => {
    const error = withFields("provider", fields);
    expect(transientSandboxResumeFailure(error)).toBe(readTransientEnvironmentProviderFailure(error) !== null);
  });
});

describe("retryTransientResumeCall", () => {
  it("gives the first call no cap and every retry the remaining budget", async () => {
    const gateway = pluginRefusal(withFields("gateway", { statusCode: 502 }));
    const timeouts: Array<number | undefined> = [];
    const call = vi.fn(async (timeoutMs: number | undefined) => {
      timeouts.push(timeoutMs);
      if (timeouts.length < 3) throw gateway;
      return "resumed";
    });
    await expect(retryTransientResumeCall({ budgetMs: 10_000, scope: "known_host", call, sleep: async () => undefined })).resolves.toBe("resumed");
    expect(timeouts[0]).toBeUndefined();
    expect(timeouts.slice(1).every(timeout => typeof timeout === "number" && timeout <= 10_000)).toBe(true);
  });

  it("does not repeat a first call that used up the provider deadline", async () => {
    const deadline = new JsonRpcCallError({ code: PLUGIN_RPC_ERROR_CODES.TIMEOUT, message: "deadline" });
    const call = vi.fn(async () => { throw deadline; });
    await expect(retryTransientResumeCall({ budgetMs: 10_000, scope: "known_host", call, sleep: async () => undefined })).rejects.toBe(deadline);
    expect(call).toHaveBeenCalledOnce();
  });

  it("stops once the next wait would pass the budget", async () => {
    const gateway = pluginRefusal(withFields("gateway", { statusCode: 503 }));
    let now = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const call = vi.fn(async () => { throw gateway; });
      await expect(retryTransientResumeCall({ budgetMs: 2_000, scope: "known_host", call, sleep: async ms => { now += ms; } })).rejects.toBe(gateway);
      expect(now).toBeLessThan(2_000);
      expect(call.mock.calls.length).toBeGreaterThan(1);
    } finally {
      clock.mockRestore();
    }
  });
});
