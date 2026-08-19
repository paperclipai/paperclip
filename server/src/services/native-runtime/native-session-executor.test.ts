import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import type { NativeExecutionInputV1 } from "@paperclipai/paperclip-runner";

type BackendFactoryOptions = {
  runnerInstanceId?: string;
  onSpawn?: (meta: {
    pid: number;
    processGroupId: number | null;
    startedAt: string;
  }) => Promise<void>;
};

const state = vi.hoisted(() => ({
  execute: vi.fn(),
  createBackend: vi.fn(
    (_input: NativeExecutionInputV1, _options: BackendFactoryOptions) => ({
      kind: "test",
    }),
  ),
  cancel: vi.fn(),
  release: null as null | (() => void),
}));

vi.mock("@paperclipai/paperclip-runner", () => ({
  createCodexNativeSessionBackend: state.createBackend,
  executeNativeSession: state.execute,
}));

import {
  cancelNativeSession,
  executePaperclipNativeSession,
  nativeSessionFailureDisposition,
} from "./native-session-executor.js";

const execution = {
  binding: {
    companyId: "company",
    runId: "run-native-cancel",
    issueId: "issue",
    agentId: "agent",
  },
  completionContract: { id: "contract", sha256: "sha" },
} as NativeExecutionInputV1;

function leaseDb(): Db {
  const coordinator = {
    runId: execution.binding.runId,
    companyId: execution.binding.companyId,
    issueId: execution.binding.issueId,
    phase: "observed",
    attempt: 0,
    leaseOwner: null,
    leaseExpiresAt: null,
    resultId: null,
  };
  const update = () => ({
    set: () => ({ where: async () => [] }),
  });
  const tx = {
    select: () => ({
      from: () => ({
        where: () => ({
          for: () => ({
            limit: () => Promise.resolve([coordinator]),
          }),
        }),
      }),
    }),
    update,
  };
  return {
    transaction: async (operation: (transaction: Db) => Promise<unknown>) => operation(tx as unknown as Db),
    update,
  } as unknown as Db;
}

describe("native session cancellation", () => {
  beforeEach(() => {
    state.cancel.mockReset();
    state.release = null;
    state.execute.mockReset().mockImplementation(async (options) => {
      options.onSession?.({ cancel: state.cancel });
      await new Promise<void>((resolve) => { state.release = resolve; });
      options.onSession?.(null);
      return {
        result: { summary: "cancelled" },
        terminal: { runTerminalState: "cancelled" },
        turnId: "turn",
        normalizedSessionId: "session",
        providerSessionId: null,
        driverKind: "test",
        driverVersion: "1",
        nativeEventCount: 1,
        highestContiguousSourceSeq: 1,
      };
    });
  });

  it("routes control-plane cancellation to the active normalized session and removes the handle", async () => {
    const running = executePaperclipNativeSession({
      db: leaseDb(),
      execution,
      runnerInstanceId: "runner",
    });
    await vi.waitFor(() => expect(state.release).toBeTypeOf("function"));

    await expect(cancelNativeSession(execution.binding.runId, "budget hard stop")).resolves.toBe(true);
    await expect(cancelNativeSession(execution.binding.runId, "duplicate budget stop")).resolves.toBe(true);
    expect(state.cancel).toHaveBeenCalledWith({ reason: "budget hard stop" });
    expect(state.cancel).toHaveBeenCalledTimes(1);

    state.release?.();
    await running;
    await expect(cancelNativeSession(execution.binding.runId, "late cancel")).resolves.toBe(false);
  });

  it("allows cancellation to be retried when the session dispatch fails", async () => {
    state.cancel.mockRejectedValueOnce(new Error("transport unavailable"));
    const running = executePaperclipNativeSession({
      db: leaseDb(),
      execution,
      runnerInstanceId: "runner",
    });
    await vi.waitFor(() => expect(state.release).toBeTypeOf("function"));

    await expect(cancelNativeSession(execution.binding.runId, "budget hard stop"))
      .rejects.toThrow("transport unavailable");
    await expect(cancelNativeSession(execution.binding.runId, "retry budget stop"))
      .resolves.toBe(true);
    expect(state.cancel).toHaveBeenNthCalledWith(2, { reason: "retry budget stop" });

    state.release?.();
    await running;
  });
});

describe("native session bounded recovery", () => {
  it("retries the same run twice and stops at the third failed attempt", () => {
    const now = new Date("2026-08-09T00:00:00.000Z");
    expect(nativeSessionFailureDisposition(1, now)).toEqual({
      phase: "retryable_failure",
      failureCode: "native_session_interrupted",
      nextAttemptAt: new Date("2026-08-09T00:00:30.000Z"),
    });
    expect(nativeSessionFailureDisposition(2, now)).toEqual({
      phase: "retryable_failure",
      failureCode: "native_session_interrupted",
      nextAttemptAt: new Date("2026-08-09T00:00:30.000Z"),
    });
    expect(nativeSessionFailureDisposition(3, now)).toEqual({
      phase: "terminal_failure",
      failureCode: "native_session_retry_exhausted",
      nextAttemptAt: null,
    });
  });
});

describe("native process ownership", () => {
  it("forwards the app-server PID and process group through the production backend seam", async () => {
    const processMetadata = {
      pid: 42_001,
      processGroupId: 42_001,
      startedAt: "2026-08-18T18:00:00.000Z",
    };
    const onSpawn = vi.fn(async () => undefined);
    state.createBackend.mockClear();
    state.execute.mockReset().mockImplementation(async (options) => {
      await options.backend.onSpawn(processMetadata);
      return {
        result: { summary: "completed" },
        terminal: { runTerminalState: "succeeded" },
        turnId: "turn",
        normalizedSessionId: "session",
        providerSessionId: null,
        driverKind: "test",
        driverVersion: "1",
        nativeEventCount: 1,
        highestContiguousSourceSeq: 1,
      };
    });
    state.createBackend.mockImplementationOnce((_input, options) => ({
      kind: "test",
      onSpawn: options.onSpawn,
    }));

    await executePaperclipNativeSession({
      db: leaseDb(),
      execution,
      runnerInstanceId: "runner",
      onSpawn,
    });

    expect(state.createBackend).toHaveBeenCalledWith(execution, {
      runnerInstanceId: "runner",
      onSpawn,
    });
    expect(onSpawn).toHaveBeenCalledWith(processMetadata);
  });
});
