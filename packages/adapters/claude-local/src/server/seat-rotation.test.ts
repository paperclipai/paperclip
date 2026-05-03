import { describe, expect, it } from "vitest";
import {
  retryDuringSeatRotation,
  type SeatRotationMarker,
} from "./seat-rotation.js";

interface FakeAttempt {
  ok: boolean;
}

function makeFakeMarker(overrides: Partial<SeatRotationMarker> = {}): SeatRotationMarker {
  return {
    from: "acct-a",
    to: "acct-b",
    startedAt: new Date().toISOString(),
    expectedDurationMs: 30_000,
    pid: 12345,
    ...overrides,
  };
}

describe("retryDuringSeatRotation", () => {
  it("returns the initial attempt unchanged when it is not an access error", async () => {
    const initial: FakeAttempt = { ok: true };
    const runAttempt = async (): Promise<FakeAttempt> => {
      throw new Error("runAttempt should not be called when initial succeeded");
    };
    const result = await retryDuringSeatRotation(initial, (a) => !a.ok, runAttempt);
    expect(result).toBe(initial);
  });

  it("retries until the next attempt succeeds, while marker is live", async () => {
    const attempts: FakeAttempt[] = [
      { ok: false },
      { ok: false },
      { ok: true },
    ];
    let nextIndex = 1;
    const runAttempt = async (): Promise<FakeAttempt> => {
      const attempt = attempts[nextIndex];
      nextIndex += 1;
      if (!attempt) throw new Error("Exhausted scripted attempts");
      return attempt;
    };

    let virtualNow = 0;
    const sleeps: number[] = [];
    const result = await retryDuringSeatRotation<FakeAttempt>(
      attempts[0]!,
      (a) => !a.ok,
      runAttempt,
      {
        totalBudgetMs: 45_000,
        baseBackoffMs: 3_000,
        isInProgress: () => ({ inProgress: true, marker: makeFakeMarker() }),
        sleep: async (ms) => {
          sleeps.push(ms);
          virtualNow += ms;
        },
        now: () => virtualNow,
      },
    );

    expect(result.ok).toBe(true);
    expect(sleeps).toEqual([3_000, 6_000]);
  });

  it("stops retrying once the budget is exhausted, even with live marker", async () => {
    const failing: FakeAttempt = { ok: false };
    let calls = 0;
    const runAttempt = async (): Promise<FakeAttempt> => {
      calls += 1;
      return failing;
    };

    let virtualNow = 0;
    const sleeps: number[] = [];
    const result = await retryDuringSeatRotation<FakeAttempt>(
      failing,
      (a) => !a.ok,
      runAttempt,
      {
        totalBudgetMs: 10_000,
        baseBackoffMs: 3_000,
        isInProgress: () => ({ inProgress: true, marker: makeFakeMarker() }),
        sleep: async (ms) => {
          sleeps.push(ms);
          virtualNow += ms;
        },
        now: () => virtualNow,
      },
    );

    expect(result).toBe(failing);
    // 3s, 6s. Third attempt would compute remaining=10_000-9_000=1_000 and sleep 1_000ms
    // before the final retry; loop then exits because budget exhausted.
    expect(sleeps).toEqual([3_000, 6_000, 1_000]);
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it("retries at most once when the marker is absent (no rotator in progress)", async () => {
    const failing: FakeAttempt = { ok: false };
    let calls = 0;
    const runAttempt = async (): Promise<FakeAttempt> => {
      calls += 1;
      return failing;
    };

    let virtualNow = 0;
    const sleeps: number[] = [];
    const result = await retryDuringSeatRotation<FakeAttempt>(
      failing,
      (a) => !a.ok,
      runAttempt,
      {
        totalBudgetMs: 45_000,
        baseBackoffMs: 3_000,
        isInProgress: () => ({ inProgress: false, marker: null }),
        sleep: async (ms) => {
          sleeps.push(ms);
          virtualNow += ms;
        },
        now: () => virtualNow,
      },
    );

    expect(result).toBe(failing);
    expect(calls).toBe(1);
    expect(sleeps).toEqual([3_000]);
  });

  it("retries at most once when the marker is stale", async () => {
    const failing: FakeAttempt = { ok: false };
    let calls = 0;
    const runAttempt = async (): Promise<FakeAttempt> => {
      calls += 1;
      return failing;
    };

    let virtualNow = 0;
    const sleeps: number[] = [];
    const staleMarker = makeFakeMarker({ startedAt: "2020-01-01T00:00:00Z" });
    const result = await retryDuringSeatRotation<FakeAttempt>(
      failing,
      (a) => !a.ok,
      runAttempt,
      {
        totalBudgetMs: 45_000,
        baseBackoffMs: 3_000,
        isInProgress: () => ({ inProgress: false, marker: staleMarker }),
        sleep: async (ms) => {
          sleeps.push(ms);
          virtualNow += ms;
        },
        now: () => virtualNow,
      },
    );

    expect(result).toBe(failing);
    expect(calls).toBe(1);
    expect(sleeps).toEqual([3_000]);
  });
});
