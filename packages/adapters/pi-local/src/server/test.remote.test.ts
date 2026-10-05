import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterSshExecutionTarget } from "@paperclipai/adapter-utils/execution-target";

const mocks = vi.hoisted(() => ({
  prepareAdapterExecutionTargetRuntime: vi.fn(),
  runAdapterExecutionTargetProcess: vi.fn(),
  ensureAdapterExecutionTargetDirectory: vi.fn(async () => {}),
  ensureAdapterExecutionTargetCommandResolvable: vi.fn(async () => {}),
  maybeRunSandboxInstallCommand: vi.fn(async () => null),
}));

vi.mock("@paperclipai/adapter-utils/execution-target", async () => ({
  ...await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  ),
  ...mocks,
}));

import { testEnvironment } from "./test.js";

const target: AdapterSshExecutionTarget = {
  kind: "remote",
  transport: "ssh",
  remoteCwd: "/remote/workspace",
  spec: {
    host: "fixture.example.test",
    port: 22,
    username: "fixture",
    remoteCwd: "/remote/workspace",
    remoteWorkspacePath: "/remote/workspace",
    privateKey: null,
    knownHosts: null,
    strictHostKeyChecking: true,
  },
};

const providers = { gateway: { apiKey: "not-needed", models: [{ id: "test-model" }] } };

describe("pi remote environment provider configuration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.runAdapterExecutionTargetProcess.mockResolvedValue({
      exitCode: 0,
      timedOut: false,
      stdout: JSON.stringify({
        type: "turn_end",
        message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
        toolResults: [],
      }),
      stderr: "",
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("ships the materialized provider config and uses the remote asset path", async () => {
    let localConfigDir = "";
    let localWorkspaceDir = "";
    const restoreWorkspace = vi.fn(async () => {
      await expect(fs.access(localConfigDir)).resolves.toBeUndefined();
    });
    mocks.prepareAdapterExecutionTargetRuntime.mockImplementation(async (input) => {
      localWorkspaceDir = input.workspaceLocalDir;
      localConfigDir = input.assets[0].localDir;
      expect(input.assets[0].key).toBe("agentConfig");
      expect(input.syncWorkspace).toBe(false);
      expect(JSON.parse(await fs.readFile(`${localConfigDir}/models.json`, "utf8"))).toEqual({ providers });
      return {
        workspaceRemoteDir: "/remote/probe-workspace",
        assetDirs: { agentConfig: "/remote/runtime/agent-config" },
        restoreWorkspace,
      };
    });
    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "pi_local",
      executionTarget: target,
      config: { model: "gateway/test-model", env: { PAPERCLIP_PI_PROVIDERS: JSON.stringify(providers) } },
    });

    expect(result.status).toBe("pass");
    expect(mocks.runAdapterExecutionTargetProcess).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ remoteCwd: "/remote/probe-workspace" }),
      "pi",
      expect.arrayContaining(["--provider", "gateway", "--model", "test-model"]),
      expect.objectContaining({
        cwd: "/remote/probe-workspace",
        env: expect.objectContaining({ PI_CODING_AGENT_DIR: "/remote/runtime/agent-config" }),
      }),
    );
    expect(restoreWorkspace).toHaveBeenCalledOnce();
    await expect(fs.access(localConfigDir)).rejects.toThrow();
    await expect(fs.access(localWorkspaceDir)).rejects.toThrow();
  });

  it("removes both temporary directories when remote preparation fails", async () => {
    let localConfigDir = "";
    let localWorkspaceDir = "";
    mocks.prepareAdapterExecutionTargetRuntime.mockImplementation(async (input) => {
      localWorkspaceDir = input.workspaceLocalDir;
      localConfigDir = input.assets[0].localDir;
      throw new Error("fake transport failure");
    });
    await expect(testEnvironment({
      companyId: "company-1",
      adapterType: "pi_local",
      executionTarget: target,
      config: { model: "gateway/test-model", env: { PAPERCLIP_PI_PROVIDERS: JSON.stringify(providers) } },
    })).rejects.toThrow("fake transport failure");
    expect(mocks.runAdapterExecutionTargetProcess).not.toHaveBeenCalled();
    await expect(fs.access(localConfigDir)).rejects.toThrow();
    await expect(fs.access(localWorkspaceDir)).rejects.toThrow();
  });
});
