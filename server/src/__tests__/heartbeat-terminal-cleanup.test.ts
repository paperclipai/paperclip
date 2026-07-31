import { describe, expect, it, vi } from "vitest";
import { completeTerminalCleanupFallback } from "../services/heartbeat.js";

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
