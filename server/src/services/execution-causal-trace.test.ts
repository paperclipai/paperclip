import { describe, expect, it } from "vitest";
import {
  buildExecutionCausalWakePayload,
  buildExecutionRecoveryContextPayload,
  buildExecutionToolSpanPayload,
} from "./execution-causal-trace.js";

describe("execution causal trace helpers", () => {
  it("summarizes carried recovery context for the next heartbeat", () => {
    const payload = buildExecutionRecoveryContextPayload({
      issueId: "issue-1",
      taskId: "issue-1",
      wakeReason: "finish_successful_run_handoff",
      retryOfRunId: "run-0",
      recoveryActionId: "recovery-1",
      handoffRequired: true,
      handoffReason: "successful_run_missing_state",
      handoffAttempt: 1,
      paperclipSessionHandoffMarkdown: "Paperclip session handoff",
      executionCausalTrace: [
        {
          version: 1,
          kind: "retry",
          recordedAt: "2026-07-24T00:00:00.000Z",
          reason: "transient_failure",
          source: "automation",
          triggerDetail: "system",
          issueId: "issue-1",
          taskId: "issue-1",
          runId: "run-0",
          retryOfRunId: "run-0",
          recoveryActionId: null,
          originKind: null,
          originId: null,
        },
      ],
    });

    expect(payload).toMatchObject({
      issueId: "issue-1",
      taskId: "issue-1",
      retryOfRunId: "run-0",
      recoveryActionId: "recovery-1",
      priorTraceCount: 1,
      handoffRequired: true,
      handoffReason: "successful_run_missing_state",
      handoffAttempt: 1,
      carriedContextKeys: expect.arrayContaining([
        "issueId",
        "taskId",
        "wakeReason",
        "retryOfRunId",
        "recoveryActionId",
        "handoffRequired",
        "handoffReason",
        "handoffAttempt",
        "paperclipSessionHandoffMarkdown",
      ]),
    });
  });

  it("builds wake and tool span payloads with stable causal fields", () => {
    const wake = buildExecutionCausalWakePayload({
      issueId: "issue-1",
      taskId: "issue-1",
      wakeReason: "issue_continuation_needed",
      wakeSource: "assignment",
      wakeTriggerDetail: "system",
      executionCausalTrace: [
        {
          version: 1,
          kind: "wake",
          recordedAt: "2026-07-24T00:00:00.000Z",
          reason: "issue_continuation_needed",
          source: "assignment",
          triggerDetail: "system",
          issueId: "issue-1",
          taskId: "issue-1",
          runId: null,
          retryOfRunId: null,
          recoveryActionId: null,
          originKind: null,
          originId: null,
        },
      ],
    });
    const toolSpan = buildExecutionToolSpanPayload({
      invocationId: "inv-1",
      actionRequestId: "action-1",
      toolName: "web.search",
      phase: "end",
      resultClass: "failed",
      errorClass: "tool_timeout",
      outcome: "timeout",
      reasonCode: "tool_timeout",
    });

    expect(wake).toMatchObject({
      wakeReason: "issue_continuation_needed",
      wakeSource: "assignment",
      wakeTriggerDetail: "system",
      issueId: "issue-1",
      taskId: "issue-1",
      latestTraceEntry: expect.objectContaining({
        kind: "wake",
        reason: "issue_continuation_needed",
      }),
    });
    expect(toolSpan).toEqual({
      traceVersion: 1,
      invocationId: "inv-1",
      actionRequestId: "action-1",
      toolName: "web.search",
      phase: "end",
      resultClass: "failed",
      errorClass: "tool_timeout",
      outcome: "timeout",
      reasonCode: "tool_timeout",
    });
  });
});
