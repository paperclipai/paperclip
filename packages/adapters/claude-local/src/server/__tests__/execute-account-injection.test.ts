import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterInvocationMeta } from "@paperclipai/adapter-utils";

const { runChildProcess, ensureCommandResolvable, resolveCommandForLogs } = vi.hoisted(() => ({
  runChildProcess: vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: [
      JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: "claude-session-acc",
        model: "claude-sonnet",
      }),
      JSON.stringify({
        type: "result",
        session_id: "claude-session-acc",
        result: "ok",
        usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 },
      }),
    ].join("\n"),
    stderr: "",
    pid: 1234,
    startedAt: new Date().toISOString(),
  })),
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
} from "../account-store.js";
import { execute } from "../execute.js";

describe("claude-local active anthropic account injection", () => {
  const cleanupDirs: string[] = [];
  const originalHome = process.env.HOME;
  const originalPaperclipHome = process.env.PAPERCLIP_HOME;

  beforeEach(async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-claude-acc-"));
    cleanupDirs.push(root);
    process.env.HOME = root;
    delete process.env.PAPERCLIP_HOME;
    runChildProcess.mockClear();
    ensureCommandResolvable.mockClear();
    resolveCommandForLogs.mockClear();
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

  it("injects CLAUDE_CONFIG_DIR for an oauth-mode active account and stamps account metadata onto loggedEnv", async () => {
    const workspaceDir = await makeWorkspace();
    setActiveAccountResolver(async (companyId, agentId) => ({
      id: "acc-oauth-1",
      label: "Primary OAuth",
      mode: "oauth",
      apiKeySecretId: null,
    }));
    let captured: AdapterInvocationMeta | undefined;

    await execute({
      runId: "run-acc-oauth",
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
        captured = meta;
      },
    });

    const expectedDir = accountDir("acc-oauth-1");
    expect(runChildProcess).toHaveBeenCalledTimes(1);
    const call = runChildProcess.mock.calls[0] as unknown as [
      string,
      string,
      string[],
      { env: Record<string, string> },
    ];
    const subprocessEnv = call[3].env;
    expect(subprocessEnv.CLAUDE_CONFIG_DIR).toBe(expectedDir);
    // oauth mode does not put any api key into the executable env.
    expect(subprocessEnv.ANTHROPIC_API_KEY).toBeUndefined();

    expect(captured).toBeDefined();
    const meta = captured as AdapterInvocationMeta;
    expect(meta.anthropicAccountId).toBe("acc-oauth-1");
    expect(meta.env?.paperclipAnthropicAccountId).toBe("acc-oauth-1");
    expect(meta.env?.paperclipAnthropicAccountLabel).toBe("Primary OAuth");
    expect(meta.env?.paperclipAnthropicAccountMode).toBe("oauth");
    expect(meta.env?.CLAUDE_CONFIG_DIR).toBe(expectedDir);
    // No api-key value should appear anywhere in loggedEnv.
    for (const value of Object.values(meta.env ?? {})) {
      expect(value).not.toContain("oauth-token-");
    }
  });

  it("injects ANTHROPIC_API_KEY via the resolver for an api_key-mode account and redacts the value in loggedEnv", async () => {
    const workspaceDir = await makeWorkspace();
    const apiKeyValue = "sk-ant-test-secret-value-do-not-leak";
    let resolveCalls = 0;
    setApiKeyResolver(async (secretId) => {
      resolveCalls += 1;
      expect(secretId).toBe("secret-abc");
      return apiKeyValue;
    });
    setActiveAccountResolver(async () => ({
      id: "acc-api-1",
      label: "Backup API",
      mode: "api_key",
      apiKeySecretId: "secret-abc",
    }));
    let captured: AdapterInvocationMeta | undefined;

    await execute({
      runId: "run-acc-apikey",
      agent: {
        id: "agent-2",
        companyId: "company-2",
        name: "Claude Coder",
        adapterType: "claude_local",
        adapterConfig: {},
      },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { command: "claude", cwd: workspaceDir },
      context: {},
      onLog: async () => {},
      onMeta: async (meta) => {
        captured = meta;
      },
    });

    expect(resolveCalls).toBe(1);
    expect(runChildProcess).toHaveBeenCalledTimes(1);
    const call = runChildProcess.mock.calls[0] as unknown as [
      string,
      string,
      string[],
      { env: Record<string, string> },
    ];
    const subprocessEnv = call[3].env;
    // The actual subprocess sees the resolved key value.
    expect(subprocessEnv.ANTHROPIC_API_KEY).toBe(apiKeyValue);

    expect(captured).toBeDefined();
    const meta = captured as AdapterInvocationMeta;
    expect(meta.anthropicAccountId).toBe("acc-api-1");
    expect(meta.env?.paperclipAnthropicAccountId).toBe("acc-api-1");
    expect(meta.env?.paperclipAnthropicAccountLabel).toBe("Backup API");
    expect(meta.env?.paperclipAnthropicAccountMode).toBe("api_key");
    // The logged env must NOT contain the plaintext key value.
    expect(meta.env?.ANTHROPIC_API_KEY).toBeDefined();
    expect(meta.env?.ANTHROPIC_API_KEY).not.toBe(apiKeyValue);
    for (const value of Object.values(meta.env ?? {})) {
      expect(value).not.toContain(apiKeyValue);
    }
  });

  it("falls back gracefully when no resolver is configured (existing single-account installs)", async () => {
    const workspaceDir = await makeWorkspace();
    // Resolver intentionally not registered.
    let captured: AdapterInvocationMeta | undefined;
    const stderrChunks: string[] = [];

    await execute({
      runId: "run-no-resolver",
      agent: {
        id: "agent-3",
        companyId: "company-3",
        name: "Claude Coder",
        adapterType: "claude_local",
        adapterConfig: {},
      },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { command: "claude", cwd: workspaceDir },
      context: {},
      onLog: async (stream, chunk) => {
        if (stream === "stderr") stderrChunks.push(chunk);
      },
      onMeta: async (meta) => {
        captured = meta;
      },
    });

    // Should run without throwing, no metadata stamped, no warning emitted
    // (resolver simply not configured — distinct from "configured but threw").
    expect(runChildProcess).toHaveBeenCalledTimes(1);
    expect(captured).toBeDefined();
    const metaSafe = captured as AdapterInvocationMeta;
    expect(metaSafe.anthropicAccountId).toBeUndefined();
    expect(metaSafe.env?.paperclipAnthropicAccountId).toBeUndefined();
    expect(stderrChunks.join("")).not.toMatch(/could not resolve active Anthropic account/);
  });

  it("emits a warning and proceeds when the resolver is registered but fails (e.g. no active account)", async () => {
    const workspaceDir = await makeWorkspace();
    setActiveAccountResolver(async () => {
      throw new Error("No active Anthropic account configured for this company");
    });
    let captured: AdapterInvocationMeta | undefined;
    const stderrChunks: string[] = [];

    await execute({
      runId: "run-resolver-fail",
      agent: {
        id: "agent-4",
        companyId: "company-4",
        name: "Claude Coder",
        adapterType: "claude_local",
        adapterConfig: {},
      },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { command: "claude", cwd: workspaceDir },
      context: {},
      onLog: async (stream, chunk) => {
        if (stream === "stderr") stderrChunks.push(chunk);
      },
      onMeta: async (meta) => {
        captured = meta;
      },
    });

    expect(runChildProcess).toHaveBeenCalledTimes(1);
    expect(captured).toBeDefined();
    const metaSafe = captured as AdapterInvocationMeta;
    expect(metaSafe.anthropicAccountId).toBeUndefined();
    expect(metaSafe.env?.paperclipAnthropicAccountId).toBeUndefined();
    expect(stderrChunks.join("")).toMatch(/could not resolve active Anthropic account/);
  });
});
