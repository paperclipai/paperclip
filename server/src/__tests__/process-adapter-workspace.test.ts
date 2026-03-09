import { beforeEach, describe, expect, it, vi } from "vitest";

const mockBuildPaperclipEnv = vi.hoisted(() => vi.fn());
const mockRedactEnvForLogs = vi.hoisted(() => vi.fn());
const mockRunChildProcess = vi.hoisted(() => vi.fn());

vi.mock("../adapters/utils.js", async () => {
  const actual = await vi.importActual<typeof import("../adapters/utils.js")>("../adapters/utils.js");
  return {
    ...actual,
    buildPaperclipEnv: mockBuildPaperclipEnv,
    redactEnvForLogs: mockRedactEnvForLogs,
    runChildProcess: mockRunChildProcess,
  };
});

import { execute, resolveProcessExecutionCwd } from "../adapters/process/execute.js";

describe("resolveProcessExecutionCwd", () => {
  it("uses the resolved Paperclip workspace when one is available", () => {
    expect(
      resolveProcessExecutionCwd(
        { cwd: "/tmp/configured" },
        {
          paperclipWorkspace: {
            cwd: "/tmp/worktree",
            source: "workspace_checkout",
          },
        },
      ),
    ).toBe("/tmp/worktree");
  });

  it("keeps an explicitly configured cwd when the wake fell back to agent_home", () => {
    expect(
      resolveProcessExecutionCwd(
        { cwd: "/tmp/configured" },
        {
          paperclipWorkspace: {
            cwd: "/tmp/agent-home",
            source: "agent_home",
          },
        },
      ),
    ).toBe("/tmp/configured");
  });
});

describe("process adapter execute", () => {
  beforeEach(() => {
    mockBuildPaperclipEnv.mockReset();
    mockBuildPaperclipEnv.mockReturnValue({
      PAPERCLIP_AGENT_ID: "agent-1",
      PAPERCLIP_COMPANY_ID: "company-1",
      PAPERCLIP_API_URL: "http://127.0.0.1:3101",
    });
    mockRedactEnvForLogs.mockReset();
    mockRedactEnvForLogs.mockImplementation((env) => env);
    mockRunChildProcess.mockReset();
    mockRunChildProcess.mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "ok\n",
      stderr: "",
    });
  });

  it("passes workspace cwd and workspace metadata into the child process", async () => {
    const onMeta = vi.fn().mockResolvedValue(undefined);

    await execute({
      runId: "run-1",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Process Agent",
        adapterType: "process",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: "issue-1",
      },
      config: {
        command: "bash",
        args: ["-lc", "pwd"],
      },
      context: {
        issueId: "issue-1",
        wakeReason: "issue_checked_out",
        paperclipWorkspace: {
          cwd: "/tmp/worktree",
          source: "workspace_checkout",
          workspaceId: "workspace-1",
          repoUrl: "https://example.com/repo.git",
          repoRef: "main",
        },
        paperclipWorkspaces: [{ workspaceId: "workspace-1", cwd: "/tmp/worktree" }],
      },
      onLog: async () => {},
      onMeta,
    });

    expect(mockRunChildProcess).toHaveBeenCalledWith(
      "run-1",
      "bash",
      ["-lc", "pwd"],
      expect.objectContaining({
        cwd: "/tmp/worktree",
        env: expect.objectContaining({
          PAPERCLIP_RUN_ID: "run-1",
          PAPERCLIP_TASK_ID: "issue-1",
          PAPERCLIP_WAKE_REASON: "issue_checked_out",
          PAPERCLIP_WORKSPACE_CWD: "/tmp/worktree",
          PAPERCLIP_WORKSPACE_SOURCE: "workspace_checkout",
          PAPERCLIP_WORKSPACE_ID: "workspace-1",
          PAPERCLIP_WORKSPACE_REPO_URL: "https://example.com/repo.git",
          PAPERCLIP_WORKSPACE_REPO_REF: "main",
          PAPERCLIP_WORKSPACES_JSON: JSON.stringify([{ workspaceId: "workspace-1", cwd: "/tmp/worktree" }]),
        }),
      }),
    );
    expect(onMeta).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: "/tmp/worktree",
      }),
    );
  });
});
