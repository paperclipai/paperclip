import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { validateCron } from "./cron.js";

const processGeneration = randomUUID();
const limit = 10_000;

export interface ScheduledWake {
  version: 1;
  kind: "routines";
  generation: string;
  nextWakeAt: string;
}

export async function readIdleRoutineSchedule(tx: Pick<Db, "execute">, ownerId: string, now: number): Promise<{
  blocked: boolean;
  scheduledWake?: ScheduledWake;
}> {
  const unknown = await tx.execute<{ blocked: boolean }>(sql`SELECT EXISTS (
    SELECT 1 FROM routines WHERE status NOT IN ('active', 'paused', 'archived')
  ) AS blocked`);
  if (unknown.length !== 1 || unknown[0]?.blocked !== false) return { blocked: true };
  const rows = await tx.execute<{
    id: string; routine_id: string; company_id: string; kind: string;
    setup_pending: boolean; cron_expression: string | null; timezone: string | null;
    next_run_at: Date | string | null; routine_updated: Date | string; trigger_updated: Date | string;
    scoped: boolean;
  }>(sql`SELECT t.id, t.routine_id, t.company_id, t.kind, t.setup_pending,
      t.cron_expression, t.timezone, t.next_run_at,
      r.updated_at AS routine_updated, t.updated_at AS trigger_updated,
      (t.company_id = r.company_id) AS scoped
    FROM routine_triggers t JOIN routines r ON r.id = t.routine_id
    WHERE r.status = 'active' AND t.enabled AND NOT t.archived
    ORDER BY t.id LIMIT ${limit + 1}`);
  if (rows.length > limit) return { blocked: true };
  let earliest = Infinity;
  const validTimezones = new Set<string>();
  const validCrons = new Set<string>();
  for (const row of rows) {
    if (row.scoped !== true || row.kind !== "schedule" || row.setup_pending !== false
      || !row.cron_expression || !row.timezone
      || row.next_run_at === null) return { blocked: true };
    if (!validCrons.has(row.cron_expression)) {
      if (validateCron(row.cron_expression)) return { blocked: true };
      validCrons.add(row.cron_expression);
    }
    if (!validTimezones.has(row.timezone)) {
      try { new Intl.DateTimeFormat("en", { timeZone: row.timezone }); }
      catch { return { blocked: true }; }
      validTimezones.add(row.timezone);
    }
    const at = new Date(row.next_run_at).getTime();
    if (!Number.isFinite(at) || at <= now) return { blocked: true };
    earliest = Math.min(earliest, at);
  }
  if (!Number.isFinite(earliest)) return { blocked: false };
  const generation = createHash("sha256").update(JSON.stringify([processGeneration, ownerId, rows])).digest("hex");
  return { blocked: false, scheduledWake: {
    version: 1, kind: "routines", generation, nextWakeAt: new Date(earliest).toISOString(),
  } };
}
