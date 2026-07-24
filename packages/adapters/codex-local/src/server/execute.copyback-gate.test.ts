import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const {
  runChildProcess,
  ensureCommandResolvable,
  resolveCommandForLogs,
  prepareAdapterExecutionTargetRuntime,
  startAdapterExecutionTargetPaperclipBridge,
  copyBackCodexAuth,
} = vi.hoisted(() => ({
  runChildProcess: vi.fn(async () => ({
    exitCode: 1,
    signal: null,
    timedOut: false,
    stdout: "",
    stderr: "remote failure",
    pid: 123,
    startedAt: new Date().toISOString(),
  })),
  ensureCommandResolvable: vi.fn(async () => undefined),
  resolveCommandForLogs: vi.fn(async () => "/usr/bin/codex"),
  // Captures the `assets` contract execute() hands to the sandbox runtime so
  // each test can invoke the `home` asset's `restore` seam exactly the way the
  // sandbox core does at teardown, without a real sandbox.
  prepareAdapterExecutionTargetRuntime: vi.fn(
    async (input: { target: unknown; runId: string }) => ({
      target: input.target,
      workspaceRemoteDir: `/remote/workspace/.paperclip-runtime/runs/${input.runId}/workspace`,
      runtimeRootDir: `/remote/workspace/.paperclip-runtime/runs/${input.runId}/workspace/.paperclip-runtime/codex`,
      assetDirs: {
        home: `/remote/workspace/.paperclip-runtime/runs/${input.runId}/workspace/.paperclip-runtime/codex/home`,
      },
      restoreWorkspace: async () => {},
    }),
  ),
  startAdapterExecutionTargetPaperclipBridge: vi.fn(async () => ({
    env: {
      PAPERCLIP_API_URL: "http://127.0.0.1:4310",
      PAPERCLIP_API_KEY: "bridge-token",
      PAPERCLIP_API_BRIDGE_MODE: "queue_v1",
    },
    stop: async () => {},
  })),
  copyBackCodexAuth: vi.fn(async () => "kept-host" as const),
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

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    prepareAdapterExecutionTargetRuntime,
    startAdapterExecutionTargetPaperclipBridge,
  };
});

vi.mock("./codex-auth-copyback.js", () => ({
  copyBackCodexAuth,
}));

import { execute } from "./execute.js";

type CapturedRestoreSeam = (ctx: {
  assetDir: string;
  readFile: (remotePath: string) => Promise<Buffer>;
}) => Promise<void>;

describe("codex auth copy-back call-site gate", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  // Runs execute() against the remote SSH transport (any remote target routes
  // through prepareAdapterExecutionTargetRuntime, which is mocked above) and
  // returns the captured `home` asset restore seam plus the collected logs.
  async function runExecuteAndCaptureRestore(input: {
    runId: string;
  }): Promise<{ restore: CapturedRestoreSeam; logs: string[] }> {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-codex-copyback-gate-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const codexHomeDir = path.join(rootDir, "codex-home");
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(codexHomeDir, { recursive: true });
    await writeFile(path.join(codexHomeDir, "auth.json"), "{}", "utf8");

    const logs: string[] = [];
    await execute({
      runId: input.runId,
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "CodexCoder",
        adapterType: "codex_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        command: "codex",
        env: {
          CODEX_HOME: codexHomeDir,
        },
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
      onLog: async (_stream, chunk) => {
        logs.push(chunk);
      },
    });

    expect(prepareAdapterExecutionTargetRuntime).toHaveBeenCalledTimes(1);
    const prepareInput = prepareAdapterExecutionTargetRuntime.mock.calls[0]?.[0] as unknown as {
      assets?: { key: string; restore?: CapturedRestoreSeam }[];
    };
    const homeAsset = (prepareInput.assets ?? []).find((asset) => asset.key === "home");
    expect(homeAsset?.restore).toBeTypeOf("function");
    return { restore: homeAsset?.restore as CapturedRestoreSeam, logs };
  }

  it("skips the copy-back with a single log line when the shared host home has no usable auth", async () => {
    const sharedRoot = await mkdtemp(path.join(os.tmpdir(), "paperclip-codex-shared-absent-"));
    cleanupDirs.push(sharedRoot);
    // The prod multi-tenant shape: the shared host codex home does not exist at
    // all (credentials came from a managed per-company CODEX_HOME instead).
    vi.stubEnv("CODEX_HOME", path.join(sharedRoot, "never-created-codex-home"));

    const { restore, logs } = await runExecuteAndCaptureRestore({ runId: "run-gate-skip" });
    await restore({
      assetDir: "/remote/home",
      readFile: async () => Buffer.from("{}", "utf8"),
    });

    expect(copyBackCodexAuth).not.toHaveBeenCalled();
    const skipLines = logs.filter((line) =>
      line.includes("Codex auth copy-back skipped: no shared host credential store"),
    );
    expect(skipLines).toHaveLength(1);
  });

  it("still runs the copy-back against the shared host credential when it exists", async () => {
    const sharedHome = await mkdtemp(path.join(os.tmpdir(), "paperclip-codex-shared-present-"));
    cleanupDirs.push(sharedHome);
    await writeFile(
      path.join(sharedHome, "auth.json"),
      JSON.stringify({ OPENAI_API_KEY: "sk-shared" }),
      "utf8",
    );
    vi.stubEnv("CODEX_HOME", sharedHome);

    const { restore, logs } = await runExecuteAndCaptureRestore({ runId: "run-gate-copy" });
    await restore({
      assetDir: "/remote/home",
      readFile: async () => Buffer.from("{}", "utf8"),
    });

    expect(copyBackCodexAuth).toHaveBeenCalledTimes(1);
    expect(copyBackCodexAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        hostAuthPath: path.join(sharedHome, "auth.json"),
      }),
    );
    expect(logs.join("")).not.toContain("Codex auth copy-back skipped");
  });
});
