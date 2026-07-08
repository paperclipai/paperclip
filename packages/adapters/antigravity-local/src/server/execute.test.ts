import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";

const ensureRuntimeInstalledMock = vi.hoisted(() => vi.fn(async () => {}));
const ensureCommandMock = vi.hoisted(() => vi.fn(async () => {}));
const prepareRuntimeMock = vi.hoisted(() => vi.fn<() => Promise<{
  workspaceRemoteDir: string | null;
  runtimeRootDir: string | null;
  assetDirs: Record<string, string>;
  restoreWorkspace: () => Promise<void>;
}>>(async () => ({
    workspaceRemoteDir: null,
    runtimeRootDir: null,
    assetDirs: {},
    restoreWorkspace: async () => {},
  })));
const resolveCommandForLogsMock = vi.hoisted(() => vi.fn(async () => "agy"));
const runProcessMock = vi.hoisted(() => vi.fn());
const runShellCommandMock = vi.hoisted(() => vi.fn(async (
  _runId: string,
  _target: unknown,
  _command: string,
  _options: unknown,
) => ({
  exitCode: 0,
  signal: null,
  timedOut: false,
  stdout: "",
  stderr: "",
})));
const readHomeDirMock = vi.hoisted(() => vi.fn(async () => "/home/agent"));
const startBridgeMock = vi.hoisted(() => vi.fn(async () => null));

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    adapterExecutionTargetIsRemote: (target: unknown) => (
      typeof target === "object" && target !== null && (target as { kind?: unknown }).kind === "remote"
    ),
    adapterExecutionTargetRemoteCwd: (target: unknown, cwd: string) => (
      typeof target === "object" && target !== null && typeof (target as { remoteCwd?: unknown }).remoteCwd === "string"
        ? (target as { remoteCwd: string }).remoteCwd
        : cwd
    ),
    overrideAdapterExecutionTargetRemoteCwd: (target: unknown, remoteCwd: string) => (
      typeof target === "object" && target !== null && (target as { kind?: unknown }).kind === "remote"
        ? {
            ...(target as Record<string, unknown>),
            remoteCwd,
            spec: {
              ...((target as { spec?: Record<string, unknown> }).spec ?? {}),
              remoteCwd,
            },
          }
        : target
    ),
    adapterExecutionTargetSessionIdentity: (target: unknown) => {
      if (!target || typeof target !== "object" || (target as { kind?: unknown }).kind !== "remote") return null;
      const parsed = target as {
        transport?: string;
        providerKey?: string | null;
        environmentId?: string | null;
        leaseId?: string | null;
        remoteCwd?: string;
        spec?: { host?: string; port?: number; username?: string; remoteCwd?: string };
      };
      if (parsed.transport === "ssh") {
        return {
          transport: "ssh",
          host: parsed.spec?.host,
          port: parsed.spec?.port,
          username: parsed.spec?.username,
          remoteCwd: parsed.spec?.remoteCwd,
        };
      }
      return {
        transport: "sandbox",
        providerKey: parsed.providerKey ?? null,
        environmentId: parsed.environmentId ?? null,
        leaseId: parsed.leaseId ?? null,
        remoteCwd: parsed.remoteCwd,
      };
    },
    adapterExecutionTargetSessionMatches: (saved: unknown, target: unknown) => {
      if (!target || typeof target !== "object" || (target as { kind?: unknown }).kind !== "remote") {
        return !saved || Object.keys(saved as Record<string, unknown>).length === 0;
      }
      const current = (target as { transport?: string; spec?: { remoteCwd?: string }; remoteCwd?: string });
      const parsed = saved && typeof saved === "object" ? saved as Record<string, unknown> : {};
      return parsed.transport === current.transport &&
        parsed.remoteCwd === (current.transport === "ssh" ? current.spec?.remoteCwd : current.remoteCwd);
    },
    adapterExecutionTargetUsesManagedHome: (target: unknown) => (
      typeof target === "object" && target !== null &&
      (target as { kind?: unknown; transport?: unknown }).kind === "remote" &&
      (target as { transport?: unknown }).transport === "sandbox"
    ),
    adapterExecutionTargetUsesPaperclipBridge: () => false,
    describeAdapterExecutionTarget: () => "local",
    ensureAdapterExecutionTargetCommandResolvable: ensureCommandMock,
    ensureAdapterExecutionTargetRuntimeCommandInstalled: ensureRuntimeInstalledMock,
    prepareAdapterExecutionTargetRuntime: prepareRuntimeMock,
    readAdapterExecutionTargetHomeDir: readHomeDirMock,
    readAdapterExecutionTarget: ({ executionTarget }: { executionTarget?: unknown }) => executionTarget ?? { kind: "local" },
    resolveAdapterExecutionTargetCommandForLogs: resolveCommandForLogsMock,
    resolveAdapterExecutionTargetTimeoutSec: (_target: unknown, timeoutSec: number) => timeoutSec,
    runAdapterExecutionTargetProcess: runProcessMock,
    runAdapterExecutionTargetShellCommand: runShellCommandMock,
    startAdapterExecutionTargetPaperclipBridge: startBridgeMock,
  };
});

import { execute } from "./execute.js";

const tempRoots: string[] = [];
const oldApiUrl = process.env.PAPERCLIP_API_URL;
const oldHome = process.env.HOME;

async function makeTempRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-antigravity-local-"));
  tempRoots.push(root);
  return root;
}

function buildContext(root: string, overrides: Partial<AdapterExecutionContext> = {}): AdapterExecutionContext {
  return {
    runId: "run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Antigravity Agent",
      adapterType: "antigravity_local",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config: {
      cwd: root,
      model: "Gemini 3.5 Flash (Low)",
    },
    context: {
      taskId: "issue-1",
      wakeReason: "issue_assigned",
      paperclipWorkspace: {
        cwd: root,
        source: "project_primary",
        workspaceId: "workspace-1",
      },
    },
    authToken: "run-token",
    onLog: async () => {},
    ...overrides,
  } as AdapterExecutionContext;
}

describe("antigravity_local execute", () => {
  beforeEach(() => {
    process.env.PAPERCLIP_API_URL = "http://127.0.0.1:3100";
    ensureRuntimeInstalledMock.mockClear();
    ensureCommandMock.mockClear();
    prepareRuntimeMock.mockReset();
    prepareRuntimeMock.mockResolvedValue({
      workspaceRemoteDir: null,
      runtimeRootDir: null,
      assetDirs: {},
      restoreWorkspace: async () => {},
    });
    resolveCommandForLogsMock.mockClear();
    runShellCommandMock.mockClear();
    readHomeDirMock.mockReset();
    readHomeDirMock.mockResolvedValue("/home/agent");
    startBridgeMock.mockClear();
    runProcessMock.mockReset();
  });

  afterEach(async () => {
    if (oldApiUrl === undefined) {
      delete process.env.PAPERCLIP_API_URL;
    } else {
      process.env.PAPERCLIP_API_URL = oldApiUrl;
    }
    if (oldHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = oldHome;
    }
    await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  });

  it("runs agy in print mode, includes Paperclip API guidance, and persists the log-derived session id", async () => {
    const root = await makeTempRoot();
    const conversationId = "55555555-5555-4555-8555-555555555555";

    runProcessMock.mockImplementation(async (_runId, _target, command, args) => {
      expect(command).toBe("agy");
      expect(args[0]).toBe("--print");
      const prompt = args[1] as string;
      expect(prompt).toContain("Paperclip runtime note:");
      expect(prompt).toContain("PAPERCLIP_TASK_ID");
      expect(prompt).toContain("Paperclip API access note:");
      expect(prompt).toContain("PAPERCLIP_API_BASE");
      expect(prompt).toContain("$PAPERCLIP_API_BASE/api/issues/$PAPERCLIP_TASK_ID/comments");
      expect(args).not.toContain("--dangerously-skip-permissions");
      expect(args).toEqual(expect.arrayContaining([
        "--model",
        "Gemini 3.5 Flash (Low)",
        "--log-file",
      ]));
      const logPath = args[args.indexOf("--log-file") + 1] as string;
      await fs.mkdir(path.dirname(logPath), { recursive: true });
      await fs.writeFile(
        logPath,
        `I0702 printmode.go:179] Print mode: conversation=${conversationId}, sending message\n`,
        "utf8",
      );
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "done\n",
        stderr: "",
      };
    });

    const result = await execute(buildContext(root));

    expect(result).toMatchObject({
      exitCode: 0,
      errorMessage: null,
      provider: "google",
      biller: "google",
      model: "Gemini 3.5 Flash (Low)",
      sessionId: conversationId,
      sessionDisplayId: conversationId,
      summary: "done",
    });
    expect(result.sessionParams).toMatchObject({
      sessionId: conversationId,
      cwd: root,
      workspaceId: "workspace-1",
    });
  });

  it("retries without a stale conversation id and stores the fresh session", async () => {
    const root = await makeTempRoot();
    const freshConversationId = "66666666-6666-4666-8666-666666666666";

    runProcessMock
      .mockResolvedValueOnce({
        exitCode: 1,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: "unknown conversation old-session",
      })
      .mockImplementationOnce(async (_runId, _target, _command, args) => {
        expect(args).not.toContain("old-session");
        const logPath = args[args.indexOf("--log-file") + 1] as string;
        await fs.mkdir(path.dirname(logPath), { recursive: true });
        await fs.writeFile(
          logPath,
          `I0702 server.go:807] Created conversation ${freshConversationId}\n`,
          "utf8",
        );
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdout: "fresh\n",
          stderr: "",
        };
      });

    const result = await execute(buildContext(root, {
      runtime: {
        sessionId: "old-session",
        sessionParams: { sessionId: "old-session", cwd: root },
        sessionDisplayId: "old-session",
        taskKey: null,
      },
    }));

    expect(runProcessMock).toHaveBeenCalledTimes(2);
    const firstArgs = runProcessMock.mock.calls[0]?.[3] as string[];
    expect(firstArgs).toEqual(expect.arrayContaining(["--conversation", "old-session"]));
    expect(result.sessionId).toBe(freshConversationId);
    expect(result.summary).toBe("fresh");
  });

  it("injects local skills into the same configured HOME used by agy", async () => {
    const root = await makeTempRoot();
    const hostHome = path.join(root, "host-home");
    const configuredHome = path.join(root, "configured-home");
    const skillSource = path.join(root, "runtime-skills", "paperclip");
    await fs.mkdir(skillSource, { recursive: true });
    await fs.writeFile(path.join(skillSource, "SKILL.md"), "paperclip skill\n", "utf8");
    process.env.HOME = hostHome;

    runProcessMock.mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "done\n",
      stderr: "",
    });

    await execute(buildContext(root, {
      config: {
        cwd: root,
        env: { HOME: configuredHome },
        paperclipRuntimeSkills: [{
          key: "paperclip",
          runtimeName: "paperclip",
          source: skillSource,
        }],
        paperclipSkillSync: {
          desiredSkills: ["paperclip"],
        },
      },
    }));

    expect((await fs.lstat(path.join(configuredHome, ".gemini", "skills", "paperclip"))).isSymbolicLink()).toBe(true);
    await expect(fs.lstat(path.join(hostHome, ".gemini", "skills", "paperclip"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("passes the permission-bypass flag only when explicitly enabled", async () => {
    const root = await makeTempRoot();

    runProcessMock.mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "done\n",
      stderr: "",
    });

    await execute(buildContext(root, {
      config: {
        cwd: root,
        dangerouslySkipPermissions: true,
      },
    }));

    const args = runProcessMock.mock.calls[0]?.[3] as string[];
    expect(args).toContain("--dangerously-skip-permissions");
  });

  it("resumes remote sessions against the stable target identity, not the per-run prepared cwd", async () => {
    const root = await makeTempRoot();
    const preparedRemoteCwd = "/remote/workspace/.paperclip-runtime/runs/run-2/workspace";
    const sessionId = "99999999-9999-4999-8999-999999999999";
    prepareRuntimeMock.mockResolvedValue({
      workspaceRemoteDir: preparedRemoteCwd,
      runtimeRootDir: "/remote/workspace/.paperclip-runtime/runs/run-2",
      assetDirs: { skills: "/remote/workspace/.paperclip-runtime/runs/run-2/antigravity/skills" },
      restoreWorkspace: async () => {},
    });
    runProcessMock.mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "resumed\n",
      stderr: "",
    });

    const result = await execute(buildContext(root, {
      runtime: {
        sessionId,
        sessionParams: {
          sessionId,
          cwd: "/remote/workspace",
          remoteExecution: {
            transport: "ssh",
            remoteCwd: "/remote/workspace",
          },
        },
        sessionDisplayId: sessionId,
        taskKey: null,
      },
      executionTarget: {
        kind: "remote",
        transport: "ssh",
        remoteCwd: "/remote/workspace",
        spec: {
          host: "127.0.0.1",
          port: 22,
          username: "agent",
          remoteWorkspacePath: "/remote/workspace",
          remoteCwd: "/remote/workspace",
          privateKey: "PRIVATE KEY",
          knownHosts: "[127.0.0.1]:22 ssh-ed25519 AAAA",
          strictHostKeyChecking: true,
        },
      },
    } as Partial<AdapterExecutionContext>));

    const args = runProcessMock.mock.calls[0]?.[3] as string[];
    expect(args).toEqual(expect.arrayContaining(["--conversation", sessionId]));
    expect(result.sessionParams).toMatchObject({
      sessionId,
      cwd: "/remote/workspace",
      remoteExecution: {
        transport: "ssh",
        remoteCwd: "/remote/workspace",
      },
    });
  });

  it("resumes remote sessions even when an older session stored a volatile prepared cwd", async () => {
    const root = await makeTempRoot();
    const oldPreparedRemoteCwd = "/remote/workspace/.paperclip-runtime/runs/run-1/workspace";
    const newPreparedRemoteCwd = "/remote/workspace/.paperclip-runtime/runs/run-2/workspace";
    const sessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    prepareRuntimeMock.mockResolvedValue({
      workspaceRemoteDir: newPreparedRemoteCwd,
      runtimeRootDir: "/remote/workspace/.paperclip-runtime/runs/run-2",
      assetDirs: { skills: "/remote/workspace/.paperclip-runtime/runs/run-2/antigravity/skills" },
      restoreWorkspace: async () => {},
    });
    runProcessMock.mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "resumed\n",
      stderr: "",
    });

    await execute(buildContext(root, {
      runtime: {
        sessionId,
        sessionParams: {
          sessionId,
          cwd: oldPreparedRemoteCwd,
          remoteExecution: {
            transport: "ssh",
            host: "127.0.0.1",
            port: 22,
            username: "agent",
            remoteCwd: "/remote/workspace",
          },
        },
        sessionDisplayId: sessionId,
        taskKey: null,
      },
      executionTarget: {
        kind: "remote",
        transport: "ssh",
        remoteCwd: "/remote/workspace",
        spec: {
          host: "127.0.0.1",
          port: 22,
          username: "agent",
          remoteWorkspacePath: "/remote/workspace",
          remoteCwd: "/remote/workspace",
          privateKey: "PRIVATE KEY",
          knownHosts: "[127.0.0.1]:22 ssh-ed25519 AAAA",
          strictHostKeyChecking: true,
        },
      },
    } as Partial<AdapterExecutionContext>));

    const args = runProcessMock.mock.calls[0]?.[3] as string[];
    expect(args).toEqual(expect.arrayContaining(["--conversation", sessionId]));
  });

  it("does not replace the whole remote Antigravity skills directory while syncing Paperclip skills", async () => {
    const root = await makeTempRoot();
    prepareRuntimeMock.mockResolvedValue({
      workspaceRemoteDir: "/remote/workspace/.paperclip-runtime/runs/run-3/workspace",
      runtimeRootDir: "/remote/workspace/.paperclip-runtime/runs/run-3",
      assetDirs: { skills: "/remote/workspace/.paperclip-runtime/runs/run-3/antigravity/skills" },
      restoreWorkspace: async () => {},
    });
    runProcessMock.mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "done\n",
      stderr: "",
    });

    await execute(buildContext(root, {
      executionTarget: {
        kind: "remote",
        transport: "ssh",
        remoteCwd: "/remote/workspace",
        spec: {
          host: "127.0.0.1",
          port: 22,
          username: "agent",
          remoteWorkspacePath: "/remote/workspace",
          remoteCwd: "/remote/workspace",
          privateKey: "PRIVATE KEY",
          knownHosts: "[127.0.0.1]:22 ssh-ed25519 AAAA",
          strictHostKeyChecking: true,
        },
      },
    } as Partial<AdapterExecutionContext>));

    const syncScript = runShellCommandMock.mock.calls
      .map((call) => String(call[2]))
      .find((script) => script.includes(".gemini/skills") && script.includes("antigravity/skills"));
    expect(syncScript).toBeDefined();
    expect(syncScript).not.toContain("rm -rf \"/home/agent/.gemini/skills\"");
    expect(syncScript).not.toContain("rm -rf \"$target\"");
    expect(syncScript).toContain("[ -e \"$target\" ] || [ -L \"$target\" ]");
    expect(syncScript).toContain("for skill_dir in");
  });
});
