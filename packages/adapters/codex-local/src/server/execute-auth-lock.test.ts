import { mkdir, mkdtemp, readlink, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const {
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetRuntimeCommandInstalled,
  resolveAdapterExecutionTargetCommandForLogs,
  runAdapterExecutionTargetProcess,
} = vi.hoisted(() => ({
  ensureAdapterExecutionTargetCommandResolvable: vi.fn(async () => undefined),
  ensureAdapterExecutionTargetRuntimeCommandInstalled: vi.fn(async () => undefined),
  resolveAdapterExecutionTargetCommandForLogs: vi.fn(async () => "/usr/bin/codex"),
  runAdapterExecutionTargetProcess: vi.fn(),
}));

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    ensureAdapterExecutionTargetCommandResolvable,
    ensureAdapterExecutionTargetRuntimeCommandInstalled,
    resolveAdapterExecutionTargetCommandForLogs,
    runAdapterExecutionTargetProcess,
  };
});

import { execute } from "./execute.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function successfulCodexStdout(runId: string): string {
  return [
    JSON.stringify({ type: "thread.started", thread_id: `thread-${runId}` }),
    JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: `done ${runId}` },
    }),
    JSON.stringify({
      type: "turn.completed",
      usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
    }),
  ].join("\n");
}

describe("codex OAuth auth locking", () => {
  const cleanupDirs: string[] = [];
  let previousCodexHome: string | undefined;
  let previousPaperclipHome: string | undefined;

  afterEach(async () => {
    vi.clearAllMocks();

    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousPaperclipHome === undefined) {
      delete process.env.PAPERCLIP_HOME;
    } else {
      process.env.PAPERCLIP_HOME = previousPaperclipHome;
    }
    previousCodexHome = undefined;
    previousPaperclipHome = undefined;

    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("serializes simultaneous OAuth-backed launches whose managed homes symlink the same auth.json", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-codex-auth-lock-"));
    cleanupDirs.push(rootDir);
    const sourceHome = path.join(rootDir, "shared-codex-home");
    const paperclipHome = path.join(rootDir, "paperclip-home");
    const workspaceDir = path.join(rootDir, "workspace");
    await mkdir(sourceHome, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });
    await writeFile(
      path.join(sourceHome, "auth.json"),
      JSON.stringify({
        tokens: {
          access_token: "access-token",
          refresh_token: "refresh-token",
        },
      }),
      "utf8",
    );

    previousCodexHome = process.env.CODEX_HOME;
    previousPaperclipHome = process.env.PAPERCLIP_HOME;
    process.env.CODEX_HOME = sourceHome;
    process.env.PAPERCLIP_HOME = paperclipHome;

    let activeProcesses = 0;
    let maxActiveProcesses = 0;
    const codexHomes: string[] = [];
    runAdapterExecutionTargetProcess.mockImplementation(async (
      runId: string,
      _target: unknown,
      _command: string,
      _args: string[],
      options: { env: Record<string, string> },
    ) => {
      activeProcesses += 1;
      maxActiveProcesses = Math.max(maxActiveProcesses, activeProcesses);
      codexHomes.push(options.env.CODEX_HOME);
      await delay(125);
      activeProcesses -= 1;

      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: successfulCodexStdout(runId),
        stderr: "",
        pid: 123,
        startedAt: new Date().toISOString(),
      };
    });

    const baseContext = {
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        command: "codex",
      },
      context: {
        paperclipWorkspace: {
          cwd: workspaceDir,
          source: "project_primary",
          strategy: "git_worktree",
        },
      },
      onLog: async () => {},
    };

    const [first, second] = await Promise.all([
      execute({
        ...baseContext,
        runId: "run-1",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "CodexCoder1",
          adapterType: "codex_local",
          adapterConfig: {},
        },
      }),
      execute({
        ...baseContext,
        runId: "run-2",
        agent: {
          id: "agent-2",
          companyId: "company-2",
          name: "CodexCoder2",
          adapterType: "codex_local",
          adapterConfig: {},
        },
      }),
    ]);

    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
    expect(runAdapterExecutionTargetProcess).toHaveBeenCalledTimes(2);
    expect(maxActiveProcesses).toBe(1);
    expect(new Set(codexHomes).size).toBe(2);
    await expect(readlink(path.join(codexHomes[0]!, "auth.json"))).resolves.toBe(path.join(sourceHome, "auth.json"));
    await expect(readlink(path.join(codexHomes[1]!, "auth.json"))).resolves.toBe(path.join(sourceHome, "auth.json"));
  });
});
