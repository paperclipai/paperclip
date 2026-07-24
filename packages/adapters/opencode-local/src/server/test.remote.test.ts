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
        JSON.stringify({ type: "step_start", sessionID: "session-1" }),
        JSON.stringify({ type: "text", sessionID: "session-1", part: { text: "hello" } }),
        JSON.stringify({
          type: "step_finish",
          sessionID: "session-1",
          part: { cost: 0.001, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } },
        }),
      ].join("\n"),
      stderr: "",
      pid: 123,
      startedAt: new Date().toISOString(),
    })),
    describeAdapterExecutionTarget: vi.fn(() => "QA Cloudflare"),
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
      runtimeRootDir: "/remote/workspace/.paperclip-runtime/runs/test/workspace/.paperclip-runtime/opencode",
      assetDirs: {
        xdgConfig: "/remote/workspace/.paperclip-runtime/runs/test/workspace/.paperclip-runtime/opencode/xdgConfig",
      },
      restoreWorkspace,
    })),
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

import { testEnvironment } from "./test.js";

describe("opencode remote environment diagnostics", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("stages remote runtime config assets for sandbox hello probes", async () => {
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
      adapterType: "opencode_local",
      config: {
        command: "opencode",
        model: "anthropic/claude-sonnet-4-5",
      },
      executionTarget: remoteTarget,
      environmentName: "QA Cloudflare",
    });

    expect(result.status).toBe("pass");
    expect(prepareAdapterExecutionTargetRuntime).toHaveBeenCalledTimes(1);
    const runtimeCalls = prepareAdapterExecutionTargetRuntime.mock.calls as unknown as Array<
      [{ adapterKey: string; assets?: Array<{ key: string; localDir: string }> }]
    >;
    const runtimeInput = runtimeCalls[0]?.[0];
    expect(runtimeInput?.adapterKey).toBe("opencode");
    expect(runtimeInput?.assets).toEqual([
      expect.objectContaining({
        key: "xdgConfig",
      }),
    ]);

    const probeCall = runAdapterExecutionTargetProcess.mock.calls[0] as unknown as
      | [string, AdapterExecutionTarget, string, string[], { cwd: string; env: Record<string, string> }]
      | undefined;
    expect(probeCall?.[4].cwd).toBe("/remote/workspace/.paperclip-runtime/runs/test/workspace");
    expect(probeCall?.[4].env.XDG_CONFIG_HOME).toBe(
      "/remote/workspace/.paperclip-runtime/runs/test/workspace/.paperclip-runtime/opencode/xdgConfig",
    );
  });
});
