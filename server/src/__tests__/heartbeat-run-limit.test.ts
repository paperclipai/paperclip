import { describe, expect, it } from "vitest";
import { countLiveRunLimitRelevantRuns, hasReachedLiveRunLimit } from "../services/heartbeat-run-limit.ts";

describe("heartbeat run live-limit helpers", () => {
  it("counts only running runs toward the live-run limit", () => {
    const runs = [
      { status: "queued" },
      { status: "running" },
      { status: "queued" },
      { status: "failed" },
    ];

    expect(countLiveRunLimitRelevantRuns(runs)).toBe(1);
  });

  it("treats queued backlog as non-saturating until running capacity is exhausted", () => {
    const runs = [
      { status: "queued" },
      { status: "running" },
    ];

    expect(hasReachedLiveRunLimit(runs, 2)).toBe(false);
    expect(hasReachedLiveRunLimit(runs, 1)).toBe(true);
  });

  it("ignores running rows that have stayed quiet past the owned-run window", () => {
    const quietAt = new Date(Date.now() - 11 * 60_000);
    const runs = [
      {
        status: "running",
        createdAt: quietAt,
        startedAt: quietAt,
        updatedAt: quietAt,
        lastActivityAt: quietAt,
      },
      {
        status: "queued",
        createdAt: quietAt,
      },
    ];

    expect(countLiveRunLimitRelevantRuns(runs)).toBe(0);
    expect(hasReachedLiveRunLimit(runs, 1)).toBe(false);
  });
});
