import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";

const PI_TURN_END = JSON.stringify({
  type: "turn_end",
  message: {
    role: "assistant",
    content: "done",
    usage: { input: 10, output: 20, cacheRead: 0, cost: { total: 0.01 } },
  },
  toolResults: [],
});

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
  actualPrepare,
} = vi.hoisted(() => ({
  runChildProcess: vi.fn(),
  ensureCommandResolvable: vi.fn(async () => undefined),
  resolveCommandForLogs: vi.fn(async () => "pi"),
  prepareWorkspaceForSshExecution: vi.fn(async () => ({ gitBacked: false })),
  restoreWorkspaceFromSshExecution: vi.fn(async () => undefined),
  runSshCommand: vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 })),
  syncDirectoryToSsh: vi.fn(async () => undefined),
  startAdapterExecutionTargetPaperclipBridge: vi.fn(),
  prepareAdapterExecutionTargetRuntime: vi.fn(),
  actualPrepare: { fn: undefined as undefined | ((...args: never[]) => unknown) },
}));

vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>(
    "@paperclipai/adapter-utils/server-utils",
  );
  return { ...actual, ensureCommandResolvable, resolveCommandForLogs, runChildProcess };
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
  actualPrepare.fn = actual.prepareAdapterExecutionTargetRuntime as never;
  return { ...actual, startAdapterExecutionTargetPaperclipBridge, prepareAdapterExecutionTargetRuntime };
});

vi.mock("./models.js", async () => {
  const actual = await vi.importActual<typeof import("./models.js")>("./models.js");
  return {
    ...actual,
    ensurePiModelConfiguredAndAvailable: vi.fn(async () => [
      { id: "openai/gpt-5.4-mini", label: "openai/gpt-5.4-mini" },
    ]),
  };
});

import { execute } from "./execute.js";

const BRIDGE_ENV = {
  PAPERCLIP_API_URL: "http://127.0.0.1:4310",
  PAPERCLIP_API_KEY: "bridge-token",
  PAPERCLIP_API_BRIDGE_MODE: "queue_v1",
};

function resetMocks() {
  vi.clearAllMocks();
  runChildProcess.mockReset().mockImplementation(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: PI_TURN_END,
    stderr: "",
    pid: 123,
    startedAt: new Date().toISOString(),
  }));
  startAdapterExecutionTargetPaperclipBridge.mockReset().mockImplementation(async () => ({
    env: { ...BRIDGE_ENV },
    stop: async () => {},
  }));
  prepareAdapterExecutionTargetRuntime.mockReset().mockImplementation(actualPrepare.fn as never);
}

const agent = {
  id: "agent-1",
  companyId: "company-1",
  name: "Pi Builder",
  adapterType: "pi_local",
  adapterConfig: {},
};
const runtime = { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null };
const config = { command: "pi", model: "openai/gpt-5.4-mini" };

describe("pi run JWT handling per execution target", () => {
  const cleanupDirs: string[] = [];

  async function makeWorkspace(prefix: string) {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), prefix));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    await mkdir(workspaceDir, { recursive: true });
    return workspaceDir;
  }

  resetMocks();
  afterEach(async () => {
    resetMocks();
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("keeps the run JWT off an SSH target and gives Pi only the bridge token", async () => {
    const workspaceDir = await makeWorkspace("paperclip-pi-ssh-jwt-");
    const runJwt = "eyJfake.run-jwt-ssh.sig";

    await execute({
      runId: "run-ssh-jwt",
      agent,
      runtime,
      config,
      context: { paperclipWorkspace: { cwd: workspaceDir, source: "project_primary" } },
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
      authToken: runJwt,
      onLog: async () => {},
    });

    expect(startAdapterExecutionTargetPaperclipBridge).toHaveBeenCalledWith(
      expect.objectContaining({ hostApiToken: runJwt }),
    );
    for (const fn of [
      ensureCommandResolvable,
      resolveCommandForLogs,
      prepareWorkspaceForSshExecution,
      runSshCommand,
      syncDirectoryToSsh,
      runChildProcess,
    ]) {
      expect(JSON.stringify(fn.mock.calls)).not.toContain(runJwt);
    }
    expect(runChildProcess).toHaveBeenCalledTimes(1);
    const [, piCommand, , piOptions] = runChildProcess.mock.calls[0] as unknown as
      [string, string, string[], { env: Record<string, string> }];
    expect(piCommand).toBe("pi");
    expect(piOptions.env.PAPERCLIP_API_KEY).toBe("bridge-token");
  });

  it("keeps the run JWT out of every sandbox exec, before and after the bridge starts", async () => {
    const workspaceDir = await makeWorkspace("paperclip-pi-sandbox-jwt-");
    const runJwt = "eyJfake.run-jwt-sandbox.sig";
    const runtimeRoot = "/workspace/.paperclip-runtime/pi";

    const sandboxInputs: unknown[] = [];
    let execsBeforeBridge = -1;
    const sandboxTarget: AdapterExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "kubernetes",
      remoteCwd: "/workspace",
      runner: {
        execute: async (input) => {
          sandboxInputs.push(input);
          return {
            exitCode: 0,
            signal: null,
            timedOut: false,
            stdout: "",
            stderr: "",
            pid: null,
            startedAt: new Date().toISOString(),
          };
        },
      },
    };
    prepareAdapterExecutionTargetRuntime.mockImplementation(async () => ({
      target: sandboxTarget,
      workspaceRemoteDir: "/workspace",
      runtimeRootDir: runtimeRoot,
      assetDirs: { attribution: `${runtimeRoot}/attribution`, skills: `${runtimeRoot}/skills` },
      additionalSourceDirs: {},
      additionalSourceFailures: [],
      workspaceSyncSnapshot: null,
      restoreWorkspace: async () => {},
    }));
    startAdapterExecutionTargetPaperclipBridge.mockImplementation(async () => {
      execsBeforeBridge = sandboxInputs.length;
      return { env: { ...BRIDGE_ENV }, stop: async () => {} };
    });

    await execute({
      runId: "run-sandbox-jwt",
      agent,
      runtime,
      config,
      context: { paperclipWorkspace: { cwd: workspaceDir, source: "project_primary" } },
      executionTarget: sandboxTarget,
      runtimeCommandSpec: { command: "pi", installCommand: "npm install -g pi", detectCommand: "pi" },
      authToken: runJwt,
      onLog: async () => {},
    });

    expect(startAdapterExecutionTargetPaperclipBridge).toHaveBeenCalledWith(
      expect.objectContaining({ hostApiToken: runJwt }),
    );
    expect(execsBeforeBridge).toBeGreaterThan(0);
    expect(sandboxInputs.length).toBeGreaterThan(execsBeforeBridge);
    expect(JSON.stringify(sandboxInputs)).not.toContain(runJwt);
    expect(JSON.stringify(prepareAdapterExecutionTargetRuntime.mock.calls)).not.toContain(runJwt);
    const postBridgeEnvs = sandboxInputs
      .slice(execsBeforeBridge)
      .map((input) => (input as { env?: Record<string, string> }).env ?? {})
      .filter((env) => env.PAPERCLIP_API_KEY !== undefined);
    expect(postBridgeEnvs.length).toBeGreaterThan(0);
    for (const env of postBridgeEnvs) expect(env.PAPERCLIP_API_KEY).toBe("bridge-token");
  });

  it("still gives a local run the run JWT as PAPERCLIP_API_KEY", async () => {
    const workspaceDir = await makeWorkspace("paperclip-pi-local-jwt-");
    const runJwt = "eyJfake.run-jwt-local.sig";

    await execute({
      runId: "run-local-jwt",
      agent,
      runtime,
      config,
      context: { paperclipWorkspace: { cwd: workspaceDir, source: "project_primary" } },
      authToken: runJwt,
      onLog: async () => {},
    });

    expect(startAdapterExecutionTargetPaperclipBridge).not.toHaveBeenCalled();
    expect(runChildProcess).toHaveBeenCalledTimes(1);
    const [, piCommand, , piOptions] = runChildProcess.mock.calls[0] as unknown as
      [string, string, string[], { env: Record<string, string> }];
    expect(piCommand).toBe("pi");
    expect(piOptions.env.PAPERCLIP_API_KEY).toBe(runJwt);
  });
});
