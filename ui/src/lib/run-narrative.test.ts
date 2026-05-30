// @vitest-environment node

import { describe, expect, it } from "vitest";
import type { HeartbeatRun } from "@paperclipai/shared";
import { buildRunNarrative, buildRunReasonLabel, detectRunDiagnostic } from "./run-narrative";

function makeRun(overrides: Partial<HeartbeatRun> = {}): HeartbeatRun {
  return {
    id: "run-1",
    companyId: "company-1",
    agentId: "agent-1",
    invocationSource: "automation",
    triggerDetail: "system",
    status: "succeeded",
    startedAt: new Date("2026-04-01T14:25:10.000Z"),
    finishedAt: new Date("2026-04-01T14:26:34.000Z"),
    error: null,
    wakeupRequestId: null,
    exitCode: 0,
    signal: null,
    usageJson: null,
    resultJson: null,
    sessionIdBefore: "session-before",
    sessionIdAfter: "session-after",
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
    contextSnapshot: {
      wakeReason: "issue_assigned",
      issueId: "issue-1234",
    },
    createdAt: new Date("2026-04-01T14:25:09.000Z"),
    updatedAt: new Date("2026-04-01T14:26:34.000Z"),
    ...overrides,
  };
}

describe("run narrative helpers", () => {
  it("explains new issue assignment runs in plain English", () => {
    const narrative = buildRunNarrative(makeRun(), [
      {
        issueId: "issue-1234",
        identifier: "BLU-585",
        title: "Chief of Staff Continuous Loop",
        status: "todo",
        priority: "medium",
      },
    ]);

    expect(narrative.why).toContain("a new issue was assigned");
    expect(narrative.work).toContain("BLU-585");
    expect(narrative.outcome).toContain("finished cleanly");
    expect(narrative.session).toContain("fresh session");
  });

  it("builds short run-list reason labels", () => {
    expect(buildRunReasonLabel(makeRun())).toBe("new issue assigned");
    expect(
      buildRunReasonLabel(
        makeRun({
          invocationSource: "timer",
          triggerDetail: "system",
          contextSnapshot: null,
        }),
      ),
    ).toBe("scheduled heartbeat");
  });

  it("distinguishes timeout config logs from actual timeout failures", () => {
    const diagnostic = detectRunDiagnostic(
      makeRun(),
      'system[hermes] Starting Hermes Agent (model=qwen/qwen3.6-plus-preview:free, timeout=1800s)\nsystem[hermes] Exit code: 0, timed out: false',
    );

    expect(diagnostic).toEqual({
      tone: "info",
      text: "This run did not time out. A log like `timeout=1800s` is just the configured limit, not a failure.",
    });
  });

  it("flags quota-like failures as non-timeout problems", () => {
    const diagnostic = detectRunDiagnostic(
      makeRun({
        status: "failed",
        error: "429 RESOURCE_EXHAUSTED: You exceeded your current quota.",
        exitCode: 1,
      }),
    );

    expect(diagnostic).toEqual({
      tone: "warn",
      text: "This looks like a quota or rate-limit problem, not a timeout.",
    });
  });

  it("flags local exec runtime failures separately from model failures", () => {
    const diagnostic = detectRunDiagnostic(
      makeRun({
        status: "failed",
        errorCode: "tool_runtime_unavailable",
        error: "CreateProcess failed for exec_command: No such file or directory",
        exitCode: 1,
      }),
    );

    expect(diagnostic).toEqual({
      tone: "error",
      text: "This failed because the local exec/tool runtime was unavailable, not because of model behavior.",
    });
  });
});
