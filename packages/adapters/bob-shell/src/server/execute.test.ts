/**
 * Tests for parseBobStreamOutput, isBobLimitError, and execute.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { parseBobStreamOutput, isBobLimitError, execute } from "./execute.js";

// ---------------------------------------------------------------------------
// Mock runChildProcess from adapter-utils so execute() never spawns a real process
// ---------------------------------------------------------------------------

vi.mock("@paperclipai/adapter-utils/server-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/adapter-utils/server-utils")>();
  return {
    ...actual,
    runChildProcess: vi.fn(),
  };
});

import * as serverUtils from "@paperclipai/adapter-utils/server-utils";
const mockRunChildProcess = vi.mocked(serverUtils.runChildProcess);

// ---------------------------------------------------------------------------
// parseBobStreamOutput
// ---------------------------------------------------------------------------

describe("parseBobStreamOutput", () => {
  it("extracts task_id, token stats and last_message from result event", () => {
    const stdout = [
      JSON.stringify({
        type: "message",
        role: "assistant",
        content: "I will analyze the project.",
      }),
      JSON.stringify({
        type: "result",
        status: "success",
        stats: {
          task_id: "abc-123-def",
          total_tokens: 500,
          input_tokens: 300,
          output_tokens: 200,
          cache_read_tokens: 50,
          session_costs: 0.02,
          duration_ms: 12345,
          tool_calls: 3,
        },
        last_message: "Analysis complete.",
      }),
    ].join("\n");

    const result = parseBobStreamOutput(stdout);
    expect(result.taskId).toBe("abc-123-def");
    expect(result.inputTokens).toBe(300);
    expect(result.outputTokens).toBe(200);
    expect(result.cachedInputTokens).toBe(50);
    expect(result.costUsd).toBe(0.02);
    expect(result.lastMessage).toBe("Analysis complete.");
    expect(result.status).toBe("success");
    expect(result.errorMessage).toBeUndefined();
  });

  it("captures error message from error event", () => {
    const stdout = [
      JSON.stringify({
        type: "error",
        severity: "cost",
        message: "Maximum cost limit reached",
      }),
      JSON.stringify({
        type: "result",
        status: "error",
        stats: { task_id: "xyz-789" },
        last_message: "Run stopped.",
      }),
    ].join("\n");

    const result = parseBobStreamOutput(stdout);
    expect(result.errorMessage).toBe("Maximum cost limit reached");
    expect(result.status).toBe("error");
    expect(result.taskId).toBe("xyz-789");
  });

  it("returns empty result for empty stdout", () => {
    const result = parseBobStreamOutput("");
    expect(result.taskId).toBeUndefined();
    expect(result.inputTokens).toBeUndefined();
    expect(result.status).toBeUndefined();
  });

  it("ignores non-JSON lines", () => {
    const stdout = [
      "Some plain text output",
      "Another plain line",
      JSON.stringify({
        type: "result",
        status: "success",
        stats: { task_id: "t1", total_tokens: 100, input_tokens: 60, output_tokens: 40 },
        last_message: "Done.",
      }),
    ].join("\n");

    const result = parseBobStreamOutput(stdout);
    expect(result.taskId).toBe("t1");
    expect(result.status).toBe("success");
  });

  it("fills errorMessage from last_message when result status is error and no prior error event", () => {
    const stdout = JSON.stringify({
      type: "result",
      status: "error",
      stats: {},
      last_message: "Something went wrong",
    });

    const result = parseBobStreamOutput(stdout);
    expect(result.status).toBe("error");
    expect(result.errorMessage).toBe("Something went wrong");
  });
});

// ---------------------------------------------------------------------------
// isBobLimitError
// ---------------------------------------------------------------------------

describe("isBobLimitError", () => {
  it("detects cost severity error", () => {
    expect(
      isBobLimitError(
        JSON.stringify({ type: "error", severity: "cost", message: "limit" }),
      ),
    ).toBe(true);
  });

  it("detects turns severity error", () => {
    expect(
      isBobLimitError(
        JSON.stringify({ type: "error", severity: "turns", message: "limit" }),
      ),
    ).toBe(true);
  });

  it("detects --max-cost text in output", () => {
    expect(isBobLimitError("Exceeded --max-cost budget")).toBe(true);
  });

  it("returns false for normal success output", () => {
    expect(
      isBobLimitError(
        JSON.stringify({
          type: "result",
          status: "success",
          stats: { task_id: "t1" },
        }),
      ),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// execute
// ---------------------------------------------------------------------------

function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    runId: "run-1",
    authToken: "token-abc",
    agent: { id: "agent-1", name: "TestBot", companyId: "co-1", adapterType: "bob_shell", adapterConfig: {} },
    config: {},
    context: {},
    runtime: { sessionParams: null },
    onLog: vi.fn().mockResolvedValue(undefined),
    onSpawn: vi.fn(),
    ...overrides,
  } as unknown as Parameters<typeof execute>[0];
}

describe("execute", () => {
  beforeEach(() => {
    mockRunChildProcess.mockReset();
  });

  it("runs a new session and passes prompt via stdin", async () => {
    const successStdout = [
      JSON.stringify({ type: "message", role: "assistant", content: "Done." }),
      JSON.stringify({
        type: "result",
        status: "success",
        stats: { task_id: "new-task-42", input_tokens: 100, output_tokens: 50 },
        last_message: "Task complete.",
      }),
    ].join("\n");

    mockRunChildProcess.mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: successStdout,
      stderr: "",
      pid: 1234,
      startedAt: new Date().toISOString(),
    });

    const result = await execute(makeCtx());

    // Spawned with "run" (not --resume) and stream-json
    const callArgs = mockRunChildProcess.mock.calls[0];
    expect(callArgs[1]).toMatch(/bob/i); // command
    expect(callArgs[2]).toContain("run");
    expect(callArgs[2]).toContain("--format");
    expect(callArgs[2]).toContain("stream-json");
    expect(callArgs[2]).not.toContain("--resume");

    // stdin carries the prompt
    expect((callArgs[3] as Record<string, unknown>).stdin).toBeTruthy();

    // Result reflects parsed output
    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe("Task complete.");
    expect(result.sessionParams).toMatchObject({ taskId: "new-task-42" });
    expect(result.usage?.inputTokens).toBe(100);
    expect(result.usage?.outputTokens).toBe(50);
  });

  it("resumes a previous session by passing --resume <task-id>", async () => {
    const successStdout = JSON.stringify({
      type: "result",
      status: "success",
      stats: { task_id: "old-task-99", input_tokens: 20, output_tokens: 10 },
      last_message: "Resumed and done.",
    });

    mockRunChildProcess.mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: successStdout,
      stderr: "",
      pid: 5678,
      startedAt: new Date().toISOString(),
    });

    const ctx = makeCtx({
      runtime: { sessionParams: { taskId: "old-task-99", cwd: "" } },
    });

    const result = await execute(ctx);

    const callArgs = mockRunChildProcess.mock.calls[0];
    expect(callArgs[2]).toContain("--resume");
    expect(callArgs[2]).toContain("old-task-99");

    expect(result.sessionParams).toMatchObject({ taskId: "old-task-99" });
    expect(result.summary).toBe("Resumed and done.");
  });
});
