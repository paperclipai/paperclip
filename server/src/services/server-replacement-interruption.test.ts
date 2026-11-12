import { describe, expect, it } from "vitest";
import { isServerReplacementInterruption } from "./server-replacement-interruption.js";
import {
  accountingForScheduledRetry, executionFailureRetryCount, SERVER_RESTART_RETRY_MAX_ATTEMPTS, SERVER_RESTART_RETRY_REASON,
  SERVER_RESTART_RETRY_WINDOW_MS, serverRestartAttemptCount, serverRestartBudgetSpent,
} from "./execution-recovery-attempt.js";
import { failedRunRetryBudgetSpent, usesServerRestartLane } from "./heartbeat/retries.js";

const thisBoot = "boot-current";
const run = (patch: Record<string, unknown>) => ({ runtimeMode: "legacy", status: "failed", errorCode: "process_lost",
  resultJson: null, controllerBootId: null, ...patch }) as Parameters<typeof isServerReplacementInterruption>[0];

describe("isServerReplacementInterruption", () => {
  it("names a graceful shutdown and a restart-caused process loss, never a run's own failure", () => {
    expect(isServerReplacementInterruption(run({ status: "interrupted", errorCode: "server_shutdown_interrupted" }), thisBoot)).toBe(true);
    expect(isServerReplacementInterruption(run({ resultJson: { processLossDiagnostic: { controllerReplaced: true } } }), thisBoot)).toBe(true);
    expect(isServerReplacementInterruption(run({ resultJson: { processLossDiagnostic: { controllerReplaced: false } },
      controllerBootId: "boot-old" }), thisBoot)).toBe(false);
    expect(isServerReplacementInterruption(run({ errorCode: "adapter_failed", controllerBootId: "boot-old" }), thisBoot)).toBe(false);
    expect(isServerReplacementInterruption(run({ runtimeMode: "native", status: "interrupted",
      errorCode: "server_shutdown_interrupted" }), thisBoot)).toBe(false);
  });

  it("reads rows saved by an older release from the owner boot or the observer start", () => {
    expect(isServerReplacementInterruption(run({ controllerBootId: "boot-old" }), thisBoot)).toBe(true);
    expect(isServerReplacementInterruption(run({ controllerBootId: thisBoot }), thisBoot)).toBe(false);
    expect(isServerReplacementInterruption(run({ resultJson: { processLossDiagnostic: { runPredatesObserver: true } } }), thisBoot)).toBe(true);
    expect(isServerReplacementInterruption(run({ resultJson: { processLossDiagnostic: { runPredatesObserver: false } } }), thisBoot)).toBe(false);
  });
});

describe("server-restart retry accounting", () => {
  const now = new Date("2026-11-12T04:00:00.000Z");

  it("counts restarts in a window, keeps the failure count, and opens a new window after it closes", () => {
    const base = { contextSnapshot: { executionRetryAccounting: { version: 1, failureRetries: 2, maxTurnContinuations: 0 } } };
    const first = accountingForScheduledRetry(base, SERVER_RESTART_RETRY_REASON, 1, now);
    expect(first).toMatchObject({ failureRetries: 2, serverRestarts: 1, serverRestartWindowStartedAt: now.toISOString() });
    const chained = { contextSnapshot: { executionRetryAccounting: first } };
    expect(executionFailureRetryCount(chained)).toBe(2);
    const later = new Date(now.getTime() + 5 * 60_000);
    expect(serverRestartAttemptCount(chained, later)).toBe(1);
    const second = accountingForScheduledRetry(chained, SERVER_RESTART_RETRY_REASON, 2, later);
    expect(second).toMatchObject({ serverRestarts: 2, serverRestartWindowStartedAt: now.toISOString() });
    const afterWindow = new Date(now.getTime() + SERVER_RESTART_RETRY_WINDOW_MS);
    expect(serverRestartAttemptCount({ contextSnapshot: { executionRetryAccounting: second } }, afterWindow)).toBe(0);
  });

  it("trips at the bound inside one window", () => {
    const spent = { contextSnapshot: { executionRetryAccounting: { version: 1, failureRetries: 0, maxTurnContinuations: 0,
      serverRestarts: SERVER_RESTART_RETRY_MAX_ATTEMPTS, serverRestartWindowStartedAt: now.toISOString() } } };
    expect(serverRestartBudgetSpent(spent, new Date(now.getTime() + 60_000))).toBe(true);
    expect(serverRestartBudgetSpent(spent, new Date(now.getTime() + SERVER_RESTART_RETRY_WINDOW_MS))).toBe(false);
  });

  it("charges only the restart bound to a restart, and the failure budget to a failure", () => {
    const spentFailures = { executionRetryAccounting: { version: 1, failureRetries: 2, maxTurnContinuations: 0 } };
    const interrupted = { ...run({ status: "interrupted", errorCode: "server_shutdown_interrupted" }), contextSnapshot: spentFailures };
    expect(usesServerRestartLane(interrupted)).toBe(true);
    expect(failedRunRetryBudgetSpent(interrupted, now)).toBe(false);
    const failed = { ...run({ errorCode: "adapter_failed" }), contextSnapshot: spentFailures };
    expect(usesServerRestartLane(failed)).toBe(false);
    expect(failedRunRetryBudgetSpent(failed, now)).toBe(true);
    // A preparation that started no provider work keeps its own lane while
    // the chain has failure budget left.
    const preparation = { ...run({ status: "interrupted", errorCode: "server_shutdown_interrupted",
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } }), contextSnapshot: {} };
    expect(usesServerRestartLane(preparation)).toBe(false);
    expect(usesServerRestartLane({ ...preparation, contextSnapshot: spentFailures })).toBe(true);
  });
});
