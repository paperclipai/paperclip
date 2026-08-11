// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deriveMonitorState,
  formatMonitorAbsolute,
  formatMonitorAbsoluteFull,
  formatMonitorEta,
  formatMonitorEtaLabel,
  formatMonitorOffset,
  useMonitorCountdown,
} from "./issue-monitor";

describe("monitor time formatting", () => {
  const now = new Date("2026-07-17T19:56:00.000Z");

  it.each([
    [45_000, "in 45s"],
    [5 * 60_000, "in 5m"],
    [2 * 60 * 60_000, "in 2h"],
    [(2 * 60 + 12) * 60_000, "in 2h 12m"],
    [(2 * 60 + 59) * 60_000, "in 2h 59m"],
    [(3 * 24 + 4) * 60 * 60_000, "in 3d 4h"],
    [3 * 24 * 60 * 60_000, "in 3d"],
  ])("formats future offset %i with up to two non-zero units", (offsetMs, expected) => {
    expect(formatMonitorEta(new Date(now.getTime() + offsetMs), now)).toBe(expected);
  });

  it("uses due-now grace before switching to overdue copy", () => {
    expect(formatMonitorEta(now, now)).toBe("due now");
    expect(formatMonitorEta(new Date(now.getTime() - 59_999), now)).toBe("due now");
    expect(formatMonitorEta(new Date(now.getTime() - 60_000), now)).toBe("overdue by 1m");
    expect(formatMonitorEta(new Date(now.getTime() - 12 * 60_000), now)).toBe("overdue by 12m");
  });

  it("formats sentence-case ETA labels without slicing prefixes", () => {
    expect(formatMonitorEtaLabel(new Date(now.getTime() + (2 * 60 + 12) * 60_000), now)).toBe("In 2h 12m");
    expect(formatMonitorEtaLabel(now, now)).toBe("Due now");
    expect(formatMonitorEtaLabel(new Date(now.getTime() - 18 * 60_000), now)).toBe("Overdue by 18m");
  });

  it("uses the injectable Date.now clock for scheduled retry offsets", () => {
    const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(now.getTime());
    expect(formatMonitorOffset(new Date(now.getTime() + 15 * 60_000))).toBe("in 15m");
    expect(formatMonitorOffset(new Date(now.getTime() + 10_000))).toBe("now");
    expect(formatMonitorOffset(now)).toBe("now");
    dateNowSpy.mockRestore();
  });

  it("formats the full local timestamp with weekday, year and zone", () => {
    const timestamp = "2026-07-17T21:08:00.000Z";
    const options = { locale: "en-US", timeZone: "America/Chicago" } as const;

    expect(formatMonitorAbsoluteFull(timestamp, options)).toBe("Friday, July 17, 2026, 4:08:00 PM CDT");
  });

  describe("formatMonitorAbsolute compact copy (wireframe 04)", () => {
    const options = { locale: "en-US", timeZone: "America/Chicago" } as const;
    // 2026-07-17T21:08:00Z is 4:08 PM in America/Chicago.
    const timestamp = "2026-07-17T21:08:00.000Z";

    it("says Today when the check lands on the reference day", () => {
      const now = "2026-07-17T14:00:00.000Z"; // 9:00 AM Chicago, same day
      expect(formatMonitorAbsolute(timestamp, options, now)).toBe("Today, 4:08 PM");
    });

    it("compares the day in the display time zone, not UTC", () => {
      // 2026-07-18T04:08:00Z is still 11:08 PM on Jul 17 in Chicago.
      const lateNight = "2026-07-18T04:08:00.000Z";
      const now = "2026-07-17T14:00:00.000Z"; // 9:00 AM Chicago, Jul 17
      expect(formatMonitorAbsolute(lateNight, options, now)).toBe("Today, 11:08 PM");
    });

    it("prefixes the weekday beyond today within the current year", () => {
      const later = "2026-07-20T14:00:00.000Z"; // 9:00 AM Chicago, Mon Jul 20
      const now = "2026-07-17T14:00:00.000Z";
      expect(formatMonitorAbsolute(later, options, now)).toBe("Mon Jul 20, 9:00 AM");
    });

    it("adds the year only when it differs from the reference year", () => {
      const nextYear = "2027-01-04T15:00:00.000Z"; // 9:00 AM Chicago, Mon Jan 4 2027
      const now = "2026-07-17T14:00:00.000Z";
      expect(formatMonitorAbsolute(nextYear, options, now)).toBe("Mon Jan 4, 2027, 9:00 AM");
    });
  });
});

describe("deriveMonitorState", () => {
  const now = new Date("2026-07-17T20:00:00.000Z");

  it("derives scheduled and retrying states with monitor details", () => {
    expect(
      deriveMonitorState(
        {
          executionPolicy: { monitor: { nextCheckAt: "2026-07-17T22:12:00.000Z", serviceName: "API" } },
          executionState: {
            monitor: {
              status: "scheduled",
              nextCheckAt: "2026-07-17T22:12:00.000Z",
              attemptCount: 1,
              serviceName: "API",
            },
          },
        },
        now,
      ),
    ).toEqual({
      state: "scheduled",
      source: "monitor",
      nextCheckAt: "2026-07-17T22:12:00.000Z",
      attemptCount: 1,
      serviceName: "API",
    });

    expect(
      deriveMonitorState(
        {
          executionState: {
            monitor: {
              status: "scheduled",
              nextCheckAt: "2026-07-17T22:12:00.000Z",
              attemptCount: 3,
              serviceName: "deploy health",
            },
          },
        },
        now,
      ).state,
    ).toBe("retrying");
  });

  it("derives due-now and overdue at the grace boundary", () => {
    const issue = (nextCheckAt: string) => ({
      executionState: { monitor: { status: "scheduled" as const, nextCheckAt, attemptCount: 1 } },
    });

    expect(deriveMonitorState(issue("2026-07-17T19:59:00.001Z"), now).state).toBe("due-now");
    expect(deriveMonitorState(issue("2026-07-17T19:59:00.000Z"), now).state).toBe("overdue");
  });

  it("derives cleared, none, and scheduled retry states", () => {
    expect(
      deriveMonitorState({ executionState: { monitor: { status: "cleared", attemptCount: 2 } } }, now),
    ).toMatchObject({ state: "cleared", attemptCount: 2 });
    expect(deriveMonitorState({}, now)).toEqual({
      state: "none",
      source: "none",
      nextCheckAt: null,
      attemptCount: 0,
      serviceName: null,
    });
    expect(
      deriveMonitorState(
        {
          monitorAttemptCount: 0,
          scheduledRetry: {
            status: "scheduled_retry",
            scheduledRetryAt: "2026-07-17T20:05:00.000Z",
            scheduledRetryAttempt: 2,
          },
        },
        now,
      ),
    ).toMatchObject({ state: "retrying", source: "scheduled-retry", attemptCount: 2 });
  });
});

describe("useMonitorCountdown", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-17T20:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("ticks every 30 seconds normally, every second near due, and cleans up", () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    const observed: number[] = [];

    function Probe({ nextCheckAt }: { nextCheckAt: string | null }) {
      observed.push(useMonitorCountdown(nextCheckAt).getTime());
      return null;
    }

    flushSync(() => root.render(<Probe nextCheckAt="2026-07-17T20:02:00.000Z" />));
    expect(vi.getTimerCount()).toBe(1);

    flushSync(() => vi.advanceTimersByTime(30_000));
    expect(observed.at(-1)).toBe(new Date("2026-07-17T20:00:30.000Z").getTime());

    flushSync(() => root.render(<Probe nextCheckAt="2026-07-17T20:00:45.000Z" />));
    flushSync(() => vi.advanceTimersByTime(1_000));
    expect(observed.at(-1)).toBe(new Date("2026-07-17T20:00:31.000Z").getTime());

    flushSync(() => root.render(<Probe nextCheckAt={null} />));
    expect(vi.getTimerCount()).toBe(0);

    flushSync(() => root.unmount());
    expect(vi.getTimerCount()).toBe(0);
  });
});
