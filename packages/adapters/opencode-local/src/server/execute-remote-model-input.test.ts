import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Keep runtime preparation and model discovery real. Stub only the remote
// process/workspace boundary so this test cannot contact a machine or model.
vi.mock("@paperclipai/adapter-utils/execution-target", async importOriginal => {
  const actual = await importOriginal<object>();
  return {
    ...actual,
    readAdapterExecutionTarget: vi.fn(({ executionTarget }) => executionTarget),
    ensureAdapterExecutionTargetRuntimeCommandInstalled: vi.fn(),
    ensureAdapterExecutionTargetCommandResolvable: vi.fn(),
    resolveAdapterExecutionTargetCommandForLogs: vi.fn().mockResolvedValue("opencode"),
    adapterExecutionTargetUsesManagedHome: vi.fn().mockReturnValue(true),
    adapterExecutionTargetUsesPaperclipBridge: vi.fn().mockReturnValue(false),
    prepareAdapterExecutionTargetRuntime: vi.fn().mockResolvedValue({
      workspaceRemoteDir: "/remote/work", runtimeRootDir: "/remote/runtime", assetDirs: {},
      restoreWorkspace: async () => {},
    }),
    runAdapterExecutionTargetProcess: vi.fn(),
  };
});

import { execute } from "./execute.js";
import { runAdapterExecutionTargetProcess, type AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";

afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe("remote OpenCode model input isolation", () => {
  it.each(["ssh", "sandbox"] as const)("ignores host modalities for permission-checked %s execution", async transport => {
    const hostHome = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-remote-host-"));
    const workspace = path.join(hostHome, "workspace");
    await fs.mkdir(workspace);
    await fs.mkdir(path.join(hostHome, "opencode"));
    await fs.writeFile(path.join(hostHome, "opencode", "opencode.json"), JSON.stringify({
      provider: { paperclip: { models: { alias: { modalities: { input: ["text"], output: ["text"] } } } } },
    }));
    vi.stubEnv("XDG_CONFIG_HOME", hostHome);
    const readFile = vi.spyOn(fs, "readFile");
    const target = { kind: "remote", transport, remoteCwd: "/remote/work", spec: { host: "unused.invalid" } } as AdapterExecutionTarget;
    const run = vi.mocked(runAdapterExecutionTargetProcess);
    let discoveryModalities: unknown;
    run.mockImplementation(async (_id, _target, command, args, options) => {
      if (command === "curl") discoveryModalities = JSON.parse(options.env.OPENCODE_CONFIG_CONTENT).provider.paperclip.models.alias.modalities;
      return {
        exitCode: 0, signal: null, timedOut: false, pid: null,
        startedAt: new Date().toISOString(), stderr: "",
        stdout: command === "curl"
          ? JSON.stringify({ data: [{ id: "alias", capabilities: { vision: true } }] }) + "\n200"
          : args[0] === "models" ? "paperclip/alias\n"
            : JSON.stringify({ type: "text", part: { text: "done" } }),
      };
    });
    try {
      const result = await execute({
        runId: "remote-model-input",
        agent: { id: "agent", companyId: "company", name: "OpenCode", adapterType: "opencode_local", adapterConfig: {} },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        executionTarget: target,
        config: {
          command: "opencode", cwd: workspace, model: "paperclip/alias", managedAiConnection: true,
          dangerouslySkipPermissions: false, paperclipSkillMode: "disabled",
          env: {
            XDG_CONFIG_HOME: hostHome, PAPERCLIP_AI_PROVIDER_URL: "http://localhost:9999/v1",
            OPENCODE_CONFIG_CONTENT: JSON.stringify({ provider: { paperclip: { models: { alias: { name: "alias" } } } } }),
          },
        },
        context: {}, onLog: async () => {},
      });
      expect(result.exitCode).toBe(0);
      expect(readFile.mock.calls.map(([file]) => String(file))).not.toContain(path.join(hostHome, "opencode", "opencode.json"));
      const discovery = run.mock.calls.find(([, , command]) => command === "curl");
      expect(discovery).toBeDefined();
      expect(discovery![1]).toMatchObject({ kind: "remote", transport });
      expect(discoveryModalities).toBeUndefined();
      const invocation = run.mock.calls.find(([, , , args]) => args[0] === "run");
      expect(invocation).toBeDefined();
      expect(invocation![4].env.XDG_CONFIG_HOME).not.toBe(hostHome);
      const config = JSON.parse(invocation![4].env.OPENCODE_CONFIG_CONTENT);
      expect(config.provider.paperclip.models.alias.modalities.input).toEqual(["text", "image"]);
      expect(config.permission).toBeUndefined();
    } finally {
      readFile.mockRestore();
      await fs.rm(hostHome, { recursive: true, force: true });
    }
  });
});
