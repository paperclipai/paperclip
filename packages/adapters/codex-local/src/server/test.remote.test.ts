import fs from "node:fs/promises";
import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";

const {
  ensureAdapterExecutionTargetDirectory,
  ensureAdapterExecutionTargetCommandResolvable,
  maybeRunSandboxInstallCommand,
  runAdapterExecutionTargetProcess,
  describeAdapterExecutionTarget,
  resolveAdapterExecutionTargetCwd,
  prepareAdapterExecutionTargetRuntime,
  prepareManagedCodexHome,
  restoreWorkspace,
} = vi.hoisted(() => {
  const restoreWorkspace = vi.fn(async () => {});
  return {
    ensureAdapterExecutionTargetDirectory: vi.fn(async () => {}),
    ensureAdapterExecutionTargetCommandResolvable: vi.fn(async () => {}),
    maybeRunSandboxInstallCommand: vi.fn(async () => null),
    runAdapterExecutionTargetProcess: vi.fn(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: [
        "{\"type\":\"thread.started\",\"thread_id\":\"thread-1\"}",
        "{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"hello\"}}",
        "{\"type\":\"turn.completed\",\"usage\":{\"input_tokens\":1,\"cached_input_tokens\":0,\"output_tokens\":1}}",
      ].join("\n"),
      stderr: "",
      pid: 123,
      startedAt: new Date().toISOString(),
    })),
    describeAdapterExecutionTarget: vi.fn(() => "QA SSH"),
    resolveAdapterExecutionTargetCwd: vi.fn((target, configuredCwd, fallbackCwd) => {
      if (typeof configuredCwd === "string" && configuredCwd.trim().length > 0) return configuredCwd;
      if (target && typeof target === "object" && "remoteCwd" in target && typeof target.remoteCwd === "string") {
        return target.remoteCwd;
      }
      return fallbackCwd;
    }),
    prepareAdapterExecutionTargetRuntime: vi.fn(async () => ({
      target: null,
      workspaceRemoteDir: "/remote/workspace/.paperclip-runtime/runs/test/workspace",
      runtimeRootDir: "/remote/workspace/.paperclip-runtime/runs/test/workspace/.paperclip-runtime/codex",
      assetDirs: {
        home: "/remote/workspace/.paperclip-runtime/runs/test/workspace/.paperclip-runtime/codex/home",
      },
      restoreWorkspace,
    })),
    prepareManagedCodexHome: vi.fn(async () => "/tmp/paperclip-managed-codex-home"),
    restoreWorkspace,
  };
});

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    ensureAdapterExecutionTargetDirectory,
    ensureAdapterExecutionTargetCommandResolvable,
    maybeRunSandboxInstallCommand,
    runAdapterExecutionTargetProcess,
    describeAdapterExecutionTarget,
    resolveAdapterExecutionTargetCwd,
    prepareAdapterExecutionTargetRuntime,
  };
});

vi.mock("./codex-home.js", async () => {
  const actual = await vi.importActual<typeof import("./codex-home.js")>("./codex-home.js");
  return {
    ...actual,
    prepareManagedCodexHome,
  };
});

import { testEnvironment } from "./test.js";

describe("codex remote environment diagnostics", () => {
  afterEach(() => {
    vi.clearAllMocks();
    delete process.env.OPENAI_API_KEY;
  });

  it("stages managed CODEX_HOME in an isolated runtime dir and keeps the probe cwd on the original remote workspace", async () => {
    const remoteTarget: AdapterExecutionTarget = {
      kind: "remote",
      transport: "ssh",
      remoteCwd: "/remote/workspace",
      spec: {
        host: "127.0.0.1",
        port: 22,
        username: "agent",
        privateKey: "PRIVATE KEY",
        knownHosts: "KNOWN HOSTS",
        remoteCwd: "/remote/workspace",
        remoteWorkspacePath: "/remote/workspace",
        strictHostKeyChecking: false,
      },
    };

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "codex_local",
      config: {
        command: "codex",
      },
      executionTarget: remoteTarget,
      environmentName: "QA SSH",
    });

    expect(result.status).toBe("pass");
    expect(result.checks.some((check) => check.code === "codex_hello_probe_passed")).toBe(true);
    expect(prepareManagedCodexHome).toHaveBeenCalledTimes(1);
    expect(prepareAdapterExecutionTargetRuntime).toHaveBeenCalledTimes(1);
    const runtimeCalls = prepareAdapterExecutionTargetRuntime.mock.calls as unknown as Array<[
      {
        workspaceLocalDir: string;
        target?: { remoteCwd?: string };
        workspaceRemoteDir?: string;
      },
    ]>;
    const runtimeInput = runtimeCalls[0]?.[0];
    expect(runtimeInput?.workspaceLocalDir).toContain(`${os.tmpdir()}/paperclip-codex-envtest-`);
    expect(runtimeInput?.workspaceLocalDir).not.toBe("/remote/workspace");
    expect(await fs.stat(runtimeInput!.workspaceLocalDir).catch(() => null)).toBeNull();
    expect(runtimeInput?.target?.remoteCwd).toBe("/remote/workspace");
    // `workspaceRemoteDir` is the base path passed to the runtime; the
    // helper's per-run subdirectory is appended internally inside
    // `prepareRemoteManagedRuntime`. Pre-building a per-run prefix here
    // would double-nest the run id in the final path.
    expect(runtimeInput?.workspaceRemoteDir).toBe("/remote/workspace");
    expect(runAdapterExecutionTargetProcess).toHaveBeenCalledTimes(1);
    const probeCall = runAdapterExecutionTargetProcess.mock.calls[0] as unknown as
      | [string, { kind: string; remoteCwd: string }, string, string[], { cwd: string; env: Record<string, string> }]
      | undefined;
    expect(probeCall?.[1]).toMatchObject({
      kind: "remote",
      remoteCwd: "/remote/workspace",
    });
    expect(probeCall?.[4]).toMatchObject({
      cwd: "/remote/workspace",
      env: expect.objectContaining({
        CODEX_HOME: "/remote/workspace/.paperclip-runtime/runs/test/workspace/.paperclip-runtime/codex/home",
      }),
    });
    expect(restoreWorkspace).toHaveBeenCalledTimes(1);
  });

  it("avoids /tmp CODEX_HOME for remote API-key hello probes", async () => {
    const remoteTarget: AdapterExecutionTarget = {
      kind: "remote",
      transport: "sandbox",
      providerKey: "cloudflare",
      remoteCwd: "/remote/workspace",
      runner: {
        execute: async () => ({
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdout: "",
          stderr: "",
          pid: null,
          startedAt: new Date().toISOString(),
        }),
      },
    };

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "codex_local",
      config: {
        command: "codex",
        env: {
          OPENAI_API_KEY: "sk-test",
        },
      },
      executionTarget: remoteTarget,
      environmentName: "QA Cloudflare",
    });

    expect(result.status).toBe("pass");
    const probeCall = runAdapterExecutionTargetProcess.mock.calls[0] as unknown as
      | [string, AdapterExecutionTarget, string, string[], { cwd: string; env: Record<string, string> }]
      | undefined;
    expect(probeCall?.[4].env.CODEX_HOME).toContain("/remote/workspace/.paperclip-runtime/codex/probe-home-codex-envtest-");
    expect(probeCall?.[4].env.CODEX_HOME?.startsWith("/tmp/")).toBe(false);
    expect(probeCall?.[3]).toContain("--skip-git-repo-check");
  });
});
