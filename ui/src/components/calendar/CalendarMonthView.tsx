import { useMemo } from "react";
import type { CalendarEvent } from "@paperclipai/shared";
import { cn } from "@/lib/utils";
import { collapseSeries, dayKey, groupEventsByDay, isSameDay, visibleDays } from "@/lib/calendar-grid";
import { CalendarEventChip } from "./CalendarEventChip";

/** Chips shown in a month cell before the rest collapse into a "+N" line. */
const MAX_CHIPS_PER_DAY = 3;

interface CalendarMonthViewProps {
  anchor: Date;
  events: CalendarEvent[];
  now: Date;
  viewerTimeZone: string;
  onSelectDay: (day: Date) => void;
}

/**
 * Month grid.
 *
 * A month is for spotting shape — which days are busy, where the gaps are —
 * rather than for reading times, so each cell caps its chips and spills the
 * remainder into a count that opens the day. That cap is also what keeps a
 * `*​/5` routine from rendering 288 identical chips in one square.
 */
export function CalendarMonthView({
  anchor,
  events,
  now,
  viewerTimeZone,
  onSelectDay,
}: CalendarMonthViewProps) {
  const days = useMemo(() => visibleDays("month", anchor), [anchor]);
  const grouped = useMemo(() => groupEventsByDay(events), [events]);
  const weekdayLabels = useMemo(
    () =>
      days.slice(0, 7).map((day) => day.toLocaleDateString(undefined, { weekday: "short" })),
    [days],
  );
  const weeks = useMemo(
    () => Array.from({ length: days.length / 7 }, (_, index) => days.slice(index * 7, index * 7 + 7)),
    [days],
  );

  return (
    <div role="grid" aria-label="Month view" className="border border-border border-b-0">
      <div role="row" className="grid grid-cols-7 border-b border-border bg-muted/40">
        {weekdayLabels.map((label) => (
          <div
            key={label}
            role="columnheader"
            className="px-2 py-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground"
          >
            {label}
          </div>
        ))}
      </div>
      {weeks.map((week) => (
        <div role="row" key={dayKey(week[0]!)} className="grid grid-cols-7">
          {week.map((day) => {
            const dayEvents = grouped.get(dayKey(day)) ?? [];
            // One line per *thing*, not per occurrence: a routine that fires
            // every fifteen minutes gets a single "×96" chip rather than
            // filling the square and hiding every other routine behind "+95
            // more".
            const clusters = collapseSeries(dayEvents);
            const visible = clusters.slice(0, MAX_CHIPS_PER_DAY);
            const overflow = clusters.length - visible.length;
            const isCurrentMonth = day.getMonth() === anchor.getMonth();
            const isToday = isSameDay(day, now);
            const projectedCount = dayEvents.filter((event) => event.tense === "projected").length;

            return (
              <div
                role="gridcell"
                key={dayKey(day)}
                aria-label={`${day.toLocaleDateString(undefined, {
                  weekday: "long",
                  day: "numeric",
                  month: "long",
                })}, ${dayEvents.length} entries, ${projectedCount} projected`}
                className={cn(
                  "min-h-24 border-b border-r border-border p-1 last:border-r-0 flex flex-col gap-1",
                  !isCurrentMonth && "bg-muted/30",
                )}
              >
                <button
                  type="button"
                  onClick={() => onSelectDay(day)}
                  className={cn(
                    "self-start px-1 text-[11px] tabular-nums transition-colors hover:bg-accent",
                    isToday
                      ? "bg-foreground text-background font-semibold"
                      : isCurrentMonth
                        ? "text-foreground"
                        : "text-muted-foreground",
                  )}
                  aria-label={`Open ${day.toLocaleDateString(undefined, {
                    day: "numeric",
                    month: "long",
                  })} in day view`}
                >
                  {day.getDate()}
                </button>
                <div className="flex flex-col gap-0.5 min-w-0">
                  {visible.map((cluster) => (
                    <CalendarEventChip
                      key={cluster.event.id}
                      event={cluster.event}
                      count={cluster.count}
                      lastAt={cluster.lastAt}
                      viewerTimeZone={viewerTimeZone}
                      variant="compact"
                    />
                  ))}
                  {overflow > 0 ? (
                    <button
                      type="button"
                      onClick={() => onSelectDay(day)}
                      className="px-1 text-left text-[11px] text-muted-foreground hover:text-foreground hover:underline"
                    >
                      +{overflow} more
                    </button>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
