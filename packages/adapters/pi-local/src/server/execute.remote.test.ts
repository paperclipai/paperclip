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
  runChildProcess: vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: JSON.stringify({
      type: "turn_end",
      message: {
        role: "assistant",
        content: "done",
        usage: {
          input: 10,
          output: 20,
          cacheRead: 0,
          cost: { total: 0.01 },
        },
      },
      toolResults: [],
    }),
    stderr: "",
    pid: 123,
    startedAt: new Date().toISOString(),
  })),
  ensureCommandResolvable: vi.fn(async () => undefined),
  resolveCommandForLogs: vi.fn(async () => "ssh://fixture@127.0.0.1:2222/remote/workspace :: pi"),
  prepareWorkspaceForSshExecution: vi.fn(async () => undefined),
  restoreWorkspaceFromSshExecution: vi.fn(async () => undefined),
  runSshCommand: vi.fn(async () => ({
    stdout: "",
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

describe("pi remote execution", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    vi.clearAllMocks();
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("prepares the workspace, syncs Pi skills, and restores workspace changes for remote SSH execution", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-pi-remote-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const alternateWorkspaceDir = path.join(rootDir, "workspace-other");
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(alternateWorkspaceDir, { recursive: true });

    const result = await execute({
      runId: "run-1",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Pi Builder",
        adapterType: "pi_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        command: "pi",
        model: "openai/gpt-5.4-mini",
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
      cwd: "/remote/workspace",
      remoteExecution: {
        transport: "ssh",
        host: "127.0.0.1",
        port: 2222,
        username: "fixture",
        remoteCwd: "/remote/workspace",
      },
    });
    expect(String(result.sessionId)).toContain("/remote/workspace/.paperclip-runtime/pi/sessions/");
    expect(prepareWorkspaceForSshExecution).toHaveBeenCalledTimes(1);
    expect(syncDirectoryToSsh).toHaveBeenCalledTimes(1);
    expect(syncDirectoryToSsh).toHaveBeenCalledWith(expect.objectContaining({
      remoteDir: "/remote/workspace/.paperclip-runtime/pi/skills",
      followSymlinks: true,
    }));
    expect(runSshCommand).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining(".paperclip-runtime/pi/sessions"),
      expect.anything(),
    );
    const call = runChildProcess.mock.calls[0] as unknown as
      | [string, string, string[], { env: Record<string, string>; remoteExecution?: { remoteCwd: string } | null }]
      | undefined;
    expect(call?.[2]).toContain("--session");
    expect(call?.[2]).toContain("--skill");
    expect(call?.[2]).toContain("/remote/workspace/.paperclip-runtime/pi/skills");
    expect(call?.[3].env.PAPERCLIP_WORKSPACE_CWD).toBe("/remote/workspace");
    expect(JSON.parse(call?.[3].env.PAPERCLIP_WORKSPACES_JSON ?? "[]")).toEqual([
      {
        workspaceId: "workspace-1",
        cwd: "/remote/workspace",
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
    expect(call?.[3].remoteExecution?.remoteCwd).toBe("/remote/workspace");
    expect(startAdapterExecutionTargetPaperclipBridge).toHaveBeenCalledTimes(1);
    expect(restoreWorkspaceFromSshExecution).toHaveBeenCalledTimes(1);
  });

  it("resumes saved Pi sessions for remote SSH execution only when the identity matches", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-pi-remote-resume-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    await mkdir(workspaceDir, { recursive: true });

    runSshCommand.mockImplementation(async (...args: unknown[]) => {
      const command = String(args[1] ?? "");
      if (command.includes("head -n 1") && command.includes("session-123.jsonl")) {
        return {
          stdout: `${JSON.stringify({ type: "session", cwd: "/remote/workspace" })}\n`,
          stderr: "",
          exitCode: 0,
        };
      }
      return {
        stdout: "",
        stderr: "",
        exitCode: 0,
      };
    });

    await execute({
      runId: "run-ssh-resume",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Pi Builder",
        adapterType: "pi_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: "/remote/workspace/.paperclip-runtime/pi/sessions/session-123.jsonl",
        sessionParams: {
          sessionId: "/remote/workspace/.paperclip-runtime/pi/sessions/session-123.jsonl",
          cwd: "/remote/workspace",
          remoteExecution: {
            transport: "ssh",
            host: "127.0.0.1",
            port: 2222,
            username: "fixture",
            remoteCwd: "/remote/workspace",
          },
        },
        sessionDisplayId: "session-123",
        taskKey: null,
      },
      config: {
        command: "pi",
        model: "openai/gpt-5.4-mini",
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

    const call = runChildProcess.mock.calls[0] as unknown as [string, string, string[]] | undefined;
    expect(call?.[2]).toContain("--session");
    expect(call?.[2]).toContain("/remote/workspace/.paperclip-runtime/pi/sessions/session-123.jsonl");
  });

  it("starts a fresh remote Pi session when the saved session header cwd points at a different workspace", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-pi-remote-stale-session-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    await mkdir(workspaceDir, { recursive: true });

    runSshCommand.mockImplementation(async (...args: unknown[]) => {
      const command = String(args[1] ?? "");
      if (command.includes("head -n 1") && command.includes("session-123.jsonl")) {
        return {
          stdout: `${JSON.stringify({ type: "session", cwd: "/remote/old-workspace" })}\n`,
          stderr: "",
          exitCode: 0,
        };
      }
      return {
        stdout: "",
        stderr: "",
        exitCode: 0,
      };
    });

    await execute({
      runId: "run-ssh-stale-session",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Pi Builder",
        adapterType: "pi_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: "/remote/workspace/.paperclip-runtime/pi/sessions/session-123.jsonl",
        sessionParams: {
          sessionId: "/remote/workspace/.paperclip-runtime/pi/sessions/session-123.jsonl",
          cwd: "/remote/workspace",
          remoteExecution: {
            transport: "ssh",
            host: "127.0.0.1",
            port: 2222,
            username: "fixture",
            remoteCwd: "/remote/workspace",
          },
        },
        sessionDisplayId: "session-123",
        taskKey: null,
      },
      config: {
        command: "pi",
        model: "openai/gpt-5.4-mini",
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

    const call = runChildProcess.mock.calls[0] as unknown as [string, string, string[]] | undefined;
    const sessionIndex = call?.[2].indexOf("--session") ?? -1;
    expect(sessionIndex).toBeGreaterThanOrEqual(0);
    const usedSession = sessionIndex >= 0 ? call?.[2][sessionIndex + 1] : null;
    expect(usedSession).toContain("/remote/workspace/.paperclip-runtime/pi/sessions/");
    expect(usedSession).not.toBe("/remote/workspace/.paperclip-runtime/pi/sessions/session-123.jsonl");
  });

  it("starts a fresh remote Pi session when the saved session header is empty or unreadable", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-pi-remote-empty-header-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    await mkdir(workspaceDir, { recursive: true });

    runSshCommand.mockImplementation(async (...args: unknown[]) => {
      const command = String(args[1] ?? "");
      if (command.includes("head -n 1") && command.includes("session-123.jsonl")) {
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    await execute({
      runId: "run-ssh-empty-header",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Pi Builder",
        adapterType: "pi_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: "/remote/workspace/.paperclip-runtime/pi/sessions/session-123.jsonl",
        sessionParams: {
          sessionId: "/remote/workspace/.paperclip-runtime/pi/sessions/session-123.jsonl",
          cwd: "/remote/workspace",
          remoteExecution: {
            transport: "ssh",
            host: "127.0.0.1",
            port: 2222,
            username: "fixture",
            remoteCwd: "/remote/workspace",
          },
        },
        sessionDisplayId: "session-123",
        taskKey: null,
      },
      config: { command: "pi", model: "openai/gpt-5.4-mini" },
      context: {
        paperclipWorkspace: { cwd: workspaceDir, source: "project_primary" },
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

    const call = runChildProcess.mock.calls[0] as unknown as [string, string, string[]] | undefined;
    const sessionIndex = call?.[2].indexOf("--session") ?? -1;
    expect(sessionIndex).toBeGreaterThanOrEqual(0);
    const usedSession = sessionIndex >= 0 ? call?.[2][sessionIndex + 1] : null;
    expect(usedSession).not.toBe("/remote/workspace/.paperclip-runtime/pi/sessions/session-123.jsonl");
  });

  it("starts a fresh remote Pi session when the remote head command fails", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-pi-remote-head-failure-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    await mkdir(workspaceDir, { recursive: true });

    runSshCommand.mockImplementation(async (...args: unknown[]) => {
      const command = String(args[1] ?? "");
      if (command.includes("head -n 1") && command.includes("session-123.jsonl")) {
        throw Object.assign(new Error("ssh: connect failed"), {
          stdout: "",
          stderr: "ssh: connect failed",
          code: "ENOENT",
        });
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    await execute({
      runId: "run-ssh-head-failure",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Pi Builder",
        adapterType: "pi_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: "/remote/workspace/.paperclip-runtime/pi/sessions/session-123.jsonl",
        sessionParams: {
          sessionId: "/remote/workspace/.paperclip-runtime/pi/sessions/session-123.jsonl",
          cwd: "/remote/workspace",
          remoteExecution: {
            transport: "ssh",
            host: "127.0.0.1",
            port: 2222,
            username: "fixture",
            remoteCwd: "/remote/workspace",
          },
        },
        sessionDisplayId: "session-123",
        taskKey: null,
      },
      config: { command: "pi", model: "openai/gpt-5.4-mini" },
      context: {
        paperclipWorkspace: { cwd: workspaceDir, source: "project_primary" },
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

    const call = runChildProcess.mock.calls[0] as unknown as [string, string, string[]] | undefined;
    const sessionIndex = call?.[2].indexOf("--session") ?? -1;
    expect(sessionIndex).toBeGreaterThanOrEqual(0);
    const usedSession = sessionIndex >= 0 ? call?.[2][sessionIndex + 1] : null;
    expect(usedSession).not.toBe("/remote/workspace/.paperclip-runtime/pi/sessions/session-123.jsonl");
  });
});
