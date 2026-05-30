import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const MOCK_STDOUT_SUCCESS = [
  JSON.stringify({ type: "system", subtype: "init", session_id: "s1", model: "claude-opus-4-8" }),
  JSON.stringify({
    type: "result",
    session_id: "s1",
    result: "ok",
    usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 },
  }),
].join("\n");

const THINKING_BLOCK_ERROR_STDOUT = [
  JSON.stringify({ type: "system", subtype: "init", session_id: "s2", model: "claude-opus-4-8" }),
  JSON.stringify({
    type: "result",
    is_error: true,
    result:
      "thinking or redacted_thinking blocks in the latest assistant message cannot be modified. These blocks must remain as they were in the original response.",
    session_id: "s2",
    usage: { input_tokens: 100, cache_read_input_tokens: 0, output_tokens: 0 },
  }),
].join("\n");

const {
  runChildProcess,
  ensureCommandResolvable,
  resolveCommandForLogs,
} = vi.hoisted(() => ({
  runChildProcess: vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: MOCK_STDOUT_SUCCESS,
    stderr: "",
    pid: 1,
    startedAt: new Date().toISOString(),
  })),
  ensureCommandResolvable: vi.fn(async () => undefined),
  resolveCommandForLogs: vi.fn(async () => "claude"),
}));

vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>(
    "@paperclipai/adapter-utils/server-utils",
  );
  return { ...actual, runChildProcess, ensureCommandResolvable, resolveCommandForLogs };
});

import { execute } from "./execute.js";

function baseAgent(name: string) {
  return {
    id: "agent-1",
    companyId: "company-1",
    name,
    adapterType: "claude_local" as const,
    adapterConfig: {},
  };
}

const baseRuntime = {
  sessionId: null,
  sessionParams: null,
  sessionDisplayId: null,
  taskKey: null,
};

describe("thinking-block mutation retry", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    vi.clearAllMocks();
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("retries with --effort none when thinking-block mutation error is detected", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pclip-thinking-"));
    cleanupDirs.push(dir);

    runChildProcess
      .mockResolvedValueOnce({
        exitCode: 1,
        signal: null,
        timedOut: false,
        stdout: THINKING_BLOCK_ERROR_STDOUT,
        stderr: "",
        pid: 1,
        startedAt: new Date().toISOString(),
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: MOCK_STDOUT_SUCCESS,
        stderr: "",
        pid: 2,
        startedAt: new Date().toISOString(),
      });

    await execute({
      runId: "run-thinking-test",
      agent: baseAgent("Coder (Claude)"),
      runtime: baseRuntime,
      config: { command: "claude", cwd: dir, model: "claude-opus-4-8" },
      context: {},
      onLog: async () => {},
    });

    expect(runChildProcess).toHaveBeenCalledTimes(2);

    const retryArgs = (runChildProcess.mock.calls[1] as unknown as [string, string, string[], unknown])[2];
    expect(retryArgs).toContain("--effort");
    expect(retryArgs[retryArgs.indexOf("--effort") + 1]).toBe("none");
    expect(retryArgs).not.toContain("--resume");
  });

  it("does not retry on clean success", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pclip-thinking-"));
    cleanupDirs.push(dir);

    await execute({
      runId: "run-no-retry-test",
      agent: baseAgent("Coder (Claude)"),
      runtime: baseRuntime,
      config: { command: "claude", cwd: dir },
      context: {},
      onLog: async () => {},
    });

    expect(runChildProcess).toHaveBeenCalledTimes(1);
  });
});
