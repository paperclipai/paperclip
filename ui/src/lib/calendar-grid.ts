/**
 * Pure date and layout maths for the Calendar page.
 *
 * Everything here works in the *viewer's* local timezone — the browser's — which
 * is the timezone the grid is drawn in. A routine's own schedule timezone rides
 * along on the event (`scheduleTimezone`) and is surfaced on the chip when the
 * two disagree, rather than being used to place anything.
 *
 * Kept free of React and of `@paperclipai/shared` value imports so the grid maths
 * can be tested directly.
 *
 * @module
 */

import type { CalendarEvent } from "@paperclipai/shared";

export type CalendarViewMode = "month" | "week" | "day" | "agenda";

export const CALENDAR_VIEW_MODES: CalendarViewMode[] = ["month", "week", "day", "agenda"];

/** Rendered height of one hour in the week/day time grid, in pixels. */
export const HOUR_HEIGHT_PX = 48;
/** Shorter events still occupy this much height so their label stays readable. */
export const MIN_EVENT_HEIGHT_PX = 22;
/** Assumed duration for an event with no end, so it has something to draw. */
export const DEFAULT_EVENT_MINUTES = 30;

const MS_PER_MINUTE = 60_000;

export function isCalendarViewMode(value: string | null): value is CalendarViewMode {
  return value !== null && (CALENDAR_VIEW_MODES as string[]).includes(value);
}

export function startOfDay(date: Date): Date {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

export function addDays(date: Date, days: number): Date {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + days);
  return copy;
}

export function addMonths(date: Date, months: number): Date {
  const copy = new Date(date);
  // Clamp to the 1st before shifting: adding a month to the 31st would
  // otherwise roll into the month after next.
  copy.setDate(1);
  copy.setMonth(copy.getMonth() + months);
  return copy;
}

/** Monday-first, matching the ISO week the rest of the product reads in. */
export function startOfWeek(date: Date): Date {
  const start = startOfDay(date);
  const weekday = (start.getDay() + 6) % 7;
  return addDays(start, -weekday);
}

export function startOfMonth(date: Date): Date {
  const copy = startOfDay(date);
  copy.setDate(1);
  return copy;
}

export function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** Stable `YYYY-MM-DD` key in local time — `toISOString` would shift the day. */
export function dayKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * The days a view covers.
 *
 * Month is always a whole 6×7 grid so the layout never reflows between months;
 * the leading and trailing days belong to the neighbouring months and are
 * rendered dimmed.
 */
export function visibleDays(mode: CalendarViewMode, anchor: Date): Date[] {
  if (mode === "day") return [startOfDay(anchor)];
  if (mode === "week") {
    const start = startOfWeek(anchor);
    return Array.from({ length: 7 }, (_, index) => addDays(start, index));
  }
  if (mode === "month") {
    const start = startOfWeek(startOfMonth(anchor));
    return Array.from({ length: 42 }, (_, index) => addDays(start, index));
  }
  // Agenda reads forward from the anchor day rather than snapping to a grid:
  // "what's next" is a question about the future, not about this month.
  return Array.from({ length: 30 }, (_, index) => addDays(startOfDay(anchor), index));
}

/** The inclusive fetch window for a view, padded by a day at each edge. */
export function windowForView(mode: CalendarViewMode, anchor: Date): { from: Date; to: Date } {
  const days = visibleDays(mode, anchor);
  const from = addDays(startOfDay(days[0]!), -1);
  const to = addDays(startOfDay(days[days.length - 1]!), 2);
  return { from, to };
}

export function shiftAnchor(mode: CalendarViewMode, anchor: Date, direction: 1 | -1): Date {
  if (mode === "month") return addMonths(anchor, direction);
  if (mode === "week") return addDays(anchor, 7 * direction);
  if (mode === "day") return addDays(anchor, direction);
  return addDays(anchor, 30 * direction);
}

export function groupEventsByDay(events: CalendarEvent[]): Map<string, CalendarEvent[]> {
  const grouped = new Map<string, CalendarEvent[]>();
  for (const event of events) {
    const key = dayKey(new Date(event.at));
    const bucket = grouped.get(key);
    if (bucket) bucket.push(event);
    else grouped.set(key, [event]);
  }
  for (const bucket of grouped.values()) {
    bucket.sort((a, b) => a.at.localeCompare(b.at));
  }
  return grouped;
}

/**
 * One or more occurrences of the same thing on the same day.
 *
 * A schedule like `*​/15 * * * *` produces 96 identical entries a day. Drawing
 * all 96 tells you nothing that "every 15 minutes, 96 times" does not, and it
 * buries every other routine on the page — so repeated occurrences of one series
 * collapse into a single entry carrying a count.
 */
export interface EventCluster {
  /** The earliest occurrence, used for placement and labelling. */
  event: CalendarEvent;
  /** How many occurrences this entry stands for. 1 means it is not collapsed. */
  count: number;
  /** ISO timestamp of the last occurrence in the cluster. */
  lastAt: string;
}

/** What makes two entries "the same thing repeating" rather than two things. */
function seriesKey(event: CalendarEvent): string {
  return [event.kind, event.routineId ?? event.issueId ?? event.agentId ?? event.title].join(":");
}

/**
 * Collapse repeated occurrences of one series within a day.
 *
 * @param threshold — collapse only once a series reaches this many occurrences,
 *   so a routine that runs twice still shows both times.
 */
export function collapseSeries(events: CalendarEvent[], threshold = 2): EventCluster[] {
  const groups = new Map<string, CalendarEvent[]>();
  for (const event of events) {
    const key = seriesKey(event);
    const bucket = groups.get(key);
    if (bucket) bucket.push(event);
    else groups.set(key, [event]);
  }

  const clusters: EventCluster[] = [];
  for (const bucket of groups.values()) {
    const sorted = [...bucket].sort((a, b) => a.at.localeCompare(b.at));
    if (sorted.length < threshold) {
      for (const event of sorted) clusters.push({ event, count: 1, lastAt: event.at });
      continue;
    }
    clusters.push({
      event: sorted[0]!,
      count: sorted.length,
      lastAt: sorted[sorted.length - 1]!.at,
    });
  }
  return clusters.sort((a, b) => a.event.at.localeCompare(b.event.at));
}

/**
 * Concurrent entries drawn side by side before the rest collapse into a count.
 *
 * A day column is roughly 190px wide in a week and seven times that in a day
 * view, and a chip needs ~90px before its label stops being a stub — so the
 * ceiling is per-view rather than a single constant.
 */
export const MAX_OVERLAP_COLUMNS = 4;
export const MAX_OVERLAP_COLUMNS_WEEK = 2;

export interface PositionedEvent {
  cluster: EventCluster;
  /** Offset from the top of the day column, in pixels. */
  top: number;
  height: number;
  /** Horizontal share of the column, 0–1. */
  left: number;
  width: number;
}

export interface DayLayout {
  /**
   * Collapsed series, drawn full width *behind* everything else.
   *
   * A "runs every fifteen minutes from 08:00 to 18:00" band is context, not an
   * appointment. Letting it take a packing column would halve the width of the
   * real entries beside it for no gain, so it becomes a background lane instead
   * — the same treatment calendars give all-day and background events.
   */
  bands: PositionedEvent[];
  positioned: PositionedEvent[];
  /** Clusters that did not fit, marked at the top of the run that hid them. */
  overflow: { top: number; count: number }[];
}

function clusterEndMs(cluster: EventCluster): number {
  const start = new Date(cluster.event.at).getTime();
  // A collapsed series is drawn as a band running from its first occurrence to
  // its last, which is the shape of the information: "this ran all afternoon".
  if (cluster.count > 1) {
    const last = new Date(cluster.lastAt).getTime();
    return Math.max(last, start + DEFAULT_EVENT_MINUTES * MS_PER_MINUTE);
  }
  if (!cluster.event.endAt) return start + DEFAULT_EVENT_MINUTES * MS_PER_MINUTE;
  const end = new Date(cluster.event.endAt).getTime();
  return end > start ? end : start + DEFAULT_EVENT_MINUTES * MS_PER_MINUTE;
}

/**
 * Place a day's events in a time grid, giving overlapping events side-by-side
 * columns.
 *
 * Events are swept in start order and packed into the first column whose last
 * event has already finished. A run of mutually overlapping events forms a
 * cluster, and every event in that cluster is given `1 / columns` of the width
 * — so two agents running at once read as two visibly parallel bars rather than
 * one hidden behind the other.
 */
export function layoutDayEvents(
  events: CalendarEvent[],
  dayStart: Date,
  maxColumns: number = MAX_OVERLAP_COLUMNS,
): DayLayout {
  const dayStartMs = startOfDay(dayStart).getTime();
  const dayEndMs = dayStartMs + 24 * 60 * MS_PER_MINUTE;

  // Collapse first: a series that fires every fifteen minutes must become one
  // band before overlap packing runs, or it alone opens 96 columns.
  const ordered = collapseSeries(events, 4).sort((a, b) => {
    const byStart = a.event.at.localeCompare(b.event.at);
    return byStart !== 0 ? byStart : a.event.id.localeCompare(b.event.id);
  });

  const bands: PositionedEvent[] = [];
  const positioned: PositionedEvent[] = [];
  const overflow: { top: number; count: number }[] = [];
  let group: { entry: PositionedEvent; column: number }[] = [];
  let columnEnds: number[] = [];
  let hiddenInGroup = 0;
  let groupTop = 0;

  const flushGroup = () => {
    const columns = Math.max(columnEnds.length, 1);
    for (const member of group) {
      member.entry.left = member.column / columns;
      member.entry.width = 1 / columns;
    }
    if (hiddenInGroup > 0) overflow.push({ top: groupTop, count: hiddenInGroup });
    group = [];
    columnEnds = [];
    hiddenInGroup = 0;
  };

  for (const cluster of ordered) {
    const startMs = Math.max(new Date(cluster.event.at).getTime(), dayStartMs);
    const endMs = Math.min(Math.max(clusterEndMs(cluster), startMs + MS_PER_MINUTE), dayEndMs);
    const topPx = ((startMs - dayStartMs) / MS_PER_MINUTE / 60) * HOUR_HEIGHT_PX;
    const heightPx = Math.max(
      ((endMs - startMs) / MS_PER_MINUTE / 60) * HOUR_HEIGHT_PX,
      MIN_EVENT_HEIGHT_PX,
    );

    if (cluster.count > 1) {
      bands.push({ cluster, top: topPx, height: heightPx, left: 0, width: 1 });
      continue;
    }

    // A new group begins as soon as an entry starts after everything so far has
    // finished.
    if (group.length > 0 && columnEnds.every((columnEnd) => columnEnd <= startMs)) {
      flushGroup();
    }
    if (group.length === 0) groupTop = topPx;

    let column = columnEnds.findIndex((columnEnd) => columnEnd <= startMs);
    if (column === -1) {
      // Past the column cap the entry would be a few pixels wide and unreadable,
      // so it is counted rather than drawn illegibly.
      if (columnEnds.length >= Math.max(1, maxColumns)) {
        hiddenInGroup += 1;
        continue;
      }
      column = columnEnds.length;
      columnEnds.push(endMs);
    } else {
      columnEnds[column] = endMs;
    }

    const durationMinutes = (endMs - startMs) / MS_PER_MINUTE;
    const entry: PositionedEvent = {
      cluster,
      top: topPx,
      height: Math.max((durationMinutes / 60) * HOUR_HEIGHT_PX, MIN_EVENT_HEIGHT_PX),
      left: 0,
      width: 1,
    };
    positioned.push(entry);
    group.push({ entry, column });
  }

  flushGroup();
  return { bands, positioned, overflow };
}

/** Fraction of the way through the day, or null when `now` is another day. */
export function nowOffsetPx(now: Date, day: Date): number | null {
  if (!isSameDay(now, day)) return null;
  const minutes = now.getHours() * 60 + now.getMinutes();
  return (minutes / 60) * HOUR_HEIGHT_PX;
}

export function formatTime(date: Date, locale?: string): string {
  return date.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
}

export function viewTitle(mode: CalendarViewMode, anchor: Date, locale?: string): string {
  if (mode === "day") {
    return anchor.toLocaleDateString(locale, {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
    });
  }
  if (mode === "week") {
    const start = startOfWeek(anchor);
    const end = addDays(start, 6);
    const sameMonth = start.getMonth() === end.getMonth();
    const startLabel = start.toLocaleDateString(locale, {
      day: "numeric",
      month: sameMonth ? undefined : "short",
    });
    const endLabel = end.toLocaleDateString(locale, {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
    return `${startLabel} – ${endLabel}`;
  }
  if (mode === "agenda") {
    return `Next 30 days from ${anchor.toLocaleDateString(locale, { day: "numeric", month: "short" })}`;
  }
  return anchor.toLocaleDateString(locale, { month: "long", year: "numeric" });
}

/** The viewer's IANA timezone, for comparing against a schedule's own. */
export function viewerTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * What a projected occurrence reads as on its own schedule's clock — shown only
 * when that differs from the viewer's, so a 09:00 Europe/London cron is never
 * silently read as 09:00 local.
 */
export function scheduleLocalTime(event: CalendarEvent, viewerZone: string): string | null {
  if (!event.scheduleTimezone || event.scheduleTimezone === viewerZone) return null;
  try {
    return new Date(event.at).toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: event.scheduleTimezone,
    });
  } catch {
    return null;
  }
}
