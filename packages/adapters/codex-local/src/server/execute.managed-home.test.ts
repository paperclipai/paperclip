import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const {
  runChildProcess,
  ensureCommandResolvable,
  resolveCommandForLogs,
  prepareManagedCodexHome,
  seedManagedCodexHome,
} = vi.hoisted(() => ({
  runChildProcess: vi.fn(async () => ({
    exitCode: 1,
    signal: null,
    timedOut: false,
    stdout: "",
    stderr: "fixture",
    pid: 123,
    startedAt: new Date().toISOString(),
  })),
  ensureCommandResolvable: vi.fn<typeof import("@paperclipai/adapter-utils/server-utils").ensureCommandResolvable>(
    async () => undefined,
  ),
  resolveCommandForLogs: vi.fn(async () => "/usr/bin/codex"),
  prepareManagedCodexHome: vi.fn(async (_env, _onLog, _companyId, options?: { targetHome?: string | null }) =>
    options?.targetHome ?? "/tmp/paperclip-managed-codex-home"
  ),
  seedManagedCodexHome: vi.fn(async (targetHome: string) => {
    const fs = await import("node:fs/promises");
    const nodePath = await import("node:path");
    await fs.mkdir(targetHome, { recursive: true });
    await fs.writeFile(nodePath.join(targetHome, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "sk-test" }), "utf8");
  }),
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

vi.mock("./codex-home.js", async () => {
  const actual = await vi.importActual<typeof import("./codex-home.js")>("./codex-home.js");
  return {
    ...actual,
    prepareManagedCodexHome,
    seedManagedCodexHome,
  };
});

import { execute } from "./execute.js";

describe("codex managed CODEX_HOME execution", () => {
  const cleanupDirs: string[] = [];
  const originalPaperclipHome = process.env.PAPERCLIP_HOME;
  const originalPaperclipInstanceId = process.env.PAPERCLIP_INSTANCE_ID;

  afterEach(async () => {
    vi.clearAllMocks();
    if (originalPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = originalPaperclipHome;
    if (originalPaperclipInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
    else process.env.PAPERCLIP_INSTANCE_ID = originalPaperclipInstanceId;
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("seeds Paperclip-managed per-agent CODEX_HOME instead of treating it as a user override", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-codex-agent-home-"));
    cleanupDirs.push(rootDir);
    const paperclipHome = path.join(rootDir, "paperclip-home");
    const workspaceDir = path.join(rootDir, "workspace");
    const agentCodexHome = path.join(
      paperclipHome,
      "instances",
      "default",
      "companies",
      "company-1",
      "agents",
      "agent-1",
      "codex-home",
    );
    await mkdir(workspaceDir, { recursive: true });
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = "default";

    await execute({
      runId: "run-agent-home",
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
        engine: "cli",
        command: "codex",
        env: {
          CODEX_HOME: agentCodexHome,
          OPENAI_API_KEY: "",
        },
      },
      context: {
        paperclipWorkspace: {
          cwd: workspaceDir,
          source: "project_primary",
        },
      },
      onLog: async () => {},
    });

    expect(prepareManagedCodexHome).not.toHaveBeenCalled();
    expect(seedManagedCodexHome).toHaveBeenCalledTimes(1);
    expect(seedManagedCodexHome).toHaveBeenCalledWith(
      agentCodexHome,
      expect.anything(),
      expect.any(Function),
      {
        apiKey: null,
      },
    );
    expect(runChildProcess).toHaveBeenCalledTimes(1);
    const call = runChildProcess.mock.calls[0] as unknown as
      | [string, string, string[], { env: Record<string, string> }]
      | undefined;
    expect(call?.[3].env.CODEX_HOME).toBe(agentCodexHome);
  });

  it("merges custom providers into a Paperclip-managed per-agent CODEX_HOME for the launched run", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-codex-agent-home-providers-"));
    cleanupDirs.push(rootDir);
    const paperclipHome = path.join(rootDir, "paperclip-home");
    const workspaceDir = path.join(rootDir, "workspace");
    const agentCodexHome = path.join(
      paperclipHome,
      "instances",
      "default",
      "companies",
      "company-1",
      "agents",
      "agent-1",
      "codex-home",
    );
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(agentCodexHome, { recursive: true });
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = "default";
    let configTomlDuringRun: string | null = null;
    (runChildProcess as unknown as {
      mockImplementationOnce: (fn: () => Promise<unknown>) => void;
    }).mockImplementationOnce(async () => {
      configTomlDuringRun = await readFile(path.join(agentCodexHome, "config.toml"), "utf8").catch(() => null);
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: "fixture",
        pid: 123,
        startedAt: new Date().toISOString(),
      };
    });

    await execute({
      runId: "run-agent-home-providers",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "CodexCoder",
        adapterType: "codex_local",
        adapterConfig: {},
      },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: {
        engine: "cli",
        command: "codex",
        env: {
          CODEX_HOME: agentCodexHome,
          OPENAI_API_KEY: "",
          PAPERCLIP_CODEX_PROVIDERS: JSON.stringify({
            providers: {
              bifrost: {
                name: "bifrost",
                base_url: "http://gateway.example.test/v1",
                env_key: "OPENAI_API_KEY",
                wire_api: "responses",
              },
            },
            model_provider: "bifrost",
          }),
        },
      },
      context: { paperclipWorkspace: { cwd: workspaceDir, source: "project_primary" } },
      onLog: async () => {},
    });

    // Without the managed-home check the provider merge skips this home and
    // the launched Codex sees no custom provider routing.
    expect(configTomlDuringRun).toContain('model_provider = "bifrost"');
    expect(configTomlDuringRun).toContain("[model_providers.bifrost]");
    expect(configTomlDuringRun).toContain('base_url = "http://gateway.example.test/v1"');
    const call = runChildProcess.mock.calls.at(-1) as unknown as
      | [string, string, string[], { env: Record<string, string> }]
      | undefined;
    expect(call?.[3].env.CODEX_HOME).toBe(agentCodexHome);
  });

  it("isolates a provider-less run from a concurrent run's custom providers in a shared CODEX_HOME", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-codex-shared-home-iso-"));
    cleanupDirs.push(rootDir);
    const paperclipHome = path.join(rootDir, "paperclip-home");
    const workspaceDir = path.join(rootDir, "workspace");
    const sharedAgentHome = path.join(
      paperclipHome,
      "instances",
      "default",
      "companies",
      "company-1",
      "agents",
      "agent-1",
      "codex-home",
    );
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(sharedAgentHome, { recursive: true });
    await writeFile(path.join(sharedAgentHome, "config.toml"), 'model = "original"\n', "utf8");
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = "default";

    let releaseProviderRun!: () => void;
    const providerRunStarted = new Promise<void>((resolve) => {
      (runChildProcess as unknown as {
        mockImplementationOnce: (
          fn: (_id: string, _cmd: string, _args: string[], opts: { env: Record<string, string> }) => Promise<unknown>,
        ) => void;
      }).mockImplementationOnce(async (_id, _cmd, _args, opts) => {
        resolve();
        await new Promise<void>((done) => {
          releaseProviderRun = done;
        });
        const configAfterOverlap = await readFile(path.join(opts.env.CODEX_HOME, "config.toml"), "utf8");
        expect(configAfterOverlap).toContain('base_url = "http://attacker.example.test/v1"');
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdout: "",
          stderr: "",
          pid: 101,
          startedAt: new Date().toISOString(),
        };
      });
    });

    const providerRunPromise = execute({
      runId: "run-provider",
      agent: { id: "agent-1", companyId: "company-1", name: "CodexCoder", adapterType: "codex_local", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: {
        engine: "cli",
        command: "codex",
        env: {
          CODEX_HOME: sharedAgentHome,
          OPENAI_API_KEY: "",
          PAPERCLIP_CODEX_PROVIDERS: JSON.stringify({
            providers: {
              attacker: {
                name: "attacker",
                base_url: "http://attacker.example.test/v1",
                env_key: "OPENAI_API_KEY",
                wire_api: "responses",
              },
            },
            model_provider: "attacker",
          }),
        },
      },
      context: { paperclipWorkspace: { cwd: workspaceDir, source: "project_primary" } },
      onLog: async () => {},
    });

    await providerRunStarted;

    let providerLessCodexHome = "";
    let providerLessConfig = "";
    (runChildProcess as unknown as {
      mockImplementationOnce: (
        fn: (_id: string, _cmd: string, _args: string[], opts: { env: Record<string, string> }) => Promise<unknown>,
      ) => void;
    }).mockImplementationOnce(async (_id, _cmd, _args, opts) => {
      providerLessCodexHome = opts.env.CODEX_HOME;
      providerLessConfig = await readFile(path.join(providerLessCodexHome, "config.toml"), "utf8");
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: "",
        pid: 102,
        startedAt: new Date().toISOString(),
      };
    });

    await execute({
      runId: "run-provider-less",
      agent: { id: "agent-1", companyId: "company-1", name: "CodexCoder", adapterType: "codex_local", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: {
        engine: "cli",
        command: "codex",
        env: {
          CODEX_HOME: sharedAgentHome,
          OPENAI_API_KEY: "",
        },
      },
      context: { paperclipWorkspace: { cwd: workspaceDir, source: "project_primary" } },
      onLog: async () => {},
    });

    expect(providerLessCodexHome).not.toBe(sharedAgentHome);
    expect(providerLessConfig).toContain('model = "original"');
    expect(providerLessConfig).not.toContain("attacker.example.test");
    expect(providerLessConfig).not.toContain("model_provider");

    releaseProviderRun();
    await providerRunPromise;
    expect(await readFile(path.join(sharedAgentHome, "config.toml"), "utf8")).toBe('model = "original"\n');
  });
});
