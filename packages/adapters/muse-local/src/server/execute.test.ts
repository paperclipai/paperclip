import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext, AdapterInvocationMeta } from "@paperclipai/adapter-utils";

const runProcessMock = vi.hoisted(() =>
  vi.fn(
    async (
      _runId: string,
      _target: unknown,
      _command: string,
      _args: string[],
      _options?: unknown,
    ) => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: JSON.stringify({ payload_type: "run.terminal.completed", payload: { text: "Task completed." } }),
      stderr: "",
    }),
  ),
);

const prepareRuntimeMock = vi.hoisted(() =>
  vi.fn(async (..._args: unknown[]) => ({
    workspaceRemoteDir: "/remote/workspace",
    assetDirs: { runConfig: "/remote/config" },
    restoreWorkspace: async () => {},
  })),
);

vi.mock("@paperclipai/adapter-utils/execution-target", () => ({
  readAdapterExecutionTarget: ({ executionTarget }: { executionTarget?: unknown }) =>
    executionTarget ?? { kind: "local" },
  prepareAdapterExecutionTargetRuntime: prepareRuntimeMock,
  resolveAdapterExecutionTargetCommandForLogs: async (cmd: string) => cmd,
  runAdapterExecutionTargetProcess: runProcessMock,
}));

import { execute } from "./execute.js";

const tempRoots: string[] = [];

async function makeTempRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-muse-test-"));
  tempRoots.push(root);
  return root;
}

function makeContext(root: string, overrides: Partial<AdapterExecutionContext> = {}): AdapterExecutionContext {
  return {
    runId: "run-123",
    agent: {
      id: "agent-123",
      companyId: "company-123",
      name: "Muse Agent",
      adapterType: "muse_local",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config: { cwd: root, model: "muse-wonder-1.0", reasoningEffort: "high" },
    context: {},
    authToken: "agent-auth-token",
    onLog: async () => {},
    ...overrides,
  };
}

describe("muse_local execute", () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    runProcessMock.mockClear();
    prepareRuntimeMock.mockClear();
    process.env.DATABASE_URL = "postgres://secret-user:secret-pass@localhost:5432/paperclip";
    process.env.HOST_SECRET = "super-secret-value";
  });

  afterEach(async () => {
    process.env = { ...origEnv };
    for (const root of tempRoots) {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    }
    tempRoots.length = 0;
  });

  it("redacts host environment secrets in onMeta to prevent credential leakage into database", async () => {
    const root = await makeTempRoot();
    const onMeta = vi.fn(async (_meta: AdapterInvocationMeta) => {});
    const ctx = makeContext(root, { onMeta });

    const result = await execute(ctx);
    expect(result.exitCode).toBe(0);
    expect(onMeta).toHaveBeenCalledTimes(1);

    const loggedMeta = onMeta.mock.calls[0]![0];
    const loggedEnv = loggedMeta.env as Record<string, string>;

    // Host secrets must NOT leak into logged environment
    expect(loggedEnv.DATABASE_URL).toBeUndefined();
    expect(loggedEnv.HOST_SECRET).toBeUndefined();

    // Standard run variables should be present
    expect(loggedEnv.PAPERCLIP_RUN_ID).toBe("run-123");
    expect(loggedEnv.PAPERCLIP_API_KEY).toBe("***REDACTED***");
    expect(loggedEnv.MUSE_NO_AUTO_UPDATE).toBe("1");
  });

  it("preserves pre-existing user files and directories in .agents during skill staging cleanup", async () => {
    const root = await makeTempRoot();
    const userAgentsDir = path.join(root, ".agents");
    await fs.mkdir(userAgentsDir, { recursive: true });
    const userRuleFile = path.join(userAgentsDir, "custom-agent-rule.md");
    await fs.writeFile(userRuleFile, "# User rule\nDo not delete me.", "utf8");

    const ctx = makeContext(root);
    await execute(ctx);

    // .agents and userRuleFile must still exist
    const stillExists = await fs.access(userRuleFile).then(() => true).catch(() => false);
    expect(stillExists).toBe(true);
    const content = await fs.readFile(userRuleFile, "utf8");
    expect(content).toBe("# User rule\nDo not delete me.");
  });

  it("passes model and reasoningEffort to CLI execution", async () => {
    const root = await makeTempRoot();
    const onMeta = vi.fn(async (_meta: AdapterInvocationMeta) => {});
    const ctx = makeContext(root, {
      onMeta,
      config: { cwd: root, model: "muse-wonder-full-1.0", reasoningEffort: "xhigh" },
    });

    await execute(ctx);
    expect(runProcessMock).toHaveBeenCalledTimes(1);

    const callArgs = runProcessMock.mock.calls[0]![3] as string[];
    expect(callArgs).toContain("--model");
    expect(callArgs).toContain("muse-wonder-full-1.0");
    expect(callArgs).toContain("--reasoning-effort");
    expect(callArgs).toContain("xhigh");
  });

  it("copies credentials from a custom XDG_CONFIG_HOME into runTmpDir", async () => {
    const root = await makeTempRoot();
    const customConfig = await makeTempRoot();
    const museDir = path.join(customConfig, "muse");
    await fs.mkdir(museDir, { recursive: true });
    await fs.writeFile(path.join(museDir, "auth.json"), JSON.stringify({ token: "custom-auth-token" }), "utf8");

    let capturedStagedAuthContent: string | null = null;
    let capturedXdgConfig: string | undefined = undefined;

    runProcessMock.mockImplementationOnce(
      async (
        _runId: string,
        _target: unknown,
        _command: string,
        _args: string[],
        options?: any,
      ) => {
        capturedXdgConfig = options?.env?.XDG_CONFIG_HOME;
        if (capturedXdgConfig) {
          const stagedAuth = path.join(capturedXdgConfig, "muse", "auth.json");
          try {
            capturedStagedAuthContent = await fs.readFile(stagedAuth, "utf8");
          } catch {}
        }
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdout: JSON.stringify({ payload_type: "run.terminal.completed", payload: { text: "Task completed." } }),
          stderr: "",
        };
      },
    );

    const onMeta = vi.fn(async (_meta: AdapterInvocationMeta) => {});
    const ctx = makeContext(root, {
      onMeta,
      config: {
        cwd: root,
        env: { XDG_CONFIG_HOME: customConfig },
      },
    });

    await execute(ctx);
    expect(capturedXdgConfig).toBeDefined();
    expect(capturedXdgConfig).not.toBe(customConfig);
    expect(capturedStagedAuthContent).toContain("custom-auth-token");
  });

  it("reports workspace restore failure when remote workspace restore fails", async () => {
    const root = await makeTempRoot();
    prepareRuntimeMock.mockResolvedValueOnce({
      workspaceRemoteDir: "/remote/workspace",
      assetDirs: { runConfig: "/remote/config" },
      restoreWorkspace: async () => {
        throw new Error("Remote restore network error");
      },
    });

    const ctx = makeContext(root, {
      executionTarget: { kind: "remote", targetId: "target-1" } as any,
    });

    const result = await execute(ctx);
    expect(result.errorCode).toBe("workspace_restore_failed");
    expect(result.errorMessage).toContain("Workspace restore failed");
  });

  it("does not leak host process.env secrets to remote execution target", async () => {
    const root = await makeTempRoot();
    let remoteEnv: Record<string, string> | undefined;

    runProcessMock.mockImplementationOnce(
      async (
        _runId: string,
        _target: unknown,
        _command: string,
        _args: string[],
        options?: any,
      ) => {
        remoteEnv = options?.env;
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdout: JSON.stringify({ payload_type: "run.terminal.completed", payload: { text: "Task completed." } }),
          stderr: "",
        };
      },
    );

    const ctx = makeContext(root, {
      executionTarget: { kind: "remote", targetId: "target-remote-1" } as any,
    });

    const result = await execute(ctx);
    expect(result.exitCode).toBe(0);
    expect(remoteEnv).toBeDefined();
    expect(remoteEnv?.DATABASE_URL).toBeUndefined();
    expect(remoteEnv?.HOST_SECRET).toBeUndefined();
    expect(remoteEnv?.PAPERCLIP_RUN_ID).toBe("run-123");
    expect(remoteEnv?.PAPERCLIP_API_KEY).toBe("agent-auth-token");
  });

  it("cleans up temporary run directory when preparation fails before execution", async () => {
    const root = await makeTempRoot();
    let createdTmpDir: string | undefined;

    const onMeta = vi.fn(async (meta: AdapterInvocationMeta) => {
      createdTmpDir = (meta.env as Record<string, string> | undefined)?.XDG_CONFIG_HOME;
      throw new Error("Simulated onMeta preparation error");
    });

    const ctx = makeContext(root, { onMeta });

    await expect(execute(ctx)).rejects.toThrow("Simulated onMeta preparation error");
    expect(createdTmpDir).toBeDefined();

    // Verify createdTmpDir was cleaned up by the finally block
    const exists = await fs.access(createdTmpDir!).then(() => true).catch(() => false);
    expect(exists).toBe(false);
  });

  it("does not copy back sandbox credentials from remote execution targets to protect host auth", async () => {
    const root = await makeTempRoot();
    const hostAuthPath = path.join(root, "host-auth.json");
    const originalAuth = JSON.stringify({ account_id: "test-acc", token: "original-host-token", expires_at: new Date(Date.now() + 3600000).toISOString() });
    await fs.writeFile(hostAuthPath, originalAuth, "utf8");

    let assetRestore: ((args: { assetDir: string; readFile: (p: string) => Promise<Buffer> }) => Promise<void>) | undefined;
    prepareRuntimeMock.mockImplementationOnce(async (options: any) => {
      assetRestore = options?.assets?.[0]?.restore;
      return {
        workspaceRemoteDir: "/remote/workspace",
        assetDirs: { runConfig: "/remote/config" },
        restoreWorkspace: async () => {
          if (assetRestore) {
            await assetRestore({
              assetDir: "/remote/sandbox",
              readFile: async () => Buffer.from(JSON.stringify({
                account_id: "test-acc",
                token: "forged-attacker-token",
                expires_at: new Date(Date.now() + 7200000).toISOString(),
              })),
            });
          }
        },
      };
    });

    const ctx = makeContext(root, {
      executionTarget: { kind: "remote", targetId: "target-remote-1" } as any,
      config: { cwd: root, env: { MUSE_AUTH_PATH: hostAuthPath } },
    });

    const result = await execute(ctx);
    expect(result.exitCode).toBe(0);

    // Host credential must remain completely unchanged and protected from the sandbox
    const currentHostAuth = await fs.readFile(hostAuthPath, "utf8");
    expect(currentHostAuth).toBe(originalAuth);
    expect(currentHostAuth).not.toContain("forged-attacker-token");
  });
});

