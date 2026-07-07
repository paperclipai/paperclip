import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { runChildProcess, ensureCommandResolvable, resolveCommandForLogs } = vi.hoisted(() => ({
  runChildProcess: vi.fn(),
  ensureCommandResolvable: vi.fn(async () => undefined),
  resolveCommandForLogs: vi.fn(async () => "claude"),
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

function streamJsonStdout(resultEvent: Record<string, unknown>): string {
  return [
    JSON.stringify({ type: "system", subtype: "init", session_id: "claude-session-1", model: "claude-opus" }),
    JSON.stringify({
      type: "assistant",
      session_id: "claude-session-1",
      message: { content: [{ type: "text", text: "working on it" }] },
    }),
    JSON.stringify({
      type: "result",
      session_id: "claude-session-1",
      usage: { input_tokens: 10, cache_read_input_tokens: 2, output_tokens: 5 },
      total_cost_usd: 0.25,
      ...resultEvent,
    }),
  ].join("\n");
}

function processResult(overrides: Partial<{ exitCode: number | null; signal: string | null; stdout: string }>) {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: "",
    stderr: "",
    pid: 123,
    startedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("claude local run result classification", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    vi.clearAllMocks();
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  async function runExecute() {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-claude-local-"));
    cleanupDirs.push(rootDir);
    const instructionsPath = path.join(rootDir, "instructions.md");
    await writeFile(instructionsPath, "Do the work.\n", "utf8");

    return execute({
      runId: "run-local-1",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Claude Coder",
        adapterType: "claude_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        command: "claude",
        cwd: rootDir,
        instructionsFilePath: instructionsPath,
      },
      context: {},
      onLog: async () => {},
    });
  }

  it("treats an explicit success result as success even when the lingering process exits 143 after SIGTERM cleanup", async () => {
    runChildProcess.mockResolvedValue(
      processResult({
        exitCode: 143,
        stdout: streamJsonStdout({
          subtype: "success",
          is_error: false,
          result: "Everything is committed and the issue is closed out.",
        }),
      }),
    );

    const result = await runExecute();

    expect(result.errorMessage).toBeNull();
    expect(result.errorCode).toBeNull();
    // The server derives run status from exitCode too, so a self-inflicted
    // post-result kill must not leak a non-zero code.
    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe("Everything is committed and the issue is closed out.");
    expect(result.resultJson).toMatchObject({ processExitCode: 143 });
  });

  it("still fails when the result event reports is_error=true despite subtype=success", async () => {
    runChildProcess.mockResolvedValue(
      processResult({
        exitCode: 1,
        stdout: streamJsonStdout({
          subtype: "success",
          is_error: true,
          result: "API Error: The socket connection was closed unexpectedly.",
        }),
      }),
    );

    const result = await runExecute();

    expect(result.exitCode).toBe(1);
    expect(result.errorMessage).toContain("API Error");
    expect(result.errorMessage).not.toContain("subtype=success");
  });

  it("keeps non-zero exits failed when no terminal result event was emitted", async () => {
    runChildProcess.mockResolvedValue(
      processResult({
        exitCode: 1,
        stdout: JSON.stringify({ type: "system", subtype: "init", session_id: "claude-session-1" }),
      }),
    );

    const result = await runExecute();

    expect(result.exitCode).toBe(1);
    expect(result.errorMessage).not.toBeNull();
  });
});
