import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SandboxManagedRuntimeAsset } from "@paperclipai/adapter-utils/sandbox-managed-runtime";

// Captured Codex `home` asset descriptor + the sandbox `auth.json` fixture the
// mocked runtime hands back during teardown. Mutated per-test so a single
// harness drives every round-trip case through the REAL `execute()` wiring.
const captured: { assets: SandboxManagedRuntimeAsset[] } = { assets: [] };
const sandboxAuthFixture: { bytes: Buffer } = { bytes: Buffer.from("{}") };
const REMOTE_RUNTIME_ROOT = "/remote/workspace/.paperclip-runtime/codex";

const {
  runChildProcess,
  ensureCommandResolvable,
  resolveCommandForLogs,
  prepareAdapterExecutionTargetRuntime,
  startAdapterExecutionTargetPaperclipBridge,
} = vi.hoisted(() => ({
  runChildProcess: vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: "",
    stderr: "",
    pid: 321,
    startedAt: new Date().toISOString(),
  })),
  ensureCommandResolvable: vi.fn(async () => undefined),
  resolveCommandForLogs: vi.fn(async () => "/usr/bin/codex"),
  prepareAdapterExecutionTargetRuntime: vi.fn(),
  startAdapterExecutionTargetPaperclipBridge: vi.fn(async () => null),
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

import { execute } from "./execute.js";

// Mirror the sandbox core's restore closure: capture the assets `execute()`
// declares, then during teardown invoke each asset's `restore` with an injected
// `readFile` (returns the sandbox fixture) and the remote asset dir. This drives
// the exact `restore` contribution the Codex adapter wires in production without
// needing a live sandbox.
prepareAdapterExecutionTargetRuntime.mockImplementation(async (input: { assets?: SandboxManagedRuntimeAsset[] }) => {
  captured.assets = input.assets ?? [];
  return {
    target: { kind: "remote", transport: "ssh" },
    workspaceRemoteDir: "/remote/workspace",
    runtimeRootDir: REMOTE_RUNTIME_ROOT,
    assetDirs: { home: `${REMOTE_RUNTIME_ROOT}/home` },
    restoreWorkspace: async () => {
      for (const asset of captured.assets) {
        if (!asset.restore) continue;
        await asset.restore({
          assetDir: `${REMOTE_RUNTIME_ROOT}/home`,
          readFile: async () => sandboxAuthFixture.bytes,
        });
      }
    },
  };
});

describe("codex execute — outbound auth copy-back restore contribution", () => {
  const cleanupDirs: string[] = [];
  let savedCodexHomeEnv: string | undefined;

  afterEach(async () => {
    vi.clearAllMocks();
    if (savedCodexHomeEnv === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = savedCodexHomeEnv;
    }
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  function subscriptionAuth(input: { accountId: string; lastRefresh?: string; marker: string }): string {
    return JSON.stringify(
      {
        tokens: {
          id_token: `id-token-${input.marker}`,
          access_token: `access-token-${input.marker}`,
          refresh_token: `refresh-token-${input.marker}`,
          account_id: input.accountId,
        },
        ...(input.lastRefresh ? { last_refresh: input.lastRefresh } : {}),
      },
      null,
      2,
    );
  }

  async function runTeardown(input: { sandboxAuth: string; hostAuth: string; onProviderStopped?: () => Promise<void> }) {
    const rootDir = await mkdtemp(
      path.join(os.tmpdir(), "paperclip-codex-copyback-e2e-"),
    );
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    // The shared host home is what `resolveSharedCodexHomeDir` returns
    // (process.env.CODEX_HOME) — the copy-back target. Point it at a tmp dir so
    // the round-trip never touches the real host credential.
    const sharedHostHome = path.join(rootDir, "shared-codex-home");
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(sharedHostHome, { recursive: true });
    const hostAuthPath = path.join(sharedHostHome, "auth.json");
    await writeFile(hostAuthPath, input.hostAuth, { mode: 0o600 });

    savedCodexHomeEnv = process.env.CODEX_HOME;
    process.env.CODEX_HOME = sharedHostHome;
    sandboxAuthFixture.bytes = Buffer.from(input.sandboxAuth, "utf8");

    const executionResult = await execute({
      runId: "run-copyback-e2e",
      onProviderStopped: input.onProviderStopped,
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "CodexCoder",
        adapterType: "codex_local",
        adapterConfig: {},
      },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: {
        command: "codex",
        engine: "cli",
        // External CODEX_HOME (outside the managed company tree) so no managed
        // seeding rewrites auth.json before teardown; equals the shared host home.
        env: { CODEX_HOME: sharedHostHome },
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

    return {
      finalHostAuth: await readFile(hostAuthPath, "utf8"),
      finalHostMode: (await lstat(hostAuthPath)).mode & 0o777,
      executionResult,
    };
  }

  it("collects stopped-provider instruction edits before a throwing remote restore", async () => {
    const order: string[] = [];
    prepareAdapterExecutionTargetRuntime.mockImplementationOnce(async () => ({
      target: { kind: "remote", transport: "ssh" }, workspaceRemoteDir: "/remote/workspace",
      runtimeRootDir: REMOTE_RUNTIME_ROOT, assetDirs: { home: `${REMOTE_RUNTIME_ROOT}/home` },
      restoreWorkspace: async () => { order.push("restore"); throw new Error("restore failed"); },
    }));
    await expect(runTeardown({ sandboxAuth: "{}", hostAuth: "{}", onProviderStopped: async () => { order.push("collect"); } })).rejects.toThrow("restore failed");
    expect(order).toEqual(["collect", "restore"]);
  });

  it("collects after a failed provider exit before restoring its workspace", async () => {
    runChildProcess.mockResolvedValueOnce({ exitCode: 1, signal: null, timedOut: false, stdout: "", stderr: "provider failed", pid: 321, startedAt: new Date().toISOString() });
    const collected = vi.fn(async () => {});
    await runTeardown({ sandboxAuth: "{}", hostAuth: "{}", onProviderStopped: collected });
    expect(collected).toHaveBeenCalledOnce();
  });

  it("stops the bridge and restores the workspace when instruction collection rejects", async () => {
    const order: string[] = [];
    startAdapterExecutionTargetPaperclipBridge.mockResolvedValueOnce({
      env: {}, stop: async () => { order.push("bridge-stop"); },
    } as never);
    prepareAdapterExecutionTargetRuntime.mockImplementationOnce(async () => ({
      target: { kind: "remote", transport: "ssh" }, workspaceRemoteDir: "/remote/workspace",
      runtimeRootDir: REMOTE_RUNTIME_ROOT, assetDirs: { home: `${REMOTE_RUNTIME_ROOT}/home` },
      restoreWorkspace: async () => { order.push("restore"); },
    }));
    await expect(runTeardown({ sandboxAuth: "{}", hostAuth: "{}", onProviderStopped: async () => {
      order.push("collect");
      throw new Error("instruction collection failed");
    } })).rejects.toThrow("instruction collection failed");
    expect(order).toEqual(["collect", "bridge-stop", "restore"]);
  });

  it("declares a Codex `home` asset carrying both inbound provision and outbound restore contributions", async () => {
    await runTeardown({
      sandboxAuth: subscriptionAuth({ accountId: "acct", lastRefresh: "2026-07-09T01:00:00Z", marker: "s" }),
      hostAuth: subscriptionAuth({ accountId: "acct", lastRefresh: "2026-07-09T02:00:00Z", marker: "h" }),
    });

    const homeAsset = captured.assets.find((asset) => asset.key === "home");
    expect(homeAsset).toBeDefined();
    expect(homeAsset?.provision).toBeTruthy();
    expect(typeof homeAsset?.restore).toBe("function");
  });

  it("round-trips a strictly-newer same-identity sandbox auth.json to the shared host at 0600 on teardown", async () => {
    const sandboxAuth = subscriptionAuth({
      accountId: "acct-same",
      lastRefresh: "2026-07-09T02:00:00Z",
      marker: "sandbox-newer",
    });
    const hostAuth = subscriptionAuth({
      accountId: "acct-same",
      lastRefresh: "2026-07-09T01:00:00Z",
      marker: "host-older",
    });

    const result = await runTeardown({ sandboxAuth, hostAuth });

    expect(result.finalHostAuth).toBe(sandboxAuth);
    expect(result.finalHostMode).toBe(0o600);
  });

  it("keeps the host auth.json when the sandbox copy is a tie or older on teardown", async () => {
    const cases = [
      {
        name: "tie",
        sandboxAuth: subscriptionAuth({ accountId: "acct-same", lastRefresh: "2026-07-09T02:00:00Z", marker: "s-tie" }),
        hostAuth: subscriptionAuth({ accountId: "acct-same", lastRefresh: "2026-07-09T02:00:00Z", marker: "h-tie" }),
      },
      {
        name: "older",
        sandboxAuth: subscriptionAuth({ accountId: "acct-same", lastRefresh: "2026-07-09T01:00:00Z", marker: "s-old" }),
        hostAuth: subscriptionAuth({ accountId: "acct-same", lastRefresh: "2026-07-09T02:00:00Z", marker: "h-new" }),
      },
    ];

    for (const entry of cases) {
      const result = await runTeardown({ sandboxAuth: entry.sandboxAuth, hostAuth: entry.hostAuth });
      expect(result.finalHostAuth, entry.name).toBe(entry.hostAuth);
      expect(result.finalHostMode, entry.name).toBe(0o600);
    }
  });

  it("surfaces workspace restore failure after successful provider execution", async () => {
    prepareAdapterExecutionTargetRuntime.mockResolvedValueOnce({
      target: { kind: "remote", transport: "ssh" },
      workspaceRemoteDir: "/remote/workspace",
      runtimeRootDir: REMOTE_RUNTIME_ROOT,
      assetDirs: { home: `${REMOTE_RUNTIME_ROOT}/home` },
      restoreWorkspace: async () => {
        throw new Error("workspace copy-back failed");
      },
    });

    await expect(
      runTeardown({
        sandboxAuth: subscriptionAuth({ accountId: "acct", marker: "sandbox" }),
        hostAuth: subscriptionAuth({ accountId: "acct", marker: "host" }),
      }),
    ).rejects.toThrow("workspace copy-back failed");
  });

  it("preserves a provider failure when workspace restore also fails", async () => {
    runChildProcess.mockResolvedValueOnce({
      exitCode: 1,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "provider failed first",
      pid: 321,
      startedAt: new Date().toISOString(),
    });
    prepareAdapterExecutionTargetRuntime.mockResolvedValueOnce({
      target: { kind: "remote", transport: "ssh" },
      workspaceRemoteDir: "/remote/workspace",
      runtimeRootDir: REMOTE_RUNTIME_ROOT,
      assetDirs: { home: `${REMOTE_RUNTIME_ROOT}/home` },
      restoreWorkspace: async () => {
        throw new Error("workspace copy-back failed second");
      },
    });

    const result = await runTeardown({
      sandboxAuth: subscriptionAuth({ accountId: "acct", marker: "sandbox" }),
      hostAuth: subscriptionAuth({ accountId: "acct", marker: "host" }),
    });
    expect(result.executionResult.errorMessage).toBe("provider failed first");
  });
});

describe("codex execute — run scratch dir in the workspace sandbox", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    vi.clearAllMocks();
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  async function runLocal(scratchFor: (rootDir: string) => Promise<string | null>) {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-codex-scratch-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    await mkdir(workspaceDir, { recursive: true });
    const scratch = await scratchFor(rootDir);
    await execute({
      runId: "run-scratch",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "CodexCoder",
        adapterType: "codex_local",
        adapterConfig: {},
      },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: {
        command: "codex",
        engine: "cli",
        filesystemScope: "workspace",
        env: {
          CODEX_HOME: path.join(rootDir, "codex-home"),
          ...(scratch ? { PAPERCLIP_RUN_SCRATCH_DIR: scratch } : {}),
        },
      },
      context: { paperclipWorkspace: { cwd: workspaceDir, source: "project_primary" } },
      onLog: async () => {},
    } as never);
    const calls = runChildProcess.mock.calls as unknown as Array<[string, string, string[], { localProcessSandbox?: { managedPaths?: Array<{ path: string; access: string }> } }]>;
    return { scratch, managedPaths: calls.at(-1)?.[3]?.localProcessSandbox?.managedPaths };
  }

  it("binds an existing run scratch dir read-write", async () => {
    const { scratch, managedPaths } = await runLocal(async (rootDir) => {
      const dir = path.join(rootDir, "run-scratch");
      await mkdir(dir);
      return dir;
    });
    expect(managedPaths).toContainEqual({ path: scratch, access: "rw" });
  });

  it("adds nothing when the scratch dir is unset or missing", async () => {
    const unset = await runLocal(async () => null);
    expect(unset.managedPaths).toBeDefined();
    expect(unset.managedPaths?.some((entry) => entry.path.endsWith("run-scratch"))).toBe(false);
    const missing = await runLocal(async (rootDir) => path.join(rootDir, "never-created"));
    expect(missing.managedPaths).toBeDefined();
    expect(missing.managedPaths?.some((entry) => entry.path === missing.scratch)).toBe(false);
  });
});
