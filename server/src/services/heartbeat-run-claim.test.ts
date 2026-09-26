import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HEARTBEAT_RUN_START_GRACE_MS,
  heartbeatRunHoldsNoLiveClaim,
} from "./issues.js";

const NOW = new Date("2026-09-26T12:00:00.000Z");
const createdAt = new Date(NOW.getTime() - 60_000);

beforeEach(() => {
  // The predicate reads the wall clock, so every fixture is anchored to NOW.
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

function run(overrides: {
  status: string;
  startedAt?: Date | null;
  createdAt?: Date;
  executionControlDeadlineAt?: Date | null;
}) {
  return {
    status: overrides.status,
    startedAt: overrides.startedAt ?? null,
    createdAt: overrides.createdAt ?? createdAt,
    executionControlDeadlineAt: overrides.executionControlDeadlineAt ?? null,
  };
}

describe("heartbeatRunHoldsNoLiveClaim", () => {
  // A queued run with no deadline is the state that pinned an issue forever:
  // nothing is terminal, so the reaper never fired and the 409 copy told the
  // reader to wait for a run that was never going to start.
  it("treats a missing run as holding no claim", () => {
    expect(heartbeatRunHoldsNoLiveClaim(null)).toBe(true);
  });

  it.each(["succeeded", "interrupted", "failed", "cancelled", "timed_out"])(
    "treats a %s run as holding no claim",
    (status) => {
      expect(
        heartbeatRunHoldsNoLiveClaim(run({ status, startedAt: NOW })),
      ).toBe(true);
    },
  );

  it("treats a running run as holding a live claim", () => {
    expect(
      heartbeatRunHoldsNoLiveClaim(run({ status: "running", startedAt: NOW })),
    ).toBe(false);
  });

  it("treats a freshly queued run as still holding its claim", () => {
    expect(heartbeatRunHoldsNoLiveClaim(run({ status: "queued" }))).toBe(false);
  });

  it("releases a queued run that never started past the start grace", () => {
    expect(
      heartbeatRunHoldsNoLiveClaim(
        run({
          status: "queued",
          createdAt: new Date(NOW.getTime() - HEARTBEAT_RUN_START_GRACE_MS - 1_000),
        }),
      ),
    ).toBe(true);
  });

  it("keeps a queued run exactly at the start grace boundary", () => {
    // Inclusive comparison: the grace is the deadline, so a run sitting on it
    // is overdue. Asserted explicitly so a future off-by-one is deliberate.
    expect(
      heartbeatRunHoldsNoLiveClaim(
        run({
          status: "queued",
          createdAt: new Date(NOW.getTime() - HEARTBEAT_RUN_START_GRACE_MS),
        }),
      ),
    ).toBe(true);
  });

  it("releases a queued run whose execution-control deadline has passed", () => {
    expect(
      heartbeatRunHoldsNoLiveClaim(
        run({
          status: "queued",
          executionControlDeadlineAt: new Date(NOW.getTime() - 1_000),
        }),
      ),
    ).toBe(true);
  });

  it("keeps a queued run whose control deadline is still in the future", () => {
    expect(
      heartbeatRunHoldsNoLiveClaim(
        run({
          status: "queued",
          executionControlDeadlineAt: new Date(NOW.getTime() + 60_000),
        }),
      ),
    ).toBe(false);
  });

  it.each(["claimed", "scheduled_retry"])(
    "does not release a %s run on the start grace",
    (status) => {
      // Only `queued` is a never-started run. A `claimed` or `scheduled_retry`
      // run is mid-lifecycle and must keep its claim until terminal.
      expect(
        heartbeatRunHoldsNoLiveClaim(
          run({
            status,
            createdAt: new Date(NOW.getTime() - HEARTBEAT_RUN_START_GRACE_MS - 1_000),
          }),
        ),
      ).toBe(false);
    },
  );
});
