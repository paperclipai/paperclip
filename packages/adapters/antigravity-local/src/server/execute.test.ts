// Unit tests for Antigravity local execution service verifying flags, permissions, prompt security, and session management
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";

type ProcessCall = {
  command: string;
  args: string[];
  opts: Record<string, unknown>;
};

const recordedCalls: ProcessCall[] = [];
let mockProcessResult = {
  exitCode: 0 as number | null,
  stdout: JSON.stringify({
    event: "result",
    result: {
      status: "SUCCESS",
      conversation_id: "conv-mock-1",
      response: "task complete",
      usage: { input_tokens: 50, output_tokens: 15 },
    },
  }),
  stderr: "",
  timedOut: false,
};

vi.mock("@paperclipai/adapter-utils/execution-target", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    ensureAdapterExecutionTargetCommandResolvable: vi.fn().mockResolvedValue(undefined),
    ensureAdapterExecutionTargetRuntimeCommandInstalled: vi.fn().mockResolvedValue(undefined),
    resolveAdapterExecutionTargetCommandForLogs: vi.fn().mockImplementation((cmd: string) => Promise.resolve(cmd)),
    runAdapterExecutionTargetProcess: vi.fn().mockImplementation(
      async (_runId: string, _target: unknown, command: string, args: string[], opts: Record<string, unknown>) => {
        recordedCalls.push({ command, args, opts });
        return mockProcessResult;
      },
    ),
  };
});

import { execute } from "./execute.js";

function makeContext(overrides: {
  config?: Record<string, unknown>;
  runtime?: Record<string, unknown>;
  context?: Record<string, unknown>;
  authToken?: string | null;
}): AdapterExecutionContext {
  return {
    runId: "run-test-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Test Agent",
      adapterType: "antigravity_local",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
      ...overrides.runtime,
    },
    config: {
      command: "agy",
      cwd: "/test/workspace",
      model: "gemini-3.8-flash-high",
      promptTemplate: "Perform work.",
      ...overrides.config,
    },
    context: overrides.context ?? {},
    authToken: overrides.authToken ?? "test-auth-token",
    onLog: async () => {},
  } as unknown as AdapterExecutionContext;
}

describe("antigravity execute unit tests", () => {
  beforeEach(() => {
    recordedCalls.length = 0;
    mockProcessResult = {
      exitCode: 0,
      stdout: JSON.stringify({
        event: "result",
        result: {
          status: "SUCCESS",
          conversation_id: "conv-mock-1",
          response: "task complete",
          usage: { input_tokens: 50, output_tokens: 15 },
        },
      }),
      stderr: "",
      timedOut: false,
    };
  });

  it("defaults dangerouslySkipPermissions to false and does NOT pass --dangerously-skip-permissions", async () => {
    const ctx = makeContext({ config: {} });
    const result = await execute(ctx);

    expect(result.exitCode).toBe(0);
    expect(recordedCalls).toHaveLength(1);
    const args = recordedCalls[0].args;
    expect(args).not.toContain("--dangerously-skip-permissions");
  });

  it("passes --dangerously-skip-permissions only when dangerouslySkipPermissions is explicitly true", async () => {
    const ctx = makeContext({
      config: { dangerouslySkipPermissions: true },
    });
    const result = await execute(ctx);

    expect(result.exitCode).toBe(0);
    expect(recordedCalls).toHaveLength(1);
    const args = recordedCalls[0].args;
    expect(args).toContain("--dangerously-skip-permissions");
  });

  it("ensures prompt does NOT leak PAPERCLIP_API_KEY, auth bearer tokens, or curl instructions", async () => {
    const ctx = makeContext({
      authToken: "super-secret-jwt-bearer-token",
    });
    await execute(ctx);

    expect(recordedCalls).toHaveLength(1);
    const args = recordedCalls[0].args;
    const printIndex = args.indexOf("--print");
    expect(printIndex).toBeGreaterThanOrEqual(0);
    const prompt = args[printIndex + 1];

    expect(prompt).not.toContain("super-secret-jwt-bearer-token");
    expect(prompt).not.toContain("PAPERCLIP_API_KEY");
    expect(prompt).not.toContain("Authorization: Bearer");
    expect(prompt).not.toContain("curl");
  });

  it("handles string extraArgs separated by comma or whitespace", async () => {
    const ctx = makeContext({
      config: { extraArgs: "--verbose, --debug, --flag=1" },
    });
    await execute(ctx);

    expect(recordedCalls).toHaveLength(1);
    const args = recordedCalls[0].args;
    expect(args).toContain("--verbose");
    expect(args).toContain("--debug");
    expect(args).toContain("--flag=1");
  });

  it("handles structured ERROR or FAILURE as failure even when exitCode is 0", async () => {
    mockProcessResult = {
      exitCode: 0,
      stdout: JSON.stringify({
        event: "result",
        result: {
          status: "FAILURE",
          error: "API rate limit reached",
          response: "",
        },
      }),
      stderr: "",
      timedOut: false,
    };

    const ctx = makeContext({});
    const result = await execute(ctx);

    expect(result.errorMessage).toBe("API rate limit reached");
    expect(result.exitCode).toBe(0);
  });

  it("clears/does not rebind old session ID when cwd changed and child returns no new session ID", async () => {
    mockProcessResult = {
      exitCode: 0,
      stdout: JSON.stringify({
        event: "result",
        result: {
          status: "SUCCESS",
          response: "done without emitting id",
        },
      }),
      stderr: "",
      timedOut: false,
    };

    const ctx = makeContext({
      config: { cwd: "/test/new-workspace" },
      runtime: {
        sessionId: "old-session-from-other-workspace",
        sessionParams: {
          sessionId: "old-session-from-other-workspace",
          cwd: "/test/old-workspace",
        },
      },
    });

    const result = await execute(ctx);
    // Because cwd did not match, session could not be resumed, and because child emitted no ID,
    // resolvedSessionId must be null, not falling back to old-session-from-other-workspace
    expect(result.sessionId).toBeNull();
  });
});
