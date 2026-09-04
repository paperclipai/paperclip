import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CAPABILITY_LIVE_PROCESS_WAIT_DEADLINE_MS,
  waitForCapabilityLiveProcess,
} from "../../test/wait-for-live-process.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("waitForCapabilityLiveProcess", () => {
  it("returns the callback's value when the first attempt succeeds", async () => {
    const result = await waitForCapabilityLiveProcess(
      "first-attempt-succeeds",
      () => "ok",
    );

    expect(result).toBe("ok");
  });

  it("retries a callback that throws, and returns the value when a later attempt succeeds", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const promise = waitForCapabilityLiveProcess(
      "retries-then-succeeds",
      () => {
        attempts += 1;
        if (attempts === 1) throw new Error("first attempt failed");
        return "recovered";
      },
    );

    await vi.advanceTimersByTimeAsync(100);

    await expect(promise).resolves.toBe("recovered");
    expect(attempts).toBe(2);
  });

  it("fails at the deadline when every attempt throws, naming the label and the elapsed time and carrying the last observed error as its cause", async () => {
    vi.useFakeTimers();
    const lastError = new Error("connection refused");
    const promise = waitForCapabilityLiveProcess("always-fails", () => {
      throw lastError;
    });
    const caughtError = promise.catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(
      CAPABILITY_LIVE_PROCESS_WAIT_DEADLINE_MS + 200,
    );

    const error = (await caughtError) as Error;
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("always-fails");
    expect(error.message).toContain(
      `did not settle within ${CAPABILITY_LIVE_PROCESS_WAIT_DEADLINE_MS}ms`,
    );
    expect(error.message).toMatch(/observed \d+ms/);
    expect(error.message).toContain("connection refused");
    expect(error.cause).toBe(lastError);
  });

  it("fails at the deadline, instead of running past it, when the callback never settles, and raises no unhandled rejection", async () => {
    vi.useFakeTimers();
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandledRejection);

    try {
      const promise = waitForCapabilityLiveProcess(
        "never-settles",
        () => new Promise<never>(() => {}),
      );
      const caughtError = promise.catch((error: unknown) => error);

      await vi.advanceTimersByTimeAsync(
        CAPABILITY_LIVE_PROCESS_WAIT_DEADLINE_MS + 200,
      );

      const error = (await caughtError) as Error;
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toContain("never-settles");
      expect(error.message).toContain(
        `did not settle within ${CAPABILITY_LIVE_PROCESS_WAIT_DEADLINE_MS}ms`,
      );
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }

    expect(unhandledRejections).toEqual([]);
  });

  it("raises no unhandled rejection when an attempt rejects after the deadline already won the race", async () => {
    vi.useFakeTimers();
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandledRejection);

    try {
      let rejectLateAttempt: (error: unknown) => void = () => {};
      const promise = waitForCapabilityLiveProcess(
        "late-rejection",
        () =>
          new Promise((_resolve, reject) => {
            rejectLateAttempt = reject;
          }),
      );
      const caughtError = promise.catch((error: unknown) => error);

      await vi.advanceTimersByTimeAsync(
        CAPABILITY_LIVE_PROCESS_WAIT_DEADLINE_MS + 200,
      );

      const error = (await caughtError) as Error;
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toContain("late-rejection");
      expect(error.message).toContain(
        `did not settle within ${CAPABILITY_LIVE_PROCESS_WAIT_DEADLINE_MS}ms`,
      );

      rejectLateAttempt(new Error("late attempt failure"));
      await vi.advanceTimersByTimeAsync(0);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }

    expect(unhandledRejections).toEqual([]);
  });
});
