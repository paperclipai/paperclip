import { describe, expect, it } from "vitest";
import type { CalendarEvent } from "@paperclipai/shared";
import {
  HOUR_HEIGHT_PX,
  MAX_OVERLAP_COLUMNS,
  MAX_OVERLAP_COLUMNS_WEEK,
  MIN_EVENT_HEIGHT_PX,
  collapseSeries,
  addMonths,
  dayKey,
  groupEventsByDay,
  isCalendarViewMode,
  layoutDayEvents,
  nowOffsetPx,
  scheduleLocalTime,
  shiftAnchor,
  startOfWeek,
  visibleDays,
  windowForView,
} from "./calendar-grid";

function event(overrides: Partial<CalendarEvent> & { id: string; at: string }): CalendarEvent {
  return {
    kind: "routine_scheduled",
    tense: "projected",
    status: "scheduled",
    title: "Routine",
    endAt: null,
    agentId: null,
    agentName: null,
    // Distinct per fixture by default so overlap tests exercise overlap rather
    // than tripping the same-series collapse; tests that want a repeating
    // series set `routineId` explicitly.
    routineId: overrides.id,
    routineTitle: null,
    issueId: null,
    issueIdentifier: null,
    projectId: null,
    scheduleTimezone: null,
    cronExpression: null,
    href: null,
    ...overrides,
  };
}

describe("view geometry", () => {
  it("renders a month as a full six-week grid so the layout never reflows", () => {
    const february = visibleDays("month", new Date(2026, 1, 15));
    const march = visibleDays("month", new Date(2026, 2, 15));
    expect(february).toHaveLength(42);
    expect(march).toHaveLength(42);
  });

  it("starts weeks on Monday", () => {
    // 2026-08-05 is a Wednesday.
    expect(startOfWeek(new Date(2026, 7, 5)).getDay()).toBe(1);
    // A Sunday belongs to the week that began the previous Monday.
    expect(dayKey(startOfWeek(new Date(2026, 7, 9)))).toBe("2026-08-03");
  });

  it("gives a week seven days and a day one", () => {
    expect(visibleDays("week", new Date(2026, 7, 5))).toHaveLength(7);
    expect(visibleDays("day", new Date(2026, 7, 5))).toHaveLength(1);
  });

  it("does not skip a month when the anchor is the 31st", () => {
    // Naively adding a month to 31 January lands in March.
    expect(addMonths(new Date(2026, 0, 31), 1).getMonth()).toBe(1);
  });

  it("moves by the unit the current view is showing", () => {
    const anchor = new Date(2026, 7, 5);
    expect(shiftAnchor("day", anchor, 1).getDate()).toBe(6);
    expect(shiftAnchor("week", anchor, 1).getDate()).toBe(12);
    expect(shiftAnchor("month", anchor, 1).getMonth()).toBe(8);
    expect(shiftAnchor("month", anchor, -1).getMonth()).toBe(6);
  });

  it("pads the fetch window past the visible edges", () => {
    const { from, to } = windowForView("week", new Date(2026, 7, 5));
    const days = visibleDays("week", new Date(2026, 7, 5));
    expect(from.getTime()).toBeLessThan(days[0]!.getTime());
    expect(to.getTime()).toBeGreaterThan(days[6]!.getTime());
  });

  it("validates view modes from the URL", () => {
    expect(isCalendarViewMode("week")).toBe(true);
    expect(isCalendarViewMode("year")).toBe(false);
    expect(isCalendarViewMode(null)).toBe(false);
  });
});

describe("grouping", () => {
  it("buckets by local day, not by UTC day", () => {
    // Late-evening local times land on the following UTC day in western zones;
    // grouping must follow the clock the grid is drawn in.
    const local = new Date(2026, 7, 5, 23, 30);
    const grouped = groupEventsByDay([event({ id: "a", at: local.toISOString() })]);
    expect([...grouped.keys()]).toEqual(["2026-08-05"]);
  });

  it("sorts each day ascending", () => {
    const grouped = groupEventsByDay([
      event({ id: "late", at: new Date(2026, 7, 5, 16, 0).toISOString() }),
      event({ id: "early", at: new Date(2026, 7, 5, 9, 0).toISOString() }),
    ]);
    expect(grouped.get("2026-08-05")!.map((entry) => entry.id)).toEqual(["early", "late"]);
  });
});

describe("time grid layout", () => {
  const day = new Date(2026, 7, 5);

  it("positions an event by its start time", () => {
    const { positioned: [positioned] } = layoutDayEvents(
      [event({ id: "a", at: new Date(2026, 7, 5, 9, 0).toISOString() })],
      day,
    );
    expect(positioned!.top).toBe(9 * HOUR_HEIGHT_PX);
  });

  it("gives a zero-length event a readable minimum height", () => {
    const { positioned: [positioned] } = layoutDayEvents(
      [event({ id: "a", at: new Date(2026, 7, 5, 9, 0).toISOString() })],
      day,
    );
    expect(positioned!.height).toBeGreaterThanOrEqual(MIN_EVENT_HEIGHT_PX);
  });

  it("uses the full width when nothing overlaps", () => {
    const { positioned } = layoutDayEvents(
      [
        event({
          id: "a",
          at: new Date(2026, 7, 5, 9, 0).toISOString(),
          endAt: new Date(2026, 7, 5, 10, 0).toISOString(),
        }),
        event({
          id: "b",
          at: new Date(2026, 7, 5, 11, 0).toISOString(),
          endAt: new Date(2026, 7, 5, 12, 0).toISOString(),
        }),
      ],
      day,
    );
    expect(positioned.map((entry) => entry.width)).toEqual([1, 1]);
  });

  it("splits the column between overlapping events so neither is hidden", () => {
    const { positioned } = layoutDayEvents(
      [
        event({
          id: "a",
          at: new Date(2026, 7, 5, 9, 0).toISOString(),
          endAt: new Date(2026, 7, 5, 10, 0).toISOString(),
        }),
        event({
          id: "b",
          at: new Date(2026, 7, 5, 9, 30).toISOString(),
          endAt: new Date(2026, 7, 5, 10, 30).toISOString(),
        }),
      ],
      day,
    );
    expect(positioned.map((entry) => entry.width)).toEqual([0.5, 0.5]);
    expect(positioned.map((entry) => entry.left)).toEqual([0, 0.5]);
  });

  it("reuses a column once its previous event has finished", () => {
    const { positioned } = layoutDayEvents(
      [
        event({
          id: "a",
          at: new Date(2026, 7, 5, 9, 0).toISOString(),
          endAt: new Date(2026, 7, 5, 11, 0).toISOString(),
        }),
        event({
          id: "b",
          at: new Date(2026, 7, 5, 9, 30).toISOString(),
          endAt: new Date(2026, 7, 5, 10, 0).toISOString(),
        }),
        event({
          id: "c",
          at: new Date(2026, 7, 5, 10, 15).toISOString(),
          endAt: new Date(2026, 7, 5, 10, 45).toISOString(),
        }),
      ],
      day,
    );
    // Three events, but only two are ever concurrent — so two columns, not three.
    expect(positioned.every((entry) => entry.width === 0.5)).toBe(true);
    expect(positioned.map((entry) => entry.left)).toEqual([0, 0.5, 0.5]);
  });

  it("keeps an event that runs past midnight inside its own day", () => {
    const { positioned: [positioned] } = layoutDayEvents(
      [
        event({
          id: "a",
          at: new Date(2026, 7, 5, 23, 0).toISOString(),
          endAt: new Date(2026, 7, 6, 2, 0).toISOString(),
        }),
      ],
      day,
    );
    expect(positioned!.top + positioned!.height).toBeLessThanOrEqual(24 * HOUR_HEIGHT_PX);
  });
});

describe("series collapsing", () => {
  it("leaves distinct entries alone", () => {
    const clusters = collapseSeries([
      event({ id: "a", at: new Date(2026, 7, 5, 9, 0).toISOString() }),
      event({ id: "b", at: new Date(2026, 7, 5, 10, 0).toISOString() }),
    ]);
    expect(clusters).toHaveLength(2);
    expect(clusters.every((cluster) => cluster.count === 1)).toBe(true);
  });

  it("collapses repeats of one schedule into a single counted entry", () => {
    const clusters = collapseSeries(
      Array.from({ length: 96 }, (_, index) =>
        event({
          id: `probe-${index}`,
          routineId: "probe",
          title: "Link health probe",
          at: new Date(2026, 7, 5, Math.floor(index / 4), (index % 4) * 15).toISOString(),
        }),
      ),
    );
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.count).toBe(96);
    // The cluster spans first to last, which is what the time grid draws as a band.
    expect(clusters[0]!.event.at).toBe(new Date(2026, 7, 5, 0, 0).toISOString());
    expect(clusters[0]!.lastAt).toBe(new Date(2026, 7, 5, 23, 45).toISOString());
  });

  it("keeps a series below the threshold expanded", () => {
    const clusters = collapseSeries(
      [0, 1].map((index) =>
        event({
          id: `triage-${index}`,
          routineId: "triage",
          at: new Date(2026, 7, 5, 8 + index * 5, 0).toISOString(),
        }),
      ),
      3,
    );
    expect(clusters).toHaveLength(2);
  });

  it("does not merge different kinds that share a routine", () => {
    const clusters = collapseSeries([
      event({ id: "a", routineId: "r1", at: new Date(2026, 7, 5, 9, 0).toISOString() }),
      event({
        id: "b",
        routineId: "r1",
        kind: "routine_run",
        tense: "actual",
        at: new Date(2026, 7, 5, 9, 30).toISOString(),
      }),
    ]);
    expect(clusters).toHaveLength(2);
  });
});

describe("overlap ceiling", () => {
  it("counts entries past the column cap instead of drawing unreadable slivers", () => {
    const concurrent = Array.from({ length: MAX_OVERLAP_COLUMNS + 3 }, (_, index) =>
      event({
        id: `run-${index}`,
        at: new Date(2026, 7, 5, 9, 0).toISOString(),
        endAt: new Date(2026, 7, 5, 10, 0).toISOString(),
      }),
    );
    const { positioned, overflow } = layoutDayEvents(concurrent, new Date(2026, 7, 5));

    expect(positioned).toHaveLength(MAX_OVERLAP_COLUMNS);
    expect(overflow).toEqual([{ top: 9 * HOUR_HEIGHT_PX, count: 3 }]);
    expect(positioned.every((entry) => entry.width === 1 / MAX_OVERLAP_COLUMNS)).toBe(true);
  });

  it("does not let a dense band steal width from real entries beside it", () => {
    const probe = Array.from({ length: 20 }, (_, index) =>
      event({
        id: `probe-${index}`,
        routineId: "probe",
        at: new Date(2026, 7, 5, 9, index * 3).toISOString(),
      }),
    );
    const single = event({
      id: "single",
      routineId: "daily",
      at: new Date(2026, 7, 5, 9, 15).toISOString(),
    });

    const { bands, positioned } = layoutDayEvents([...probe, single], new Date(2026, 7, 5));

    expect(bands).toHaveLength(1);
    expect(positioned).toHaveLength(1);
    expect(positioned[0]!.width).toBe(1);
  });

  it("takes a tighter ceiling when the caller asks for one, as the week view does", () => {
    const concurrent = Array.from({ length: 5 }, (_, index) =>
      event({
        id: `run-${index}`,
        at: new Date(2026, 7, 5, 9, 0).toISOString(),
        endAt: new Date(2026, 7, 5, 10, 0).toISOString(),
      }),
    );
    const { positioned, overflow } = layoutDayEvents(
      concurrent,
      new Date(2026, 7, 5),
      MAX_OVERLAP_COLUMNS_WEEK,
    );

    expect(positioned).toHaveLength(MAX_OVERLAP_COLUMNS_WEEK);
    expect(overflow).toEqual([{ top: 9 * HOUR_HEIGHT_PX, count: 3 }]);
  });

  it("draws a dense schedule as one band rather than a wall of chips", () => {
    const probe = Array.from({ length: 96 }, (_, index) =>
      event({
        id: `probe-${index}`,
        routineId: "probe",
        title: "Link health probe",
        at: new Date(2026, 7, 5, Math.floor(index / 4), (index % 4) * 15).toISOString(),
      }),
    );
    const { bands, positioned, overflow } = layoutDayEvents(probe, new Date(2026, 7, 5));

    // The band goes to the background lane, leaving the packing columns free.
    expect(bands).toHaveLength(1);
    expect(bands[0]!.cluster.count).toBe(96);
    expect(bands[0]!.width).toBe(1);
    expect(positioned).toEqual([]);
    expect(overflow).toEqual([]);
  });
});

describe("current time indicator", () => {
  it("offsets by the time of day", () => {
    expect(nowOffsetPx(new Date(2026, 7, 5, 6, 0), new Date(2026, 7, 5))).toBe(6 * HOUR_HEIGHT_PX);
  });

  it("is absent on any other day", () => {
    expect(nowOffsetPx(new Date(2026, 7, 5, 6, 0), new Date(2026, 7, 6))).toBeNull();
  });
});

describe("schedule timezone disclosure", () => {
  it("says nothing when the schedule matches the viewer", () => {
    const entry = event({ id: "a", at: "2026-08-05T09:00:00.000Z", scheduleTimezone: "UTC" });
    expect(scheduleLocalTime(entry, "UTC")).toBeNull();
  });

  it("shows the schedule's own clock when it differs", () => {
    const entry = event({
      id: "a",
      at: "2026-08-05T13:00:00.000Z",
      scheduleTimezone: "America/New_York",
    });
    // 13:00 UTC is 09:00 in New York in August.
    expect(scheduleLocalTime(entry, "Europe/London")).toContain("09");
  });

  it("stays silent rather than throwing on an unusable zone", () => {
    const entry = event({
      id: "a",
      at: "2026-08-05T13:00:00.000Z",
      scheduleTimezone: "Mars/Olympus_Mons",
    });
    expect(scheduleLocalTime(entry, "UTC")).toBeNull();
  });
});
