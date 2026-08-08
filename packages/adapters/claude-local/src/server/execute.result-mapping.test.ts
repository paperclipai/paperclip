import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetRuntimeCommandInstalled,
  resolveAdapterExecutionTargetCommandForLogs,
  runAdapterExecutionTargetProcess,
} = vi.hoisted(() => ({
  ensureAdapterExecutionTargetCommandResolvable: vi.fn(async () => undefined),
  ensureAdapterExecutionTargetRuntimeCommandInstalled: vi.fn(async () => undefined),
  resolveAdapterExecutionTargetCommandForLogs: vi.fn(async () => "claude"),
  runAdapterExecutionTargetProcess: vi.fn(),
}));

vi.mock("./acp.js", () => ({
  createClaudeAcpExecutor: () => vi.fn(),
  formatClaudeAcpFallbackMessage: (reason: string) => `[paperclip] ${reason}\n`,
  resolveClaudeExecutionEngineForRun: async () => ({ engine: "cli" as const, explicit: true }),
}));

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    ensureAdapterExecutionTargetCommandResolvable,
    ensureAdapterExecutionTargetRuntimeCommandInstalled,
    resolveAdapterExecutionTargetCommandForLogs,
    runAdapterExecutionTargetProcess,
  };
});

import { execute } from "./execute.js";

function buildContext(config: Record<string, unknown> = {}) {
  return {
    runId: "run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Claude Coder",
      adapterType: "claude_local",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config: { timeoutSec: 45, ...config },
    context: {},
    onLog: vi.fn(async () => {}),
  };
}

describe("claude_local exec timeout attribution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("attributes a dropped sandbox exec channel to the sandbox, not the adapter wall clock", async () => {
    const watchdogMessage =
      "execInPod timed out after 870000ms (pod=agent-abc, container=agent, cmd0=claude). " +
      "The WebSocket likely dropped before the command produced a status frame.";
    runAdapterExecutionTargetProcess.mockResolvedValueOnce({
      exitCode: null,
      signal: null,
      timedOut: true,
      stdout: "",
      stderr: watchdogMessage,
      pid: 123,
      startedAt: new Date().toISOString(),
    });

    const ctx = buildContext();
    const result = await execute(ctx as never);

    expect(result.timedOut).toBe(true);
    expect(result.errorCode).toBe("sandbox_exec_timeout");
    expect(result.errorMessage).toBe(watchdogMessage);
  });

  it("keeps the legacy adapter wall-clock timeout message for a genuine timeout", async () => {
    runAdapterExecutionTargetProcess.mockResolvedValueOnce({
      exitCode: null,
      signal: null,
      timedOut: true,
      stdout: "",
      stderr: "some unrelated stderr noise",
      pid: 123,
      startedAt: new Date().toISOString(),
    });

    const ctx = buildContext();
    const result = await execute(ctx as never);

    expect(result.timedOut).toBe(true);
    expect(result.errorCode).toBe("timeout");
    expect(result.errorMessage).toBe("Timed out after 45s");
  });
});
