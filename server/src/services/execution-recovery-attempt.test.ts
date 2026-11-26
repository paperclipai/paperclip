import { describe, expect, it } from "vitest";
import { accountingForScheduledRetry, AGENT_DIRECTORY_WAIT_RETRY_REASON, executionFailureRetryCount, executionRetryAttemptCount, INTERRUPTED_PREPARATION_RETRY_MAX_ATTEMPTS, INTERRUPTED_PREPARATION_RETRY_REASON } from "./execution-recovery-attempt.js";
import { AGENT_DIRECTORY_BUSY_MAX_DEFERRALS } from "./heartbeat/agent-directory-busy.js";
import { RUNNER_REVISION_WAIT_RETRY_REASON } from "./runner-revision-mismatch.js";
import { RUNNER_REVISION_WAIT_RETRY_REASON as DISPATCH_RUNNER_REVISION_WAIT_RETRY_REASON } from "../modules/run-dispatch/index.js";

describe("failure attempts across resource waits", () => {
  it("preserves prior failures through subscription waits without trusting unrelated context", () => {
    expect(executionFailureRetryCount({ scheduledRetryReason: "ai_connection_busy", scheduledRetryAttempt: 12,
      contextSnapshot: { failureRetriesBeforeAiConnectionWait: 1 } })).toBe(1);
    expect(executionFailureRetryCount({ scheduledRetryReason: "transient_failure", scheduledRetryAttempt: 2,
      contextSnapshot: { failureRetriesBeforeAiConnectionWait: 0 } })).toBe(2);
    for (const count of [undefined, -1, 1.5, "0"]) {
      expect(executionFailureRetryCount({ scheduledRetryReason: "ai_connection_busy", scheduledRetryAttempt: 4,
        contextSnapshot: { failureRetriesBeforeAiConnectionWait: count } })).toBe(4);
    }
  });
  it("preserves prior failures through repeated workspace waits", () => {
    expect(executionFailureRetryCount({ scheduledRetryReason: "workspace_busy", scheduledRetryAttempt: 12,
      contextSnapshot: { failureRetriesBeforeWorkspaceWait: 1 } })).toBe(1);
  });
  it("does not trust a caller-supplied count outside a server-created workspace retry", () => {
    expect(executionFailureRetryCount({ scheduledRetryReason: "transient_failure", scheduledRetryAttempt: 2,
      contextSnapshot: { failureRetriesBeforeWorkspaceWait: 0 } })).toBe(2);
  });
  it("keeps ambiguous historical counts without treating a historical productive count as failures", () => {
    expect(executionFailureRetryCount({ scheduledRetryReason: "workspace_busy", scheduledRetryAttempt: 4 })).toBe(4);
    expect(executionFailureRetryCount({ scheduledRetryReason: "max_turns_continuation", scheduledRetryAttempt: 4 })).toBe(0);
  });
});

describe("persisted independent accounting", () => {
  it.each(["max_turns_continuation", "issue_disposition_repair", "workspace_busy", "ai_connection_busy", "ai_connection_pool_wait", "runner_revision_wait", "storage_unavailable_wait"])("%s cannot erase prior infrastructure debits or spend more", scheduledRetryReason => {
    expect(executionFailureRetryCount({ scheduledRetryReason, scheduledRetryAttempt: 20,
      contextSnapshot: { executionRetryAccounting: { version: 1, failureRetries: 2, maxTurnContinuations: 1 } },
    })).toBe(2);
  });
  it("never lowers the current failure count from a partial or stale ledger", () => {
    for (const executionRetryAccounting of [
      { version: 1, failureRetries: 0, maxTurnContinuations: 1 },
      { version: 1, failureRetries: -1, maxTurnContinuations: 1 },
      { version: 1, failureRetries: "0", maxTurnContinuations: 1 },
      { version: 2, failureRetries: 0, maxTurnContinuations: 1 },
    ]) expect(executionFailureRetryCount({ scheduledRetryReason: "transient_failure", scheduledRetryAttempt: 2,
      contextSnapshot: { executionRetryAccounting },
    })).toBe(2);
  });
});

describe("Runner update waits", () => {
  it("uses the same retry reason as run dispatch", () => {
    expect(RUNNER_REVISION_WAIT_RETRY_REASON).toBe(DISPATCH_RUNNER_REVISION_WAIT_RETRY_REASON);
  });
  const ledger = (failureRetries: number) => ({ executionRetryAccounting: { version: 1, failureRetries, maxTurnContinuations: 0 } });
  it("never spend the failure retry budget", () => {
    const waited = { scheduledRetryReason: "runner_revision_wait", scheduledRetryAttempt: 9, contextSnapshot: ledger(0) };
    expect(executionRetryAttemptCount(waited, "runner_revision_wait")).toBe(9);
    expect(accountingForScheduledRetry(waited, "runner_revision_wait", 10)).toMatchObject({ failureRetries: 0 });
    expect(executionFailureRetryCount(waited)).toBe(0);
    expect(executionRetryAttemptCount(waited, "transient_failure")).toBe(0);
  });
  it("keep failures recorded before the wait and are not shortened by them", () => {
    const failed = { scheduledRetryReason: "transient_failure", scheduledRetryAttempt: 1, contextSnapshot: ledger(1) };
    expect(executionRetryAttemptCount(failed, "runner_revision_wait")).toBe(0);
    const waited = { scheduledRetryReason: "runner_revision_wait", scheduledRetryAttempt: 3,
      contextSnapshot: { ...ledger(1), executionRetryAccounting: accountingForScheduledRetry(failed, "runner_revision_wait", 3) } };
    expect(executionFailureRetryCount(waited)).toBe(1);
    expect(executionRetryAttemptCount(waited, "transient_failure")).toBe(1);
  });
});

// Section F: a preparation interrupted before provider work started spent no
// provider work, so it never charges the failure budget. Its own lane counts
// its retries, up to the same cap as native controller generations.
describe("interrupted preparation retries", () => {
  const accounting = (failureRetries: number) => ({ version: 1, failureRetries, maxTurnContinuations: 0 });
  it("keeps the failure count when scheduling an interrupted-preparation retry", () => {
    const source = { scheduledRetryReason: "transient_failure", scheduledRetryAttempt: 1,
      contextSnapshot: { executionRetryAccounting: accounting(1) } };
    expect(executionRetryAttemptCount(source, INTERRUPTED_PREPARATION_RETRY_REASON)).toBe(0);
    expect(accountingForScheduledRetry(source, INTERRUPTED_PREPARATION_RETRY_REASON, 1))
      .toEqual({ ...accounting(1), interruptedPreparations: 1 });
  });
  it("counts consecutive interrupted preparations in their own lane, never as failures", () => {
    const retry = { scheduledRetryReason: INTERRUPTED_PREPARATION_RETRY_REASON, scheduledRetryAttempt: 5,
      contextSnapshot: { executionRetryAccounting: accounting(0) } };
    expect(executionRetryAttemptCount(retry, INTERRUPTED_PREPARATION_RETRY_REASON)).toBe(5);
    expect(executionFailureRetryCount(retry)).toBe(0);
    expect(accountingForScheduledRetry(retry, INTERRUPTED_PREPARATION_RETRY_REASON, 6))
      .toEqual({ ...accounting(0), interruptedPreparations: 6 });
    expect(INTERRUPTED_PREPARATION_RETRY_MAX_ATTEMPTS).toBe(12);
  });
  it("keeps the interrupted-preparation count across a wait retry in between", () => {
    const prepared = accountingForScheduledRetry({ scheduledRetryReason: INTERRUPTED_PREPARATION_RETRY_REASON,
      scheduledRetryAttempt: 4, contextSnapshot: { executionRetryAccounting: accounting(0) } },
    INTERRUPTED_PREPARATION_RETRY_REASON, 5);
    expect(prepared).toEqual({ ...accounting(0), interruptedPreparations: 5 });
    // A workspace wait in between carries the chain's accounting forward.
    const waited = { scheduledRetryReason: "workspace_busy", scheduledRetryAttempt: 1,
      contextSnapshot: { executionRetryAccounting: accountingForScheduledRetry(
        { contextSnapshot: { executionRetryAccounting: prepared } }, "workspace_busy", 1) } };
    expect(executionRetryAttemptCount(waited, INTERRUPTED_PREPARATION_RETRY_REASON)).toBe(5);
  });
  it("still charges a real failure after interrupted preparations", () => {
    const retry = { scheduledRetryReason: INTERRUPTED_PREPARATION_RETRY_REASON, scheduledRetryAttempt: 3,
      contextSnapshot: { executionRetryAccounting: accounting(1) } };
    expect(executionRetryAttemptCount(retry, "transient_failure")).toBe(1);
    expect(accountingForScheduledRetry(retry, "transient_failure", 2).failureRetries).toBe(2);
  });
});

describe("storage outage waits", () => {
  it("keep their count through an intervening workspace wait", () => {
    const afterStorage = { scheduledRetryReason: "storage_unavailable_wait", scheduledRetryAttempt: 7,
      contextSnapshot: { executionRetryAccounting: { version: 1, failureRetries: 1, maxTurnContinuations: 0 } } };
    const ledger = accountingForScheduledRetry(afterStorage, "workspace_busy", 1);
    expect(ledger).toMatchObject({ storageWaits: 7, failureRetries: 1 });
    const afterWorkspaceWait = { scheduledRetryReason: "workspace_busy", scheduledRetryAttempt: 1,
      contextSnapshot: { executionRetryAccounting: ledger } };
    expect(executionRetryAttemptCount(afterWorkspaceWait, "storage_unavailable_wait")).toBe(7);
    expect(accountingForScheduledRetry(afterWorkspaceWait, "storage_unavailable_wait", 8)).toMatchObject({ storageWaits: 8, failureRetries: 1 });
    expect(executionFailureRetryCount(afterWorkspaceWait)).toBe(1);
  });
});

describe("agent directory waits", () => {
  it("keep their count through alternating workspace waits and stop at the bound", () => {
    let run: { scheduledRetryReason: string; scheduledRetryAttempt: number; contextSnapshot: Record<string, unknown> } = {
      scheduledRetryReason: "transient_failure", scheduledRetryAttempt: 1,
      contextSnapshot: { executionRetryAccounting: { version: 1, failureRetries: 1, maxTurnContinuations: 0 } } };
    let directoryWaits = 0;
    while (executionRetryAttemptCount(run, AGENT_DIRECTORY_WAIT_RETRY_REASON) < AGENT_DIRECTORY_BUSY_MAX_DEFERRALS) {
      const attempt = executionRetryAttemptCount(run, AGENT_DIRECTORY_WAIT_RETRY_REASON) + 1;
      run = { scheduledRetryReason: AGENT_DIRECTORY_WAIT_RETRY_REASON, scheduledRetryAttempt: attempt,
        contextSnapshot: { executionRetryAccounting: accountingForScheduledRetry(run, AGENT_DIRECTORY_WAIT_RETRY_REASON, attempt) } };
      directoryWaits++;
      const workspaceAttempt = executionRetryAttemptCount(run, "workspace_busy") + 1;
      run = { scheduledRetryReason: "workspace_busy", scheduledRetryAttempt: workspaceAttempt,
        contextSnapshot: { executionRetryAccounting: accountingForScheduledRetry(run, "workspace_busy", workspaceAttempt) } };
      expect(executionRetryAttemptCount(run, AGENT_DIRECTORY_WAIT_RETRY_REASON)).toBe(directoryWaits);
    }
    expect(directoryWaits).toBe(AGENT_DIRECTORY_BUSY_MAX_DEFERRALS);
    expect(executionFailureRetryCount(run)).toBe(1);
  });
});
