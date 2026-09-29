import { readRunEventLaneIds } from "./run-event-history.js";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { heartbeatRunEvents, type Db } from "@paperclipai/db";
import { redactEventPayload } from "../redaction.js";

/** Feedback is a bounded recent excerpt. Select sizes before fetching bodies so
 * neither a long run nor a handful of large events becomes a history-sized
 * allocation. The immutable run log remains the source for complete history. */
export async function readRunEventExcerpt(db: Db, companyId: string, runId: string,
  limits = { events: 200, bytes: 10_000_000 }) {
  if (!Number.isInteger(limits.events) || limits.events < 1 || limits.events > 1000 ||
    !Number.isInteger(limits.bytes) || limits.bytes < 1 || limits.bytes > 10_000_000) throw new Error("Invalid run-event excerpt capacity");
  const scope = and(eq(heartbeatRunEvents.companyId, companyId), eq(heartbeatRunEvents.runId, runId));
  const recentIds = await readRunEventLaneIds(db, runId, "all", limits.events + 1);
  const metadataRows = recentIds.length ? await db.select({ id: heartbeatRunEvents.id,
    bytes: sql<number>`octet_length(row_to_json(${heartbeatRunEvents})::text)` })
    .from(heartbeatRunEvents).where(and(scope, inArray(heartbeatRunEvents.id, recentIds))) : [];
  const metadataById = new Map(metadataRows.map(row => [String(row.id), row]));
  const metadata = recentIds.map(id => metadataById.get(id)).filter(row => row !== undefined);
  const ids: (number | string)[] = [];
  let bytes = 2;
  for (const row of metadata) {
    if (ids.length >= limits.events || bytes + row.bytes + 1 > limits.bytes) break;
    ids.push(row.id); bytes += row.bytes + 1;
  }
  const rows = ids.length ? await db.select().from(heartbeatRunEvents)
    .where(and(scope, inArray(heartbeatRunEvents.id, ids))) : [];
  const byId = new Map(rows.map(row => [String(row.id), row]));
  return { events: ids.reverse().map(id => byId.get(String(id))!).map(row => ({ ...row, payload: redactEventPayload(row.payload) })), truncated: ids.length < metadata.length };
}
