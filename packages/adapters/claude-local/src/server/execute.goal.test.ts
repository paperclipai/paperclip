import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { runChildProcess, ensureCommandResolvable, resolveCommandForLogs } = vi.hoisted(() => ({
  runChildProcess: vi.fn(),
  ensureCommandResolvable: vi.fn(async () => undefined),
  resolveCommandForLogs: vi.fn(async () => "/usr/bin/claude"),
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

import { execute } from "./execute.js";
import { resetClaudeGoalCommandSupportCacheForTests } from "./goal.js";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";

function cliResult(result: string, opts?: { numTurns?: number; sessionId?: string; isError?: boolean }) {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: opts?.isError ?? false,
      num_turns: opts?.numTurns ?? 0,
      result,
      session_id: opts?.sessionId ?? SESSION_ID,
      usage: { input_tokens: 5, cache_read_input_tokens: 0, output_tokens: 7 },
      total_cost_usd: 0.001,
    }),
    stderr: "",
    pid: 42,
    startedAt: new Date().toISOString(),
  };
}

type CliCall = [string, string, string[], { stdin?: string }];

function callArgs(index: number): string[] {
  const call = runChildProcess.mock.calls[index] as unknown as CliCall | undefined;
  return call?.[2] ?? [];
}

describe("claude /goal chat command execution", () => {
  let cwd = "";

  beforeEach(async () => {
    resetClaudeGoalCommandSupportCacheForTests();
    cwd = await mkdtemp(path.join(os.tmpdir(), "paperclip-claude-goal-"));
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
  });

  function baseInput(overrides?: {
    args?: string;
    sessionId?: string | null;
    goalEnabled?: boolean;
    executionTransport?: Record<string, unknown>;
  }) {
    const sessionId = overrides?.sessionId === undefined ? null : overrides.sessionId;
    return {
      runId: "run-goal-1",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Claude Coder",
        adapterType: "claude_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId,
        sessionParams: sessionId ? { sessionId, cwd } : null,
        sessionDisplayId: sessionId,
        taskKey: null,
      },
      config: {
        command: "claude",
        cwd,
        goal: { enabled: overrides?.goalEnabled ?? true },
      },
      context: {
        paperclipChatCommand: {
          name: "goal",
          raw: `/goal ${overrides?.args ?? ""}`.trim(),
          args: overrides?.args ?? "",
          sourceCommentId: "comment-1",
          sourceAuthorType: "user",
        },
      },
      ...(overrides?.executionTransport ? { executionTransport: overrides.executionTransport } : {}),
      onLog: async () => {},
    } as Parameters<typeof execute>[0];
  }

  it("answers status locally when no session exists, without spawning the CLI", async () => {
    const result = await execute(baseInput({ args: "status" }));
    expect(runChildProcess).not.toHaveBeenCalled();
    expect(result.errorCode).toBeNull();
    expect(result.summary).toBe("No goal set.");
    const resultJson = result.resultJson as Record<string, unknown>;
    expect(resultJson.chatCommand).toMatchObject({ name: "goal", action: "status", sourceCommentId: "comment-1" });
    expect(resultJson.claudeGoal).toMatchObject({ objective: null, status: "cleared" });
  });

  it("rejects an empty /goal without spawning the CLI", async () => {
    const result = await execute(baseInput({ args: "" }));
    expect(runChildProcess).not.toHaveBeenCalled();
    expect((result.resultJson as Record<string, unknown>).chatCommand).toMatchObject({ action: "invalid" });
    expect(result.summary).toContain("`/goal` needs an objective");
  });

  it("refuses remote execution targets before any process spawn", async () => {
    const result = await execute(
      baseInput({
        args: "all tests pass",
        executionTransport: {
          remoteExecution: {
            host: "127.0.0.1",
            port: 2222,
            username: "fixture",
            remoteWorkspacePath: "/remote/workspace",
            remoteCwd: "/remote/workspace",
            privateKey: "PRIVATE KEY",
            knownHosts: "[127.0.0.1]:2222 ssh-ed25519 AAAA",
            strictHostKeyChecking: true,
          },
        },
      }),
    );
    expect(runChildProcess).not.toHaveBeenCalled();
    expect(result.errorCode).toBe("claude_goal_remote_unsupported");
  });

  it("refuses when the goal command is not enabled in adapter config", async () => {
    const result = await execute(baseInput({ args: "all tests pass", goalEnabled: false }));
    expect(runChildProcess).not.toHaveBeenCalled();
    expect(result.errorCode).toBe("claude_goal_not_enabled");
  });

  it("reports an unsupported CLI when the capability probe falls through to the model", async () => {
    // A gated/older CLI treats "/goal" as prose: the model answers and
    // num_turns goes positive. Nothing may touch the issue session afterwards.
    runChildProcess.mockResolvedValueOnce(cliResult("Sure — what goal would you like to set?", { numTurns: 1 }));
    const result = await execute(baseInput({ args: "all tests pass", sessionId: SESSION_ID }));
    expect(runChildProcess).toHaveBeenCalledTimes(1);
    expect(callArgs(0)).toContain("--no-session-persistence");
    expect(result.errorCode).toBe("claude_goal_unsupported_cli");
  });

  it("runs /goal status against the saved session as an argv prompt", async () => {
    runChildProcess
      .mockResolvedValueOnce(cliResult("No goal set")) // capability probe
      .mockResolvedValueOnce(
        cliResult("Goal active: a marker file exists (not yet evaluated)", { sessionId: SESSION_ID }),
      );
    const result = await execute(baseInput({ args: "status", sessionId: SESSION_ID }));
    expect(runChildProcess).toHaveBeenCalledTimes(2);
    const statusArgs = callArgs(1);
    expect(statusArgs.slice(0, 2)).toEqual(["--print", "/goal"]);
    expect(statusArgs).toContain("--resume");
    expect(statusArgs).toContain(SESSION_ID);
    const statusCall = runChildProcess.mock.calls[1] as unknown as CliCall;
    expect(statusCall[3].stdin).toBeUndefined();
    expect(result.errorCode).toBeNull();
    expect((result.resultJson as Record<string, unknown>).claudeGoal).toMatchObject({
      objective: "a marker file exists",
      status: "active",
      evaluation: "not yet evaluated",
    });
    expect(result.sessionId).toBe(SESSION_ID);
  });

  it("clears the goal and maps Claude clear synonyms onto the clear action", async () => {
    runChildProcess
      .mockResolvedValueOnce(cliResult("No goal set")) // capability probe
      .mockResolvedValueOnce(cliResult("Goal cleared: a marker file exists", { sessionId: SESSION_ID }));
    const result = await execute(baseInput({ args: "stop", sessionId: SESSION_ID }));
    const clearArgs = callArgs(1);
    expect(clearArgs.slice(0, 2)).toEqual(["--print", "/goal clear"]);
    const resultJson = result.resultJson as Record<string, unknown>;
    expect(resultJson.chatCommand).toMatchObject({ action: "clear" });
    expect(resultJson.claudeGoal).toMatchObject({ objective: "a marker file exists", status: "cleared" });
  });

  it("sets a goal, works until met, and reports complete after the auto-clear status probe", async () => {
    runChildProcess
      .mockResolvedValueOnce(cliResult("No goal set")) // capability probe
      .mockResolvedValueOnce(
        cliResult("Goal complete. Created marker.txt with the word done.", {
          numTurns: 2,
          sessionId: SESSION_ID,
        }),
      )
      .mockResolvedValueOnce(cliResult("No goal set", { sessionId: SESSION_ID })); // post-run status probe
    const result = await execute(baseInput({ args: "a marker file exists" }));
    expect(runChildProcess).toHaveBeenCalledTimes(3);
    const setArgs = callArgs(1);
    expect(setArgs.slice(0, 2)).toEqual(["--print", "/goal a marker file exists"]);
    const probeArgs = callArgs(2);
    expect(probeArgs.slice(0, 2)).toEqual(["--print", "/goal"]);
    expect(probeArgs).toContain("--resume");
    const resultJson = result.resultJson as Record<string, unknown>;
    expect(resultJson.chatCommand).toMatchObject({ action: "set" });
    expect(resultJson.claudeGoal).toMatchObject({
      objective: "a marker file exists",
      status: "complete",
      tokenBudget: null,
      tokensUsed: 12,
    });
    expect(result.summary).toContain("Goal met: a marker file exists");
    expect(result.sessionId).toBe(SESSION_ID);
    expect(result.sessionParams).toMatchObject({ sessionId: SESSION_ID, cwd });
  });

  it("reports the goal still active when the post-run probe sees it unmet", async () => {
    runChildProcess
      .mockResolvedValueOnce(cliResult("No goal set")) // capability probe
      .mockResolvedValueOnce(cliResult("I made progress but the suite still fails.", { numTurns: 4, sessionId: SESSION_ID }))
      .mockResolvedValueOnce(cliResult("Goal active: all tests pass (not met)", { sessionId: SESSION_ID }));
    const result = await execute(baseInput({ args: "all tests pass" }));
    const resultJson = result.resultJson as Record<string, unknown>;
    expect(resultJson.claudeGoal).toMatchObject({ status: "active", evaluation: "not met" });
    expect(result.summary).toContain("Still active after this run");
  });

  it("surfaces zero-turn CLI rejections as invalid instead of pretending the goal was set", async () => {
    runChildProcess
      .mockResolvedValueOnce(cliResult("No goal set")) // capability probe
      .mockResolvedValueOnce(
        cliResult("/goal is only available in trusted workspaces. Restart, accept the trust dialog, and try again.", {
          sessionId: SESSION_ID,
        }),
      );
    const result = await execute(baseInput({ args: "all tests pass" }));
    expect(runChildProcess).toHaveBeenCalledTimes(2);
    expect((result.resultJson as Record<string, unknown>).chatCommand).toMatchObject({ action: "invalid" });
    expect(result.summary).toContain("trusted workspaces");
  });
});
