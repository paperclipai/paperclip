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
    stdout: "",
    stderr: "",
    pid: 123,
    startedAt: new Date().toISOString(),
  })),
  ensureCommandResolvable: vi.fn(async () => undefined),
  resolveCommandForLogs: vi.fn(async () => "ssh://fixture@127.0.0.1:2222/remote/workspace :: opencode"),
  prepareWorkspaceForSshExecution: vi.fn(async () => ({ gitBacked: false })),
  restoreWorkspaceFromSshExecution: vi.fn(async () => undefined),
  runSshCommand: vi.fn(async () => ({ stdout: "/home/agent", stderr: "", exitCode: 0 })),
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

import { OPENCODE_PROVIDER_CREDENTIAL_ENV_KEYS } from "./credential-preflight.js";
import { execute } from "./execute.js";

describe("opencode credential preflight in execute", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    vi.clearAllMocks();
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  async function buildCredentiallessConfigEnv(): Promise<Record<string, string>> {
    // Mask any credential the host machine running the tests may carry: the run
    // env overrides process.env, and empty values do not count as credentials.
    const dataHome = await mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-data-"));
    const configHome = await mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-config-"));
    cleanupDirs.push(dataHome, configHome);
    const env: Record<string, string> = {
      XDG_DATA_HOME: dataHome,
      XDG_CONFIG_HOME: configHome,
      PAPERCLIP_OPENCODE_PROVIDERS: "",
    };
    for (const key of OPENCODE_PROVIDER_CREDENTIAL_ENV_KEYS) {
      env[key] = "";
    }
    return env;
  }

  it("fails fast with inference_auth_invalid when the run has no provider credential", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-nocred-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    await mkdir(workspaceDir, { recursive: true });

    const result = await execute({
      runId: "run-nocred-1",
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
        model: "anthropic/claude-sonnet-4-5",
        env: await buildCredentiallessConfigEnv(),
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

    expect(result.errorCode).toBe("inference_auth_invalid");
    expect(result.errorMessage).toBe(
      "No model provider credential is connected for this agent. Connect a provider key, then resume.",
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.timedOut).toBe(false);

    // Fail FAST: no workspace sync and no OpenCode process launch happened.
    expect(prepareWorkspaceForSshExecution).not.toHaveBeenCalled();
    expect(runChildProcess).not.toHaveBeenCalled();
  });

  it("does not fail fast when a provider credential is present in the run env", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-cred-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    await mkdir(workspaceDir, { recursive: true });
    const env = await buildCredentiallessConfigEnv();
    env.ANTHROPIC_API_KEY = "test-key";
    // Keep the run local and cheap: with a credential present the preflight
    // passes and execution proceeds to the model probe, which we make succeed.
    runChildProcess.mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "anthropic/claude-sonnet-4-5\n",
      stderr: "",
      pid: 123,
      startedAt: new Date().toISOString(),
    });

    const result = await execute({
      runId: "run-cred-1",
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
        model: "anthropic/claude-sonnet-4-5",
        env,
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

    expect(result.errorCode ?? null).not.toBe("inference_auth_invalid");
    expect(runChildProcess).toHaveBeenCalled();
  });
});
