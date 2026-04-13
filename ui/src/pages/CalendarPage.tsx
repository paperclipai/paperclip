import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Calendar, dateFnsLocalizer, type View } from "react-big-calendar";
import "react-big-calendar/lib/css/react-big-calendar.css";
import { format, parse, startOfWeek, endOfWeek, getDay, addWeeks, addMonths, startOfMonth, endOfMonth } from "date-fns";
import { enUS } from "date-fns/locale";
import { CalendarIcon, ChevronLeft, ChevronRight } from "lucide-react";
import { useNavigate } from "@/lib/router";
import { calendarApi, type CalendarEvent } from "../api/calendar";
import { agentsApi } from "../api/agents";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";

// react-big-calendar CSS — minimal inline override using CSS vars
const calendarStyles = `
.rbc-calendar {
  font-family: inherit;
  color: var(--foreground);
  background: transparent;
}
.rbc-toolbar {
  display: none; /* We render our own toolbar */
}
.rbc-header {
  padding: 6px 3px;
  font-size: 0.75rem;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--muted-foreground);
  border-color: var(--border);
  background: transparent;
}
.rbc-month-view,
.rbc-agenda-view,
.rbc-time-view {
  border-color: var(--border);
  border-radius: 0.5rem;
  overflow: hidden;
}
.rbc-day-bg,
.rbc-time-slot {
  background: transparent;
}
.rbc-off-range-bg {
  background: color-mix(in srgb, var(--muted) 30%, transparent);
}
.rbc-today {
  background: color-mix(in srgb, var(--primary) 8%, transparent);
}
.rbc-event {
  border-radius: 4px;
  font-size: 0.75rem;
  font-weight: 500;
  padding: 1px 4px;
  border: none;
  cursor: pointer;
}
.rbc-event.rbc-selected {
  outline: 2px solid var(--primary);
}
.rbc-show-more {
  font-size: 0.7rem;
  color: var(--muted-foreground);
  background: transparent;
}
.rbc-date-cell {
  font-size: 0.8rem;
  padding: 2px 4px;
  color: var(--foreground);
}
.rbc-date-cell.rbc-off-range {
  color: var(--muted-foreground);
}
.rbc-agenda-table {
  width: 100%;
}
.rbc-agenda-table td,
.rbc-agenda-table th {
  padding: 6px 12px;
  border-color: var(--border);
  font-size: 0.875rem;
  color: var(--foreground);
  background: transparent;
}
.rbc-agenda-date-cell {
  font-weight: 500;
}
.rbc-agenda-empty {
  padding: 24px;
  text-align: center;
  color: var(--muted-foreground);
  font-size: 0.875rem;
}
.rbc-time-content {
  border-color: var(--border);
}
.rbc-time-header {
  border-color: var(--border);
}
.rbc-time-header-content {
  border-color: var(--border);
}
.rbc-timeslot-group {
  border-color: var(--border);
  min-height: 40px;
}
.rbc-time-slot {
  border-color: color-mix(in srgb, var(--border) 40%, transparent);
}
.rbc-label {
  font-size: 0.7rem;
  color: var(--muted-foreground);
  padding: 0 6px;
}
.rbc-current-time-indicator {
  background-color: var(--primary);
  height: 2px;
  opacity: 0.8;
}
`;

const localizer = dateFnsLocalizer({
  format,
  parse,
  startOfWeek: () => startOfWeek(new Date(), { locale: enUS }),
  getDay,
  locales: { "en-US": enUS },
});

interface BigCalendarEvent {
  id: string;
  title: string;
  start: Date;
  end: Date;
  resource: CalendarEvent;
}

function eventStyleGetter(event: BigCalendarEvent) {
  const kind = event.resource.kind;
  const status = event.resource.status;

  if (status === "paused") {
    return {
      style: {
        backgroundColor: "var(--muted)",
        color: "var(--muted-foreground)",
        opacity: 0.7,
      },
    };
  }
  if (kind === "routine") {
    return {
      style: {
        backgroundColor: "#3b82f6",
        color: "#fff",
      },
    };
  }
  // plugin_job
  return {
    style: {
      backgroundColor: "#a855f7",
      color: "#fff",
    },
  };
}

function EventDetail({ event, agentName, onClose }: { event: CalendarEvent; agentName?: string; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center p-4 sm:items-center" onClick={onClose}>
      <div
        className="relative w-full max-w-sm rounded-xl border border-border bg-card p-5 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <span
                className="h-2.5 w-2.5 rounded-full shrink-0"
                style={{
                  backgroundColor:
                    event.status === "paused"
                      ? "var(--muted-foreground)"
                      : event.kind === "routine"
                        ? "#3b82f6"
                        : "#a855f7",
                }}
              />
              <p className="text-sm font-semibold text-foreground">{event.title}</p>
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground capitalize">
              {event.kind === "routine" ? "Routine" : "Plugin job"}
              {event.status === "paused" && <span className="ml-2 text-amber-600 dark:text-amber-400">paused</span>}
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground transition-colors"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <dl className="space-y-1.5 text-sm">
          {event.nextRunAt && (
            <div className="flex gap-2">
              <dt className="text-muted-foreground w-20 shrink-0">Time</dt>
              <dd className="text-foreground">{new Date(event.nextRunAt).toLocaleString()}</dd>
            </div>
          )}
          <div className="flex gap-2">
            <dt className="text-muted-foreground w-20 shrink-0">Schedule</dt>
            <dd className="text-foreground font-mono text-xs">{event.cronExpression}</dd>
          </div>
          {event.timezone && (
            <div className="flex gap-2">
              <dt className="text-muted-foreground w-20 shrink-0">Timezone</dt>
              <dd className="text-foreground">{event.timezone}</dd>
            </div>
          )}
          {agentName && (
            <div className="flex gap-2">
              <dt className="text-muted-foreground w-20 shrink-0">Agent</dt>
              <dd className="text-foreground">{agentName}</dd>
            </div>
          )}
        </dl>

        {event.routineId && (
          <div className="mt-4">
            <a
              href={`/routines/${event.routineId}`}
              className="text-xs text-primary hover:underline"
              onClick={onClose}
            >
              Open routine →
            </a>
          </div>
        )}
      </div>
    </div>
  );
}

export function CalendarPage() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const navigate = useNavigate();
  const [view, setView] = useState<View>("week");
  const [currentDate, setCurrentDate] = useState(() => new Date());
  const [selectedEvent, setSelectedEvent] = useState<CalendarEvent | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Calendar" }]);
  }, [setBreadcrumbs]);

  // Window for current view (1 full month)
  const windowStart = useMemo(() => startOfMonth(currentDate), [currentDate]);
  const windowEnd = useMemo(() => endOfMonth(addMonths(currentDate, 1)), [currentDate]);

  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.calendar.events(
      selectedCompanyId!,
      windowStart.toISOString(),
      windowEnd.toISOString(),
    ),
    queryFn: () => calendarApi.getEvents(selectedCompanyId!, windowStart, windowEnd),
    enabled: !!selectedCompanyId,
    refetchOnWindowFocus: true,
    refetchInterval: 5 * 60 * 1000, // 5-minute polling
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const agentById = useMemo(
    () => new Map((agents ?? []).map((a) => [a.id, a])),
    [agents],
  );

  // Convert CalendarEvents → react-big-calendar events
  const bigCalEvents = useMemo<BigCalendarEvent[]>(() => {
    if (!data?.events) return [];
    return data.events
      .filter((e) => e.nextRunAt)
      .map((e) => {
        const start = new Date(e.nextRunAt!);
        const end = new Date(start.getTime() + 30 * 60 * 1000); // 30-min display block
        return {
          id: e.id,
          title: e.title,
          start,
          end,
          resource: e,
        };
      });
  }, [data]);

  function navigate_(direction: "prev" | "next" | "today") {
    setCurrentDate((d) => {
      if (direction === "today") return new Date();
      const delta = direction === "next" ? 1 : -1;
      return view === "week" ? addWeeks(d, delta) : addMonths(d, delta);
    });
  }

  if (!selectedCompanyId) {
    return <EmptyState icon={CalendarIcon} message="Select a company to view the calendar." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="issues-list" />;
  }

  if (error) {
    return (
      <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
        {error instanceof Error ? error.message : "Failed to load calendar events"}
      </div>
    );
  }

  const dateLabel = view === "week"
    ? `${format(startOfWeek(currentDate), "MMM d")} – ${format(endOfWeek(currentDate), "MMM d, yyyy")}`
    : format(currentDate, "MMMM yyyy");

  return (
    <>
      <style>{calendarStyles}</style>

      <div className="flex flex-col gap-4 h-full">
        {/* Header */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
              <CalendarIcon className="h-6 w-6 text-muted-foreground" />
              Calendar
            </h1>
            <p className="text-sm text-muted-foreground">
              Scheduled routines and plugin jobs across the company.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1">
              <Button variant="outline" size="sm" onClick={() => navigate_("prev")} aria-label="Previous month">
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <Button variant="outline" size="sm" onClick={() => navigate_("today")}>
                Today
              </Button>
              <Button variant="outline" size="sm" onClick={() => navigate_("next")} aria-label="Next month">
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
            <span className="text-sm font-medium text-foreground min-w-[140px] text-center">{dateLabel}</span>
            <div className="flex items-center gap-1 rounded-md border border-border p-0.5">
              {(["week", "month", "agenda"] as View[]).map((v) => (
                <button
                  key={v}
                  onClick={() => setView(v)}
                  className={`px-3 py-1 text-xs font-medium rounded transition-colors ${
                    view === v
                      ? "bg-foreground text-background"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {v.charAt(0).toUpperCase() + v.slice(1)}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Legend */}
        <div className="flex items-center gap-4 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full bg-blue-500" />
            Routines
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full bg-purple-500" />
            Plugin jobs
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full bg-muted-foreground opacity-50" />
            Paused
          </span>
        </div>

        {/* Calendar */}
        <div className="flex-1 min-h-0" style={{ minHeight: "500px" }}>
          <Calendar
            localizer={localizer}
            events={bigCalEvents}
            view={view}
            views={["week", "month", "agenda"]}
            date={currentDate}
            onView={setView}
            onNavigate={setCurrentDate}
            eventPropGetter={eventStyleGetter}
            onSelectEvent={(event: BigCalendarEvent) => setSelectedEvent(event.resource)}
            startAccessor="start"
            endAccessor="end"
            titleAccessor="title"
            min={new Date(0, 0, 0, 6, 0, 0)}
            max={new Date(0, 0, 0, 22, 0, 0)}
            popup
            style={{ height: "100%", minHeight: 500 }}
          />
        </div>
      </div>

      {selectedEvent && (
        <EventDetail
          event={selectedEvent}
          agentName={
            selectedEvent.assigneeAgentId
              ? (agentById.get(selectedEvent.assigneeAgentId)?.name ?? undefined)
              : undefined
          }
          onClose={() => setSelectedEvent(null)}
        />
      )}
    </>
  );
}
