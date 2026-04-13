import { describe, expect, it, vi } from "vitest";

const { createMockRunChildProcess } = vi.hoisted(() => {
  const createMockRunChildProcess = (responses: Array<{
    exitCode: number | null;
    signal: string | null;
    timedOut: boolean;
    stdout: string;
    stderr: string;
  }>) => {
    let callIndex = 0;
    const mock = vi.fn().mockImplementation(async () => {
      const response = responses[Math.min(callIndex, responses.length - 1)];
      callIndex++;
      return {
        ...response,
        pid: 12345 + callIndex,
        startedAt: new Date().toISOString(),
      };
    });
    return { mock, getCallCount: () => callIndex };
  };

  return { createMockRunChildProcess };
});

vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>(
    "@paperclipai/adapter-utils/server-utils",
  );
  return {
    ...actual,
    runChildProcess: vi.fn(),
    ensureOpenCodeModelConfiguredAndAvailable: vi.fn().mockResolvedValue([]),
    prepareOpenCodeRuntimeConfig: vi.fn().mockResolvedValue({
      env: {},
      notes: [],
      cleanup: vi.fn(),
    }),
  };
});

vi.mock("./models.js", () => ({
  ensureOpenCodeModelConfiguredAndAvailable: vi.fn().mockResolvedValue([]),
}));

vi.mock("./runtime-config.js", () => ({
  prepareOpenCodeRuntimeConfig: vi.fn().mockResolvedValue({
    env: {},
    notes: [],
    cleanup: vi.fn(),
  }),
}));

import { execute } from "./execute.js";
import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";

const mockedRunChildProcess = vi.mocked(runChildProcess);

describe("execute delegation guard", () => {
  it("prompt includes delegation policy section", async () => {
    mockedRunChildProcess.mockResolvedValueOnce({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: JSON.stringify({ type: "text", part: { text: "done" } }),
      stderr: "",
      pid: 12345,
      startedAt: new Date().toISOString(),
    });

    const logChunks: string[] = [];
    await execute({
      runId: "test-run-1",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "TestAgent",
      } as any,
      runtime: {
        sessionId: null,
        sessionDisplayId: null,
        sessionParams: null,
      },
      config: {
        model: "test/model",
        cwd: "/tmp",
        dangerouslySkipPermissions: false,
      },
      context: {},
      onLog: async (_stream: string, chunk: string) => {
        logChunks.push(chunk);
      },
    } as any);

    const callArgs = mockedRunChildProcess.mock.calls[0];
    const stdinPrompt = callArgs[3].stdin as string;
    expect(stdinPrompt).toContain("Delegation Policy");
    expect(stdinPrompt).toContain("NEVER use run_in_background=true");
    expect(stdinPrompt).toContain("run_in_background=false");
    expect(stdinPrompt).toContain("Your process exits when you stop responding");
  });
});

describe("execute delegation continuation", () => {
  it("resumes session when background delegation is detected", async () => {
    const sessionA = "sess_abc123";
    const backgroundDelegationStdout = [
      JSON.stringify({ type: "text", sessionID: sessionA, part: { text: "Delegating to explore agent" } }),
      JSON.stringify({
        type: "tool_use",
        sessionID: sessionA,
        part: {
          name: "task",
          input: {
            description: "Find patterns",
            prompt: "Search X",
            run_in_background: true,
          },
          state: { status: "done" },
        },
      }),
      JSON.stringify({ type: "text", sessionID: sessionA, part: { text: "Delegation complete" } }),
    ].join("\n");

    const continuationStdout = [
      JSON.stringify({ type: "text", sessionID: sessionA, part: { text: "Sub-agent results received, continuing work" } }),
      JSON.stringify({ type: "step_finish", sessionID: sessionA, part: { reason: "done", tokens: { input: 100, output: 50 }, cost: 0.001 } }),
    ].join("\n");

    const { mock } = createMockRunChildProcess([
      { exitCode: 0, signal: null, timedOut: false, stdout: backgroundDelegationStdout, stderr: "" },
      { exitCode: 0, signal: null, timedOut: false, stdout: continuationStdout, stderr: "" },
    ]);
    mockedRunChildProcess.mockImplementation(mock);

    const result = await execute({
      runId: "test-run-continuation",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "TestAgent",
      } as any,
      runtime: {
        sessionId: null,
        sessionDisplayId: null,
        sessionParams: null,
      },
      config: {
        model: "test/model",
        cwd: "/tmp",
        dangerouslySkipPermissions: false,
      },
      context: {},
      onLog: vi.fn(),
    } as any);

    expect(mock).toHaveBeenCalledTimes(2);
    expect(result.exitCode).toBe(0);
    expect(result.errorMessage).toBeNull();

    const secondCallArgsList = mock.mock.calls[1][2];
    expect(secondCallArgsList).toContain("--session");
    expect(secondCallArgsList).toContain(sessionA);
  });

  it("does not continue when no background delegation is detected", async () => {
    const normalStdout = [
      JSON.stringify({ type: "text", part: { text: "Work completed" } }),
      JSON.stringify({ type: "step_finish", part: { reason: "done", tokens: { input: 100, output: 50 }, cost: 0.001 } }),
    ].join("\n");

    const { mock } = createMockRunChildProcess([
      { exitCode: 0, signal: null, timedOut: false, stdout: normalStdout, stderr: "" },
    ]);
    mockedRunChildProcess.mockImplementation(mock);

    await execute({
      runId: "test-run-no-delegation",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "TestAgent",
      } as any,
      runtime: {
        sessionId: null,
        sessionDisplayId: null,
        sessionParams: null,
      },
      config: {
        model: "test/model",
        cwd: "/tmp",
        dangerouslySkipPermissions: false,
      },
      context: {},
      onLog: vi.fn(),
    } as any);

    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("stops continuing after max delegation continuations and returns last attempt", async () => {
    const sessionA = "sess_max_test";
    const alwaysDelegatingStdout = [
      JSON.stringify({ type: "text", sessionID: sessionA, part: { text: "Delegating again" } }),
      JSON.stringify({
        type: "tool_use",
        sessionID: sessionA,
        part: {
          name: "task",
          input: { description: "More work", prompt: "X", run_in_background: true },
          state: { status: "done" },
        },
      }),
    ].join("\n");

    const finalAttemptStdout = [
      JSON.stringify({ type: "text", sessionID: sessionA, part: { text: "Final attempt summary" } }),
      JSON.stringify({
        type: "tool_use",
        sessionID: sessionA,
        part: {
          name: "task",
          input: { description: "Still delegating", prompt: "Y", run_in_background: true },
          state: { status: "done" },
        },
      }),
    ].join("\n");

    const { mock } = createMockRunChildProcess([
      { exitCode: 0, signal: null, timedOut: false, stdout: alwaysDelegatingStdout, stderr: "" },
      { exitCode: 0, signal: null, timedOut: false, stdout: alwaysDelegatingStdout, stderr: "" },
      { exitCode: 0, signal: null, timedOut: false, stdout: finalAttemptStdout, stderr: "" },
    ]);
    mockedRunChildProcess.mockImplementation(mock);

    const result = await execute({
      runId: "test-run-max-continuations",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "TestAgent",
      } as any,
      runtime: {
        sessionId: null,
        sessionDisplayId: null,
        sessionParams: null,
      },
      config: {
        model: "test/model",
        cwd: "/tmp",
        dangerouslySkipPermissions: false,
      },
      context: {},
      onLog: vi.fn(),
    } as any);

    expect(mock).toHaveBeenCalledTimes(3);
    expect(result.summary).toBe("Final attempt summary");
  });
});
