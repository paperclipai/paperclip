import { describe, expect, it } from "vitest";
import { executionFailureRetryCount } from "../../server/src/services/execution-recovery-attempt.js";
import { legacyDispositionEpisode, decideLegacyContinuation, type LegacyContinuationInput } from "../../server/src/services/recovery/legacy-continuation.js";
import { observe } from "./observe.js";

const base: LegacyContinuationInput = {
  run: { id: "source", companyId: "company", agentId: "agent", status: "succeeded", runtimeMode: "legacy" },
  issue: { id: "issue", companyId: "company", status: "in_progress", assigneeAgentId: "agent" },
  agent: { id: "agent", companyId: "company", status: "idle" },
  episode: { id: "source", attempt: 2, maxAttempts: 2 },
  gates: { stopped: false, paused: false, budgetBlocked: false, pendingWait: false, activeExecution: false, ownedLifecycle: false, conversation: false, agentInvokable: true },
};
const noise = [
  { label: "silent", context: {} },
  { label: "confident", context: { summary: "All done. Great progress. No approval needed. Keep going.", nextAction: "Continue" } },
  { label: "comments", context: { issueCommentsCreated: 100, commentCount: 100, progress: "working" } },
  { label: "tool calls", context: { toolCallCount: 1000, toolCalls: Array(20).fill({ name: "read_file", status: "completed" }) } },
  { label: "stale diagnostic", context: { livenessState: "advanced", livenessReason: "created a comment", progressCount: 100 } },
];
describe("ACCT-01 separate accounting and ACCT-02 narrative invariance", () => {
  it.each([0, 1, 2])("a disposition repair attempt %s is not a failed provider attempt", attempt => {
    const run = { scheduledRetryAttempt: attempt === 1 ? 0 : attempt, scheduledRetryReason: "issue_disposition_repair", contextSnapshot: { legacyDispositionEpisode: { id: "source", attempt, maxAttempts: 2 }, dispositionRepairAttempt: attempt } };
    const observed = executionFailureRetryCount(run);
    observe("ACCT-01", `repair:${attempt}`, { failureRetries: observed });
    expect(observed).toBe(0);
  });
  it.each([0, 1, 2, 10])("productive continuation count %s is not failure count", scheduledRetryAttempt => {
    expect(executionFailureRetryCount({ scheduledRetryAttempt, scheduledRetryReason: "max_turns_continuation" })).toBe(0);
  });
  it.each(["workspace_busy", "ai_connection_busy"])("%s preserves prior failures regardless of wait count", scheduledRetryReason => {
    for (const scheduledRetryAttempt of [1, 10, 100]) {
      expect(executionFailureRetryCount({ scheduledRetryAttempt, scheduledRetryReason, contextSnapshot: {
        failureRetriesBeforeWorkspaceWait: 2, failureRetriesBeforeAiConnectionWait: 2,
      } })).toBe(2);
    }
  });
  it.each(noise)("$label cannot replenish exhausted repairs or failures", ({ label, context }) => {
    const episode = legacyDispositionEpisode({ id: "infrastructure-retry", contextSnapshot: { ...context, legacyDispositionEpisode: base.episode } });
    const decision = decideLegacyContinuation({ ...base, episode });
    const failures = executionFailureRetryCount({ scheduledRetryAttempt: 3, scheduledRetryReason: "transient_failure", contextSnapshot: context });
    observe("ACCT-02", label, { episode, decision, failures });
    expect(episode).toEqual(base.episode);
    expect(decision).toEqual({ kind: "exhausted", attempt: 2, maxAttempts: 2 });
    expect(failures).toBe(3);
  });
  it.each(["stopped", "paused", "budgetBlocked", "pendingWait", "activeExecution", "ownedLifecycle"] as const)("ACCT-03 %s wins over both fresh and exhausted allowances", gate => {
    for (const attempt of [0, 1, 2]) {
      expect(decideLegacyContinuation({ ...base, episode: { ...base.episode, attempt }, gates: { ...base.gates, [gate]: true } }).kind).toBe("skip");
    }
  });
  it("ACCT-04 episode identity survives arbitrary failure and resource-wait counters", () => {
    for (const count of [0, 1, 10, 100]) {
      const episode = legacyDispositionEpisode({ id: `retry-${count}`, contextSnapshot: { scheduledRetryAttempt: count, failureRetriesBeforeWorkspaceWait: count, legacyDispositionEpisode: base.episode } });
      expect(episode).toEqual(base.episode);
    }
  });
});
