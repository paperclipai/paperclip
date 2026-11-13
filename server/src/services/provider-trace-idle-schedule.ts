import { providerTraceRecords, type Db } from "@paperclipai/db";
import { getTableColumns, sql } from "drizzle-orm";
import { importingProviderTraceRef, objectProviderTraceRef } from "./provider-trace-object-store.js";
import { finishedIdleRun } from "./idle-work-proof.js";
import { idleDeadlineRowLimit, isFutureIdleDeadline, type IdleDeadlineSnapshot } from "./idle-deadline-types.js";

const expiredTraceRef = "00000000-0000-0000-0000-000000000000.ndjson";
export type IdleProviderTraceRow = { trace: typeof providerTraceRecords.$inferSelect; finishedRun: boolean };
export function projectIdleProviderTraceSchedule(rows: IdleProviderTraceRow[], now: number): IdleDeadlineSnapshot {
  const state = rows;
  const deadlines: number[] = [];
  const blocked = () => ({ blocked: true, state, deadlines: [] });
  if (rows.length > idleDeadlineRowLimit) return blocked();
  for (const { trace, finishedRun } of rows) {
    if (finishedRun !== true) return blocked();
    if (trace.traceRef === expiredTraceRef) {
      if (!["expired", "deleted"].includes(trace.status) || !trace.deletedAt) return blocked();
      continue;
    }
    const objectRef = objectProviderTraceRef(trace.traceRef);
    const localRef = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.ndjson$/.test(trace.traceRef);
    if (localRef && trace.status === "deleted" && trace.deletedAt) continue;
    if (importingProviderTraceRef(trace.traceRef) || (objectRef && (objectRef[1] !== trace.companyId || objectRef[2] !== trace.runId))
      || (!objectRef && !localRef)
      || trace.deletedAt || !["complete", "incomplete", "truncated"].includes(trace.status)) return blocked();
    const at = trace.expiresAt.getTime();
    if (!isFutureIdleDeadline(at, now)) return blocked();
    deadlines.push(at);
  }
  return { blocked: false, state, deadlines };
}
export async function readIdleProviderTraceSchedule(tx: Pick<Db, "select">, now: number) {
  const rows = await tx.select({ trace: getTableColumns(providerTraceRecords),
    finishedRun: sql<boolean>`EXISTS (SELECT 1 FROM heartbeat_runs r WHERE r.id = ${providerTraceRecords.runId}
      AND r.company_id = ${providerTraceRecords.companyId} AND ${sql.raw(finishedIdleRun("r"))})`,
  }).from(providerTraceRecords).orderBy(providerTraceRecords.id).limit(idleDeadlineRowLimit + 1);
  return projectIdleProviderTraceSchedule(rows, now);
}
