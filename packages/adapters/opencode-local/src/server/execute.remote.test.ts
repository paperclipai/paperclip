import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  runChildProcess,
  ensureCommandResolvable,
  resolveCommandForLogs,
  prepareWorkspaceForSshExecution,
  restoreWorkspaceFromSshExecution,
  runSshCommand,
  syncDirectoryToSsh,
  startAdapterExecutionTargetPaperclipBridge,
  prepareAdapterExecutionTargetRuntime,
} = vi.hoisted(() => ({
  runChildProcess: vi.fn(async (_runId: string, _command: string, args: string[], _options?: { onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void> }) => {
    if (args.includes("models")) {
      return {
        exitCode: 0,
        signal: null as string | null,
        timedOut: false,
        stdout: "opencode/gpt-5-nano\nopenai/gpt-4.1\n",
        stderr: "",
        pid: 122,
        startedAt: new Date().toISOString(),
      };
    }
    return {
      exitCode: 0,
      signal: null as string | null,
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
  prepareAdapterExecutionTargetRuntime: vi.fn(),
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
  prepareAdapterExecutionTargetRuntime.mockImplementation(
    (input: Parameters<typeof actual.prepareAdapterExecutionTargetRuntime>[0]) =>
      actual.prepareAdapterExecutionTargetRuntime(input),
  );
  return {
    ...actual,
    startAdapterExecutionTargetPaperclipBridge,
    prepareAdapterExecutionTargetRuntime,
  };
});

import { execute } from "./execute.js";

describe("opencode remote execution", () => {
  const cleanupDirs: string[] = [];
  const originalOpenCodeAllowAllModels = process.env.OPENCODE_ALLOW_ALL_MODELS;

  beforeEach(async () => {
    const configHome = await mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-test-config-"));
    cleanupDirs.push(configHome);
    vi.stubEnv("XDG_CONFIG_HOME", configHome);
    // Isolate the persistent directory-merge lock root: the stable-workspace
    // tests acquire a real keyed lock, and the machine-global root would both
    // leak state between tests and contend with stale owners from other runs.
    const paperclipHome = await mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-test-home-"));
    cleanupDirs.push(paperclipHome);
    vi.stubEnv("PAPERCLIP_HOME", paperclipHome);
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "opencode-remote-test");
    delete process.env.OPENCODE_ALLOW_ALL_MODELS;
  });

  afterEach(async () => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    if (originalOpenCodeAllowAllModels === undefined) {
      delete process.env.OPENCODE_ALLOW_ALL_MODELS;
    } else {
      process.env.OPENCODE_ALLOW_ALL_MODELS = originalOpenCodeAllowAllModels;
    }
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it.each([[false, false], [false, true], [true, false], [true, true]])(
    "uses only forwarded credentials for remote billing (forwarded=%s, timeout=%s)", async (forwarded, timedOut) => {
      vi.stubEnv("OPENROUTER_API_KEY", "host-only-api-key");
      const workspace = await mkdtemp(path.join(os.tmpdir(), "opencode-remote-billing-"));
      cleanupDirs.push(workspace);
      const usageLine = JSON.stringify({ type: "step_finish", sessionID: "session-billing",
        part: { cost: 0.001, tokens: { input: 10, output: 2, cache: { read: 1, write: 0 } } } });
      runChildProcess.mockImplementationOnce(async (_runId, _command, _args, options) => {
        await options?.onLog?.("stdout", `${usageLine}\n`);
        return { stdout: usageLine, stderr: "", exitCode: timedOut ? 143 : 0,
          signal: timedOut ? "SIGTERM" : null, timedOut, pid: 123, startedAt: new Date().toISOString() };
      });
      const onUsage = vi.fn();
      const result = await execute({
        runId: "remote-billing", agent: { id: "agent", companyId: "company", name: "OpenCode", adapterType: "opencode_local", adapterConfig: {} },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: { command: "opencode", cwd: workspace, model: "openrouter/anthropic/claude-sonnet-4.5",
          env: { OPENCODE_ALLOW_ALL_MODELS: "1", ...(forwarded ? { OPENROUTER_API_KEY: "forwarded-api-key" } : {}) } },
        context: {}, executionTransport: { remoteExecution: { host: "127.0.0.1", port: 2222, username: "fixture", remoteCwd: "/remote/workspace", remoteWorkspacePath: "/remote/workspace" } },
        onLog: async () => {}, onUsage,
      });
      const expected = forwarded ? "metered_api" : "unknown";
      expect(result.billingType).toBe(expected);
      expect(result.timedOut).toBe(timedOut);
      expect(onUsage).toHaveBeenCalledWith(expect.objectContaining({ billingType: expected, complete: false }));
      expect(onUsage).toHaveBeenLastCalledWith(expect.objectContaining({ billingType: expected, complete: !timedOut }));
      const runCall = runChildProcess.mock.calls.find(call => call[2].includes("run"))!;
      expect((runCall[3] as { env: Record<string, string> }).env.OPENROUTER_API_KEY).toBe(forwarded ? "forwarded-api-key" : undefined);
    },
  );

  it.each([false, true])("prepares the workspace, syncs OpenCode skills, and restores workspace changes for remote SSH execution (managed=%s)", async (managed) => {
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
        extraArgs: ["--", "--dir"],
        ...(managed ? {
          managedAiConnection: { provider: "openrouter", method: "api_key" },
        } : {}),
        env: {
          XDG_CONFIG_HOME: path.join(rootDir, "config"),
          ...(managed ? { HOME: "/var/folders/qa-managed", XDG_DATA_HOME: "/var/folders/qa-managed/data" } : {}),
        },
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
    expect(runCall?.[2].slice(-4)).toEqual(["--dir", managedRemoteWorkspace, "--", "--dir"]);
    const call = runCall as
      | [string, string, string[], { env: Record<string, string>; remoteExecution?: { remoteCwd: string } | null }]
      | undefined;
    expect(call?.[3].env.PAPERCLIP_WORKSPACE_CWD).toBe(managedRemoteWorkspace);
    if (managed) {
      const home = `${managedRemoteWorkspace}/.paperclip-runtime/opencode/managed-auth/run-1`;
      expect(call?.[3].env.HOME).toBe(home);
      expect(call?.[3].env.XDG_DATA_HOME).toBe(`${home}/data`);
      expect(modelProbeCall?.[3].env.XDG_DATA_HOME).toBe(`${home}/data`);
      expect(runSshCommand).toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining(`${home}/.claude/skills`),
        expect.anything(),
      );
    }
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

  it("resumes matching remote sessions and preserves an explicit run directory", async () => {
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
        extraArgs: ["--dir", "/operator-supplied"],
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
    expect(call?.[2].slice(-2)).toEqual(["--dir", "/operator-supplied"]);
    expect(call?.[2].filter((arg) => arg === "--dir" || arg.startsWith("--dir="))).toHaveLength(1);
  });
});

describe("opencode remote execution — stable task workspace", () => {
  const cleanupDirs: string[] = [];
  const stableWorkspace = "/remote/workspace/.paperclip-runtime/tasks/company-1/agent-1/task-1/workspace";
  const remoteExecution = {
    host: "127.0.0.1",
    port: 2222,
    username: "fixture",
    remoteWorkspacePath: "/remote/workspace",
    remoteCwd: "/remote/workspace",
    privateKey: "PRIVATE KEY",
    knownHosts: "[127.0.0.1]:2222 ssh-ed25519 AAAA",
    strictHostKeyChecking: true,
  };

  beforeEach(async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-stable-flag-lockroot-"));
    cleanupDirs.push(root);
    vi.stubEnv("PAPERCLIP_HOME", path.join(root, "home"));
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "stable-opencode-test");
    delete process.env.PAPERCLIP_OPENCODE_STABLE_TASK_WORKSPACE;
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    delete process.env.PAPERCLIP_OPENCODE_STABLE_TASK_WORKSPACE;
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  function baseOverrides() {
    return {
      runId: "run-stable",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "OpenCode Builder",
        adapterType: "opencode_local",
        adapterConfig: {},
      },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { command: "opencode", model: "opencode/gpt-5-nano" },
      context: {
        taskId: "task-1",
        paperclipWorkspace: {
          cwd: "",
          source: "agent_home",
          repoUrl: "https://github.com/paperclipai/paperclip.git",
          repoRef: "main",
        },
      },
      executionTransport: { remoteExecution },
      onLog: async () => {},
    } as const;
  }

  it.each([
    ["config", undefined],
    ["env", "1"],
  ] as const)("realizes the workspace at the stable per-task directory (%s flag)", async (_mode, envFlag) => {
    const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "opencode-stable-ws-"));
    cleanupDirs.push(workspaceDir);
    if (envFlag) vi.stubEnv("PAPERCLIP_OPENCODE_STABLE_TASK_WORKSPACE", envFlag);
    const logs: string[] = [];
    const result = await execute({
      ...baseOverrides(),
      config: {
        command: "opencode",
        model: "opencode/gpt-5-nano",
        ...(envFlag ? {} : { stableTaskWorkspace: true }),
      },
      context: {
        taskId: "task-1",
        paperclipWorkspace: { cwd: workspaceDir, source: "project_primary" },
      },
      onLog: async (_stream, chunk) => { logs.push(chunk); },
    });
    expect(prepareWorkspaceForSshExecution).toHaveBeenCalledWith(expect.objectContaining({
      remoteDir: stableWorkspace,
    }));
    expect(result.sessionParams).toMatchObject({
      sessionId: "session_123",
      cwd: stableWorkspace,
      remoteExecution: { transport: "ssh", host: "127.0.0.1", port: 2222, username: "fixture", remoteCwd: stableWorkspace },
    });
    const runCall = runChildProcess.mock.calls.find((entry) => Array.isArray(entry[2]) && entry[2].includes("run")) as
      | [string, string, string[], { env: Record<string, string> }]
      | undefined;
    expect(runCall?.[2].slice(-2)).toEqual(["--dir", stableWorkspace]);
    expect(runCall?.[3].env.PAPERCLIP_WORKSPACE_CWD).toBe(stableWorkspace);
    expect(logs.join("")).toContain("Stable task workspace enabled");
    expect(restoreWorkspaceFromSshExecution).toHaveBeenCalledWith(expect.objectContaining({
      remoteDir: stableWorkspace,
    }));
  }, 30_000);

  it("falls back to the per-run workspace when no task identity is available", async () => {
    const logs: string[] = [];
    const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "opencode-stable-noid-"));
    cleanupDirs.push(workspaceDir);
    await execute({
      ...baseOverrides(),
      config: { command: "opencode", model: "opencode/gpt-5-nano", stableTaskWorkspace: true },
      context: { paperclipWorkspace: { cwd: workspaceDir, source: "project_primary" } },
      onLog: async (_stream, chunk) => { logs.push(chunk); },
    });
    expect(prepareWorkspaceForSshExecution).toHaveBeenCalledWith(expect.objectContaining({
      remoteDir: "/remote/workspace/.paperclip-runtime/runs/run-stable/workspace",
    }));
    expect(logs.join("")).toContain("falling back to the per-run workspace");
  }, 30_000);

  it("resumes a session saved for the stable workspace and matching repo identity", async () => {
    const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "opencode-stable-resume-"));
    cleanupDirs.push(workspaceDir);
    await execute({
      ...baseOverrides(),
      runtime: {
        sessionId: "session-stable",
        sessionParams: {
          sessionId: "session-stable",
          cwd: stableWorkspace,
          workspaceId: "workspace-1",
          repoUrl: "https://github.com/paperclipai/paperclip.git",
          repoRef: "main",
          remoteExecution: {
            transport: "ssh",
            host: "127.0.0.1",
            port: 2222,
            username: "fixture",
            remoteCwd: stableWorkspace,
          },
        },
        sessionDisplayId: "session-stable",
        taskKey: null,
      },
      config: { command: "opencode", model: "opencode/gpt-5-nano", stableTaskWorkspace: true },
      context: {
        taskId: "task-1",
        paperclipWorkspace: {
          cwd: workspaceDir,
          source: "project_primary",
          workspaceId: "workspace-1",
          repoUrl: "https://github.com/paperclipai/paperclip.git",
          repoRef: "main",
        },
      },
    });
    const runCall = runChildProcess.mock.calls.find((entry) => Array.isArray(entry[2]) && entry[2].includes("run")) as
      | [string, string, string[]]
      | undefined;
    expect(runCall?.[2]).toContain("--session");
    expect(runCall?.[2]).toContain("session-stable");
    expect(runCall?.[2].slice(-2)).toEqual(["--dir", stableWorkspace]);
  }, 30_000);

  it("starts a fresh session when the stable workspace was rebound to another repository", async () => {
    const logs: string[] = [];
    const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "opencode-stable-rebind-"));
    cleanupDirs.push(workspaceDir);
    await execute({
      ...baseOverrides(),
      runtime: {
        sessionId: "session-stale",
        sessionParams: {
          sessionId: "session-stale",
          cwd: stableWorkspace,
          repoUrl: "https://github.com/paperclipai/paperclip.git",
          repoRef: "main",
          remoteExecution: {
            transport: "ssh",
            host: "127.0.0.1",
            port: 2222,
            username: "fixture",
            remoteCwd: stableWorkspace,
          },
        },
        sessionDisplayId: "session-stale",
        taskKey: null,
      },
      config: { command: "opencode", model: "opencode/gpt-5-nano", stableTaskWorkspace: true },
      context: {
        taskId: "task-1",
        paperclipWorkspace: {
          cwd: workspaceDir,
          source: "project_primary",
          repoUrl: "https://github.com/other/repo.git",
          repoRef: "main",
        },
      },
      onLog: async (_stream, chunk) => { logs.push(chunk); },
    });
    const runCall = runChildProcess.mock.calls.find((entry) => Array.isArray(entry[2]) && entry[2].includes("run")) as
      | [string, string, string[]]
      | undefined;
    expect(runCall?.[2]).not.toContain("--session");
    expect(runCall?.[2]).not.toContain("session-stale");
    expect(logs.join("")).toContain("saved for a different workspace");
  }, 30_000);

  it("uses stable XDG data/state homes for managed connections in the stable workspace", async () => {
    const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "opencode-stable-managed-"));
    cleanupDirs.push(workspaceDir);
    await execute({
      ...baseOverrides(),
      config: {
        command: "opencode",
        model: "opencode/gpt-5-nano",
        stableTaskWorkspace: true,
        managedAiConnection: { provider: "openrouter", method: "api_key" },
      },
      context: {
        taskId: "task-1",
        paperclipWorkspace: { cwd: workspaceDir, source: "project_primary" },
      },
    });
    const runCall = runChildProcess.mock.calls.find((entry) => Array.isArray(entry[2]) && entry[2].includes("run")) as
      | [string, string, string[], { env: Record<string, string> }]
      | undefined;
    const runtimeRoot = `${stableWorkspace}/.paperclip-runtime/opencode`;
    expect(runCall?.[3].env.HOME).toBe(`${runtimeRoot}/managed-auth/run-stable`);
    expect(runCall?.[3].env.XDG_CONFIG_HOME).toBe(`${runtimeRoot}/xdgConfig`);
    expect(runCall?.[3].env.XDG_DATA_HOME).toBe(`${runtimeRoot}/xdg/data`);
    expect(runCall?.[3].env.XDG_STATE_HOME).toBe(`${runtimeRoot}/xdg/state`);
    expect(runCall?.[3].env.XDG_CACHE_HOME).toBe(`${runtimeRoot}/xdg/cache`);
  }, 30_000);

  it("falls back to the per-run workspace when the config disables the stable workspace despite the env flag", async () => {
    const logs: string[] = [];
    const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "opencode-stable-rollback-"));
    cleanupDirs.push(workspaceDir);
    vi.stubEnv("PAPERCLIP_OPENCODE_STABLE_TASK_WORKSPACE", "1");
    await execute({
      ...baseOverrides(),
      config: { command: "opencode", model: "opencode/gpt-5-nano", stableTaskWorkspace: false },
      context: {
        taskId: "task-1",
        paperclipWorkspace: { cwd: workspaceDir, source: "project_primary" },
      },
      onLog: async (_stream, chunk) => { logs.push(chunk); },
    });
    expect(prepareWorkspaceForSshExecution).toHaveBeenCalledWith(expect.objectContaining({
      remoteDir: "/remote/workspace/.paperclip-runtime/runs/run-stable/workspace",
    }));
    expect(logs.join("")).not.toContain("Stable task workspace enabled");
  }, 30_000);

  it("returns a transient retry result when the stable-workspace cycle lock is held by a concurrent run", async () => {
    const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "opencode-stable-lockwait-"));
    cleanupDirs.push(workspaceDir);
    prepareAdapterExecutionTargetRuntime.mockImplementationOnce(() =>
      Promise.reject(Object.assign(new Error("Timed out waiting for the stable task workspace cycle lock"), {
        code: "ERR_WORKSPACE_RESTORE_LOCK_TIMEOUT",
      })));
    const result = await execute({
      ...baseOverrides(),
      config: { command: "opencode", model: "opencode/gpt-5-nano", stableTaskWorkspace: true },
      context: {
        taskId: "task-1",
        paperclipWorkspace: { cwd: workspaceDir, source: "project_primary" },
      },
    });
    expect(result.errorCode).toBe("ERR_WORKSPACE_RESTORE_LOCK_TIMEOUT");
    expect(result.errorMessage).toContain("cycle lock");
    expect(result.retryNotBefore).toBeTruthy();
    expect((result.resultJson as Record<string, unknown> | null)?.transientRetryNotBefore).toBe(result.retryNotBefore);
    expect(result.exitCode).toBe(1);
    expect(runChildProcess.mock.calls.some((entry) => Array.isArray(entry[2]) && entry[2].includes("run"))).toBe(false);
  }, 30_000);

  it("releases the remote workspace when remote setup fails after preparation", async () => {
    const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "opencode-stable-setupfail-"));
    cleanupDirs.push(workspaceDir);
    restoreWorkspaceFromSshExecution.mockClear();
    runSshCommand.mockRejectedValueOnce(new Error("remote setup failed"));
    await expect(execute({
      ...baseOverrides(),
      config: { command: "opencode", model: "opencode/gpt-5-nano", stableTaskWorkspace: true },
      context: {
        taskId: "task-1",
        paperclipWorkspace: { cwd: workspaceDir, source: "project_primary" },
      },
    })).rejects.toThrow("remote setup failed");
    expect(prepareWorkspaceForSshExecution).toHaveBeenCalledWith(expect.objectContaining({
      remoteDir: stableWorkspace,
    }));
    expect(restoreWorkspaceFromSshExecution).toHaveBeenCalledWith(expect.objectContaining({
      remoteDir: stableWorkspace,
    }));
    // The cycle lock was released with the workspace: the next run of the
    // same task prepares and restores normally.
    const result = await execute({
      ...baseOverrides(),
      config: { command: "opencode", model: "opencode/gpt-5-nano", stableTaskWorkspace: true },
      context: {
        taskId: "task-1",
        paperclipWorkspace: { cwd: workspaceDir, source: "project_primary" },
      },
    });
    expect(result.sessionParams).toMatchObject({ sessionId: "session_123" });
    expect(restoreWorkspaceFromSshExecution).toHaveBeenCalledTimes(2);
  }, 60_000);
});
