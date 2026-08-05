import { useEffect, useMemo, useRef } from "react";
import type { CalendarEvent } from "@paperclipai/shared";
import { cn } from "@/lib/utils";
import {
  HOUR_HEIGHT_PX,
  MAX_OVERLAP_COLUMNS,
  MAX_OVERLAP_COLUMNS_WEEK,
  dayKey,
  groupEventsByDay,
  isSameDay,
  layoutDayEvents,
  nowOffsetPx,
  visibleDays,
} from "@/lib/calendar-grid";
import { CalendarEventChip } from "./CalendarEventChip";

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);
/** Width of the hour-label gutter, matched between the header and the grid. */
const GUTTER_CLASS = "w-14 shrink-0";

interface CalendarTimeGridViewProps {
  mode: "week" | "day";
  anchor: Date;
  events: CalendarEvent[];
  now: Date;
  viewerTimeZone: string;
}

/**
 * Week and day share one time grid — a week is seven day columns.
 *
 * Overlaps are packed into side-by-side columns (see `layoutDayEvents`) so two
 * routines firing at the same minute read as two parallel bars instead of one
 * hiding the other, which is the whole reason to draw a time grid rather than a
 * list.
 */
export function CalendarTimeGridView({
  mode,
  anchor,
  events,
  now,
  viewerTimeZone,
}: CalendarTimeGridViewProps) {
  const days = useMemo(() => visibleDays(mode, anchor), [mode, anchor]);
  const grouped = useMemo(() => groupEventsByDay(events), [events]);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Open on the working day rather than at midnight: an operator wants to see
  // what is happening around now, and 00:00–08:00 is usually empty.
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const focusHour = days.some((day) => isSameDay(day, now)) ? Math.max(now.getHours() - 1, 0) : 7;
    container.scrollTop = focusHour * HOUR_HEIGHT_PX;
  }, [days, now]);

  return (
    <div className="border border-border">
      <div className="flex border-b border-border bg-muted/40">
        <div className={cn(GUTTER_CLASS, "border-r border-border")} aria-hidden="true" />
        {days.map((day) => {
          const isToday = isSameDay(day, now);
          return (
            <div
              key={dayKey(day)}
              className="flex-1 min-w-0 border-r border-border last:border-r-0 px-2 py-1.5"
            >
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
                {day.toLocaleDateString(undefined, { weekday: "short" })}
              </div>
              <div
                className={cn(
                  "text-sm tabular-nums",
                  isToday ? "font-semibold text-foreground" : "text-muted-foreground",
                )}
              >
                {day.getDate()}
              </div>
            </div>
          );
        })}
      </div>

      <div
        ref={scrollRef}
        className="relative max-h-[calc(100vh-19rem)] overflow-y-auto"
        role="grid"
        aria-label={mode === "week" ? "Week view" : "Day view"}
      >
        <div className="flex">
          <div className={cn(GUTTER_CLASS, "border-r border-border")}>
            {HOURS.map((hour) => (
              <div
                key={hour}
                role="rowheader"
                style={{ height: HOUR_HEIGHT_PX }}
                className="relative text-[10px] tabular-nums text-muted-foreground"
              >
                <span className="absolute -top-1.5 right-1.5">
                  {hour === 0 ? "" : `${String(hour).padStart(2, "0")}:00`}
                </span>
              </div>
            ))}
          </div>

          {days.map((day) => {
            const dayEvents = grouped.get(dayKey(day)) ?? [];
            // A week squeezes seven days into the same width one day gets, so it
            // tolerates far fewer side-by-side columns before labels become stubs.
            const { bands, positioned, overflow } = layoutDayEvents(
              dayEvents,
              day,
              mode === "week" ? MAX_OVERLAP_COLUMNS_WEEK : MAX_OVERLAP_COLUMNS,
            );
            const nowOffset = nowOffsetPx(now, day);

            return (
              <div
                key={dayKey(day)}
                role="gridcell"
                aria-label={`${day.toLocaleDateString(undefined, {
                  weekday: "long",
                  day: "numeric",
                  month: "long",
                })}, ${dayEvents.length} entries`}
                className="relative flex-1 min-w-0 border-r border-border last:border-r-0"
                style={{ height: HOURS.length * HOUR_HEIGHT_PX }}
              >
                {HOURS.map((hour) => (
                  <div
                    key={hour}
                    style={{ height: HOUR_HEIGHT_PX }}
                    className="border-b border-border/50"
                  />
                ))}

                {bands.map(({ cluster, top, height }) => (
                  <div
                    key={cluster.event.id}
                    className="absolute inset-x-0 px-0.5 opacity-70"
                    style={{ top, height }}
                  >
                    <CalendarEventChip
                      event={cluster.event}
                      count={cluster.count}
                      lastAt={cluster.lastAt}
                      viewerTimeZone={viewerTimeZone}
                    />
                  </div>
                ))}

                {positioned.map(({ cluster, top, height, left, width }) => (
                  <div
                    key={cluster.event.id}
                    className="absolute z-[1] px-0.5"
                    style={{
                      top,
                      height,
                      left: `${left * 100}%`,
                      width: `${width * 100}%`,
                    }}
                  >
                    <CalendarEventChip
                      event={cluster.event}
                      count={cluster.count}
                      lastAt={cluster.lastAt}
                      viewerTimeZone={viewerTimeZone}
                    />
                  </div>
                ))}

                {overflow.map((entry) => (
                  <div
                    key={`overflow-${entry.top}`}
                    className="absolute right-0.5 z-10 border border-border bg-background px-1 text-[10px] text-muted-foreground"
                    style={{ top: entry.top }}
                    title={`${entry.count} more overlapping at this time`}
                  >
                    +{entry.count}
                  </div>
                ))}

                {nowOffset !== null ? (
                  <div
                    className="pointer-events-none absolute inset-x-0 z-10 border-t-2 border-destructive"
                    style={{ top: nowOffset }}
                    aria-label={`Current time ${now.toLocaleTimeString(undefined, {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}`}
                  >
                    <span className="absolute -left-1 -top-1 block h-2 w-2 rounded-full bg-destructive" />
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
