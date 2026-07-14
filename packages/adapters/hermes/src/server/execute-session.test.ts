import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import type * as ServerUtils from "@paperclipai/adapter-utils/server-utils";
import type { RunProcessResult } from "@paperclipai/adapter-utils/server-utils";

vi.mock("@paperclipai/adapter-utils/server-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof ServerUtils>();
  return {
    ...actual,
    runChildProcess: vi.fn(),
  };
});

import * as serverUtils from "@paperclipai/adapter-utils/server-utils";
import { execute } from "./execute.js";

const OLD_SESSION_ID = "20260713_120000_a1b2c3";
const NEW_SESSION_ID = "20260713_120100_d4e5f6";

function processResult(overrides: Partial<RunProcessResult>): RunProcessResult {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: "",
    stderr: "",
    pid: 123,
    startedAt: "2026-07-13T12:00:00.000Z",
    ...overrides,
  };
}

function makeContext(sessionId: string | null): AdapterExecutionContext {
  return {
    runId: "run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Hermes",
      adapterType: "hermes_local",
      adapterConfig: {},
    },
    runtime: {
      sessionId,
      sessionParams: sessionId ? { sessionId } : null,
      sessionDisplayId: sessionId,
      taskKey: "issue-1",
    },
    config: {
      command: "/usr/bin/hermes",
      provider: "auto",
      timeoutSec: 60,
      graceSec: 5,
    },
    context: {
      issueId: "issue-1",
      wakeReason: "issue_commented",
      paperclipWake: {
        reason: "issue_commented",
        issue: {
          id: "issue-1",
          identifier: "PAP-6347",
          title: "Recover a missing Hermes session",
          status: "in_progress",
          priority: "medium",
          workMode: "standard",
        },
        latestCommentId: "comment-1",
        commentWindow: { requestedCount: 1, includedCount: 1, missingCount: 0 },
        comments: [
          {
            id: "comment-1",
            body: "Retry this heartbeat without the stale session.",
            createdAt: "2026-07-13T12:00:00.000Z",
          },
        ],
        fallbackFetchNeeded: false,
      },
    },
    onLog: vi.fn(async () => undefined),
  };
}

const runChildProcess = vi.mocked(serverUtils.runChildProcess);

describe("Hermes session recovery", () => {
  beforeEach(() => {
    runChildProcess.mockReset();
  });

  it("does not pass a poisoned persisted value to --resume", async () => {
    runChildProcess.mockResolvedValueOnce(processResult({
      stdout: `fresh response\nsession_id: ${NEW_SESSION_ID}\n`,
    }));

    const result = await execute(makeContext("from"));
    const args = runChildProcess.mock.calls[0]?.[2] ?? [];

    expect(args).not.toContain("--resume");
    expect(result.sessionParams).toEqual({ sessionId: NEW_SESSION_ID });
    expect(result.sessionDisplayId).toBe(NEW_SESSION_ID);
  });

  it("does not parse instructional prose as a session ID", async () => {
    runChildProcess.mockResolvedValueOnce(processResult({
      exitCode: 1,
      stderr: "Use a session ID from a previous CLI run.\n",
    }));

    const result = await execute(makeContext(null));

    expect(result.sessionParams).toBeUndefined();
    expect(result.sessionDisplayId).toBeUndefined();
    expect(result.resultJson?.session_id).toBeNull();
  });

  it("does not publish a canonical session ID from a failed run", async () => {
    runChildProcess.mockResolvedValueOnce(processResult({
      exitCode: 1,
      stdout: `partial response\nsession_id: ${NEW_SESSION_ID}\n`,
      stderr: "Provider request failed.\n",
    }));

    const result = await execute(makeContext(null));

    expect(result.sessionParams).toBeUndefined();
    expect(result.sessionDisplayId).toBeUndefined();
    expect(result.resultJson?.session_id).toBeNull();
  });

  it("does not publish session state when persistence is disabled", async () => {
    runChildProcess.mockResolvedValueOnce(processResult({
      stdout: `fresh response\nsession_id: ${NEW_SESSION_ID}\n`,
    }));
    const ctx = makeContext(null);
    ctx.config = { ...ctx.config, persistSession: false };

    const result = await execute(ctx);

    expect(result.sessionParams).toBeUndefined();
    expect(result.sessionDisplayId).toBeUndefined();
    expect(result.resultJson?.session_id).toBe(NEW_SESSION_ID);
  });

  it("retries a missing saved session once without --resume", async () => {
    runChildProcess
      .mockResolvedValueOnce(processResult({
        exitCode: 1,
        stdout: `Session not found: ${OLD_SESSION_ID}\nUse a session ID from a previous CLI run.\n`,
      }))
      .mockResolvedValueOnce(processResult({
        stdout: `recovered response\nsession_id: ${NEW_SESSION_ID}\n`,
      }));

    const result = await execute(makeContext(OLD_SESSION_ID));
    const firstArgs = runChildProcess.mock.calls[0]?.[2] ?? [];
    const retryArgs = runChildProcess.mock.calls[1]?.[2] ?? [];

    expect(runChildProcess).toHaveBeenCalledTimes(2);
    expect(firstArgs).toContain("--resume");
    expect(firstArgs).toContain(OLD_SESSION_ID);
    expect(firstArgs[2]).toContain("## Paperclip Resume Delta");
    expect(retryArgs).not.toContain("--resume");
    expect(retryArgs).not.toContain(OLD_SESSION_ID);
    expect(retryArgs[2]).toContain("## Paperclip Wake Payload");
    expect(result.exitCode).toBe(0);
    expect(result.clearSession).toBeUndefined();
    expect(result.sessionParams).toEqual({ sessionId: NEW_SESSION_ID });
    expect(result.sessionDisplayId).toBe(NEW_SESSION_ID);
  });

  it("clears a missing saved session when the fresh retry also fails", async () => {
    runChildProcess
      .mockResolvedValueOnce(processResult({
        exitCode: 1,
        stdout: `Session not found: ${OLD_SESSION_ID}\n`,
      }))
      .mockResolvedValueOnce(processResult({
        exitCode: 1,
        stderr: "Provider request failed.\n",
      }));

    const result = await execute(makeContext(OLD_SESSION_ID));

    expect(runChildProcess).toHaveBeenCalledTimes(2);
    expect(result.exitCode).toBe(1);
    expect(result.clearSession).toBe(true);
    expect(result.sessionParams).toBeUndefined();
  });
});
