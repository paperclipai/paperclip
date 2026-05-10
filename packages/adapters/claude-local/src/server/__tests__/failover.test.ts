import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterInvocationMeta } from "@paperclipai/adapter-utils";
import type { RunProcessResult } from "@paperclipai/adapter-utils/server-utils";

// Resets at 3:00 AM (UTC) — the parser only resolves 12h clock times with an
// explicit AM/PM marker, so we use that format. With now=20:00Z, the reset
// rolls forward to tomorrow's 03:00Z = 7h away (above the 5min threshold).
const RATE_LIMIT_STDERR =
  "Claude usage limit reached — weekly limit reached. Resets at 3:00 AM (UTC).";

function makeRateLimitedRunResult(): RunProcessResult {
  return {
    exitCode: 1,
    signal: null,
    timedOut: false,
    stdout: "",
    stderr: RATE_LIMIT_STDERR,
    pid: 1234,
    startedAt: new Date().toISOString(),
  };
}

function makeOkRunResult(sessionId: string): RunProcessResult {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: [
      JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: sessionId,
        model: "claude-sonnet",
      }),
      JSON.stringify({
        type: "result",
        session_id: sessionId,
        result: "ok",
        usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 },
      }),
    ].join("\n"),
    stderr: "",
    pid: 5678,
    startedAt: new Date().toISOString(),
  };
}

const { runChildProcess, ensureCommandResolvable, resolveCommandForLogs } = vi.hoisted(() => ({
  runChildProcess: vi.fn(async () => makeOkRunResult("ok-session")),
  ensureCommandResolvable: vi.fn(async () => undefined),
  resolveCommandForLogs: vi.fn(async () => "claude"),
}));

vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>(
    "@paperclipai/adapter-utils/server-utils",
  );
  return {
    ...actual,
    runChildProcess,
    ensureCommandResolvable,
    resolveCommandForLogs,
  };
});

import {
  accountDir,
  setActiveAccountResolver,
  setApiKeyResolver,
  setAutoFailoverHook,
  type ActiveAnthropicAccount,
} from "../account-store.js";
import { execute } from "../execute.js";

describe("claude-local auto-failover on transient rate limit", () => {
  const cleanupDirs: string[] = [];
  const originalHome = process.env.HOME;
  const originalPaperclipHome = process.env.PAPERCLIP_HOME;

  beforeEach(async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-claude-failover-"));
    cleanupDirs.push(root);
    process.env.HOME = root;
    delete process.env.PAPERCLIP_HOME;
    runChildProcess.mockReset();
    ensureCommandResolvable.mockReset();
    resolveCommandForLogs.mockReset();
    ensureCommandResolvable.mockImplementation(async () => undefined);
    resolveCommandForLogs.mockImplementation(async () => "claude");
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    if (originalPaperclipHome === undefined) {
      delete process.env.PAPERCLIP_HOME;
    } else {
      process.env.PAPERCLIP_HOME = originalPaperclipHome;
    }
    setActiveAccountResolver(null);
    setApiKeyResolver(null);
    setAutoFailoverHook(null);
    vi.useRealTimers();
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  async function makeWorkspace(): Promise<string> {
    const ws = path.join(process.env.HOME!, "workspace");
    await mkdir(ws, { recursive: true });
    return ws;
  }

  it("fails over to a healthy candidate, swaps CLAUDE_CONFIG_DIR, logs the switch, and retries once", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-10T20:00:00.000Z"));

    const workspaceDir = await makeWorkspace();

    const accounts = new Map<string, ActiveAnthropicAccount>([
      [
        "company-1",
        {
          id: "acc-primary",
          label: "Primary OAuth",
          mode: "oauth",
          apiKeySecretId: null,
        },
      ],
    ]);

    setActiveAccountResolver(async (companyId) => {
      const account = accounts.get(companyId);
      if (!account) throw new Error(`no account for ${companyId}`);
      return account;
    });

    const listHealthyCandidates = vi.fn(async () => [
      {
        id: "acc-fallback",
        label: "Fallback OAuth",
        mode: "oauth" as const,
        apiKeySecretId: null,
        lastUtilizationFiveHour: 20,
      },
    ]);
    const setActiveAccount = vi.fn(async ({ companyId, accountId }) => {
      accounts.set(companyId, {
        id: accountId,
        label: "Fallback OAuth",
        mode: "oauth",
        apiKeySecretId: null,
      });
    });
    const logSwitch = vi.fn(async () => undefined);
    setAutoFailoverHook({ listHealthyCandidates, setActiveAccount, logSwitch });

    // env is a single mutable reference passed through both runs — snapshot
    // CLAUDE_CONFIG_DIR / ANTHROPIC_API_KEY at call time so we can assert the
    // failover actually swapped credentials at spawn time, not just at observation.
    const envSnapshots: Array<{ CLAUDE_CONFIG_DIR?: string; ANTHROPIC_API_KEY?: string }> = [];
    runChildProcess
      .mockImplementationOnce(async (...args: unknown[]) => {
        const opts = args[3] as { env: Record<string, string> };
        envSnapshots.push({
          CLAUDE_CONFIG_DIR: opts.env.CLAUDE_CONFIG_DIR,
          ANTHROPIC_API_KEY: opts.env.ANTHROPIC_API_KEY,
        });
        return makeRateLimitedRunResult();
      })
      .mockImplementationOnce(async (...args: unknown[]) => {
        const opts = args[3] as { env: Record<string, string> };
        envSnapshots.push({
          CLAUDE_CONFIG_DIR: opts.env.CLAUDE_CONFIG_DIR,
          ANTHROPIC_API_KEY: opts.env.ANTHROPIC_API_KEY,
        });
        return makeOkRunResult("retry-session");
      });

    const metaCalls: AdapterInvocationMeta[] = [];

    const result = await execute({
      runId: "run-failover",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Claude Coder",
        adapterType: "claude_local",
        adapterConfig: {},
      },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { command: "claude", cwd: workspaceDir },
      context: {},
      onLog: async () => {},
      onMeta: async (meta) => {
        metaCalls.push(meta);
      },
    });

    expect(runChildProcess).toHaveBeenCalledTimes(2);
    expect(listHealthyCandidates).toHaveBeenCalledTimes(1);
    expect(listHealthyCandidates).toHaveBeenCalledWith({
      companyId: "company-1",
      currentAccountId: "acc-primary",
    });
    expect(setActiveAccount).toHaveBeenCalledTimes(1);
    expect(setActiveAccount).toHaveBeenCalledWith({
      companyId: "company-1",
      accountId: "acc-fallback",
      setBy: "system:auto-failover",
    });
    expect(logSwitch).toHaveBeenCalledTimes(1);
    expect(logSwitch).toHaveBeenCalledWith({
      runId: "run-failover",
      fromAccountId: "acc-primary",
      toAccountId: "acc-fallback",
      reason: "auto:rate_limit",
    });

    expect(envSnapshots[0]?.CLAUDE_CONFIG_DIR).toBe(accountDir("acc-primary"));
    expect(envSnapshots[1]?.CLAUDE_CONFIG_DIR).toBe(accountDir("acc-fallback"));
    expect(envSnapshots[0]?.CLAUDE_CONFIG_DIR).not.toBe(envSnapshots[1]?.CLAUDE_CONFIG_DIR);

    // Final result reflects the successful retry on the fallback account.
    expect(result.errorCode).toBeNull();
    expect(result.sessionId).toBe("retry-session");

    // The retry's onMeta payload reports the new account.
    expect(metaCalls.length).toBeGreaterThanOrEqual(2);
    const retryMeta = metaCalls.at(-1)!;
    expect(retryMeta.anthropicAccountId).toBe("acc-fallback");
    expect(retryMeta.env?.paperclipAnthropicAccountId).toBe("acc-fallback");
    expect(retryMeta.env?.CLAUDE_CONFIG_DIR).toBe(accountDir("acc-fallback"));
  });

  it("swaps to ANTHROPIC_API_KEY when the fallback is api_key mode", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-10T20:00:00.000Z"));

    const workspaceDir = await makeWorkspace();
    const apiKeyValue = "sk-ant-fallback-secret";

    const accounts = new Map<string, ActiveAnthropicAccount>([
      [
        "company-1",
        {
          id: "acc-primary",
          label: "Primary OAuth",
          mode: "oauth",
          apiKeySecretId: null,
        },
      ],
    ]);

    setActiveAccountResolver(async (companyId) => {
      const account = accounts.get(companyId);
      if (!account) throw new Error(`no account for ${companyId}`);
      return account;
    });
    setApiKeyResolver(async (secretId) => {
      expect(secretId).toBe("secret-fallback");
      return apiKeyValue;
    });

    setAutoFailoverHook({
      listHealthyCandidates: async () => [
        {
          id: "acc-api",
          label: "Backup API",
          mode: "api_key",
          apiKeySecretId: "secret-fallback",
          lastUtilizationFiveHour: 5,
        },
      ],
      setActiveAccount: async ({ companyId, accountId }) => {
        accounts.set(companyId, {
          id: accountId,
          label: "Backup API",
          mode: "api_key",
          apiKeySecretId: "secret-fallback",
        });
      },
      logSwitch: async () => undefined,
    });

    const envSnapshots: Array<{ CLAUDE_CONFIG_DIR?: string; ANTHROPIC_API_KEY?: string }> = [];
    runChildProcess
      .mockImplementationOnce(async (...args: unknown[]) => {
        const opts = args[3] as { env: Record<string, string> };
        envSnapshots.push({
          CLAUDE_CONFIG_DIR: opts.env.CLAUDE_CONFIG_DIR,
          ANTHROPIC_API_KEY: opts.env.ANTHROPIC_API_KEY,
        });
        return makeRateLimitedRunResult();
      })
      .mockImplementationOnce(async (...args: unknown[]) => {
        const opts = args[3] as { env: Record<string, string> };
        envSnapshots.push({
          CLAUDE_CONFIG_DIR: opts.env.CLAUDE_CONFIG_DIR,
          ANTHROPIC_API_KEY: opts.env.ANTHROPIC_API_KEY,
        });
        return makeOkRunResult("retry-session-api");
      });

    const result = await execute({
      runId: "run-api-failover",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Claude Coder",
        adapterType: "claude_local",
        adapterConfig: {},
      },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { command: "claude", cwd: workspaceDir },
      context: {},
      onLog: async () => {},
      onMeta: async () => {},
    });

    expect(runChildProcess).toHaveBeenCalledTimes(2);
    // First call ran on the oauth primary, so no api key in env yet.
    expect(envSnapshots[0]?.ANTHROPIC_API_KEY).toBeUndefined();
    // Second call (post-failover) carries the resolved key for the api_key fallback.
    expect(envSnapshots[1]?.ANTHROPIC_API_KEY).toBe(apiKeyValue);
    expect(result.errorCode).toBeNull();
  });

  it("does not fail over when no healthy candidate is available", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-10T20:00:00.000Z"));

    const workspaceDir = await makeWorkspace();
    setActiveAccountResolver(async () => ({
      id: "acc-primary",
      label: "Primary OAuth",
      mode: "oauth",
      apiKeySecretId: null,
    }));

    const setActiveAccount = vi.fn(async () => undefined);
    const logSwitch = vi.fn(async () => undefined);
    setAutoFailoverHook({
      listHealthyCandidates: async () => [],
      setActiveAccount,
      logSwitch,
    });

    runChildProcess.mockResolvedValueOnce(makeRateLimitedRunResult());

    const result = await execute({
      runId: "run-no-candidate",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Claude Coder",
        adapterType: "claude_local",
        adapterConfig: {},
      },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { command: "claude", cwd: workspaceDir },
      context: {},
      onLog: async () => {},
      onMeta: async () => {},
    });

    expect(runChildProcess).toHaveBeenCalledTimes(1);
    expect(setActiveAccount).not.toHaveBeenCalled();
    expect(logSwitch).not.toHaveBeenCalled();
    expect(result.errorCode).toBe("claude_transient_upstream");
    expect(result.errorFamily).toBe("transient_upstream");
  });

  it("does not fail over when the rate-limit reset is within 5 minutes", async () => {
    vi.useFakeTimers();
    // Reset is at 03:00 UTC. Set "now" to 02:58 UTC → only 2 min away, below threshold.
    vi.setSystemTime(new Date("2026-05-10T02:58:00.000Z"));

    const workspaceDir = await makeWorkspace();
    setActiveAccountResolver(async () => ({
      id: "acc-primary",
      label: "Primary OAuth",
      mode: "oauth",
      apiKeySecretId: null,
    }));

    const listHealthyCandidates = vi.fn(async () => [
      {
        id: "acc-fallback",
        label: "Fallback OAuth",
        mode: "oauth" as const,
        apiKeySecretId: null,
        lastUtilizationFiveHour: 20,
      },
    ]);
    const setActiveAccount = vi.fn(async () => undefined);
    setAutoFailoverHook({
      listHealthyCandidates,
      setActiveAccount,
      logSwitch: async () => undefined,
    });

    runChildProcess.mockResolvedValueOnce(makeRateLimitedRunResult());

    const result = await execute({
      runId: "run-short-wait",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Claude Coder",
        adapterType: "claude_local",
        adapterConfig: {},
      },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { command: "claude", cwd: workspaceDir },
      context: {},
      onLog: async () => {},
      onMeta: async () => {},
    });

    expect(runChildProcess).toHaveBeenCalledTimes(1);
    expect(listHealthyCandidates).not.toHaveBeenCalled();
    expect(setActiveAccount).not.toHaveBeenCalled();
    expect(result.errorCode).toBe("claude_transient_upstream");
  });

  it("only attempts ONE failover retry even when the fallback account is also rate-limited", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-10T20:00:00.000Z"));

    const workspaceDir = await makeWorkspace();
    const accounts = new Map<string, ActiveAnthropicAccount>([
      [
        "company-1",
        {
          id: "acc-primary",
          label: "Primary OAuth",
          mode: "oauth",
          apiKeySecretId: null,
        },
      ],
    ]);

    setActiveAccountResolver(async (companyId) => {
      const account = accounts.get(companyId);
      if (!account) throw new Error(`no account for ${companyId}`);
      return account;
    });

    const listHealthyCandidates = vi.fn(async () => [
      {
        id: "acc-fallback",
        label: "Fallback OAuth",
        mode: "oauth" as const,
        apiKeySecretId: null,
        lastUtilizationFiveHour: 20,
      },
    ]);
    const setActiveAccount = vi.fn(async ({ companyId, accountId }) => {
      accounts.set(companyId, {
        id: accountId,
        label: "Fallback OAuth",
        mode: "oauth",
        apiKeySecretId: null,
      });
    });
    const logSwitch = vi.fn(async () => undefined);
    setAutoFailoverHook({ listHealthyCandidates, setActiveAccount, logSwitch });

    // Both attempts fail with the same transient rate-limit signal.
    runChildProcess
      .mockResolvedValueOnce(makeRateLimitedRunResult())
      .mockResolvedValueOnce(makeRateLimitedRunResult());

    const result = await execute({
      runId: "run-cascading",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Claude Coder",
        adapterType: "claude_local",
        adapterConfig: {},
      },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { command: "claude", cwd: workspaceDir },
      context: {},
      onLog: async () => {},
      onMeta: async () => {},
    });

    // Initial + ONE failover retry — never a third.
    expect(runChildProcess).toHaveBeenCalledTimes(2);
    expect(listHealthyCandidates).toHaveBeenCalledTimes(1);
    expect(setActiveAccount).toHaveBeenCalledTimes(1);
    expect(logSwitch).toHaveBeenCalledTimes(1);
    expect(result.errorCode).toBe("claude_transient_upstream");
  });

  it("does not fail over when no auto-failover hook is configured", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-10T20:00:00.000Z"));

    const workspaceDir = await makeWorkspace();
    setActiveAccountResolver(async () => ({
      id: "acc-primary",
      label: "Primary OAuth",
      mode: "oauth",
      apiKeySecretId: null,
    }));
    // No setAutoFailoverHook call.

    runChildProcess.mockResolvedValueOnce(makeRateLimitedRunResult());

    const result = await execute({
      runId: "run-no-hook",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Claude Coder",
        adapterType: "claude_local",
        adapterConfig: {},
      },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { command: "claude", cwd: workspaceDir },
      context: {},
      onLog: async () => {},
      onMeta: async () => {},
    });

    expect(runChildProcess).toHaveBeenCalledTimes(1);
    expect(result.errorCode).toBe("claude_transient_upstream");
  });

  // Cross-cutting QA guard (MAS-259 D1): the api-key plaintext must never appear
  // in any meta.env value on any attempt, including after auto-failover swaps the
  // primary oauth account for an api_key fallback. The plaintext is the canary
  // string set up below; if any loggedEnv value contains it, we have a leak in
  // either buildInvocationEnvForLogs redaction or the failover env rebuild path.
  it("after failover from oauth to api_key, no meta.env value leaks the api-key plaintext", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-10T20:00:00.000Z"));

    const workspaceDir = await makeWorkspace();
    const apiKeyValue = "sk-ant-leak-canary-mas-259-do-not-log";

    const accounts = new Map<string, ActiveAnthropicAccount>([
      [
        "company-1",
        {
          id: "acc-primary",
          label: "Primary OAuth",
          mode: "oauth",
          apiKeySecretId: null,
        },
      ],
    ]);

    setActiveAccountResolver(async (companyId) => {
      const account = accounts.get(companyId);
      if (!account) throw new Error(`no account for ${companyId}`);
      return account;
    });
    setApiKeyResolver(async () => apiKeyValue);

    setAutoFailoverHook({
      listHealthyCandidates: async () => [
        {
          id: "acc-api",
          label: "Backup API",
          mode: "api_key",
          apiKeySecretId: "secret-leak-canary",
          lastUtilizationFiveHour: 5,
        },
      ],
      setActiveAccount: async ({ companyId, accountId }) => {
        accounts.set(companyId, {
          id: accountId,
          label: "Backup API",
          mode: "api_key",
          apiKeySecretId: "secret-leak-canary",
        });
      },
      logSwitch: async () => undefined,
    });

    runChildProcess
      .mockImplementationOnce(async () => makeRateLimitedRunResult())
      .mockImplementationOnce(async () => makeOkRunResult("retry-no-leak"));

    const metaCalls: AdapterInvocationMeta[] = [];

    await execute({
      runId: "run-leak-canary",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Claude Coder",
        adapterType: "claude_local",
        adapterConfig: {},
      },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { command: "claude", cwd: workspaceDir },
      context: {},
      onLog: async () => {},
      onMeta: async (meta) => {
        metaCalls.push(meta);
      },
    });

    // The first attempt (oauth) and the retry (api_key) both produce a meta.
    expect(metaCalls.length).toBeGreaterThanOrEqual(2);
    for (const [index, meta] of metaCalls.entries()) {
      for (const [key, value] of Object.entries(meta.env ?? {})) {
        expect(
          value,
          `meta.env[${key}] on attempt #${index + 1} leaked api-key plaintext`,
        ).not.toContain(apiKeyValue);
      }
    }

    // The retry's metadata reports the api_key fallback for operator visibility,
    // but ANTHROPIC_API_KEY in the logged env (if present) must be redacted.
    const retryMeta = metaCalls.at(-1)!;
    expect(retryMeta.env?.paperclipAnthropicAccountMode).toBe("api_key");
    if (retryMeta.env?.ANTHROPIC_API_KEY !== undefined) {
      expect(retryMeta.env.ANTHROPIC_API_KEY).not.toBe(apiKeyValue);
    }
  });
});
