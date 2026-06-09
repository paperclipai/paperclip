import { describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext, AdapterRuntime } from "@paperclipai/adapter-utils";
import {
  buildClaudeDnsPreflightResult,
  CLAUDE_DNS_PREFLIGHT_HOST,
  execute,
} from "./execute.js";
import { CLAUDE_DEFAULT_DNS_ERROR_CODE } from "./parse.js";

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
  resolveCommandForLogs: vi.fn(async () => "/usr/local/bin/claude"),
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
    command: "claude",
    cwd: null,
    env: {},
    provider: "anthropic",
    biller: "anthropic",
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
      adapterType: "claude_local",
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

describe("buildClaudeDnsPreflightResult", () => {
  it("shapes a successful probe as a no-op result with addressCount", () => {
    const result = buildClaudeDnsPreflightResult({
      host: CLAUDE_DNS_PREFLIGHT_HOST,
      outcome: { ok: true, host: CLAUDE_DNS_PREFLIGHT_HOST, addresses: [{ address: "10.0.0.1", family: 4 }] },
    });
    expect(result.errorCode).toBeNull();
    expect(result.errorFamily).toBeNull();
    expect(result.resultJson).toMatchObject({
      preflight: "dns",
      host: CLAUDE_DNS_PREFLIGHT_HOST,
      addressCount: 1,
    });
  });

  it("shapes a failed probe as transient_dns with a 5-minute cooldown", () => {
    const before = Date.now();
    const result = buildClaudeDnsPreflightResult({
      host: CLAUDE_DNS_PREFLIGHT_HOST,
      outcome: {
        ok: false,
        host: CLAUDE_DNS_PREFLIGHT_HOST,
        reason: "lookup_failed",
        errorCode: "ENOTFOUND",
        message: "failed to lookup address information: nodename nor servname provided, or not known",
      },
    });
    expect(result.errorCode).toBe(CLAUDE_DEFAULT_DNS_ERROR_CODE);
    expect(result.errorFamily).toBe("transient_dns");
    expect(result.errorMessage).toMatch(/api\.anthropic\.com is not resolvable/);
    const retryAt = new Date(result.retryNotBefore as string).getTime();
    expect(retryAt - before).toBeGreaterThanOrEqual(5 * 60 * 1000 - 5_000);
    expect(retryAt - before).toBeLessThanOrEqual(5 * 60 * 1000 + 5_000);
  });
});

describe("execute (claude_local) DNS preflight integration", () => {
  it("short-circuits with claude_dns_unreachable when api.anthropic.com is unresolvable, no claude CLI spawn", async () => {
    const resolver = vi.fn(async () => {
      const err = new Error("failed to lookup address information: nodename nor servname provided, or not known") as NodeJS.ErrnoException;
      err.code = "ENOTFOUND";
      throw err;
    });
    const onLog = vi.fn(async () => undefined);
    const onSpawn = vi.fn(async () => undefined);
    const result = await execute(
      makeContext({
        config: { claudeDnsPreflightResolver: resolver },
        onLog,
        onSpawn,
      }),
    );
    expect(result.errorCode).toBe(CLAUDE_DEFAULT_DNS_ERROR_CODE);
    expect(result.errorFamily).toBe("transient_dns");
    expect(result.errorMessage).toMatch(/api\.anthropic\.com is not resolvable/);
    expect(onSpawn).not.toHaveBeenCalled();
    expect(resolver).toHaveBeenCalledTimes(1);
  });

  it("skips the preflight entirely when claudeDnsPreflightHost is \"none\"", async () => {
    const resolver = vi.fn(async () => {
      throw new Error("resolver should not be called when preflight is disabled");
    });
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
          claudeDnsPreflightHost: "none",
          claudeDnsPreflightResolver: resolver,
        },
        onSpawn,
      }),
    );
    expect(resolver).not.toHaveBeenCalled();
    expect(result.errorCode).not.toBe(CLAUDE_DEFAULT_DNS_ERROR_CODE);
    expect(result.errorFamily).not.toBe("transient_dns");
  });
});
