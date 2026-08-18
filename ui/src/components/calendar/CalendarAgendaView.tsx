import { useMemo } from "react";
import type { CalendarEvent } from "@paperclipai/shared";
import { cn } from "@/lib/utils";
import { Link } from "@/lib/router";
import {
  collapseSeries,
  dayKey,
  formatTime,
  groupEventsByDay,
  isSameDay,
  scheduleLocalTime,
  visibleDays,
} from "@/lib/calendar-grid";
import { CALENDAR_KIND_META, eventHue, eventStatusLabel } from "./calendar-visuals";

interface CalendarAgendaViewProps {
  anchor: Date;
  events: CalendarEvent[];
  now: Date;
  viewerTimeZone: string;
}

/**
 * The reading surface: a forward list of what is coming, grouped by day.
 *
 * Days with nothing on them are skipped entirely — an agenda that lists thirty
 * empty headings is worse than one that lists the four days that matter.
 */
export function CalendarAgendaView({
  anchor,
  events,
  now,
  viewerTimeZone,
}: CalendarAgendaViewProps) {
  const days = useMemo(() => visibleDays("agenda", anchor), [anchor]);
  const grouped = useMemo(() => groupEventsByDay(events), [events]);
  const populated = useMemo(
    () => days.filter((day) => (grouped.get(dayKey(day)) ?? []).length > 0),
    [days, grouped],
  );

  if (populated.length === 0) {
    return (
      <div className="border border-border p-8 text-center text-sm text-muted-foreground">
        Nothing scheduled in the next 30 days.
      </div>
    );
  }

  return (
    <div className="border border-border divide-y divide-border">
      {populated.map((day) => {
        const dayEvents = grouped.get(dayKey(day))!;
        return (
          <section key={dayKey(day)} aria-label={day.toDateString()}>
            <h3
              className={cn(
                "sticky top-0 z-10 bg-muted/60 px-3 py-1.5 text-[11px] font-medium uppercase tracking-wide backdrop-blur",
                isSameDay(day, now) ? "text-foreground" : "text-muted-foreground",
              )}
            >
              {day.toLocaleDateString(undefined, {
                weekday: "long",
                day: "numeric",
                month: "long",
              })}
              {isSameDay(day, now) ? " · Today" : ""}
            </h3>
            <ul className="divide-y divide-border/60">
              {collapseSeries(dayEvents, 3).map((cluster) => {
                const event = cluster.event;
                const meta = CALENDAR_KIND_META[event.kind];
                const Icon = meta.icon;
                const scheduleTime = scheduleLocalTime(event, viewerTimeZone);
                const row = (
                  <div className="flex items-center gap-3 px-3 py-2">
                    <span
                      aria-hidden="true"
                      className="h-6 w-0.5 shrink-0 status-fill"
                      style={{ "--sc": eventHue(event) } as React.CSSProperties}
                    />
                    <span className="w-[4.5rem] shrink-0 text-xs tabular-nums text-muted-foreground">
                      {formatTime(new Date(event.at))}
                    </span>
                    <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                      {event.title}
                      {cluster.count > 1 ? (
                        <span className="ml-1.5 text-[11px] text-muted-foreground">
                          ×{cluster.count} until {formatTime(new Date(cluster.lastAt))}
                        </span>
                      ) : null}
                    </span>
                    {scheduleTime ? (
                      <span className="hidden shrink-0 text-[11px] text-muted-foreground sm:inline">
                        {scheduleTime} {event.scheduleTimezone}
                      </span>
                    ) : null}
                    {event.agentName ? (
                      <span className="hidden shrink-0 text-[11px] text-muted-foreground md:inline">
                        {event.agentName}
                      </span>
                    ) : null}
                    <span
                      className={cn(
                        "shrink-0 border px-1.5 py-0.5 text-[10px] uppercase tracking-wide",
                        event.tense === "projected"
                          ? "border-dashed border-border text-muted-foreground"
                          : "border-border text-muted-foreground",
                      )}
                    >
                      {eventStatusLabel(event)}
                    </span>
                  </div>
                );

                return (
                  <li key={event.id}>
                    {event.href ? (
                      <Link to={event.href} className="block hover:bg-accent/50">
                        {row}
                      </Link>
                    ) : (
                      row
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
