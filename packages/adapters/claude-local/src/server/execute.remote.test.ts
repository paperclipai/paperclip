import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const {
  runChildProcess,
  ensureCommandResolvable,
  resolveCommandForLogs,
  prepareWorkspaceForSshExecution,
  restoreWorkspaceFromSshExecution,
  syncDirectoryToSsh,
  startAdapterExecutionTargetPaperclipBridge,
} = vi.hoisted(() => ({
  runChildProcess: vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: [
      JSON.stringify({ type: "system", subtype: "init", session_id: "claude-session-1", model: "claude-sonnet" }),
      JSON.stringify({ type: "assistant", session_id: "claude-session-1", message: { content: [{ type: "text", text: "hello" }] } }),
      JSON.stringify({ type: "result", session_id: "claude-session-1", result: "hello", usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 } }),
    ].join("\n"),
    stderr: "",
    pid: 123,
    startedAt: new Date().toISOString(),
  })),
  ensureCommandResolvable: vi.fn(async () => undefined),
  resolveCommandForLogs: vi.fn(async () => "ssh://fixture@127.0.0.1:2222/remote/workspace :: claude"),
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

vi.mock("@paperclipai/adapter-utils/ssh", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/ssh")>(
    "@paperclipai/adapter-utils/ssh",
  );
  return {
    ...actual,
    prepareWorkspaceForSshExecution,
    restoreWorkspaceFromSshExecution,
    syncDirectoryToSsh,
  };
});

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    startAdapterExecutionTargetPaperclipBridge,
  };
});

import { execute } from "./execute.js";

describe("claude remote execution", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    vi.clearAllMocks();
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("prepares the workspace, syncs Claude runtime assets, and restores workspace changes for remote SSH execution", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-claude-remote-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const alternateWorkspaceDir = path.join(rootDir, "workspace-other");
    const instructionsPath = path.join(rootDir, "instructions.md");
    const managedRemoteWorkspace = "/remote/workspace/.paperclip-runtime/runs/run-1/workspace";
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(alternateWorkspaceDir, { recursive: true });
    await writeFile(instructionsPath, "Use the remote workspace.\n", "utf8");

    await execute({
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
      config: {
        command: "claude",
        instructionsFilePath: instructionsPath,
        env: {
          QA_PROJECT_WORKSPACE_CWD: workspaceDir,
          RANDOM_WORKSPACE_CWD: workspaceDir,
          OTHER_ENV: workspaceDir,
        },
      },
      context: {
        paperclipWorkspace: {
          cwd: workspaceDir,
          source: "project_primary",
          strategy: "git_worktree",
          workspaceId: "workspace-1",
          repoUrl: "https://github.com/paperclipai/paperclip.git",
          repoRef: "main",
          branchName: "feature/remote-claude",
          worktreePath: workspaceDir,
        },
        paperclipWorkspaces: [
          {
            workspaceId: "workspace-1",
            cwd: workspaceDir,
            repoUrl: "https://github.com/paperclipai/paperclip.git",
            repoRef: "main",
          },
          {
            workspaceId: "workspace-2",
            cwd: alternateWorkspaceDir,
            repoUrl: "https://github.com/paperclipai/paperclip.git",
            repoRef: "feature/other",
          },
        ],
      },
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
      onLog: async () => {},
    });

    expect(prepareWorkspaceForSshExecution).toHaveBeenCalledTimes(1);
    expect(prepareWorkspaceForSshExecution).toHaveBeenCalledWith(expect.objectContaining({
      localDir: workspaceDir,
      remoteDir: managedRemoteWorkspace,
    }));
    expect(syncDirectoryToSsh).toHaveBeenCalledTimes(1);
    expect(syncDirectoryToSsh).toHaveBeenCalledWith(expect.objectContaining({
      remoteDir: `${managedRemoteWorkspace}/.paperclip-runtime/claude/skills`,
      followSymlinks: true,
    }));
    expect(runChildProcess).toHaveBeenCalledTimes(1);
    const call = runChildProcess.mock.calls[0] as unknown as
      | [string, string, string[], { env: Record<string, string>; remoteExecution?: { remoteCwd: string } | null }]
      | undefined;
    expect(call?.[2]).toContain("--append-system-prompt-file");
    expect(call?.[2]).toContain(
      `${managedRemoteWorkspace}/.paperclip-runtime/claude/skills/agent-instructions.md`,
    );
    expect(call?.[2]).toContain("--add-dir");
    expect(call?.[2]).toContain(`${managedRemoteWorkspace}/.paperclip-runtime/claude/skills`);
    expect(call?.[3].env.PAPERCLIP_WORKSPACE_CWD).toBe(managedRemoteWorkspace);
    expect(call?.[3].env.PAPERCLIP_WORKSPACE_WORKTREE_PATH).toBeUndefined();
    expect(JSON.parse(call?.[3].env.PAPERCLIP_WORKSPACES_JSON ?? "[]")).toEqual([
      {
        workspaceId: "workspace-1",
        cwd: managedRemoteWorkspace,
        repoUrl: "https://github.com/paperclipai/paperclip.git",
        repoRef: "main",
      },
      {
        workspaceId: "workspace-2",
        repoUrl: "https://github.com/paperclipai/paperclip.git",
        repoRef: "feature/other",
      },
    ]);
    expect(call?.[3].env.PAPERCLIP_API_URL).toBe("http://127.0.0.1:4310");
    expect(call?.[3].env.PAPERCLIP_API_BRIDGE_MODE).toBe("queue_v1");
    expect(call?.[3].env.QA_PROJECT_WORKSPACE_CWD).toBe(managedRemoteWorkspace);
    expect(call?.[3].env.RANDOM_WORKSPACE_CWD).toBe(managedRemoteWorkspace);
    expect(call?.[3].env.OTHER_ENV).toBe(workspaceDir);
    expect(call?.[3].remoteExecution?.remoteCwd).toBe(managedRemoteWorkspace);
    expect(startAdapterExecutionTargetPaperclipBridge).toHaveBeenCalledTimes(1);
    expect(restoreWorkspaceFromSshExecution).toHaveBeenCalledTimes(1);
    expect(restoreWorkspaceFromSshExecution).toHaveBeenCalledWith(expect.objectContaining({
      localDir: workspaceDir,
      remoteDir: managedRemoteWorkspace,
    }));
  });

  it("does not resume saved Claude sessions for remote SSH execution without a matching remote identity", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-claude-remote-resume-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    await mkdir(workspaceDir, { recursive: true });

    await execute({
      runId: "run-ssh-no-resume",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Claude Coder",
        adapterType: "claude_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: "session-123",
        sessionParams: {
          sessionId: "session-123",
          cwd: "/remote/workspace",
        },
        sessionDisplayId: "session-123",
        taskKey: null,
      },
      config: {
        command: "claude",
      },
      context: {
        paperclipWorkspace: {
          cwd: workspaceDir,
          source: "project_primary",
        },
      },
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
      onLog: async () => {},
    });

    expect(runChildProcess).toHaveBeenCalledTimes(1);
    const call = runChildProcess.mock.calls[0] as unknown as [string, string, string[]] | undefined;
    expect(call?.[2]).not.toContain("--resume");
  });

  it("resumes saved Claude sessions for remote SSH execution when the remote identity matches", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-claude-remote-resume-match-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const managedRemoteWorkspace = "/remote/workspace/.paperclip-runtime/runs/run-ssh-resume/workspace";
    await mkdir(workspaceDir, { recursive: true });

    await execute({
      runId: "run-ssh-resume",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Claude Coder",
        adapterType: "claude_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: "session-123",
        sessionParams: {
          sessionId: "session-123",
          cwd: managedRemoteWorkspace,
          remoteExecution: {
            transport: "ssh",
            host: "127.0.0.1",
            port: 2222,
            username: "fixture",
            remoteCwd: managedRemoteWorkspace,
          },
        },
        sessionDisplayId: "session-123",
        taskKey: null,
      },
      config: {
        command: "claude",
      },
      context: {
        paperclipWorkspace: {
          cwd: workspaceDir,
          source: "project_primary",
        },
      },
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
      onLog: async () => {},
    });

    expect(runChildProcess).toHaveBeenCalledTimes(1);
    const call = runChildProcess.mock.calls[0] as unknown as [string, string, string[]] | undefined;
    expect(call?.[2]).toContain("--resume");
    expect(call?.[2]).toContain("session-123");
  });

  it("retries with a fresh session when the Claude CLI returns 'No conversation found with session id'", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-claude-stale-session-explicit-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    await mkdir(workspaceDir, { recursive: true });

    runChildProcess.mockResolvedValueOnce({
      exitCode: 1,
      signal: null,
      timedOut: false,
      stdout: JSON.stringify({
        type: "result",
        is_error: true,
        result: "No conversation found with session id stale-session-id",
        errors: [{ message: "No conversation found with session id stale-session-id" }],
      }),
      stderr: "",
      pid: 124,
      startedAt: new Date().toISOString(),
    });

    const logs: string[] = [];
    await execute({
      runId: "run-stale-explicit",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Claude Coder",
        adapterType: "claude_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: "stale-session-id",
        sessionParams: { sessionId: "stale-session-id" },
        sessionDisplayId: "stale-session-id",
        taskKey: null,
      },
      config: { command: "claude" },
      context: {
        paperclipWorkspace: { cwd: workspaceDir, source: "project_primary" },
      },
      executionTransport: {},
      onLog: async (_stream, line) => { logs.push(line); },
    });

    expect(runChildProcess).toHaveBeenCalledTimes(2);
    const firstCall = runChildProcess.mock.calls[0] as unknown as [string, string, string[]] | undefined;
    const secondCall = runChildProcess.mock.calls[1] as unknown as [string, string, string[]] | undefined;
    expect(firstCall?.[2]).toContain("--resume");
    expect(firstCall?.[2]).toContain("stale-session-id");
    expect(secondCall?.[2]).not.toContain("--resume");
    expect(logs.some((l) => l.includes("stale-session-id") && l.includes("retrying with a fresh session"))).toBe(true);
  });

  it("retries with a fresh session when the Claude CLI crashes with no output (STATUS_ACCESS_VIOLATION / exit 3221225477)", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-claude-stale-session-crash-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    await mkdir(workspaceDir, { recursive: true });

    runChildProcess.mockResolvedValueOnce({
      exitCode: 3221225477,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "",
      pid: 125,
      startedAt: new Date().toISOString(),
    });

    const logs: string[] = [];
    await execute({
      runId: "run-stale-crash",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Claude Coder",
        adapterType: "claude_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: "stale-session-id",
        sessionParams: { sessionId: "stale-session-id" },
        sessionDisplayId: "stale-session-id",
        taskKey: null,
      },
      config: { command: "claude" },
      context: {
        paperclipWorkspace: { cwd: workspaceDir, source: "project_primary" },
      },
      executionTransport: {},
      onLog: async (_stream, line) => { logs.push(line); },
    });

    expect(runChildProcess).toHaveBeenCalledTimes(2);
    const firstCall = runChildProcess.mock.calls[0] as unknown as [string, string, string[]] | undefined;
    const secondCall = runChildProcess.mock.calls[1] as unknown as [string, string, string[]] | undefined;
    expect(firstCall?.[2]).toContain("--resume");
    expect(firstCall?.[2]).toContain("stale-session-id");
    expect(secondCall?.[2]).not.toContain("--resume");
    expect(logs.some((l) => l.includes("retrying with a fresh session"))).toBe(true);
  });

  it("retries with a new process when the Claude CLI crashes on a fresh (non-resume) run (STATUS_ACCESS_VIOLATION / exit 3221225477)", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-claude-fresh-crash-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    await mkdir(workspaceDir, { recursive: true });

    // First call: fresh run crashes with STATUS_ACCESS_VIOLATION and no output.
    runChildProcess.mockResolvedValueOnce({
      exitCode: 3221225477,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "",
      pid: 200,
      startedAt: new Date().toISOString(),
    });
    // Second call (retry): succeeds.

    const logs: string[] = [];
    const result = await execute({
      runId: "run-fresh-crash",
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
      config: { command: "claude" },
      context: {
        paperclipWorkspace: { cwd: workspaceDir, source: "project_primary" },
      },
      executionTransport: {},
      onLog: async (_stream, line) => { logs.push(line); },
    });

    expect(runChildProcess).toHaveBeenCalledTimes(2);
    const firstCall = runChildProcess.mock.calls[0] as unknown as [string, string, string[]] | undefined;
    const secondCall = runChildProcess.mock.calls[1] as unknown as [string, string, string[]] | undefined;
    expect(firstCall?.[2]).not.toContain("--resume");
    expect(secondCall?.[2]).not.toContain("--resume");
    expect(logs.some((l) => l.includes("3221225477") && l.includes("retrying with a new process"))).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  it("surfaces exit 127 as an explicit missing-dependency error with the offending command", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-claude-exit127-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    await mkdir(workspaceDir, { recursive: true });

    runChildProcess.mockResolvedValueOnce({
      exitCode: 127,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "bash: claude: command not found",
      pid: 201,
      startedAt: new Date().toISOString(),
    });

    const result = await execute({
      runId: "run-exit127",
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
      config: { command: "claude" },
      context: {
        paperclipWorkspace: { cwd: workspaceDir, source: "project_primary" },
      },
      executionTransport: {},
      onLog: async () => {},
    });

    expect(runChildProcess).toHaveBeenCalledTimes(1);
    expect(result.exitCode).toBe(127);
    expect(result.errorMessage).toContain("claude");
    expect(result.errorMessage).toContain("127");
  });

});
