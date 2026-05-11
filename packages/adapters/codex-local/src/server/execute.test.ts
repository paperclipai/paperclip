import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function buildCompletedStdout(summary = "done"): string {
  return [
    JSON.stringify({ type: "thread.started", thread_id: "thread_test" }),
    JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: summary },
    }),
    JSON.stringify({
      type: "turn.completed",
      usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
    }),
  ].join("\n");
}

function buildFailedStdout(message = "boom"): string {
  return [
    JSON.stringify({ type: "thread.started", thread_id: "thread_test" }),
    JSON.stringify({
      type: "turn.failed",
      error: { message },
    }),
  ].join("\n");
}

function buildProcessResult(
  overrides: Partial<{
    exitCode: number | null;
    signal: string | null;
    timedOut: boolean;
    stdout: string;
    stderr: string;
    pid: number | null;
    startedAt: string | null;
  }> = {},
) {
  return {
    exitCode: 0 as number | null,
    signal: null as string | null,
    timedOut: false,
    stdout: buildCompletedStdout(),
    stderr: "",
    pid: 123,
    startedAt: new Date().toISOString(),
    ...overrides,
  };
}

const {
  runChildProcess,
  ensureCommandResolvable,
  resolveCommandForLogs,
  readPaperclipRuntimeSkillEntries,
} = vi.hoisted(() => ({
  runChildProcess: vi.fn(async () => buildProcessResult()),
  ensureCommandResolvable: vi.fn(async () => undefined),
  resolveCommandForLogs: vi.fn(async () => "codex"),
  readPaperclipRuntimeSkillEntries: vi.fn(async () => []),
}));

vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>(
    "@paperclipai/adapter-utils/server-utils",
  );
  return {
    ...actual,
    runChildProcess,
    ensureCommandResolvable,
    resolveCommandForLogs,
    readPaperclipRuntimeSkillEntries,
  };
});

import { execute } from "./execute.js";

describe("codex execute terminal cleanup", () => {
  const cleanupDirs: string[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    runChildProcess.mockResolvedValue(buildProcessResult());
    ensureCommandResolvable.mockResolvedValue(undefined);
    resolveCommandForLogs.mockResolvedValue("codex");
    readPaperclipRuntimeSkillEntries.mockResolvedValue([]);
  });

  afterEach(async () => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("passes terminal-result cleanup for Codex turn completion output", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-codex-terminal-cleanup-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const codexHomeDir = path.join(rootDir, "codex-home");
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(codexHomeDir, { recursive: true });
    await writeFile(path.join(codexHomeDir, "auth.json"), "{}", "utf8");

    await execute({
      runId: "run-terminal-cleanup",
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
        command: "codex",
        env: {
          CODEX_HOME: codexHomeDir,
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

    expect(runChildProcess).toHaveBeenCalledTimes(1);
    const call = runChildProcess.mock.calls[0] as unknown as [
      string,
      string,
      string[],
      {
        terminalResultCleanup?: {
          graceMs?: number;
          hasTerminalResult: (output: { stdout: string; stderr: string }) => boolean;
        };
      },
    ];
    expect(call?.[3].terminalResultCleanup?.graceMs).toBe(5_000);
    expect(
      call?.[3].terminalResultCleanup?.hasTerminalResult({
        stdout: `${JSON.stringify({
          type: "turn.completed",
          usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
        })}\n`,
        stderr: "",
      }),
    ).toBe(true);
    expect(
      call?.[3].terminalResultCleanup?.hasTerminalResult({
        stdout: "",
        stderr: `${JSON.stringify({ type: "turn.failed", error: { message: "boom" } })}\n`,
      }),
    ).toBe(true);
    expect(
      call?.[3].terminalResultCleanup?.hasTerminalResult({
        stdout: `${JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "still running" },
        })}\n`,
        stderr: "",
      }),
    ).toBe(false);
  });

  it("normalizes a completed turn back to success after cleanup", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-codex-terminal-normalize-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const codexHomeDir = path.join(rootDir, "codex-home");
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(codexHomeDir, { recursive: true });
    await writeFile(path.join(codexHomeDir, "auth.json"), "{}", "utf8");

    runChildProcess.mockResolvedValueOnce(buildProcessResult({
      exitCode: 1,
      signal: "SIGTERM",
      stdout: buildCompletedStdout("done"),
    }));

    const result = await execute({
      runId: "run-terminal-normalize",
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
        command: "codex",
        env: {
          CODEX_HOME: codexHomeDir,
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

    expect(result.exitCode).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.timedOut).toBe(false);
    expect(result.errorMessage).toBeNull();
    expect(result.sessionId).toBe("thread_test");
    expect(result.summary).toBe("done");
  });

  it("preserves parsed turn.failed errors when cleanup exits via SIGTERM", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-codex-terminal-failed-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const codexHomeDir = path.join(rootDir, "codex-home");
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(codexHomeDir, { recursive: true });
    await writeFile(path.join(codexHomeDir, "auth.json"), "{}", "utf8");

    runChildProcess.mockResolvedValueOnce(buildProcessResult({
      exitCode: null,
      signal: "SIGTERM",
      stdout: buildFailedStdout("resume failed"),
    }));

    const result = await execute({
      runId: "run-terminal-failed",
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
        command: "codex",
        env: {
          CODEX_HOME: codexHomeDir,
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

    expect(result.exitCode).toBeNull();
    expect(result.signal).toBe("SIGTERM");
    expect(result.timedOut).toBe(false);
    expect(result.errorMessage).toBe("resume failed");
    expect(result.sessionId).toBe("thread_test");
  });
});
