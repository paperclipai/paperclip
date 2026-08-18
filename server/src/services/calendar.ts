/**
 * Company Calendar aggregation.
 *
 * Collapses every scheduled surface in a company — routine cron schedules,
 * routine runs, task monitor checks, task lifecycle moments and agent runs —
 * into one time-ordered event stream for `GET /api/companies/:id/calendar`.
 *
 * The distinguishing feature versus `work-timeline.ts` is direction. The
 * timeline's window normaliser clamps `to` down to `now`, so it is structurally
 * incapable of answering "what happens next"; this service projects forward
 * from cron schedules and returns the result alongside recorded history, marked
 * so the UI can tell forecast from fact.
 *
 * @module
 */

import { and, asc, desc, eq, gte, isNotNull, lte, or } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, heartbeatRuns, issues, routineRuns, routineTriggers, routines } from "@paperclipai/db";
import type {
  CalendarEvent,
  CalendarEventKind,
  CalendarEventStatus,
  CalendarResult,
  CalendarTruncatedSeries,
} from "@paperclipai/shared";
import { expandCronOccurrences } from "./cron-occurrences.js";

export const CALENDAR_EVENT_KINDS: CalendarEventKind[] = [
  "routine_scheduled",
  "routine_run",
  "task_monitor",
  "task_activity",
  "agent_run",
];

const DEFAULT_WINDOW_MS = 31 * 24 * 60 * 60 * 1000;
/** Three months. Longer windows make the cron projection cost unbounded. */
const MAX_WINDOW_MS = 92 * 24 * 60 * 60 * 1000;
/**
 * Per-schedule projection cap. A `*​/5` cron produces ~8,600 occurrences a
 * month; past a few hundred the calendar is a wall of identical chips and the
 * honest answer is a count plus a "capped" note.
 */
const PER_SERIES_LIMIT = 500;
/** Total events returned, across every kind. */
const GLOBAL_LIMIT = 3_000;
/** Row ceiling per source query, so one busy company cannot exhaust memory. */
const MAX_SOURCE_ROWS = 2_000;

/**
 * Read one row past the ceiling so hitting it is detectable.
 *
 * A silently-truncated source is the worst failure this endpoint has: the
 * calendar would look complete while missing entries, with nothing in the
 * response to say so. Every source therefore asks for `MAX_SOURCE_ROWS + 1`
 * rows and reports the overflow instead of swallowing it.
 */
function takeWithinCap<T>(rows: T[]): { rows: T[]; capped: boolean } {
  return rows.length > MAX_SOURCE_ROWS
    ? { rows: rows.slice(0, MAX_SOURCE_ROWS), capped: true }
    : { rows, capped: false };
}

export interface CalendarQuery {
  companyId: string;
  from?: Date;
  to?: Date;
  kinds?: CalendarEventKind[];
  agentId?: string;
  projectId?: string;
  routineId?: string;
}

export function normalizeCalendarWindow(input: { from?: Date; to?: Date }, now = new Date()) {
  const from = input.from ?? new Date(now.getTime() - DEFAULT_WINDOW_MS / 2);
  const requestedTo = input.to ?? new Date(from.getTime() + DEFAULT_WINDOW_MS);
  let to = requestedTo;
  let capped = false;

  if (to.getTime() < from.getTime()) {
    to = new Date(from.getTime() + DEFAULT_WINDOW_MS);
    capped = true;
  }
  if (to.getTime() - from.getTime() > MAX_WINDOW_MS) {
    to = new Date(from.getTime() + MAX_WINDOW_MS);
    capped = true;
  }
  return { from, to, capped };
}

export function normalizeCalendarKinds(raw: unknown): CalendarEventKind[] {
  const requested = Array.isArray(raw)
    ? raw
    : typeof raw === "string"
      ? raw.split(",")
      : [];
  const wanted = requested
    .map((value) => String(value).trim())
    .filter((value): value is CalendarEventKind =>
      (CALENDAR_EVENT_KINDS as string[]).includes(value),
    );
  return wanted.length > 0 ? [...new Set(wanted)] : [...CALENDAR_EVENT_KINDS];
}

/**
 * Map a stored routine-run status onto the calendar's small status vocabulary.
 * Unknown values fall through to `succeeded` rather than inventing a failure.
 */
function routineRunStatus(status: string, failureReason: string | null): CalendarEventStatus {
  if (status === "failed" || failureReason) return "failed";
  if (status === "skipped" || status === "skipped_paused" || status === "coalesced") return "skipped";
  if (status === "received" || status === "dispatching") return "running";
  return "succeeded";
}

function heartbeatRunStatus(status: string): CalendarEventStatus {
  if (status === "failed" || status === "error") return "failed";
  if (status === "cancelled") return "cancelled";
  if (status === "running" || status === "queued" || status === "claimed") return "running";
  return "succeeded";
}

function issueHref(identifier: string | null, id: string): string {
  return `/issues/${identifier ?? id}`;
}

/**
 * Keep the earliest events while guaranteeing every series is represented.
 *
 * A naive "sort by time, slice to the cap" lets one `*​/5` routine eat the whole
 * budget and silently delete another routine's genuine next run — the calendar
 * would look complete and be wrong. So the cap is spent round-robin across
 * groups: each pass takes the next-earliest event from every group in turn.
 */
function allocateFairly(groups: Map<string, CalendarEvent[]>, limit: number) {
  const ordered = [...groups.values()].map((events) =>
    [...events].sort((a, b) => a.at.localeCompare(b.at)),
  );
  const total = ordered.reduce((sum, events) => sum + events.length, 0);
  if (total <= limit) {
    return { events: ordered.flat(), dropped: 0 };
  }

  const kept: CalendarEvent[] = [];
  const cursors = new Array<number>(ordered.length).fill(0);
  let exhaustedGroups = 0;
  while (kept.length < limit && exhaustedGroups < ordered.length) {
    exhaustedGroups = 0;
    for (let group = 0; group < ordered.length && kept.length < limit; group += 1) {
      const cursor = cursors[group]!;
      const events = ordered[group]!;
      if (cursor >= events.length) {
        exhaustedGroups += 1;
        continue;
      }
      kept.push(events[cursor]!);
      cursors[group] = cursor + 1;
    }
  }
  return { events: kept, dropped: total - kept.length };
}

export function calendarService(db: Db) {
  /**
   * Project every enabled cron trigger in the company into the window.
   *
   * Only `schedule` triggers project: webhook and API triggers fire when
   * something external says so, and drawing a guess for them on a calendar
   * would be a fabrication.
   */
  async function projectRoutineSchedules(
    query: CalendarQuery,
    window: { from: Date; to: Date },
    now: Date,
  ) {
    const conditions = [
      eq(routines.companyId, query.companyId),
      eq(routines.status, "active"),
      eq(routineTriggers.kind, "schedule"),
      eq(routineTriggers.enabled, true),
      isNotNull(routineTriggers.cronExpression),
    ];
    if (query.routineId) conditions.push(eq(routines.id, query.routineId));
    if (query.projectId) conditions.push(eq(routines.projectId, query.projectId));
    if (query.agentId) conditions.push(eq(routines.assigneeAgentId, query.agentId));

    const scheduleRows = await db
      .select({
        triggerId: routineTriggers.id,
        cronExpression: routineTriggers.cronExpression,
        timezone: routineTriggers.timezone,
        routineId: routines.id,
        routineTitle: routines.title,
        projectId: routines.projectId,
        agentId: routines.assigneeAgentId,
        agentName: agents.name,
      })
      .from(routineTriggers)
      .innerJoin(routines, eq(routineTriggers.routineId, routines.id))
      .leftJoin(agents, eq(routines.assigneeAgentId, agents.id))
      .where(and(...conditions))
      // Deterministic order. Without it the rows that survive the ceiling are
      // whatever the planner happened to return, so two identical requests
      // could project different schedules.
      .orderBy(asc(routines.title), asc(routineTriggers.id))
      .limit(MAX_SOURCE_ROWS + 1);
    const { rows, capped } = takeWithinCap(scheduleRows);

    // Only the future is projected. The past half of the window is served by
    // `routine_run` records, which are what actually happened — overlaying
    // guesses on top of history would double-count and could contradict it.
    const projectFrom = window.from.getTime() > now.getTime() ? window.from : now;

    const series = new Map<string, CalendarEvent[]>();
    const truncatedSeries: CalendarTruncatedSeries[] = [];
    const unschedulable: CalendarResult["unschedulable"] = [];

    for (const row of rows) {
      const expression = row.cronExpression;
      const timezone = row.timezone ?? "UTC";
      if (!expression) continue;

      let expanded;
      try {
        expanded = expandCronOccurrences(expression, timezone, {
          from: projectFrom,
          to: window.to,
          limit: PER_SERIES_LIMIT,
        });
      } catch (err) {
        // A trigger with an unparseable cron or a dead timezone must not blank
        // the whole calendar — it becomes a visible warning instead. Same
        // isolation principle as #5238 in the scheduler batch.
        unschedulable.push({
          routineId: row.routineId,
          routineTitle: row.routineTitle,
          triggerId: row.triggerId,
          reason: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      const events = expanded.occurrences.map<CalendarEvent>((occurrence) => ({
        id: `routine_scheduled:${row.triggerId}:${occurrence.toISOString()}`,
        kind: "routine_scheduled",
        tense: "projected",
        status: "scheduled",
        title: row.routineTitle,
        at: occurrence.toISOString(),
        endAt: null,
        agentId: row.agentId,
        agentName: row.agentName ?? null,
        routineId: row.routineId,
        routineTitle: row.routineTitle,
        issueId: null,
        issueIdentifier: null,
        projectId: row.projectId,
        scheduleTimezone: timezone,
        cronExpression: expression,
        href: `/routines/${row.routineId}`,
      }));

      if (events.length > 0) series.set(row.triggerId, events);
      if (expanded.truncated) {
        truncatedSeries.push({
          routineId: row.routineId,
          routineTitle: row.routineTitle,
          triggerId: row.triggerId,
          cronExpression: expression,
          returned: events.length,
        });
      }
    }

    return { series, truncatedSeries, unschedulable, capped };
  }

  async function loadRoutineRuns(query: CalendarQuery, window: { from: Date; to: Date }) {
    const conditions = [
      eq(routineRuns.companyId, query.companyId),
      gte(routineRuns.triggeredAt, window.from),
      lte(routineRuns.triggeredAt, window.to),
    ];
    if (query.routineId) conditions.push(eq(routineRuns.routineId, query.routineId));
    if (query.projectId) conditions.push(eq(routines.projectId, query.projectId));
    if (query.agentId) conditions.push(eq(routines.assigneeAgentId, query.agentId));

    const runRows = await db
      .select({
        id: routineRuns.id,
        status: routineRuns.status,
        failureReason: routineRuns.failureReason,
        triggeredAt: routineRuns.triggeredAt,
        completedAt: routineRuns.completedAt,
        routineId: routines.id,
        routineTitle: routines.title,
        projectId: routines.projectId,
        agentId: routines.assigneeAgentId,
        agentName: agents.name,
        issueId: routineRuns.linkedIssueId,
      })
      .from(routineRuns)
      .innerJoin(routines, eq(routineRuns.routineId, routines.id))
      .leftJoin(agents, eq(routines.assigneeAgentId, agents.id))
      .where(and(...conditions))
      .orderBy(desc(routineRuns.triggeredAt), asc(routineRuns.id))
      .limit(MAX_SOURCE_ROWS + 1);
    const { rows, capped } = takeWithinCap(runRows);

    const events = rows.map<CalendarEvent>((row) => ({
      id: `routine_run:${row.id}`,
      kind: "routine_run",
      tense: "actual",
      status: routineRunStatus(row.status, row.failureReason),
      title: row.routineTitle,
      at: row.triggeredAt.toISOString(),
      endAt: row.completedAt ? row.completedAt.toISOString() : null,
      agentId: row.agentId,
      agentName: row.agentName ?? null,
      routineId: row.routineId,
      routineTitle: row.routineTitle,
      issueId: row.issueId,
      issueIdentifier: null,
      projectId: row.projectId,
      scheduleTimezone: null,
      cronExpression: null,
      href: `/routines/${row.routineId}`,
    }));
    return { events, capped };
  }

  async function loadTaskMonitors(query: CalendarQuery, window: { from: Date; to: Date }) {
    const conditions = [
      eq(issues.companyId, query.companyId),
      isNotNull(issues.monitorNextCheckAt),
      gte(issues.monitorNextCheckAt, window.from),
      lte(issues.monitorNextCheckAt, window.to),
    ];
    if (query.projectId) conditions.push(eq(issues.projectId, query.projectId));
    if (query.agentId) conditions.push(eq(issues.assigneeAgentId, query.agentId));

    const monitorRows = await db
      .select({
        id: issues.id,
        identifier: issues.identifier,
        title: issues.title,
        projectId: issues.projectId,
        agentId: issues.assigneeAgentId,
        agentName: agents.name,
        monitorNextCheckAt: issues.monitorNextCheckAt,
      })
      .from(issues)
      .leftJoin(agents, eq(issues.assigneeAgentId, agents.id))
      .where(and(...conditions))
      .orderBy(asc(issues.monitorNextCheckAt), asc(issues.id))
      .limit(MAX_SOURCE_ROWS + 1);
    const { rows, capped } = takeWithinCap(monitorRows);

    const events = rows.map<CalendarEvent>((row) => ({
      id: `task_monitor:${row.id}`,
      kind: "task_monitor",
      tense: "projected",
      status: "scheduled",
      title: row.title,
      at: row.monitorNextCheckAt!.toISOString(),
      endAt: null,
      agentId: row.agentId,
      agentName: row.agentName ?? null,
      routineId: null,
      routineTitle: null,
      issueId: row.id,
      issueIdentifier: row.identifier,
      projectId: row.projectId,
      scheduleTimezone: null,
      cronExpression: null,
      href: issueHref(row.identifier, row.id),
    }));
    return { events, capped };
  }

  /**
   * Task lifecycle moments. Each task contributes at most one entry — its
   * completion if it has one, otherwise its start — so a busy week reads as
   * "these shipped" rather than two chips per task.
   */
  async function loadTaskActivity(query: CalendarQuery, window: { from: Date; to: Date }) {
    const inWindow = (column: typeof issues.completedAt | typeof issues.startedAt) =>
      and(isNotNull(column), gte(column, window.from), lte(column, window.to));

    const conditions = [
      eq(issues.companyId, query.companyId),
      or(inWindow(issues.completedAt), inWindow(issues.startedAt))!,
    ];
    if (query.projectId) conditions.push(eq(issues.projectId, query.projectId));
    if (query.agentId) conditions.push(eq(issues.assigneeAgentId, query.agentId));

    const activityRows = await db
      .select({
        id: issues.id,
        identifier: issues.identifier,
        title: issues.title,
        status: issues.status,
        projectId: issues.projectId,
        agentId: issues.assigneeAgentId,
        agentName: agents.name,
        startedAt: issues.startedAt,
        completedAt: issues.completedAt,
      })
      .from(issues)
      .leftJoin(agents, eq(issues.assigneeAgentId, agents.id))
      .where(and(...conditions))
      .orderBy(desc(issues.updatedAt), asc(issues.id))
      .limit(MAX_SOURCE_ROWS + 1);
    const { rows, capped } = takeWithinCap(activityRows);

    const events: CalendarEvent[] = [];
    for (const row of rows) {
      const completedInWindow =
        row.completedAt &&
        row.completedAt >= window.from &&
        row.completedAt <= window.to;
      const at = completedInWindow ? row.completedAt! : row.startedAt;
      if (!at || at < window.from || at > window.to) continue;

      events.push({
        id: `task_activity:${row.id}`,
        kind: "task_activity",
        tense: "actual",
        status: completedInWindow
          ? row.status === "cancelled"
            ? "cancelled"
            : "succeeded"
          : "running",
        title: row.title,
        at: at.toISOString(),
        endAt: null,
        agentId: row.agentId,
        agentName: row.agentName ?? null,
        routineId: null,
        routineTitle: null,
        issueId: row.id,
        issueIdentifier: row.identifier,
        projectId: row.projectId,
        scheduleTimezone: null,
        cronExpression: null,
        href: issueHref(row.identifier, row.id),
      });
    }
    return { events, capped };
  }

  async function loadAgentRuns(query: CalendarQuery, window: { from: Date; to: Date }) {
    const conditions = [
      eq(heartbeatRuns.companyId, query.companyId),
      isNotNull(heartbeatRuns.startedAt),
      gte(heartbeatRuns.startedAt, window.from),
      lte(heartbeatRuns.startedAt, window.to),
    ];
    if (query.agentId) conditions.push(eq(heartbeatRuns.agentId, query.agentId));

    const agentRunRows = await db
      .select({
        id: heartbeatRuns.id,
        status: heartbeatRuns.status,
        startedAt: heartbeatRuns.startedAt,
        finishedAt: heartbeatRuns.finishedAt,
        agentId: heartbeatRuns.agentId,
        agentName: agents.name,
      })
      .from(heartbeatRuns)
      .innerJoin(agents, eq(heartbeatRuns.agentId, agents.id))
      .where(and(...conditions))
      .orderBy(desc(heartbeatRuns.startedAt), asc(heartbeatRuns.id))
      .limit(MAX_SOURCE_ROWS + 1);
    const { rows, capped } = takeWithinCap(agentRunRows);

    const events = rows.map<CalendarEvent>((row) => ({
      id: `agent_run:${row.id}`,
      kind: "agent_run",
      tense: "actual",
      status: heartbeatRunStatus(row.status),
      title: row.agentName,
      at: row.startedAt!.toISOString(),
      endAt: row.finishedAt ? row.finishedAt.toISOString() : null,
      agentId: row.agentId,
      agentName: row.agentName,
      routineId: null,
      routineTitle: null,
      issueId: null,
      issueIdentifier: null,
      projectId: null,
      scheduleTimezone: null,
      cronExpression: null,
      href: `/agents/${row.agentId}`,
    }));
    return { events, capped };
  }

  return {
    async getCalendar(query: CalendarQuery, now = new Date()): Promise<CalendarResult> {
      const window = normalizeCalendarWindow({ from: query.from, to: query.to }, now);
      const kinds = new Set(query.kinds ?? CALENDAR_EVENT_KINDS);

      // `routine_run` and `task_activity` are per-routine/per-task groups so the
      // fair allocator can spread the global cap across them; the rest are
      // naturally sparse and share one group each.
      const groups = new Map<string, CalendarEvent[]>();
      const addToGroup = (key: string, event: CalendarEvent) => {
        const existing = groups.get(key);
        if (existing) existing.push(event);
        else groups.set(key, [event]);
      };

      let truncatedSeries: CalendarTruncatedSeries[] = [];
      let unschedulable: CalendarResult["unschedulable"] = [];
      // Kinds whose source query hit its row ceiling. Tracked separately from
      // the projection and allocation caps because it happens earlier, and
      // because leaving it unreported is what would make a partial calendar
      // look complete.
      const cappedSources: CalendarEventKind[] = [];

      if (kinds.has("routine_scheduled")) {
        const projected = await projectRoutineSchedules(query, window, now);
        truncatedSeries = projected.truncatedSeries;
        unschedulable = projected.unschedulable;
        if (projected.capped) cappedSources.push("routine_scheduled");
        for (const [triggerId, events] of projected.series) {
          groups.set(`routine_scheduled:${triggerId}`, events);
        }
      }
      if (kinds.has("routine_run")) {
        const loaded = await loadRoutineRuns(query, window);
        if (loaded.capped) cappedSources.push("routine_run");
        for (const event of loaded.events) {
          addToGroup(`routine_run:${event.routineId}`, event);
        }
      }
      if (kinds.has("task_monitor")) {
        const loaded = await loadTaskMonitors(query, window);
        if (loaded.capped) cappedSources.push("task_monitor");
        for (const event of loaded.events) {
          addToGroup("task_monitor", event);
        }
      }
      if (kinds.has("task_activity")) {
        const loaded = await loadTaskActivity(query, window);
        if (loaded.capped) cappedSources.push("task_activity");
        for (const event of loaded.events) {
          addToGroup("task_activity", event);
        }
      }
      if (kinds.has("agent_run")) {
        const loaded = await loadAgentRuns(query, window);
        if (loaded.capped) cappedSources.push("agent_run");
        for (const event of loaded.events) {
          addToGroup(`agent_run:${event.agentId}`, event);
        }
      }

      const allocated = allocateFairly(groups, GLOBAL_LIMIT);
      const events = allocated.events.sort((a, b) => a.at.localeCompare(b.at));

      const counts = CALENDAR_EVENT_KINDS.reduce(
        (acc, kind) => {
          acc[kind] = 0;
          return acc;
        },
        {} as Record<CalendarEventKind, number>,
      );
      for (const event of events) counts[event.kind] += 1;

      return {
        events,
        window: {
          from: window.from.toISOString(),
          to: window.to.toISOString(),
          capped: window.capped,
        },
        counts,
        truncated:
          truncatedSeries.length > 0 || allocated.dropped > 0 || cappedSources.length > 0
            ? {
                series: truncatedSeries,
                droppedEvents: allocated.dropped,
                sources: cappedSources,
              }
            : null,
        unschedulable,
      };
    },
  };
}
