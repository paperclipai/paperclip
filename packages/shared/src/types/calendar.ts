/**
 * Company Calendar types — shared between the aggregation service
 * (`server/src/services/calendar.ts`) and the UI page (`ui/src/pages/Calendar.tsx`)
 * so both sides consume one contract. Returned by
 * `GET /api/companies/:companyId/calendar`.
 *
 * The calendar differs from the work timeline (`./work-timeline.js`) in one
 * decisive way: the timeline's window is clamped to `now`, so it can only ever
 * answer "what happened". The calendar spans both directions and its headline
 * content is the *projected* future — cron occurrences that have not run yet.
 */

/** Which scheduled surface an entry came from. */
export type CalendarEventKind =
  /** A projected future occurrence of a routine's cron schedule. */
  | "routine_scheduled"
  /** A routine execution that actually happened. */
  | "routine_run"
  /** A task's next scheduled monitor check. */
  | "task_monitor"
  /** A task lifecycle moment (started / completed). */
  | "task_activity"
  /** An agent heartbeat run. */
  | "agent_run";

/**
 * Whether an entry is a fact or a forecast. `projected` entries are computed
 * from a schedule and have not happened; everything else is a stored record.
 */
export type CalendarEventTense = "projected" | "actual";

/**
 * Outcome shown on the chip. `scheduled` is the only value a projected entry
 * can carry; the rest describe records that exist.
 */
export type CalendarEventStatus =
  | "scheduled"
  | "running"
  | "succeeded"
  | "failed"
  | "skipped"
  | "cancelled";

export interface CalendarEvent {
  /**
   * Stable within a single response. Projected occurrences have no database
   * row, so their id is derived from the trigger and the occurrence instant
   * (`routine_scheduled:<triggerId>:<iso>`), which keeps React keys and
   * selection stable across refetches.
   */
  id: string;
  kind: CalendarEventKind;
  tense: CalendarEventTense;
  status: CalendarEventStatus;
  title: string;
  /** ISO timestamp the entry is placed at. */
  at: string;
  /** ISO timestamp the entry ends at, when it has a real duration. */
  endAt: string | null;
  agentId: string | null;
  agentName: string | null;
  routineId: string | null;
  routineTitle: string | null;
  issueId: string | null;
  issueIdentifier: string | null;
  projectId: string | null;
  /**
   * IANA timezone the schedule is expressed in, for `routine_scheduled` only.
   * The UI renders every entry in the viewer's timezone and surfaces this when
   * the two differ, so a 09:00 Europe/London cron is not silently read as 09:00
   * local.
   */
  scheduleTimezone: string | null;
  /** The cron expression behind a projected occurrence, for the detail popover. */
  cronExpression: string | null;
  /** In-app path the chip links to, e.g. `/routines/<id>` or `/issues/<identifier>`. */
  href: string | null;
}

/**
 * A schedule whose occurrences were capped inside the requested window. The UI
 * says so out loud rather than rendering a partial month as if it were whole.
 */
export interface CalendarTruncatedSeries {
  routineId: string;
  routineTitle: string;
  triggerId: string;
  cronExpression: string;
  /** Occurrences actually returned for this series. */
  returned: number;
}

export interface CalendarResult {
  events: CalendarEvent[];
  window: {
    /** ISO timestamp of the window start. */
    from: string;
    /** ISO timestamp of the window end. */
    to: string;
    /** True when the requested window exceeded the maximum and was shortened. */
    capped: boolean;
  };
  counts: Record<CalendarEventKind, number>;
  /**
   * Present when output was capped, for any reason. The UI says so out loud
   * rather than rendering a partial window as if it were whole.
   *
   * `series` names the schedules that hit the per-series projection cap.
   * `droppedEvents` counts entries the global cap discarded.
   * `sources` names the kinds whose *database query* hit its row ceiling, which
   * happens before any of the above and would otherwise be invisible.
   */
  truncated: {
    series: CalendarTruncatedSeries[];
    droppedEvents: number;
    sources: CalendarEventKind[];
  } | null;
  /**
   * Schedules that could not be projected — an unparseable cron expression or
   * an unknown timezone on the trigger. Surfaced so a broken routine shows up
   * as a visible warning instead of an empty calendar.
   */
  unschedulable: {
    routineId: string;
    routineTitle: string;
    triggerId: string;
    reason: string;
  }[];
}
