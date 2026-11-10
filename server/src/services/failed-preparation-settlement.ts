import { and, asc, eq } from "drizzle-orm";
import { heartbeatRunEvents, heartbeatRuns, type Db } from "@paperclipai/db";
import { isUuidLike } from "@paperclipai/shared";

type Source = Pick<typeof heartbeatRuns.$inferSelect, "id" | "companyId" | "agentId" | "error">;

export async function readFailedPreparationSettlement(db: Db, source: Source, allowRunStarted = false): Promise<{
  unsupportedHarnessWarning: { message: string | null; revision: string } | null;
} | null> {
  if (typeof source.error !== "string" || !source.error.length) return null;
  const events = await db.select().from(heartbeatRunEvents).where(and(
    eq(heartbeatRunEvents.companyId, source.companyId), eq(heartbeatRunEvents.runId, source.id),
  )).orderBy(asc(heartbeatRunEvents.seq)).limit(allowRunStarted ? 5 : 4);
  const hostEvent = (event: typeof heartbeatRunEvents.$inferSelect) => event.agentId === source.agentId
    && event.stream === "system" && event.sourceInstanceId === null && event.sourceEventId === null
    && event.sourceSeq === null && event.sourcePayloadSha256 === null && event.protocolSchemaVersion === null;
  let offset = 0;
  let unsupportedHarnessWarning: { message: string | null; revision: string } | null = null;
  const warning = events[0];
  if (warning?.eventType === "agent_observability.unavailable") {
    if (!hostEvent(warning) || warning.seq !== 1 || warning.level !== "warn"
      || warning.payload?.reason !== "unsupported_harness" || typeof warning.payload.revision !== "string" || !isUuidLike(warning.payload.revision)
      || Object.keys(warning.payload).some(key => !["reason", "revision"].includes(key))) return null;
    unsupportedHarnessWarning = { message: warning.message, revision: warning.payload.revision };
    offset = 1;
  }
  const started = events[offset];
  if (allowRunStarted && started?.eventType === "lifecycle" && started.message === "run started") {
    if (!hostEvent(started) || started.seq !== 1 + offset || started.level !== "info" || started.payload !== null) return null;
    offset++;
  }
  const [error, measured] = events.slice(offset);
  if (events.length !== 2 + offset || !error || !measured || !hostEvent(error) || !hostEvent(measured)
    || error.seq !== 1 + offset || error.eventType !== "error" || error.level !== "error"
    || error.message !== source.error || error.payload !== null
    || measured.seq !== 2 + offset || measured.eventType !== "lifecycle" || measured.level !== "info" || measured.message !== "task.run.measured"
    || measured.payload?.phase !== "task.run.measured" || measured.payload.outcome !== "failed"
    || measured.payload.durableSettlement !== true
    || Object.keys(measured.payload).some(key => !["phase", "outcome", "durationMs", "durableSettlement"].includes(key))
    || typeof measured.payload.durationMs !== "number"
    || !Number.isFinite(measured.payload.durationMs) || measured.payload.durationMs < 0) return null;
  return { unsupportedHarnessWarning };
}
