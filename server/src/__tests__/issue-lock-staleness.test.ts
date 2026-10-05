import { describe, expect, it } from "vitest";
import {
  STALE_QUEUED_RUN_GRACE_MS,
  heartbeatRunLockIsStale,
} from "../services/issue-lock-staleness.js";

const NOW = new Date("2026-10-05T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const ahead = (ms: number) => new Date(NOW.getTime() + ms);

const queuedRun = (overrides: Record<string, unknown> = {}) => ({
  status: "queued",
  startedAt: null,
  scheduledRetryAt: null,
  createdAt: ago(STALE_QUEUED_RUN_GRACE_MS * 2),
  updatedAt: ago(STALE_QUEUED_RUN_GRACE_MS * 2),
  ...overrides,
});

describe("heartbeatRunLockIsStale", () => {
  it("treats a missing run as no claim", () => {
    expect(heartbeatRunLockIsStale(null, NOW)).toBe(true);
    expect(heartbeatRunLockIsStale(undefined, NOW)).toBe(true);
  });

  it.each(["succeeded", "interrupted", "failed", "cancelled", "timed_out"])(
    "treats a %s run as no claim",
    (status) => {
      expect(heartbeatRunLockIsStale(queuedRun({ status }), NOW)).toBe(true);
    },
  );

  it("keeps a running run's lock", () => {
    expect(
      heartbeatRunLockIsStale(
        queuedRun({ status: "running", startedAt: ago(60_000) }),
        NOW,
      ),
    ).toBe(false);
  });

  it("keeps a scheduled_retry run's lock no matter how old it is", () => {
    expect(
      heartbeatRunLockIsStale(
        queuedRun({ status: "scheduled_retry", startedAt: null }),
        NOW,
      ),
    ).toBe(false);
  });

  it("keeps a queued run that already started", () => {
    expect(
      heartbeatRunLockIsStale(queuedRun({ startedAt: ago(60_000) }), NOW),
    ).toBe(false);
  });

  it("reaps a queued, never-started run with no armed retry past the grace window", () => {
    expect(heartbeatRunLockIsStale(queuedRun(), NOW)).toBe(true);
  });

  it("keeps a freshly queued run inside the grace window", () => {
    expect(
      heartbeatRunLockIsStale(
        queuedRun({ createdAt: ago(60_000), updatedAt: ago(60_000) }),
        NOW,
      ),
    ).toBe(false);
  });

  it("keeps a queued run whose armed retry is still in the future", () => {
    expect(
      heartbeatRunLockIsStale(
        queuedRun({ scheduledRetryAt: ahead(STALE_QUEUED_RUN_GRACE_MS * 2) }),
        NOW,
      ),
    ).toBe(false);
  });

  it("reaps a queued run whose armed retry is overdue", () => {
    expect(
      heartbeatRunLockIsStale(
        queuedRun({
          createdAt: ago(60_000),
          updatedAt: ago(60_000),
          scheduledRetryAt: ago(STALE_QUEUED_RUN_GRACE_MS * 2),
        }),
        NOW,
      ),
    ).toBe(true);
  });

  it("anchors the age on the oldest timestamp so a future-dated column cannot pin a dead lock", () => {
    expect(
      heartbeatRunLockIsStale(
        queuedRun({ createdAt: ahead(6 * 60 * 60 * 1000) }),
        NOW,
      ),
    ).toBe(true);
  });

  it("keeps a run conservatively locked when every timestamp is future-dated", () => {
    expect(
      heartbeatRunLockIsStale(
        queuedRun({
          createdAt: ahead(6 * 60 * 60 * 1000),
          updatedAt: ahead(6 * 60 * 60 * 1000),
        }),
        NOW,
      ),
    ).toBe(false);
  });

  it("keeps a queued run with no timestamps at all", () => {
    expect(
      heartbeatRunLockIsStale(
        queuedRun({ createdAt: null, updatedAt: null }),
        NOW,
      ),
    ).toBe(false);
  });
});