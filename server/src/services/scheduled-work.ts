import { registerDeadlineWork } from "./deadline-work.js";
import type { Db } from "@paperclipai/db";
import { sql, type SQL } from "drizzle-orm";
import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { DELIVERY_QUEUES, type DeliveryQueue } from "./delivery-work-notifications.js";

export function registerScheduledWork(
  coordinator: Pick<ReturnType<typeof createDeliveryWorkCoordinator>, "register">,
  db: Pick<Db, "execute">,
  options: {
    retryMs: number;
    tickTimers: () => Promise<unknown>;
    tickRoutines: (signal: AbortSignal) => Promise<unknown>;
    nextRoutineRunAt: () => Promise<number | null>;
    canRun: () => boolean;
  },
) {
  function register(queue: DeliveryQueue, work: () => Promise<unknown>, query: (now: Date) => SQL) {
    let next: number | null = null;
    return coordinator.register(queue, {
      retryMs: options.retryMs,
      run: async () => {
        const cutoff = new Date();
        await work();
        const [row] = await db.execute<{ next_at: Date | string | null }>(query(cutoff));
        if (!row || row.next_at === undefined) throw new Error("Scheduled deadline query returned no result");
        next = row.next_at === null ? null
          : row.next_at instanceof Date ? row.next_at.getTime() : Date.parse(row.next_at);
        if (next !== null && !Number.isFinite(next)) throw new Error("Scheduled deadline is invalid");
      },
      hasPending: async () => false,
      nextRunAt: () => next,
    });
  }

  const routines = registerDeadlineWork(coordinator, DELIVERY_QUEUES.routineSchedules, {
    run: options.tickRoutines,
    next: options.nextRoutineRunAt,
    canRun: options.canRun,
    retryMs: options.retryMs,
  });
  const timers = register(DELIVERY_QUEUES.issueMonitors, options.tickTimers, now => sql`
    SELECT min(i.monitor_next_check_at) AS next_at
    FROM issues i JOIN companies c ON c.id = i.company_id
    WHERE c.status = 'active' AND i.status IN ('in_progress', 'in_review')
      AND i.assignee_agent_id IS NOT NULL AND i.assignee_user_id IS NULL
      AND i.monitor_next_check_at > ${now.toISOString()}::timestamptz`);
  return { routines, timers };
}
