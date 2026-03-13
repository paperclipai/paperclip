import { describe, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { defineLocalAdapterExecuteContract } from "@paperclipai/adapter-utils/local-execute-contract-test";

const {
  mockRunChildProcess,
  mockEnsureCommandResolvable,
} = vi.hoisted(() => ({
  mockRunChildProcess: vi.fn(),
  mockEnsureCommandResolvable: vi.fn(),
}));

vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>(
    "@paperclipai/adapter-utils/server-utils",
  );
  return {
    ...actual,
    runChildProcess: mockRunChildProcess,
    ensureCommandResolvable: mockEnsureCommandResolvable,
  };
});

vi.mock("./parse.js", () => ({
  parseClaudeStreamJson: () => ({
    sessionId: "claude-session-123",
    model: "sonnet",
    costUsd: 0,
    usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
    summary: "hello",
    resultJson: { subtype: "success", result: "hello", total_cost_usd: 0, usage: {} },
  }),
  describeClaudeFailure: () => "Claude failed",
  detectClaudeLoginRequired: () => ({ loginRequired: false, loginUrl: null }),
  isClaudeMaxTurnsResult: () => false,
  isClaudeUnknownSessionError: () => false,
}));

import { execute } from "./execute.js";

function buildContext(overrides: Partial<AdapterExecutionContext> = {}): AdapterExecutionContext {
  return {
    runId: "run-123",
    agent: {
      id: "agent-123",
      companyId: "company-123",
      name: "CEO",
      adapterType: "claude_local",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config: {
      command: "claude",
      model: "sonnet",
    },
    context: {},
    onLog: async () => {},
    onMeta: async () => {},
    authToken: "pcp-test-token",
    ...overrides,
  };
}

describe("claude execute", () => {
  defineLocalAdapterExecuteContract({
    label: "claude",
    execute,
    buildContext,
    defaultConfig: {
      command: "claude",
      model: "sonnet",
    },
    configuredCwdConfig: (configuredCwd) => ({
      command: "claude",
      model: "sonnet",
      cwd: configuredCwd,
    }),
    prepareMocks: async () => {
      mockEnsureCommandResolvable.mockResolvedValue(undefined);
      mockRunChildProcess.mockResolvedValue({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: "",
      });
    },
    getRunOptions: () => {
      const [, , , runOpts] = mockRunChildProcess.mock.calls[0];
      return runOpts;
    },
    getMeta: (onMeta) => {
      const metaCalls = onMeta.mock.calls as unknown as Array<[unknown]>;
      return metaCalls[0]?.[0] as { cwd?: string } | undefined;
    },
  });
});
