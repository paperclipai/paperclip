import { describe, expect, it, vi } from "vitest";
import {
  completeTerminalCleanupFallback,
  MAX_TURN_CONTINUATION_RETRY_REASON,
  MAX_TURN_CONTINUATION_WAKE_REASON,
  resolveTerminalCleanupRetryOptions,
} from "../services/heartbeat.js";

describe("resolveTerminalCleanupRetryOptions", () => {
  it("uses the max-turn continuation retry when the policy is enabled with a positive budget", () => {
    expect(
      resolveTerminalCleanupRetryOptions({
        maxTurnCleanupPolicy: { enabled: true, maxAttempts: 3, delayMs: 4_000 },
        outcome: "failed",
        hasTransientRecoveryContract: true,
      }),
    ).toEqual({
      retryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
      wakeReason: MAX_TURN_CONTINUATION_WAKE_REASON,
      maxAttempts: 3,
      delayMs: 4_000,
    });
  });

  it("suppresses retry entirely when the policy is enabled but has a zero attempt budget", () => {
    // Mirrors the normal finalization path, which only schedules a max-turn
    // retry when `policy.enabled && policy.maxAttempts > 0`. The cleanup
    // fallback must not fall through to the transient retry in that case.
    expect(
      resolveTerminalCleanupRetryOptions({
        maxTurnCleanupPolicy: { enabled: true, maxAttempts: 0, delayMs: 4_000 },
        outcome: "failed",
        hasTransientRecoveryContract: true,
      }),
    ).toBeNull();
  });

  it("suppresses retry entirely when the policy is disabled, even with a budget", () => {
    expect(
      resolveTerminalCleanupRetryOptions({
        maxTurnCleanupPolicy: { enabled: false, maxAttempts: 3, delayMs: 4_000 },
        outcome: "failed",
        hasTransientRecoveryContract: true,
      }),
    ).toBeNull();
  });

  it("falls back to the default bounded transient retry when no max-turn policy applies", () => {
    expect(
      resolveTerminalCleanupRetryOptions({
        maxTurnCleanupPolicy: null,
        outcome: "failed",
        hasTransientRecoveryContract: true,
      }),
    ).toEqual({});
  });

  it("schedules nothing without a max-turn policy or a failed run with a transient contract", () => {
    expect(
      resolveTerminalCleanupRetryOptions({
        maxTurnCleanupPolicy: null,
        outcome: "failed",
        hasTransientRecoveryContract: false,
      }),
    ).toBeNull();
    expect(
      resolveTerminalCleanupRetryOptions({
        maxTurnCleanupPolicy: null,
        outcome: "succeeded",
        hasTransientRecoveryContract: true,
      }),
    ).toBeNull();
    expect(
      resolveTerminalCleanupRetryOptions({
        maxTurnCleanupPolicy: null,
        outcome: "cancelled",
        hasTransientRecoveryContract: true,
      }),
    ).toBeNull();
  });
});

describe("terminal heartbeat cleanup fallback", () => {
  it("continues required cleanup after earlier steps fail", async () => {
    const calls: string[] = [];
    const onError = vi.fn();

    await completeTerminalCleanupFallback({
      finalizeWakeup: async () => {
        calls.push("wakeup");
        throw new Error("wakeup failed");
      },
      scheduleRetry: async () => {
        calls.push("retry");
      },
      releaseIssue: async (options) => {
        calls.push("issue_release");
        expect(options).toEqual({
          suppressImmediateRecovery: false,
          suppressDeferredPromotion: false,
        });
        throw new Error("release failed");
      },
      finalizeAgent: async () => {
        calls.push("agent");
      },
      onError,
    });

    expect(calls).toEqual(["wakeup", "retry", "issue_release", "agent"]);
    expect(onError.mock.calls.map(([step]) => step)).toEqual(["wakeup", "issue_release"]);
  });

  it("suppresses immediate and deferred recovery when bounded retry scheduling fails", async () => {
    const releaseIssue = vi.fn(async () => undefined);
    const finalizeAgent = vi.fn(async () => undefined);
    const onError = vi.fn();

    await completeTerminalCleanupFallback({
      scheduleRetry: async () => {
        throw new Error("retry scheduling failed");
      },
      releaseIssue,
      finalizeAgent,
      onError,
    });

    expect(releaseIssue).toHaveBeenCalledWith({
      suppressImmediateRecovery: true,
      suppressDeferredPromotion: true,
    });
    expect(finalizeAgent).toHaveBeenCalledOnce();
    expect(onError.mock.calls.map(([step]) => step)).toEqual(["retry"]);
  });

  it("keeps recovery suppressed after an ambiguous earlier retry failure", async () => {
    const releaseIssue = vi.fn(async () => undefined);

    await completeTerminalCleanupFallback({
      suppressRecoveryBeforeRetry: true,
      releaseIssue,
      onError: vi.fn(),
    });

    expect(releaseIssue).toHaveBeenCalledWith({
      suppressImmediateRecovery: true,
      suppressDeferredPromotion: true,
    });
  });

  it("skips omitted steps without reporting them", async () => {
    const calls: string[] = [];
    const reported: string[] = [];

    await completeTerminalCleanupFallback({
      finalizeWakeup: async () => {
        calls.push("wakeup");
      },
      releaseIssue: async () => {
        calls.push("issue_release");
      },
      // scheduleRetry and finalizeAgent intentionally omitted.
      onError: (step) => {
        reported.push(step);
      },
    });

    expect(calls).toEqual(["wakeup", "issue_release"]);
    expect(reported).toEqual([]);
  });

  it("continues cleanup when error reporting also fails", async () => {
    const calls: string[] = [];

    await completeTerminalCleanupFallback({
      finalizeWakeup: async () => {
        calls.push("wakeup");
        throw new Error("wakeup failed");
      },
      scheduleRetry: async () => {
        calls.push("retry");
      },
      releaseIssue: async () => {
        calls.push("issue_release");
      },
      finalizeAgent: async () => {
        calls.push("agent");
      },
      onError: () => {
        calls.push("report");
        throw new Error("error reporter failed");
      },
    });

    expect(calls).toEqual(["wakeup", "report", "retry", "issue_release", "agent"]);
  });
});
