import { describe, expect, it, vi } from "vitest";

const { runAdapterExecutionTargetProcess } = vi.hoisted(() => ({
  runAdapterExecutionTargetProcess: vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: "",
    stderr: "",
    pid: 123,
    startedAt: new Date().toISOString(),
  })),
}));

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    ensureAdapterExecutionTargetDirectory: vi.fn(async () => {}),
    ensureAdapterExecutionTargetCommandResolvable: vi.fn(async () => {}),
    maybeRunSandboxInstallCommand: vi.fn(async () => null),
    runAdapterExecutionTargetProcess,
    describeAdapterExecutionTarget: vi.fn(() => "local"),
    resolveAdapterExecutionTargetCwd: vi.fn(() => "/home/paperclip"),
  };
});

import { runClaudeLogin } from "./execute.js";

describe("runClaudeLogin", () => {
  it("invokes the `auth login` subcommand, not a bare `login` argument", async () => {
    await runClaudeLogin({
      runId: "run-1",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "CEO",
        adapterType: "claude_local",
        adapterConfig: {},
      } as Parameters<typeof runClaudeLogin>[0]["agent"],
      config: {},
    });

    expect(runAdapterExecutionTargetProcess).toHaveBeenCalledTimes(1);
    const args = runAdapterExecutionTargetProcess.mock.calls[0]?.[3] as unknown as string[];
    // `claude login` is not a subcommand: the CLI treats the word as a prompt,
    // answers it conversationally, exits 0, and the login URL is never emitted.
    expect(args).toEqual(["auth", "login"]);
  });
});
