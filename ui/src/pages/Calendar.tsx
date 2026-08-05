import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CalendarDays } from "lucide-react";
import type { CalendarEventKind } from "@paperclipai/shared";
import { calendarApi } from "../api/calendar";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { CalendarToolbar } from "../components/calendar/CalendarToolbar";
import { CalendarMonthView } from "../components/calendar/CalendarMonthView";
import { CalendarTimeGridView } from "../components/calendar/CalendarTimeGridView";
import { CalendarAgendaView } from "../components/calendar/CalendarAgendaView";
import { CALENDAR_KIND_META } from "../components/calendar/calendar-visuals";
import { useSearchParams } from "@/lib/router";
import {
  isCalendarViewMode,
  shiftAnchor,
  startOfDay,
  viewTitle,
  viewerTimeZone,
  windowForView,
  type CalendarViewMode,
} from "@/lib/calendar-grid";

const ALL_KINDS = Object.keys(CALENDAR_KIND_META) as CalendarEventKind[];

function parseAnchor(raw: string | null): Date {
  if (raw) {
    const parsed = new Date(`${raw}T00:00:00`);
    if (!Number.isNaN(parsed.getTime())) return startOfDay(parsed);
  }
  return startOfDay(new Date());
}

/** `YYYY-MM-DD` in local time, so a shared URL opens on the day it names. */
function anchorParam(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function parseKinds(raw: string | null): CalendarEventKind[] {
  if (!raw) return ALL_KINDS;
  const requested = raw.split(",").filter((kind): kind is CalendarEventKind =>
    (ALL_KINDS as string[]).includes(kind),
  );
  return requested.length > 0 ? requested : ALL_KINDS;
}

/**
 * The company calendar.
 *
 * Paperclip could already tell you what its agents *had* done — the activity
 * feed and the work timeline both look backwards, and the timeline's window is
 * clamped to `now` in code. This page answers the other half: what is about to
 * happen. Cron schedules are projected forward and drawn next to the runs that
 * already occurred, with forecast and fact visually distinct.
 *
 * View, date and filters all live in the URL so a particular week is a link
 * someone can send.
 */
export function Calendar() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [searchParams, setSearchParams] = useSearchParams();

  const mode: CalendarViewMode = isCalendarViewMode(searchParams.get("view"))
    ? (searchParams.get("view") as CalendarViewMode)
    : "month";
  const anchor = parseAnchor(searchParams.get("date"));
  const activeKinds = parseKinds(searchParams.get("kinds"));

  // `now` is state rather than a fresh `new Date()` per render so the current
  // time indicator advances on a timer instead of only when something else
  // happens to re-render the page.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    setBreadcrumbs([{ label: "Calendar" }]);
    return () => setBreadcrumbs([]);
  }, [setBreadcrumbs]);

  const timeZone = useMemo(() => viewerTimeZone(), []);
  const window = useMemo(() => windowForView(mode, anchor), [mode, anchor]);
  const kindsKey = activeKinds.join(",");

  const updateParams = useCallback(
    (next: { view?: CalendarViewMode; date?: Date; kinds?: CalendarEventKind[] }) => {
      const params = new URLSearchParams(searchParams);
      if (next.view) params.set("view", next.view);
      if (next.date) params.set("date", anchorParam(next.date));
      if (next.kinds) {
        if (next.kinds.length === ALL_KINDS.length) params.delete("kinds");
        else params.set("kinds", next.kinds.join(","));
      }
      setSearchParams(params, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  const goToday = useCallback(() => updateParams({ date: new Date() }), [updateParams]);
  const navigate = useCallback(
    (direction: 1 | -1) => updateParams({ date: shiftAnchor(mode, anchor, direction) }),
    [updateParams, mode, anchor],
  );
  const setMode = useCallback(
    (next: CalendarViewMode) => updateParams({ view: next }),
    [updateParams],
  );
  const toggleKind = useCallback(
    (kind: CalendarEventKind) => {
      const next = activeKinds.includes(kind)
        ? activeKinds.filter((candidate) => candidate !== kind)
        : [...activeKinds, kind];
      // Refuse to filter everything away — an empty calendar that the user
      // caused by accident looks identical to one with nothing scheduled.
      updateParams({ kinds: next.length === 0 ? ALL_KINDS : next });
    },
    [activeKinds, updateParams],
  );

  // Keyboard bindings follow Google Calendar and Linear: view keys, arrows for
  // the period, T for today. Ignored while a field or a modifier is in play.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      // `target` is only an Element when the key went to the document tree — a
      // keydown dispatched at the window has the window itself as its target.
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest("input, textarea, select, [contenteditable='true']")
      ) {
        return;
      }

      const key = event.key.toLowerCase();
      if (key === "t") return void (event.preventDefault(), goToday());
      if (key === "m") return void (event.preventDefault(), setMode("month"));
      if (key === "w") return void (event.preventDefault(), setMode("week"));
      if (key === "d") return void (event.preventDefault(), setMode("day"));
      if (key === "a") return void (event.preventDefault(), setMode("agenda"));
      if (key === "arrowright" || key === "j") return void (event.preventDefault(), navigate(1));
      if (key === "arrowleft" || key === "k") return void (event.preventDefault(), navigate(-1));
    };
    globalThis.addEventListener("keydown", onKeyDown);
    return () => globalThis.removeEventListener("keydown", onKeyDown);
  }, [goToday, setMode, navigate]);

  const { data, isLoading, isError } = useQuery({
    queryKey: queryKeys.calendar(
      selectedCompanyId!,
      window.from.toISOString(),
      window.to.toISOString(),
      kindsKey,
    ),
    queryFn: () =>
      calendarApi.get(selectedCompanyId!, {
        from: window.from.toISOString(),
        to: window.to.toISOString(),
        kinds: activeKinds,
      }),
    enabled: !!selectedCompanyId,
    // Projections are deterministic; the only thing that moves underneath is
    // new history, so a slow poll is plenty.
    refetchInterval: 60_000,
  });

  const events = data?.events ?? [];
  const upcomingCount = useMemo(
    () => events.filter((event) => event.tense === "projected" && new Date(event.at) >= now).length,
    [events, now],
  );

  if (!selectedCompanyId) return null;
  if (isLoading) return <PageSkeleton variant="list" />;

  return (
    <div className="space-y-4">
      <div className="flex items-baseline gap-3">
        <h1 className="text-lg font-semibold text-foreground">Calendar</h1>
        <p className="text-xs text-muted-foreground">
          {upcomingCount > 0
            ? `${upcomingCount} scheduled ahead · times in ${timeZone}`
            : `Times in ${timeZone}`}
        </p>
      </div>

      <CalendarToolbar
        title={viewTitle(mode, anchor)}
        mode={mode}
        activeKinds={activeKinds}
        onModeChange={setMode}
        onNavigate={navigate}
        onToday={goToday}
        onToggleKind={toggleKind}
      />

      {data?.unschedulable && data.unschedulable.length > 0 ? (
        <div className="flex items-start gap-2 border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <p>
            {data.unschedulable.length} routine
            {data.unschedulable.length === 1 ? " has" : "s have"} a schedule that cannot be read, so
            nothing is projected for {data.unschedulable.length === 1 ? "it" : "them"}:{" "}
            {data.unschedulable.map((entry) => entry.routineTitle).join(", ")}.
          </p>
        </div>
      ) : null}

      {data?.truncated ? (
        <div className="flex items-start gap-2 border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <div className="space-y-1">
            {data.truncated.series.length > 0 ? (
              <p>
                Some schedules run too often to draw in full. Showing the earliest occurrences for{" "}
                {data.truncated.series.map((entry) => entry.routineTitle).join(", ")}
                {data.truncated.droppedEvents > 0
                  ? `, and ${data.truncated.droppedEvents} further entries are hidden`
                  : ""}
                .
              </p>
            ) : data.truncated.droppedEvents > 0 ? (
              <p>{data.truncated.droppedEvents} entries are hidden in this window.</p>
            ) : null}
            {data.truncated.sources.length > 0 ? (
              <p>
                This window holds more{" "}
                {data.truncated.sources
                  .map((kind) => CALENDAR_KIND_META[kind].label.toLowerCase())
                  .join(" and ")}{" "}
                than the calendar loads at once. Narrow the window or use the filters to see the
                rest.
              </p>
            ) : null}
          </div>
        </div>
      ) : null}

      {isError ? (
        <div className="border border-border px-3 py-8 text-center text-sm text-muted-foreground">
          The calendar could not be loaded.
        </div>
      ) : events.length === 0 ? (
        <EmptyState
          icon={CalendarDays}
          message="Nothing scheduled in this window. Give a routine a cron schedule and its next runs will appear here."
        />
      ) : mode === "month" ? (
        <CalendarMonthView
          anchor={anchor}
          events={events}
          now={now}
          viewerTimeZone={timeZone}
          onSelectDay={(day) => updateParams({ view: "day", date: day })}
        />
      ) : mode === "agenda" ? (
        <CalendarAgendaView anchor={anchor} events={events} now={now} viewerTimeZone={timeZone} />
      ) : (
        <CalendarTimeGridView
          mode={mode}
          anchor={anchor}
          events={events}
          now={now}
          viewerTimeZone={timeZone}
        />
      )}
    </div>
  );
}
