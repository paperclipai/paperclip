import { and, eq, isNotNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { plugins, pluginJobs, routines, routineTriggers } from "@paperclipai/db";
import { parseCron, nextCronTick } from "./cron.js";

export interface CalendarEvent {
  id: string;
  kind: "routine" | "plugin_job";
  title: string;
  cronExpression: string;
  timezone: string | null;
  nextRunAt: string | null;
  status: string;
  // routine-specific
  assigneeAgentId?: string | null;
  routineId?: string | null;
  triggerId?: string | null;
  // plugin-job-specific
  pluginJobId?: string | null;
}

/**
 * Expand a cron expression into all occurrence timestamps within [start, end].
 *
 * NOTE: All recurring schedules MUST be backed by either a `routine_trigger` or
 * a `plugin_job` row so they appear automatically in the Calendar. Ad-hoc shell
 * crons or hardcoded timers are not acceptable — they will be invisible to users.
 */
export function expandCronOccurrences(expression: string, start: Date, end: Date): Date[] {
  let parsed;
  try {
    parsed = parseCron(expression);
  } catch {
    return [];
  }

  const occurrences: Date[] = [];
  // Start searching from one minute before `start` so we catch hits at exactly `start`
  let cursor = new Date(start.getTime() - 60_000);

  while (true) {
    const next = nextCronTick(parsed, cursor);
    if (!next || next > end) break;
    if (next >= start) {
      occurrences.push(next);
    }
    cursor = next;
  }

  return occurrences;
}

export function calendarService(db: Db) {
  return {
    /**
     * Return all scheduled calendar events for a company within [start, end].
     *
     * Sources:
     *  - routine_triggers (cron-based) joined to routines
     *  - plugin_jobs joined to plugins
     *
     * NOTE: All recurring schedules must use these two tables so they appear
     * in the Calendar. Any new automated recurring action must be backed by
     * either a `routine_trigger` or a `plugin_job` row.
     */
    getEvents: async (companyId: string, start: Date, end: Date): Promise<CalendarEvent[]> => {
      const events: CalendarEvent[] = [];

      // --- Routine triggers ---
      const triggerRows = await db
        .select({
          triggerId: routineTriggers.id,
          cronExpression: routineTriggers.cronExpression,
          timezone: routineTriggers.timezone,
          nextRunAt: routineTriggers.nextRunAt,
          enabled: routineTriggers.enabled,
          routineId: routines.id,
          routineTitle: routines.title,
          routineStatus: routines.status,
          assigneeAgentId: routines.assigneeAgentId,
        })
        .from(routineTriggers)
        .innerJoin(routines, eq(routineTriggers.routineId, routines.id))
        .where(
          and(
            eq(routineTriggers.companyId, companyId),
            isNotNull(routineTriggers.cronExpression),
          ),
        );

      for (const row of triggerRows) {
        if (!row.cronExpression) continue;

        const isPaused = !row.enabled || row.routineStatus === "paused";
        const occurrences = expandCronOccurrences(row.cronExpression, start, end);

        for (const occurrence of occurrences) {
          events.push({
            id: `trigger:${row.triggerId}:${occurrence.getTime()}`,
            kind: "routine",
            title: row.routineTitle,
            cronExpression: row.cronExpression,
            timezone: row.timezone ?? null,
            nextRunAt: occurrence.toISOString(),
            status: isPaused ? "paused" : "active",
            assigneeAgentId: row.assigneeAgentId,
            routineId: row.routineId,
            triggerId: row.triggerId,
          });
        }
      }

      // --- Plugin jobs ---
      const jobRows = await db
        .select({
          jobId: pluginJobs.id,
          schedule: pluginJobs.schedule,
          nextRunAt: pluginJobs.nextRunAt,
          jobStatus: pluginJobs.status,
          jobKey: pluginJobs.jobKey,
          pluginKey: plugins.pluginKey,
        })
        .from(pluginJobs)
        .innerJoin(plugins, eq(pluginJobs.pluginId, plugins.id));

      for (const row of jobRows) {
        const occurrences = expandCronOccurrences(row.schedule, start, end);
        const isPaused = row.jobStatus === "paused" || row.jobStatus === "error";

        for (const occurrence of occurrences) {
          events.push({
            id: `plugin-job:${row.jobId}:${occurrence.getTime()}`,
            kind: "plugin_job",
            title: `${row.pluginKey} / ${row.jobKey}`,
            cronExpression: row.schedule,
            timezone: null,
            nextRunAt: occurrence.toISOString(),
            status: isPaused ? "paused" : "active",
            pluginJobId: row.jobId,
          });
        }
      }

      events.sort((a, b) => {
        if (!a.nextRunAt) return 1;
        if (!b.nextRunAt) return -1;
        return a.nextRunAt.localeCompare(b.nextRunAt);
      });

      return events;
    },
  };
}
