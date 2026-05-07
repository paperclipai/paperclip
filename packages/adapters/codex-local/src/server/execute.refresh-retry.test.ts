import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetCodexAuthLockQueueForTests } from "./auth-lock.js";

const REUSE_ERROR_LINE =
  "stream error: Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.";

const SUCCESS_STDOUT = [
  JSON.stringify({ type: "thread.started", thread_id: "thread_after_retry" }),
  JSON.stringify({
    type: "item.completed",
    item: { type: "agent_message", text: "Recovered after refresh retry" },
  }),
  JSON.stringify({
    type: "turn.completed",
    usage: { input_tokens: 5, cached_input_tokens: 1, output_tokens: 2 },
  }),
].join("\n");

const { runChildProcess, ensureCommandResolvable, resolveCommandForLogs } = vi.hoisted(() => ({
  runChildProcess: vi.fn(),
  ensureCommandResolvable: vi.fn(async () => undefined),
  resolveCommandForLogs: vi.fn(async () => "/usr/bin/codex"),
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

type AttemptShape = {
  exitCode: number;
  stderr: string;
  stdout: string;
};

function reuseFailureAttempt(): AttemptShape {
  return {
    exitCode: 1,
    stderr: REUSE_ERROR_LINE,
    stdout: "",
  };
}

function successfulAttempt(): AttemptShape {
  return {
    exitCode: 0,
    stderr: "",
    stdout: SUCCESS_STDOUT,
  };
}

describe("execute refresh-token-reuse retry", () => {
  const cleanupDirs: string[] = [];
  let codexHomeDir: string;
  let workspaceDir: string;
  let lockPath: string;

  beforeEach(async () => {
    await __resetCodexAuthLockQueueForTests();
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-codex-refresh-retry-"));
    cleanupDirs.push(rootDir);
    codexHomeDir = path.join(rootDir, "codex-home");
    workspaceDir = path.join(rootDir, "workspace");
    await mkdir(codexHomeDir, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });
    await writeFile(path.join(codexHomeDir, "auth.json"), "{}", "utf8");
    lockPath = path.join(codexHomeDir, ".paperclip-auth-refresh.lock");
    // Point CODEX_HOME at our fixture so prepareManagedCodexHome short-circuits
    // and we don't touch the real shared ~/.codex directory.
    process.env.CODEX_HOME = codexHomeDir;
    process.env.PAPERCLIP_HOME = path.join(rootDir, "paperclip-home");
    // Force a fresh shared-home root so the refresh lock lives under our tmpdir.
  });

  afterEach(async () => {
    delete process.env.CODEX_HOME;
    delete process.env.PAPERCLIP_HOME;
    delete process.env.PAPERCLIP_CODEX_AUTH_LOCK;
    vi.clearAllMocks();
    await __resetCodexAuthLockQueueForTests();
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("re-runs codex once when stderr matches the refresh-token-reuse error", async () => {
    runChildProcess
      .mockResolvedValueOnce({
        ...reuseFailureAttempt(),
        signal: null,
        timedOut: false,
        pid: 100,
        startedAt: new Date().toISOString(),
      })
      .mockResolvedValueOnce({
        ...successfulAttempt(),
        signal: null,
        timedOut: false,
        pid: 101,
        startedAt: new Date().toISOString(),
      });

    const logs: string[] = [];
    const result = await execute({
      runId: "run-refresh-retry",
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
        cwd: workspaceDir,
        // Intentionally do NOT set OPENAI_API_KEY so billingType resolves to
        // "subscription" and the auth lock + retry path is exercised.
        env: {},
      },
      context: {
        paperclipWorkspace: {
          cwd: workspaceDir,
          source: "project_primary",
        },
      },
      onLog: async (_stream, chunk) => {
        logs.push(chunk);
      },
    });

    expect(runChildProcess).toHaveBeenCalledTimes(2);
    expect(result.exitCode).toBe(0);
    expect(result.errorMessage).toBeNull();
    expect(result.sessionId).toBe("thread_after_retry");
    expect(logs.join("\n")).toContain("refresh-token reuse detected");
  });

  it("does not retry when OPENAI_API_KEY is configured (api-key billing has no refresh window)", async () => {
    runChildProcess.mockResolvedValueOnce({
      ...reuseFailureAttempt(),
      signal: null,
      timedOut: false,
      pid: 200,
      startedAt: new Date().toISOString(),
    });

    const result = await execute({
      runId: "run-no-retry-apikey",
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
        cwd: workspaceDir,
        env: {
          OPENAI_API_KEY: "sk-test",
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
    expect(result.exitCode).toBe(1);
  });

  it("respects PAPERCLIP_CODEX_AUTH_LOCK=0 by skipping the lock and retry", async () => {
    process.env.PAPERCLIP_CODEX_AUTH_LOCK = "0";
    runChildProcess.mockResolvedValueOnce({
      ...reuseFailureAttempt(),
      signal: null,
      timedOut: false,
      pid: 300,
      startedAt: new Date().toISOString(),
    });

    const result = await execute({
      runId: "run-lock-disabled",
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
        cwd: workspaceDir,
        env: {},
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
    expect(result.exitCode).toBe(1);
    // Lock file should never have been created.
    await expect(rm(lockPath, { force: false })).rejects.toMatchObject({ code: "ENOENT" });
  });
});
