import { mkdir, mkdtemp, rm, stat, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const {
  runChildProcess,
  ensureCommandResolvable,
  resolveCommandForLogs,
  prepareWorkspaceForSshExecution,
  restoreWorkspaceFromSshExecution,
  syncDirectoryToSsh,
  startAdapterExecutionTargetPaperclipBridge,
} = vi.hoisted(() => ({
  runChildProcess: vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: [
      JSON.stringify({ type: "system", subtype: "init", session_id: "claude-session-1", model: "claude-sonnet" }),
      JSON.stringify({ type: "result", session_id: "claude-session-1", result: "ok", usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 } }),
    ].join("\n"),
    stderr: "",
    pid: 1,
    startedAt: new Date().toISOString(),
  })),
  ensureCommandResolvable: vi.fn(async () => undefined),
  resolveCommandForLogs: vi.fn(async () => "claude"),
  prepareWorkspaceForSshExecution: vi.fn(async () => undefined),
  restoreWorkspaceFromSshExecution: vi.fn(async () => undefined),
  syncDirectoryToSsh: vi.fn(async () => undefined),
  startAdapterExecutionTargetPaperclipBridge: vi.fn(async () => ({
    env: {
      PAPERCLIP_API_URL: "http://127.0.0.1:4310",
      PAPERCLIP_API_KEY: "bridge-token",
      PAPERCLIP_API_BRIDGE_MODE: "queue_v1",
    },
    stop: async () => {},
  })),
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

vi.mock("@paperclipai/adapter-utils/ssh", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/ssh")>(
    "@paperclipai/adapter-utils/ssh",
  );
  return {
    ...actual,
    prepareWorkspaceForSshExecution,
    restoreWorkspaceFromSshExecution,
    syncDirectoryToSsh,
  };
});

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    startAdapterExecutionTargetPaperclipBridge,
  };
});

import { execute } from "./execute.js";

async function fileExists(p: string) {
  return stat(p).then(
    () => true,
    () => false,
  );
}

describe("claude-local execute() — mcp-config propagation", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    vi.clearAllMocks();
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  async function makeWorkspace() {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "claude-mcp-exec-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    await mkdir(workspaceDir, { recursive: true });
    return { rootDir, workspaceDir };
  }

  it("writes mcp-config.json and passes --mcp-config when mcpServers is present (local)", async () => {
    const { workspaceDir } = await makeWorkspace();
    const logs: Array<[string, string]> = [];
    let mcpConfigPathDuringRun: string | null = null;

    runChildProcess.mockImplementationOnce(async (...args: unknown[]) => {
      const argv = (args as [string, string, string[], unknown])[2];
      const idx = argv.indexOf("--mcp-config");
      if (idx >= 0) {
        const candidate = argv[idx + 1];
        if (typeof candidate === "string") mcpConfigPathDuringRun = candidate;
      }
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: [
          JSON.stringify({ type: "system", subtype: "init", session_id: "s1", model: "claude-sonnet" }),
          JSON.stringify({ type: "result", session_id: "s1", result: "ok", usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 } }),
        ].join("\n"),
        stderr: "",
        pid: 1,
        startedAt: new Date().toISOString(),
      };
    });

    await execute({
      runId: "run-mcp-1",
      agent: { id: "a", companyId: "c", name: "n", adapterType: "claude_local", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: {
        command: "claude",
        cwd: workspaceDir,
        mcpServers: {
          linear: {
            type: "stdio",
            command: "mcp-linear",
            args: [],
            env: { LINEAR_API_KEY: "k" },
          },
        },
      },
      context: { paperclipWorkspace: { cwd: workspaceDir, source: "project_primary" } },
      onLog: async (stream, msg) => {
        logs.push([stream, msg]);
      },
    });

    expect(mcpConfigPathDuringRun).not.toBeNull();
    expect(mcpConfigPathDuringRun!).toBe(path.join(workspaceDir, "mcp-config.json"));

    const stdoutLogs = logs.filter(([s]) => s === "stdout").map(([, m]) => m).join("");
    expect(stdoutLogs).toMatch(/Wrote per-run Claude mcp-config\.json with 1 server/);

    // The file is cleaned up in the adapter's finally block — by the time
    // execute() resolves the on-disk file should be gone.
    expect(await fileExists(mcpConfigPathDuringRun!)).toBe(false);
  });

  it("does not pass --mcp-config when mcpServers is absent and writes no file", async () => {
    const { workspaceDir } = await makeWorkspace();

    await execute({
      runId: "run-mcp-2",
      agent: { id: "a", companyId: "c", name: "n", adapterType: "claude_local", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: {
        command: "claude",
        cwd: workspaceDir,
      },
      context: { paperclipWorkspace: { cwd: workspaceDir, source: "project_primary" } },
      onLog: async () => {},
    });

    expect(runChildProcess).toHaveBeenCalledTimes(1);
    const args = (runChildProcess.mock.calls[0] as unknown as [string, string, string[]])[2];
    expect(args).not.toContain("--mcp-config");
    expect(await fileExists(path.join(workspaceDir, "mcp-config.json"))).toBe(false);
  });

  it("does not pass --mcp-config when mcpServers is an empty object", async () => {
    const { workspaceDir } = await makeWorkspace();

    await execute({
      runId: "run-mcp-3",
      agent: { id: "a", companyId: "c", name: "n", adapterType: "claude_local", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: {
        command: "claude",
        cwd: workspaceDir,
        mcpServers: {},
      },
      context: { paperclipWorkspace: { cwd: workspaceDir, source: "project_primary" } },
      onLog: async () => {},
    });

    expect(runChildProcess).toHaveBeenCalledTimes(1);
    const args = (runChildProcess.mock.calls[0] as unknown as [string, string, string[]])[2];
    expect(args).not.toContain("--mcp-config");
    expect(await fileExists(path.join(workspaceDir, "mcp-config.json"))).toBe(false);
  });

  it("warns and skips mcp-config when execution target is remote (SSH)", async () => {
    const { workspaceDir } = await makeWorkspace();
    const logs: Array<[string, string]> = [];

    await execute({
      runId: "run-mcp-remote",
      agent: { id: "a", companyId: "c", name: "n", adapterType: "claude_local", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: {
        command: "claude",
        cwd: workspaceDir,
        mcpServers: {
          linear: {
            type: "stdio",
            command: "mcp-linear",
            args: [],
            env: { LINEAR_API_KEY: "k" },
          },
        },
      },
      context: { paperclipWorkspace: { cwd: workspaceDir, source: "project_primary" } },
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
      onLog: async (stream, msg) => {
        logs.push([stream, msg]);
      },
    });

    expect(runChildProcess).toHaveBeenCalledTimes(1);
    const args = (runChildProcess.mock.calls[0] as unknown as [string, string, string[]])[2];
    expect(args).not.toContain("--mcp-config");

    const stderrLogs = logs.filter(([s]) => s === "stderr").map(([, m]) => m).join("");
    expect(stderrLogs).toMatch(/execution target is remote; mcp-config not propagated/);

    // No file written next to the local cwd either.
    expect(await fileExists(path.join(workspaceDir, "mcp-config.json"))).toBe(false);
  });

  it("preserves header values verbatim (including hyphenated keys) when writing mcp-config.json", async () => {
    const { workspaceDir } = await makeWorkspace();
    let writtenAt: string | null = null;

    runChildProcess.mockImplementationOnce(async (...args: unknown[]) => {
      const argv = (args as [string, string, string[], unknown])[2];
      const idx = argv.indexOf("--mcp-config");
      if (idx >= 0) {
        const candidate = argv[idx + 1];
        if (typeof candidate === "string") {
          writtenAt = candidate;
          // capture file contents while it still exists (before adapter
          // finally-cleanup deletes it)
          const body = JSON.parse(await readFile(candidate, "utf-8"));
          (globalThis as unknown as { __mcpCfgBody?: unknown }).__mcpCfgBody = body;
        }
      }
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: [
          JSON.stringify({ type: "system", subtype: "init", session_id: "s", model: "claude-sonnet" }),
          JSON.stringify({ type: "result", session_id: "s", result: "ok", usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 } }),
        ].join("\n"),
        stderr: "",
        pid: 1,
        startedAt: new Date().toISOString(),
      };
    });

    await execute({
      runId: "run-mcp-headers",
      agent: { id: "a", companyId: "c", name: "n", adapterType: "claude_local", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: {
        command: "claude",
        cwd: workspaceDir,
        mcpServers: {
          remote: {
            type: "http",
            url: "https://mcp.linear.app/mcp",
            headers: {
              "X-API-Key": "secret-value",
              Authorization: "Bearer xxx",
            },
          },
        },
      },
      context: { paperclipWorkspace: { cwd: workspaceDir, source: "project_primary" } },
      onLog: async () => {},
    });

    expect(writtenAt).not.toBeNull();
    const body = (globalThis as unknown as { __mcpCfgBody?: { mcpServers: Record<string, { headers: Record<string, string> }> } }).__mcpCfgBody;
    expect(body?.mcpServers.remote.headers["X-API-Key"]).toBe("secret-value");
    expect(body?.mcpServers.remote.headers.Authorization).toBe("Bearer xxx");

    // Cleanup the captured side-channel.
    delete (globalThis as unknown as { __mcpCfgBody?: unknown }).__mcpCfgBody;
  });
});
