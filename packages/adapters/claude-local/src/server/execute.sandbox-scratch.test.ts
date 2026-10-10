import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { runAdapterExecutionTargetProcess } = vi.hoisted(() => ({
  runAdapterExecutionTargetProcess: vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: "",
    stderr: "",
    pid: 123,
    startedAt: new Date().toISOString(),
  })),
}));

vi.mock("./acp.js", () => ({
  createClaudeAcpExecutor: () => vi.fn(),
  resolveClaudeExecutionEngineForRun: async () => ({ engine: "cli", explicit: true }),
}));

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    ensureAdapterExecutionTargetCommandResolvable: vi.fn(async () => undefined),
    ensureAdapterExecutionTargetRuntimeCommandInstalled: vi.fn(async () => undefined),
    resolveAdapterExecutionTargetCommandForLogs: vi.fn(async () => "claude"),
    runAdapterExecutionTargetProcess,
  };
});

import { execute } from "./execute.js";

describe("claude_local run scratch dir in the workspace sandbox", () => {
  const cleanupDirs: string[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  async function run(scratchFor: (rootDir: string) => Promise<string | null>) {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-claude-scratch-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    await mkdir(workspaceDir, { recursive: true });
    const scratch = await scratchFor(rootDir);
    await execute({
      runId: "run-scratch",
      agent: { id: "agent-1", companyId: "company-1", name: "Claude Coder", adapterType: "claude_local", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: {
        engine: "cli",
        cwd: workspaceDir,
        filesystemScope: "workspace",
        env: scratch ? { PAPERCLIP_RUN_SCRATCH_DIR: scratch } : {},
      },
      context: {},
      onLog: vi.fn(async () => {}),
    } as never);
    const calls = runAdapterExecutionTargetProcess.mock.calls as unknown as Array<
      [string, null, string, string[], { localProcessSandbox?: { managedPaths?: Array<{ path: string; access: string }> } }]
    >;
    return { scratch, managedPaths: calls.at(-1)?.[4]?.localProcessSandbox?.managedPaths };
  }

  it("binds an existing run scratch dir read-write", async () => {
    const { scratch, managedPaths } = await run(async (rootDir) => {
      const dir = path.join(rootDir, "run-scratch");
      await mkdir(dir);
      return dir;
    });
    expect(managedPaths).toContainEqual({ path: scratch, access: "rw" });
  });

  it("adds nothing when the scratch dir is unset or missing", async () => {
    const unset = await run(async () => null);
    expect(unset.managedPaths).toBeDefined();
    expect(unset.managedPaths?.some((entry) => entry.path.endsWith("run-scratch"))).toBe(false);
    const missing = await run(async (rootDir) => path.join(rootDir, "never-created"));
    expect(missing.managedPaths).toBeDefined();
    expect(missing.managedPaths?.some((entry) => entry.path === missing.scratch)).toBe(false);
  });
});
