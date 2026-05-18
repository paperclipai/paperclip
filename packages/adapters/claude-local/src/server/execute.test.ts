import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  runChildProcess,
  ensureCommandResolvable,
  resolveCommandForLogs,
} = vi.hoisted(() => ({
  runChildProcess: vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: [
      JSON.stringify({ type: "system", subtype: "init", session_id: "claude-session-1", model: "claude-sonnet" }),
      JSON.stringify({
        type: "result",
        session_id: "claude-session-1",
        result: "ok",
        usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 },
      }),
    ].join("\n"),
    stderr: "",
    pid: 123,
    startedAt: new Date().toISOString(),
  })),
  ensureCommandResolvable: vi.fn(async () => undefined),
  resolveCommandForLogs: vi.fn(async (command: string) => command),
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

import { execute } from "./execute.js";
import {
  __clearProbeCacheForTesting,
  __setShimSourcePathOverrideForTesting,
} from "./paperclip-tools-mcp.js";

describe("claude local execution -- paperclip-tools MCP wiring", () => {
  const cleanupDirs: string[] = [];
  let fakeShimPath: string;

  beforeEach(async () => {
    __clearProbeCacheForTesting();
    const stagingDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-shim-fixture-"));
    cleanupDirs.push(stagingDir);
    fakeShimPath = path.join(stagingDir, "paperclip-tools-mcp-shim.bundle.js");
    await writeFile(fakeShimPath, "// fixture\n", "utf8");
    __setShimSourcePathOverrideForTesting(fakeShimPath);
  });

  afterEach(async () => {
    vi.clearAllMocks();
    __setShimSourcePathOverrideForTesting(null);
    __clearProbeCacheForTesting();
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  async function runLocalExecute(extraConfig: Record<string, unknown> = {}) {
    const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-claude-local-cwd-"));
    cleanupDirs.push(workspaceDir);

    await execute({
      runId: "run-local-1",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Claude Coder",
        adapterType: "claude_local",
        adapterConfig: {},
      },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: {
        command: "claude",
        ...extraConfig,
      },
      context: {
        paperclipWorkspace: { cwd: workspaceDir, source: "project_primary" },
      },
      authToken: "test-paperclip-token",
      onLog: async () => {},
    });

    return runChildProcess.mock.calls[0] as unknown as
      | [string, string, string[], { env: Record<string, string> }]
      | undefined;
  }

  it("appends --mcp-config when MCP wiring is enabled (default)", async () => {
    const call = await runLocalExecute();
    expect(call).toBeTruthy();
    const args = call?.[2] ?? [];
    const idx = args.indexOf("--mcp-config");
    expect(idx).toBeGreaterThan(-1);
    const configPath = args[idx + 1];
    expect(typeof configPath).toBe("string");
    expect(configPath).toMatch(/paperclip-tools-mcp\.json$/);
    const addDirIdx = args.indexOf("--add-dir");
    expect(addDirIdx).toBeGreaterThan(-1);
    expect(idx).toBeGreaterThan(addDirIdx);
  });

  it("omits --mcp-config when disablePluginToolsMcp is true", async () => {
    const call = await runLocalExecute({ disablePluginToolsMcp: true });
    expect(call).toBeTruthy();
    const args = call?.[2] ?? [];
    expect(args).not.toContain("--mcp-config");
  });

  it("places --mcp-config before operator-supplied extraArgs", async () => {
    const call = await runLocalExecute({ extraArgs: ["--strict-mcp-config"] });
    expect(call).toBeTruthy();
    const args = call?.[2] ?? [];
    const mcpIdx = args.indexOf("--mcp-config");
    const strictIdx = args.indexOf("--strict-mcp-config");
    expect(mcpIdx).toBeGreaterThan(-1);
    expect(strictIdx).toBeGreaterThan(mcpIdx);
  });

  it("propagates PAPERCLIP_* env to the child process so the spawned shim can read them", async () => {
    const call = await runLocalExecute();
    expect(call).toBeTruthy();
    const env = call?.[3]?.env ?? {};
    expect(env.PAPERCLIP_RUN_ID).toBe("run-local-1");
    expect(env.PAPERCLIP_API_KEY).toBe("test-paperclip-token");
  });
});
