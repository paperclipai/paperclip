/**
 * Regression tests for #15801: Hermes runs that complete zero agent turns
 * (provider calls failed silently, process still exits 0) were recorded
 * as succeeded. The adapter must surface stdout WARNING failure lines and
 * mark empty, usage-less clean exits as failed with a distinct errorCode.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@paperclipai/adapter-utils/server-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/adapter-utils/server-utils")>();
  return {
    ...actual,
    runChildProcess: vi.fn(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "",
    })),
  };
});

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(async () => ""),
  writeFile: vi.fn(async () => undefined),
  mkdir: vi.fn(async () => undefined),
  rm: vi.fn(async () => undefined),
  access: vi.fn(async () => undefined),
  readdir: vi.fn(async () => []),
  stat: vi.fn(async () => ({ isFile: () => true, isDirectory: () => false })),
}));

import { execute } from "./execute.js";
import * as serverUtils from "@paperclipai/adapter-utils/server-utils";

function makeCtx() {
  return {
    runId: "test-run-zero-turn",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Hermes",
      adapterType: "hermes_local",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config: {
      command: "/usr/bin/hermes",
      timeoutSec: 60,
      graceSec: 5,
    },
    context: {
      issueId: "issue-1",
      wakeReason: "manual",
      paperclipWake: null,
    },
    onLog: vi.fn(async () => undefined),
    onMeta: vi.fn(async () => undefined),
    onSpawn: vi.fn(async () => undefined),
  };
}

function mockChildResult(result: { exitCode: number; stdout: string; stderr: string }) {
  vi.mocked(serverUtils.runChildProcess).mockResolvedValue({
    exitCode: result.exitCode,
    signal: null,
    timedOut: false,
    stdout: result.stdout,
    stderr: result.stderr,
  } as Awaited<ReturnType<typeof serverUtils.runChildProcess>>);
}

describe("hermes-local zero-turn runs (#15801)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("surfaces stdout WARNING API failures and marks the run failed", async () => {
    mockChildResult({
      exitCode: 0,
      stdout: [
        "[2026-10-07T22:18:00Z] WARNING: API request failed: HTTP 404 model 'auto' not found",
        "[2026-10-07T22:18:01Z] WARNING: API request failed: HTTP 404 model 'auto' not found",
      ].join("\n"),
      stderr: "",
    });

    const result = await execute(makeCtx() as any);
    expect(result.errorMessage).toContain("API request failed");
    expect(result.errorMessage).toContain("404");
    expect(result.errorCode).toBe("zero_agent_turns");
  });

  it("marks a silent clean exit with no response and no usage as failed", async () => {
    mockChildResult({ exitCode: 0, stdout: "", stderr: "" });

    const result = await execute(makeCtx() as any);
    expect(result.errorMessage).toContain("zero agent turns");
    expect(result.errorCode).toBe("zero_agent_turns");
  });

  it("keeps a normal successful run successful", async () => {
    mockChildResult({
      exitCode: 0,
      stdout: "Here is the answer.\n\nsession_id: abc123\ntokens: 120 input, 45 output",
      stderr: "",
    });

    const result = await execute(makeCtx() as any);
    expect(result.errorMessage ?? null).toBeNull();
    expect(result.errorCode ?? null).toBeNull();
    expect(result.summary).toContain("Here is the answer.");
  });

  it("does not apply the zero-turn code to non-zero exits", async () => {
    mockChildResult({ exitCode: 2, stdout: "", stderr: "" });

    const result = await execute(makeCtx() as any);
    expect(result.errorMessage).toContain("exited with code 2");
    expect(result.errorCode ?? null).toBeNull();
  });

  it("still surfaces stderr errors as before", async () => {
    mockChildResult({
      exitCode: 0,
      stdout: "Partial work.\n\nsession_id: abc123\ntokens: 10 input, 5 output",
      stderr: "Traceback: something failed in a tool",
    });

    const result = await execute(makeCtx() as any);
    expect(result.errorMessage).toContain("something failed");
    expect(result.errorCode ?? null).toBeNull();
  });
});
