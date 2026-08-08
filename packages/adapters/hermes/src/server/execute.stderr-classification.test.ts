import { beforeEach, describe, expect, it, vi } from "vitest";

const runChildProcessMock = vi.hoisted(() => vi.fn());

vi.mock("@paperclipai/adapter-utils/server-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/adapter-utils/server-utils")>();
  return {
    ...actual,
    runChildProcess: runChildProcessMock,
  };
});

vi.mock("node:fs/promises", () => ({
  default: {
    readFile: vi.fn(async () => ""),
  },
  readFile: vi.fn(async () => ""),
}));

import { execute } from "./execute.js";

function makeCtx() {
  return {
    runId: "test-run-stderr",
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

const recoverableCheckpointError =
  "tools.checkpoint_manager - ERROR - Git command failed: git gc --prune=now --quiet " +
  "(rc=128) stderr=fatal: gc is already running";

describe("hermes-local stderr classification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not fail an exit-code-0 run because a recoverable tool error was logged", async () => {
    runChildProcessMock.mockResolvedValueOnce({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "Work completed successfully.\n",
      stderr: recoverableCheckpointError,
    });

    const result = await execute(makeCtx() as any);

    expect(result.exitCode).toBe(0);
    expect(result.errorMessage).toBeUndefined();
    expect(result.summary).toContain("Work completed successfully");
  });

  it("preserves stderr diagnostics when the Hermes child actually fails", async () => {
    runChildProcessMock.mockResolvedValueOnce({
      exitCode: 1,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: recoverableCheckpointError,
    });

    const result = await execute(makeCtx() as any);

    expect(result.exitCode).toBe(1);
    expect(result.errorMessage).toContain("git gc");
  });

  it("preserves stderr diagnostics when the Hermes child times out", async () => {
    runChildProcessMock.mockResolvedValueOnce({
      exitCode: null,
      signal: "SIGTERM",
      timedOut: true,
      stdout: "",
      stderr: recoverableCheckpointError,
    });

    const result = await execute(makeCtx() as any);

    expect(result.timedOut).toBe(true);
    expect(result.errorMessage).toContain("git gc");
  });
});
