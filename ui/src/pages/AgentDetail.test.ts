// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import type { HeartbeatRun } from "@paperclipai/shared";
import { formatRunAlert } from "../lib/runAlerts";

function createRun(overrides: Partial<HeartbeatRun> = {}): HeartbeatRun {
  return {
    id: "run-1",
    companyId: "company-1",
    agentId: "agent-1",
    invocationSource: "assignment",
    triggerDetail: null,
    status: "running",
    startedAt: new Date("2026-03-11T00:00:00.000Z"),
    finishedAt: null,
    error: null,
    wakeupRequestId: null,
    exitCode: null,
    signal: null,
    usageJson: null,
    resultJson: null,
    sessionIdBefore: null,
    sessionIdAfter: null,
    logStore: null,
    logRef: null,
    logBytes: null,
    logSha256: null,
    logCompressed: false,
    stdoutExcerpt: null,
    stderrExcerpt: null,
    errorCode: null,
    externalRunId: null,
    processPid: null,
    processStartedAt: null,
    retryOfRunId: null,
    processLossRetryCount: 0,
    contextSnapshot: null,
    createdAt: new Date("2026-03-11T00:00:00.000Z"),
    updatedAt: new Date("2026-03-11T00:00:00.000Z"),
    ...overrides,
  };
}

describe("formatRunAlert", () => {
  it("returns a non-fatal recovery message for detached processes", () => {
    const alert = formatRunAlert(
      createRun({
        errorCode: "process_detached",
        error: "Lost in-memory process handle, but child pid 93000 is still alive",
      }),
    );

    expect(alert).toEqual({
      tone: "info",
      message:
        "Paperclip lost its in-memory handle for this process, but the child process is still running. Live activity will clear this warning automatically, and Cancel will still stop the process.",
    });
  });

  it("falls back to the raw error for true failures", () => {
    const alert = formatRunAlert(
      createRun({
        status: "failed",
        errorCode: "process_lost",
        error: "Process lost -- child pid 93000 is no longer running",
      }),
    );

    expect(alert).toEqual({
      tone: "error",
      message: "Process lost -- child pid 93000 is no longer running",
    });
  });
});
