import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const {
  runChildProcess,
  ensureCommandResolvable,
  resolveCommandForLogs,
  prepareWorkspaceForSshExecution,
  restoreWorkspaceFromSshExecution,
  runSshCommand,
  syncDirectoryToSsh,
  startAdapterExecutionTargetPaperclipBridge,
} = vi.hoisted(() => ({
  runChildProcess: vi.fn(async (_runId: string, _command: string, args: string[]) => {
    if (args.includes("models")) {
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "opencode/gpt-5-nano\nopenai/gpt-4.1\n",
        stderr: "",
        pid: 122,
        startedAt: new Date().toISOString(),
      };
    }
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: [
        JSON.stringify({ type: "step_start", sessionID: "session_123" }),
        JSON.stringify({ type: "text", sessionID: "session_123", part: { text: "hello" } }),
        JSON.stringify({
          type: "step_finish",
          sessionID: "session_123",
          part: { cost: 0.001, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } },
        }),
      ].join("\n"),
      stderr: "",
      pid: 123,
      startedAt: new Date().toISOString(),
    };
  }),
  ensureCommandResolvable: vi.fn(async () => undefined),
  resolveCommandForLogs: vi.fn(async () => "ssh://fixture@127.0.0.1:2222/remote/workspace :: opencode"),
  prepareWorkspaceForSshExecution: vi.fn(async () => ({ gitBacked: false })),
  restoreWorkspaceFromSshExecution: vi.fn(async () => undefined),
  runSshCommand: vi.fn(async () => ({
    stdout: "/home/agent",
    stderr: "",
    exitCode: 0,
  })),
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
    runSshCommand,
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

describe("opencode remote execution", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    vi.clearAllMocks();
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("prepares the workspace, syncs OpenCode skills, and restores workspace changes for remote SSH execution", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-remote-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const alternateWorkspaceDir = path.join(rootDir, "workspace-other");
    const managedRemoteWorkspace = "/remote/workspace/.paperclip-runtime/runs/run-1/workspace";
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(alternateWorkspaceDir, { recursive: true });

    const result = await execute({
      runId: "run-1",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "OpenCode Builder",
        adapterType: "opencode_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        command: "opencode",
        model: "opencode/gpt-5-nano",
      },
      context: {
        paperclipWorkspace: {
          cwd: workspaceDir,
          source: "project_primary",
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

    expect(result.sessionParams).toMatchObject({
      sessionId: "session_123",
      cwd: managedRemoteWorkspace,
      remoteExecution: {
        transport: "ssh",
        host: "127.0.0.1",
        port: 2222,
        username: "fixture",
        remoteCwd: managedRemoteWorkspace,
      },
    });
    expect(prepareWorkspaceForSshExecution).toHaveBeenCalledTimes(1);
    expect(syncDirectoryToSsh).toHaveBeenCalledTimes(2);
    expect(syncDirectoryToSsh).toHaveBeenCalledWith(expect.objectContaining({
      remoteDir: `${managedRemoteWorkspace}/.paperclip-runtime/opencode/xdgConfig`,
    }));
    expect(syncDirectoryToSsh).toHaveBeenCalledWith(expect.objectContaining({
      remoteDir: `${managedRemoteWorkspace}/.paperclip-runtime/opencode/skills`,
      followSymlinks: true,
    }));
    expect(runSshCommand).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining(".claude/skills"),
      expect.anything(),
    );
    const runCall = runChildProcess.mock.calls.find((entry) => Array.isArray(entry[2]) && entry[2].includes("run")) as
      | [string, string, string[], { env: Record<string, string>; remoteExecution?: { remoteCwd: string } | null }]
      | undefined;
    const modelProbeCall = runChildProcess.mock.calls.find((entry) => Array.isArray(entry[2]) && entry[2].includes("models")) as
      | [string, string, string[], { env: Record<string, string>; remoteExecution?: { remoteCwd: string } | null }]
      | undefined;
    expect(modelProbeCall?.[2]).toEqual(["models"]);
    // The model probe runs after the runtime workspace is prepared (so XDG
    // points at the managed subdirectory) but the SSH session targets the
    // original target remoteCwd — the per-run subdirectory is layered
    // underneath via XDG/runtime config rather than by switching the cwd.
    expect(modelProbeCall?.[3].env.XDG_CONFIG_HOME).toBe(
      `${managedRemoteWorkspace}/.paperclip-runtime/opencode/xdgConfig`,
    );
    expect(modelProbeCall?.[3].remoteExecution?.remoteCwd).toBe("/remote/workspace");
    const call = runCall as
      | [string, string, string[], { env: Record<string, string>; remoteExecution?: { remoteCwd: string } | null }]
      | undefined;
    expect(call?.[3].env.PAPERCLIP_WORKSPACE_CWD).toBe(managedRemoteWorkspace);
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
    expect(call?.[3].env.XDG_CONFIG_HOME).toBe(`${managedRemoteWorkspace}/.paperclip-runtime/opencode/xdgConfig`);
    expect(call?.[3].remoteExecution?.remoteCwd).toBe(managedRemoteWorkspace);
    expect(startAdapterExecutionTargetPaperclipBridge).toHaveBeenCalledTimes(1);
    expect(restoreWorkspaceFromSshExecution).toHaveBeenCalledTimes(1);
  });

  it("fails before the remote run when the configured model is unavailable on the SSH target", async () => {
    runChildProcess.mockImplementationOnce(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "openai/gpt-4.1\n",
      stderr: "",
      pid: 456,
      startedAt: new Date().toISOString(),
    }));

    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-remote-model-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    await mkdir(workspaceDir, { recursive: true });

    await expect(() =>
      execute({
        runId: "run-ssh-model-missing",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "OpenCode Builder",
          adapterType: "opencode_local",
          adapterConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          command: "opencode",
          model: "opencode/gpt-5-nano",
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
      }),
    ).rejects.toThrow("Configured OpenCode model is unavailable on the remote execution target");

    expect(runChildProcess).toHaveBeenCalledTimes(1);
    expect((runChildProcess.mock.calls[0]?.[2] as string[] | undefined) ?? []).toEqual(["models"]);
    expect(startAdapterExecutionTargetPaperclipBridge).not.toHaveBeenCalled();
  });

  it("resumes saved OpenCode sessions for remote SSH execution only when the identity matches", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-remote-resume-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const managedRemoteWorkspace = "/remote/workspace/.paperclip-runtime/runs/run-ssh-resume/workspace";
    await mkdir(workspaceDir, { recursive: true });

    await execute({
      runId: "run-ssh-resume",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "OpenCode Builder",
        adapterType: "opencode_local",
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
        command: "opencode",
        model: "opencode/gpt-5-nano",
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

    const call = runChildProcess.mock.calls.find((entry) => Array.isArray(entry[2]) && entry[2].includes("run")) as
      | [string, string, string[]]
      | undefined;
    expect(call?.[2]).toContain("--session");
    expect(call?.[2]).toContain("session-123");
  });
});
