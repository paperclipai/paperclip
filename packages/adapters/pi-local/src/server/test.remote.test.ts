import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";

const REMOTE_AGENT_CONFIG = "/remote/workspace/.paperclip-runtime/envtests/probe/.paperclip-runtime/pi/agentConfig";

const {
  ensureAdapterExecutionTargetDirectory,
  ensureAdapterExecutionTargetCommandResolvable,
  maybeRunSandboxInstallCommand,
  runAdapterExecutionTargetProcess,
  runAdapterExecutionTargetShellCommand,
  prepareAdapterExecutionTargetRuntime,
  restoreWorkspace,
  shipped,
} = vi.hoisted(() => {
  const restoreWorkspace = vi.fn(async () => {});
  const shipped: { modelsJson: string | null } = { modelsJson: null };
  return {
    restoreWorkspace,
    shipped,
    ensureAdapterExecutionTargetDirectory: vi.fn(async () => {}),
    ensureAdapterExecutionTargetCommandResolvable: vi.fn(async () => {}),
    maybeRunSandboxInstallCommand: vi.fn(async () => null),
    runAdapterExecutionTargetProcess: vi.fn(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: '{"type":"agent_end","success":true,"messages":[{"role":"assistant","content":[{"type":"text","text":"hello"}]}]}\n',
      stderr: "",
      pid: 123,
      startedAt: new Date().toISOString(),
    })),
    runAdapterExecutionTargetShellCommand: vi.fn(async () => ({
      exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "", pid: null, startedAt: new Date().toISOString(),
    })),
    prepareAdapterExecutionTargetRuntime: vi.fn(),
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
    runAdapterExecutionTargetShellCommand,
    prepareAdapterExecutionTargetRuntime,
  };
});

import { testEnvironment } from "./test.js";

const sandboxTarget: AdapterExecutionTarget = {
  kind: "remote",
  transport: "sandbox",
  providerKey: "kubernetes",
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

const providers = JSON.stringify({
  "ramp-router": { baseUrl: "https://api.router.com/v1", api: "openai-responses", apiKey: "$RAMP_ROUTER_API_KEY", models: [{ id: "gpt-6-luna" }] },
});

function stubPrepare() {
  prepareAdapterExecutionTargetRuntime.mockImplementation(
    async (input: { assets?: Array<{ key: string; localDir: string }> }) => {
      const asset = input.assets?.find((entry) => entry.key === "agentConfig");
      // Read what would be shipped while the managed dir still exists.
      shipped.modelsJson = asset ? await readFile(path.join(asset.localDir, "models.json"), "utf8") : null;
      return {
        target: sandboxTarget,
        workspaceRemoteDir: null,
        runtimeRootDir: "/remote/workspace/.paperclip-runtime/pi",
        assetDirs: asset ? { agentConfig: REMOTE_AGENT_CONFIG } : {},
        additionalSourceDirs: {},
        additionalSourceFailures: [],
        workspaceSyncSnapshot: null,
        restoreWorkspace,
      };
    },
  );
}

function runRemote(env: Record<string, string>) {
  return testEnvironment({
    companyId: "c",
    adapterType: "pi_local",
    config: { command: "pi", model: "ramp-router/gpt-6-luna", env },
    executionTarget: sandboxTarget,
    environmentName: "eks-proof",
  });
}

afterEach(() => {
  vi.clearAllMocks();
  prepareAdapterExecutionTargetRuntime.mockReset();
  shipped.modelsJson = null;
});

type ProbeCall = [string, AdapterExecutionTarget, string, string[], { env: Record<string, string> }];
type PrepareInput = { workspaceRemoteDir: string; syncWorkspace: boolean };

describe("pi testEnvironment on a remote target with PAPERCLIP_PI_PROVIDERS", () => {
  it("ships the managed provider config and points the hello probe at it", async () => {
    stubPrepare();
    const result = await runRemote({ PAPERCLIP_PI_PROVIDERS: providers, RAMP_ROUTER_API_KEY: "sk-fake-router" });

    expect(prepareAdapterExecutionTargetRuntime).toHaveBeenCalledTimes(1);
    expect(prepareAdapterExecutionTargetRuntime).toHaveBeenCalledWith(expect.objectContaining({
      adapterKey: "pi",
      syncWorkspace: false,
      assets: [expect.objectContaining({ key: "agentConfig" })],
    }));
    // Staged under a per-probe dir, never the shared runtime dir a live run uses.
    const { workspaceRemoteDir } = prepareAdapterExecutionTargetRuntime.mock.calls[0]![0] as PrepareInput;
    expect(workspaceRemoteDir).toMatch(/^\/remote\/workspace\/\.paperclip-runtime\/envtests\/pi-envtest-[^/]+$/);
    expect(JSON.parse(shipped.modelsJson ?? "{}").providers["ramp-router"].models).toEqual([{ id: "gpt-6-luna" }]);
    // The key stays an env reference in the shipped file; Pi resolves it from the probe env.
    expect(shipped.modelsJson).not.toContain("sk-fake-router");

    expect(runAdapterExecutionTargetProcess).toHaveBeenCalledTimes(1);
    const [, , , args, options] = runAdapterExecutionTargetProcess.mock.calls[0] as unknown as ProbeCall;
    expect(args).toEqual(expect.arrayContaining(["--provider", "ramp-router", "--model", "gpt-6-luna"]));
    expect(options.env.PI_CODING_AGENT_DIR).toBe(REMOTE_AGENT_CONFIG);
    expect(options.env.RAMP_ROUTER_API_KEY).toBe("sk-fake-router");
    expect(restoreWorkspace).toHaveBeenCalledTimes(1);
    // The per-probe dir (and the shipped config in it) is removed from the target.
    expect(runAdapterExecutionTargetShellCommand).toHaveBeenCalledWith(
      expect.any(String),
      sandboxTarget,
      `rm -rf '${workspaceRemoteDir}'`,
      expect.anything(),
    );
    expect(result.checks.map((check) => check.code)).toContain("pi_hello_probe_passed");
  });

  it("does not stage anything for a remote target without custom providers", async () => {
    stubPrepare();
    const result = await runRemote({});

    expect(prepareAdapterExecutionTargetRuntime).not.toHaveBeenCalled();
    expect(runAdapterExecutionTargetShellCommand).not.toHaveBeenCalled();
    expect(runAdapterExecutionTargetProcess).toHaveBeenCalledTimes(1);
    const [, , , , options] = runAdapterExecutionTargetProcess.mock.calls[0] as unknown as ProbeCall;
    expect(options.env.PI_CODING_AGENT_DIR).toBeUndefined();
    expect(result.checks.map((check) => check.code)).toContain("pi_hello_probe_passed");
  });

  it("fails the test and skips the probe when the config cannot be shipped", async () => {
    prepareAdapterExecutionTargetRuntime.mockRejectedValue(new Error("upload failed"));
    const result = await runRemote({ PAPERCLIP_PI_PROVIDERS: providers, RAMP_ROUTER_API_KEY: "sk-fake-router" });

    expect(result.status).toBe("fail");
    expect(result.checks.find((check) => check.code === "pi_provider_config_failed")?.message).toContain("upload failed");
    expect(runAdapterExecutionTargetProcess).not.toHaveBeenCalled();
    // The host-local config path must not leak into later remote calls.
    expect(JSON.stringify(ensureAdapterExecutionTargetCommandResolvable.mock.calls)).not.toContain("paperclip-pi-agent-config-");
  });
});
