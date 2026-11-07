import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const RUNTIME_ORIGIN = "http://127.0.0.1:3199";
const PUBLIC_DASHBOARD_ORIGIN = "https://dashboard.paperclip.example.test";

const {
  runAdapterExecutionTargetProcess,
  ensureCommandResolvable,
  resolveCommandForLogs,
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetRuntimeCommandInstalled,
  prepareAdapterExecutionTargetRuntime,
  resolveAdapterExecutionTargetCommandForLogs,
  runAdapterExecutionTargetShellCommand,
  startAdapterExecutionTargetPaperclipBridge,
} = vi.hoisted(() => ({
  runAdapterExecutionTargetProcess: vi.fn(),
  ensureAdapterExecutionTargetCommandResolvable: vi.fn(async () => undefined),
  ensureAdapterExecutionTargetRuntimeCommandInstalled: vi.fn(async () => undefined),
  prepareAdapterExecutionTargetRuntime: vi.fn(async () => ({
    target: { kind: "remote", transport: "sandbox", remoteCwd: "/sandbox/workspace" },
    workspaceRemoteDir: "/sandbox/workspace",
    runtimeRootDir: "/sandbox/.paperclip-runtime",
    assetDirs: { home: "/sandbox/.paperclip-runtime/codex/home" },
    restoreWorkspace: vi.fn(async () => undefined),
  })),
  resolveAdapterExecutionTargetCommandForLogs: vi.fn(async () => "/usr/bin/codex"),
  runAdapterExecutionTargetShellCommand: vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: "",
    stderr: "",
    pid: null,
    startedAt: new Date().toISOString(),
  })),
  startAdapterExecutionTargetPaperclipBridge: vi.fn(async () => null),
  ensureCommandResolvable: vi.fn(async () => undefined),
  resolveCommandForLogs: vi.fn(async () => "/usr/bin/codex"),
}));

vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>(
    "@paperclipai/adapter-utils/server-utils",
  );
  return { ...actual, ensureCommandResolvable, resolveCommandForLogs };
});

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    runAdapterExecutionTargetProcess,
    ensureAdapterExecutionTargetCommandResolvable,
    ensureAdapterExecutionTargetRuntimeCommandInstalled,
    prepareAdapterExecutionTargetRuntime,
    resolveAdapterExecutionTargetCommandForLogs,
    runAdapterExecutionTargetShellCommand,
    startAdapterExecutionTargetPaperclipBridge,
  };
});

import { execute } from "./execute.js";

const launched: {
  env: Record<string, string> | null;
  sandbox: { networkTrustedUrls?: string[] } | null;
} = { env: null, sandbox: null };

runAdapterExecutionTargetProcess.mockImplementation(
  async (
    _runId: string,
    _target: unknown,
    _command: string,
    _args: string[],
    options: { env: Record<string, string>; localProcessSandbox?: { networkTrustedUrls?: string[] } | null },
  ) => {
    launched.env = options.env;
    launched.sandbox = options.localProcessSandbox ?? null;
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "",
      pid: 4242,
      startedAt: new Date().toISOString(),
    };
  },
);

describe("codex execute — internal runtime callback endpoint", () => {
  const cleanupDirs: string[] = [];
  const savedEnv: Record<string, string | undefined> = {};

  function setEnv(key: string, value: string): void {
    if (!(key in savedEnv)) savedEnv[key] = process.env[key];
    process.env[key] = value;
  }

  afterEach(async () => {
    vi.clearAllMocks();
    launched.env = null;
    launched.sandbox = null;
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
      delete savedEnv[key];
    }
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  async function runCli(
    extraConfig: Record<string, unknown> = {},
    executionTarget?: Parameters<typeof execute>[0]["executionTarget"],
  ): Promise<{ configToml: string; env: Record<string, string> }> {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-codex-runtime-callback-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const codexHome = path.join(rootDir, "codex-home");
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(codexHome, { recursive: true });
    await writeFile(path.join(codexHome, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "sk-fixture" }), {
      mode: 0o600,
    });
    setEnv("CODEX_HOME", codexHome);

    await execute({
      runId: "run-runtime-callback",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "CodexCoder",
        adapterType: "codex_local",
        adapterConfig: {},
      },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { command: "codex", engine: "cli", env: { CODEX_HOME: codexHome }, ...extraConfig },
      context: {
        paperclipWorkspace: { cwd: workspaceDir, source: "project_primary" },
        paperclipManagedMcp: {
          managedMcpOnly: true,
          gateways: [
            { name: "paperclip-assigned", endpointPath: "/mcp/gateways/gw-1", bearerToken: "pcgw_fixture" },
          ],
        },
      },
      ...(executionTarget ? { executionTarget } : {}),
      onLog: async () => {},
    });

    expect(launched.env).not.toBeNull();
    return {
      configToml: await readFile(path.join(codexHome, "config.toml"), "utf8"),
      env: launched.env!,
    };
  }

  it("points managed MCP gateways at the internal runtime origin, never the public dashboard origin", async () => {
    setEnv("PAPERCLIP_RUNTIME_API_URL", RUNTIME_ORIGIN);
    setEnv("PAPERCLIP_API_URL", PUBLIC_DASHBOARD_ORIGIN);

    const { configToml } = await runCli();

    expect(configToml).toContain(`url = "${RUNTIME_ORIGIN}/mcp/gateways/gw-1"`);
    expect(configToml).not.toContain(PUBLIC_DASHBOARD_ORIGIN);
  });

  it("exports the internal runtime origin and the public dashboard origin as distinct child env vars", async () => {
    setEnv("PAPERCLIP_RUNTIME_API_URL", RUNTIME_ORIGIN);
    setEnv("PAPERCLIP_API_URL", PUBLIC_DASHBOARD_ORIGIN);

    const { env } = await runCli();

    expect(env.PAPERCLIP_RUNTIME_API_URL).toBe(RUNTIME_ORIGIN);
    expect(env.PAPERCLIP_API_URL).toBe(PUBLIC_DASHBOARD_ORIGIN);
  });

  it("trusts the internal runtime origin when network access is allowlisted", async () => {
    setEnv("PAPERCLIP_RUNTIME_API_URL", RUNTIME_ORIGIN);
    setEnv("PAPERCLIP_API_URL", PUBLIC_DASHBOARD_ORIGIN);

    await runCli({ networkScope: "allowlist" });

    expect(launched.sandbox?.networkTrustedUrls).toEqual(expect.arrayContaining([RUNTIME_ORIGIN]));
  });

  it("keeps a PAPERCLIP_API_URL override when nothing is pinned, instead of a derived loopback origin", async () => {
    setEnv("PAPERCLIP_RUNTIME_API_URL", "http://10.0.0.5:3100");
    setEnv("PAPERCLIP_API_URL", "http://10.0.0.5:3100");
    setEnv("PAPERCLIP_LISTEN_HOST", "127.0.0.1");
    setEnv("PAPERCLIP_LISTEN_PORT", "3177");

    const { configToml, env } = await runCli();

    expect(env.PAPERCLIP_RUNTIME_API_URL).toBe("http://10.0.0.5:3100");
    expect(env.PAPERCLIP_API_URL).toBe("http://10.0.0.5:3100");
    expect(configToml).toContain('url = "http://10.0.0.5:3100/mcp/gateways/gw-1"');
    expect(configToml).not.toContain("127.0.0.1:3177");
  });

  it("resolves both origins from PAPERCLIP_RUNTIME_API_URL alone in a sanitized inherited environment", async () => {
    if (!("PAPERCLIP_API_URL" in savedEnv)) savedEnv.PAPERCLIP_API_URL = process.env.PAPERCLIP_API_URL;
    delete process.env.PAPERCLIP_API_URL;
    setEnv("PAPERCLIP_RUNTIME_API_URL", "http://10.0.0.5:3100");
    setEnv("PAPERCLIP_LISTEN_HOST", "127.0.0.1");
    setEnv("PAPERCLIP_LISTEN_PORT", "3177");

    const { configToml, env } = await runCli();

    expect(env.PAPERCLIP_RUNTIME_API_URL).toBe("http://10.0.0.5:3100");
    expect(env.PAPERCLIP_API_URL).toBe("http://10.0.0.5:3100");
    expect(configToml).toContain('url = "http://10.0.0.5:3100/mcp/gateways/gw-1"');
  });

  it("points managed MCP gateways of a remote target at PAPERCLIP_API_URL, never a host-local runtime origin", async () => {
    setEnv("PAPERCLIP_RUNTIME_API_URL", RUNTIME_ORIGIN);
    setEnv("PAPERCLIP_API_URL", PUBLIC_DASHBOARD_ORIGIN);

    const { configToml } = await runCli({}, {
      kind: "remote",
      transport: "sandbox",
      providerKey: "fixture",
      remoteCwd: "/workspace",
      runner: { execute: vi.fn() },
    });

    expect(configToml).toContain(`url = "${PUBLIC_DASHBOARD_ORIGIN}/mcp/gateways/gw-1"`);
    expect(configToml).not.toContain(RUNTIME_ORIGIN);
  });
});
