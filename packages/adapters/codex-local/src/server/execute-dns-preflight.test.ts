import { describe, expect, it, vi } from "vitest";
import type { HostnamePreflightAddress, HostnamePreflightOptions } from "@paperclipai/adapter-utils";
import type { AdapterExecutionContext, AdapterRuntime } from "@paperclipai/adapter-utils";
import {
  buildCodexDnsPreflightResult,
  CODEX_DNS_PREFLIGHT_HOST,
  execute,
  preflightCodexUpstreamDns,
} from "./execute.js";
import { CODEX_DEFAULT_DNS_ERROR_CODE } from "./parse.js";

// We mock the heavy adapter-utils surfaces that the execute path normally
// reaches AFTER the preflight. With a DNS failure the preflight should
// return before any of these are touched, which is itself part of the
// test contract. When the preflight is disabled we let the mock return a
// deterministic failure so we can verify the error code is NOT DNS.
const {
  runChildProcess,
  ensureCommandResolvable,
  resolveCommandForLogs,
  prepareWorkspaceForSshExecution,
  restoreWorkspaceFromSshExecution,
  syncDirectoryToSsh,
  startAdapterExecutionTargetPaperclipBridge,
} = vi.hoisted(() => ({
  runChildProcess: vi.fn(async () => {
    throw new Error("runChildProcess should not be called when preflight short-circuits");
  }),
  ensureCommandResolvable: vi.fn(async () => undefined),
  resolveCommandForLogs: vi.fn(async () => "/usr/bin/codex"),
  prepareWorkspaceForSshExecution: vi.fn(async () => ({ gitBacked: false })),
  restoreWorkspaceFromSshExecution: vi.fn(async () => undefined),
  syncDirectoryToSsh: vi.fn(async () => undefined),
  startAdapterExecutionTargetPaperclipBridge: vi.fn(async () => ({
    env: {
      PAPERCLIP_API_URL: "http://127.0.0.1:4310",
      PAPERCLIP_API_KEY: "bridge-token",
      PAPERCLIP_API_BRIDGE_MODE: "queue_v1",
    },
    stop: async () => {},
  })),
}));

vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>(
    "@paperclipai/adapter-utils/server-utils",
  );
  return {
    ...actual,
    ensureCommandResolvable,
    resolveCommandForLogs,
    runChildProcess,
  };
});

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    prepareWorkspaceForSshExecution,
    restoreWorkspaceFromSshExecution,
    syncDirectoryToSsh,
    startAdapterExecutionTargetPaperclipBridge,
  };
});

function makeContext(overrides: Partial<AdapterExecutionContext> = {}): AdapterExecutionContext {
  const runtime = {
    sessionId: null,
    sessionParams: {},
    sessionDisplayId: null,
    command: "codex",
    cwd: null,
    env: {},
    provider: "openai",
    biller: "chatgpt",
    model: null,
    billingType: "subscription",
    costUsd: null,
    startedAt: new Date().toISOString(),
  } as unknown as AdapterRuntime;
  return {
    runId: "run_test",
    agent: {
      id: "agent_test",
      companyId: "company_test",
      name: "CTO",
      adapterType: "codex_local",
      model: null,
      runtime,
    },
    runtime,
    config: {},
    context: {},
    onLog: vi.fn(async () => undefined),
    onSpawn: vi.fn(async () => undefined),
    authToken: undefined,
    ...overrides,
  } as unknown as AdapterExecutionContext;
}

type Resolver = HostnamePreflightOptions["resolver"];

describe("preflightCodexUpstreamDns", () => {
  it("probes chatgpt.com by default and returns the lookup outcome", async () => {
    const resolver = vi.fn(async (host: string) => {
      expect(host).toBe(CODEX_DNS_PREFLIGHT_HOST);
      return [{ address: "10.0.0.1", family: 4 }] as HostnamePreflightAddress[];
    });
    const result = await preflightCodexUpstreamDns({ preflight: { resolver: resolver as Resolver } });
    expect(result.outcome.ok).toBe(true);
    if (result.outcome.ok) {
      expect(result.outcome.host).toBe(CODEX_DNS_PREFLIGHT_HOST);
    }
  });

  it("propagates ENOTFOUND outcomes from the underlying resolver", async () => {
    const resolver = vi.fn(async () => {
      const err = new Error("failed to lookup address information: nodename nor servname provided, or not known") as NodeJS.ErrnoException;
      err.code = "ENOTFOUND";
      throw err;
    });
    const result = await preflightCodexUpstreamDns({ preflight: { resolver: resolver as Resolver } });
    expect(result.outcome.ok).toBe(false);
    if (!result.outcome.ok) {
      expect(result.outcome.reason).toBe("lookup_failed");
      expect(result.outcome.errorCode).toBe("ENOTFOUND");
    }
  });
});

describe("buildCodexDnsPreflightResult", () => {
  it("shapes a successful probe as a no-op result with addressCount", () => {
    const result = buildCodexDnsPreflightResult({
      host: "chatgpt.com",
      outcome: { ok: true, host: "chatgpt.com", addresses: [{ address: "10.0.0.1", family: 4 }] },
    });
    expect(result.errorCode).toBeNull();
    expect(result.errorFamily).toBeNull();
    expect(result.resultJson).toMatchObject({
      preflight: "dns",
      host: "chatgpt.com",
      addressCount: 1,
    });
  });

  it("shapes a failed probe as transient_dns with a 5-minute cooldown and the underlying error code", () => {
    const before = Date.now();
    const result = buildCodexDnsPreflightResult({
      host: "chatgpt.com",
      outcome: {
        ok: false,
        host: "chatgpt.com",
        reason: "lookup_failed",
        errorCode: "ENOTFOUND",
        message: "failed to lookup address information: nodename nor servname provided, or not known",
      },
    });
    expect(result.errorCode).toBe(CODEX_DEFAULT_DNS_ERROR_CODE);
    expect(result.errorFamily).toBe("transient_dns");
    expect(result.errorMessage).toMatch(/chatgpt\.com is not resolvable/);
    expect(result.resultJson).toMatchObject({
      preflight: "dns",
      host: "chatgpt.com",
      reason: "lookup_failed",
      preflightErrorCode: "ENOTFOUND",
    });
    const retryAt = new Date(result.retryNotBefore as string).getTime();
    expect(retryAt - before).toBeGreaterThanOrEqual(5 * 60 * 1000 - 5_000);
    expect(retryAt - before).toBeLessThanOrEqual(5 * 60 * 1000 + 5_000);
  });
});

describe("execute (codex_local) DNS preflight integration", () => {
  it("short-circuits with codex_dns_unreachable when chatgpt.com is unresolvable, no codex CLI spawn", async () => {
    const resolver = vi.fn(async () => {
      const err = new Error("failed to lookup address information: nodename nor servname provided, or not known") as NodeJS.ErrnoException;
      err.code = "ENOTFOUND";
      throw err;
    });
    const onLog = vi.fn(async () => undefined);
    const onSpawn = vi.fn(async () => undefined);
    const before = Date.now();
    const result = await execute(
      makeContext({
        config: { codexDnsPreflightResolver: resolver },
        onLog,
        onSpawn,
      }),
    );
    expect(result.errorCode).toBe(CODEX_DEFAULT_DNS_ERROR_CODE);
    expect(result.errorFamily).toBe("transient_dns");
    expect(result.errorMessage).toMatch(/chatgpt\.com is not resolvable/);
    expect(result.resultJson).toMatchObject({
      preflight: "dns",
      host: "chatgpt.com",
      reason: "lookup_failed",
      preflightErrorCode: "ENOTFOUND",
    });
    expect(onSpawn).not.toHaveBeenCalled();
    expect(resolver).toHaveBeenCalledTimes(1);
    const onLogCalls = (onLog as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const flatMessages = onLogCalls
      .map((call) => (Array.isArray(call) ? call[1] : ""))
      .filter((value): value is string => typeof value === "string")
      .join("\n");
    expect(flatMessages).toMatch(/DNS preflight for chatgpt\.com failed/);
    const retryAt = new Date(result.retryNotBefore as string).getTime();
    expect(retryAt - before).toBeGreaterThanOrEqual(5 * 60 * 1000 - 5_000);
    expect(retryAt - before).toBeLessThanOrEqual(5 * 60 * 1000 + 5_000);
  });

  it("skips the preflight entirely when codexDnsPreflightHost is \"none\"", async () => {
    const resolver = vi.fn(async () => {
      throw new Error("resolver should not be called when preflight is disabled");
    });
    // The preflight is disabled, so the codex CLI spawn path is reached.
    // Override the runChildProcess mock for this case so it returns a
    // deterministic failure rather than throwing — we still want to
    // verify that the resulting error code is NOT codex_dns_unreachable.
    (runChildProcess as unknown as { mockImplementationOnce: (fn: () => Promise<unknown>) => void }).mockImplementationOnce(
      async () => ({
        exitCode: 1,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: "non-dns upstream failure",
        pid: 999,
        startedAt: new Date().toISOString(),
      }),
    );
    const onSpawn = vi.fn(async () => undefined);
    const result = await execute(
      makeContext({
        config: {
          codexDnsPreflightHost: "none",
          codexDnsPreflightResolver: resolver,
        },
        onSpawn,
      }),
    );
    expect(resolver).not.toHaveBeenCalled();
    expect(result.errorCode).not.toBe(CODEX_DEFAULT_DNS_ERROR_CODE);
    expect(result.errorFamily).not.toBe("transient_dns");
  });
});
