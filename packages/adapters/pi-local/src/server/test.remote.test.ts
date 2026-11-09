import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PreparedAdapterExecutionTargetRuntime } from "@paperclipai/adapter-utils/execution-target";

const {
  prepareAdapterExecutionTargetRuntime,
  ensureAdapterExecutionTargetDirectory,
  ensureAdapterExecutionTargetCommandResolvable,
  maybeRunSandboxInstallCommand,
  runAdapterExecutionTargetProcess,
  runAdapterExecutionTargetShellCommand,
  describeAdapterExecutionTarget,
  resolveAdapterExecutionTargetCwd,
  runtimeAssetDir,
  stagedModelsSnapshots,
} = vi.hoisted(() => {
  const restoreWorkspace = vi.fn(async () => undefined);
  const remoteAgentConfigBase = "/remote/workspace/.paperclip-runtime/pi";
  // Snapshot the staged models.json content at staging time: the real
  // preparePiRuntimeConfig temp dir is deleted by cleanup before assertions
  // run, so capture the bytes when the "upload" happens. The destination is
  // per-run (agentConfig-<runId>), mirroring the production isolation fix.
  const stagedModelsSnapshots: { key: string; models: unknown }[] = [];
  const preparedAssetDirs: Record<string, string> = {};
  const prepare = vi.fn(async (input: { assets?: { key: string; localDir: string }[] }) => {
    for (const asset of input.assets ?? []) {
      if (!asset.key.startsWith("agentConfig")) continue;
      preparedAssetDirs[asset.key] = `${remoteAgentConfigBase}/${asset.key}`;
      stagedModelsSnapshots.push({
        key: asset.key,
        models: JSON.parse(readFileSync(path.join(asset.localDir, "models.json"), "utf8")),
      });
    }
    const prepared: PreparedAdapterExecutionTargetRuntime = {
      target: { kind: "local" },
      workspaceRemoteDir: null,
      runtimeRootDir: null,
      assetDirs: preparedAssetDirs,
      additionalSourceDirs: {},
      additionalSourceFailures: [],
      workspaceSyncSnapshot: null,
      restoreWorkspace,
    };
    return prepared;
  });
  return {
    prepareAdapterExecutionTargetRuntime: prepare,
    ensureAdapterExecutionTargetDirectory: vi.fn(async () => undefined),
    ensureAdapterExecutionTargetCommandResolvable: vi.fn(async () => undefined),
    maybeRunSandboxInstallCommand: vi.fn(async () => null),
    runAdapterExecutionTargetProcess: vi.fn(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: JSON.stringify({
        type: "turn_end",
        message: { role: "assistant", content: "hello from the sandbox" },
      }),
      stderr: "",
    })),
    runAdapterExecutionTargetShellCommand: vi.fn(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "",
    })),
    describeAdapterExecutionTarget: vi.fn(() => "env:fixture"),
    resolveAdapterExecutionTargetCwd: vi.fn(
      (_target: unknown, _configCwd: string, _fallback: string) => "/remote/workspace",
    ),
    runtimeAssetDir: vi.fn(
      (
        prepared: Pick<PreparedAdapterExecutionTargetRuntime, "assetDirs">,
        key: string,
        fallbackRemoteCwd: string,
      ) => prepared.assetDirs[key] ?? path.posix.join(fallbackRemoteCwd, ".paperclip-runtime", key),
    ),
    stagedModelsSnapshots,
  };
});

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    prepareAdapterExecutionTargetRuntime,
    ensureAdapterExecutionTargetDirectory,
    ensureAdapterExecutionTargetCommandResolvable,
    maybeRunSandboxInstallCommand,
    runAdapterExecutionTargetProcess,
    runAdapterExecutionTargetShellCommand,
    describeAdapterExecutionTarget,
    resolveAdapterExecutionTargetCwd,
    runtimeAssetDir,
  };
});

vi.mock("./models.js", async () => {
  const actual = await vi.importActual<typeof import("./models.js")>("./models.js");
  return {
    ...actual,
    discoverPiModelsCached: vi.fn(async () => []),
  };
});

import { testEnvironment } from "./test.js";
import type { AdapterSshExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import type { AdapterEnvironmentTestContext } from "@paperclipai/adapter-utils";

const remoteTarget: AdapterSshExecutionTarget = {
  kind: "remote",
  transport: "ssh",
  environmentId: null,
  leaseId: null,
  remoteCwd: "/remote/workspace",
  spec: {
    host: "127.0.0.1",
    port: 2222,
    username: "fixture",
    remoteWorkspacePath: "/remote/workspace",
    remoteCwd: "/remote/workspace",
    privateKey: "PRIVATE KEY",
    knownHosts: "[127.0.0.1]:2222 ssh-ed25519 AAAA",
    strictHostKeyChecking: true,
  },
};

function buildCtx(config: Record<string, unknown>): AdapterEnvironmentTestContext {
  return {
    companyId: "company-1",
    adapterType: "pi_local",
    config,
    executionTarget: remoteTarget,
    environmentName: "fixture-env",
  };
}

const PROVIDERS = {
  tensorix: {
    baseUrl: "http://gateway.example.svc.cluster.local:8080/anthropic",
    apiKey: "{env:ANTHROPIC_API_KEY}",
    api: "anthropic-messages",
    models: [{ id: "deepseek/deepseek-chat-v3.1", name: "DeepSeek v3.1" }],
  },
};

describe("pi environment test (remote target)", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("ships the managed agent config to the target and repoints PI_CODING_AGENT_DIR when PAPERCLIP_PI_PROVIDERS is set", async () => {
    const result = await testEnvironment(
      buildCtx({
        command: "pi",
        model: "tensorix/deepseek/deepseek-chat-v3.1",
        env: {
          PAPERCLIP_PI_PROVIDERS: JSON.stringify(PROVIDERS),
          ANTHROPIC_API_KEY: "sk-bf-REALVK",
        },
      }),
    );

    // The managed dir (built by preparePiRuntimeConfig) is staged as the
    // agentConfig asset, not the local tmp path left in the env.
    expect(prepareAdapterExecutionTargetRuntime).toHaveBeenCalledTimes(1);
    const prepareInput = prepareAdapterExecutionTargetRuntime.mock.calls[0]?.[0] as
      | {
          syncWorkspace?: boolean;
          assets?: { key: string; localDir: string }[];
        }
      | undefined;
    expect(prepareInput?.syncWorkspace).toBe(false);
    const agentConfigAsset = prepareInput?.assets?.find((asset) => asset.key.startsWith("agentConfig-"));
    expect(agentConfigAsset?.localDir).toBeTruthy();
    const staged = stagedModelsSnapshots[0];
    expect(staged?.key).toBe(agentConfigAsset?.key);
    const stagedModels = staged?.models as
      | { providers?: Record<string, { baseUrl?: string }> }
      | undefined;
    expect(stagedModels?.providers?.tensorix?.baseUrl).toBe(
      "http://gateway.example.svc.cluster.local:8080/anthropic",
    );

    // The probe env is repointed at the in-sandbox copy of the config, in a
    // per-run directory (concurrent checks must not share a destination).
    const probeCall = runAdapterExecutionTargetProcess.mock.calls[0] as unknown as
      | [string, unknown, string, string[], { env: Record<string, string> }]
      | undefined;
    expect(probeCall?.[4].env.PI_CODING_AGENT_DIR).toBe(
      `/remote/workspace/.paperclip-runtime/pi/${agentConfigAsset!.key}`,
    );
    expect(probeCall?.[4].env.PAPERCLIP_PI_PROVIDERS).toBeTruthy();

    // The hello probe runs in the sandbox and passes with the shipped config.
    expect(runAdapterExecutionTargetProcess).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("pass");
    expect(result.checks.some((check) => check.code === "pi_hello_probe_passed")).toBe(true);

    // The per-run remote agent config directory is removed after the probe
    // (restoreWorkspace is a no-op with syncWorkspace:false), so repeated
    // checks do not accumulate abandoned settings dirs on the remote host.
    const cleanupCall = runAdapterExecutionTargetShellCommand.mock.calls[0] as unknown as
      | [string, unknown, string, { cwd: string; env: Record<string, string>; timeoutSec?: number }]
      | undefined;
    expect(cleanupCall?.[2]).toBe(
      `rm -rf -- '/remote/workspace/.paperclip-runtime/pi/${agentConfigAsset!.key}'`,
    );
  });

  it("does not stage a runtime when PAPERCLIP_PI_PROVIDERS is unset", async () => {
    const prior = process.env.PI_CODING_AGENT_DIR;
    delete process.env.PI_CODING_AGENT_DIR;
    try {
      const result = await testEnvironment(
        buildCtx({
          command: "pi",
          model: "openai/gpt-5.4-mini",
        }),
      );

      expect(prepareAdapterExecutionTargetRuntime).not.toHaveBeenCalled();
      expect(runAdapterExecutionTargetShellCommand).not.toHaveBeenCalled();
      const probeCall = runAdapterExecutionTargetProcess.mock.calls[0] as unknown as
        | [string, unknown, string, string[], { env: Record<string, string> }]
        | undefined;
      expect(probeCall?.[4].env.PI_CODING_AGENT_DIR).toBeUndefined();
      expect(result.status).toBe("pass");
    } finally {
      if (prior !== undefined) process.env.PI_CODING_AGENT_DIR = prior;
    }
  });
});
