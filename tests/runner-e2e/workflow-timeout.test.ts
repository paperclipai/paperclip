import { describe, expect, it, vi } from "vitest";
import { pollUntil } from "./api.js";
import { classifyFailure } from "./failure-classifier.js";

describe("workflow timeout classification", () => {
  it("does not classify observed task data as an infrastructure error", async () => {
    vi.useFakeTimers();
    try {
      const pending = pollUntil({
        label: "everyday hire-reuse settled",
        deadlineAt: Date.now() + 10,
        intervalMs: 10,
        load: async () => ({
          status: "in_progress",
          connection: "server unavailable",
          secret: "plaintext in an ordinary task description",
        }),
        accept: () => false,
      });
      const caught = pending.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(11);
      const error = await caught;
      expect(classifyFailure(error)).toBe("candidate_failure");
      expect((error as Error).message).not.toContain(
        "ordinary task description",
      );
    } finally {
      vi.useRealTimers();
    }
  });
  it("keeps a failed network read retryable", async () => {
    vi.useFakeTimers();
    try {
      const caught = pollUntil({
        label: "task state",
        deadlineAt: Date.now() + 10,
        intervalMs: 10,
        load: async () => {
          throw new Error("ECONNRESET");
        },
        accept: () => false,
      }).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(11);
      expect(classifyFailure(await caught)).toBe("transient_infrastructure");
    } finally {
      vi.useRealTimers();
    }
  });
});
