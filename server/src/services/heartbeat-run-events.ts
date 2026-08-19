import { and, asc, eq, or } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRunEvents, heartbeatRuns } from "@paperclipai/db";
import { nativeSha256 } from "./native-runtime/canonical.js";

export interface AppendHeartbeatRunEventInput {
  companyId: string;
  runId: string;
  agentId: string;
  eventType: string;
  stream?: string | null;
  level?: string | null;
  color?: string | null;
  message?: string | null;
  payload?: Record<string, unknown> | null;
  nativeSource?: {
    sourceInstanceId: string;
    sourceEventId: string;
    sourceSeq: number;
    protocolSchemaVersion: number;
    canonicalPayload: Record<string, unknown>;
  };
}

export interface AppendHeartbeatRunEventResult {
  row: typeof heartbeatRunEvents.$inferSelect;
  disposition: "committed" | "duplicate";
  highestContiguousSourceSeq: number;
}

export class HeartbeatRunEventConflictError extends Error {
  readonly code = "native_event_replay_conflict" as const;
  constructor() {
    super("native_event_replay_conflict");
    this.name = "HeartbeatRunEventConflictError";
  }
}

export async function appendHeartbeatRunEvent(
  db: Db,
  input: AppendHeartbeatRunEventInput,
): Promise<AppendHeartbeatRunEventResult> {
  return db.transaction(async (tx) => {
    const run = await tx
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, input.runId))
      .for("update")
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!run || run.companyId !== input.companyId || run.agentId !== input.agentId) {
      throw new Error("heartbeat_run_event_binding_mismatch");
    }

    const sourceHash = input.nativeSource
      ? nativeSha256(input.nativeSource.canonicalPayload)
      : null;
    if (input.nativeSource) {
      const existing = await tx
        .select()
        .from(heartbeatRunEvents)
        .where(and(
          eq(heartbeatRunEvents.runId, input.runId),
          or(
            eq(heartbeatRunEvents.sourceEventId, input.nativeSource.sourceEventId),
            and(
              eq(heartbeatRunEvents.sourceInstanceId, input.nativeSource.sourceInstanceId),
              eq(heartbeatRunEvents.sourceSeq, input.nativeSource.sourceSeq),
            ),
          ),
        ))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (existing) {
        if (existing.sourcePayloadSha256 !== sourceHash) {
          throw new HeartbeatRunEventConflictError();
        }
        return {
          row: existing,
          disposition: "duplicate" as const,
          highestContiguousSourceSeq: await contiguousCursor(
            tx as unknown as Db,
            input.runId,
            input.nativeSource.sourceInstanceId,
          ),
        };
      }
    }

    const seq = Number(run.nextEventSeq ?? 1);
    const [row] = await tx.insert(heartbeatRunEvents).values({
      companyId: input.companyId,
      runId: input.runId,
      agentId: input.agentId,
      seq,
      eventType: input.eventType,
      stream: input.stream ?? null,
      level: input.level ?? null,
      color: input.color ?? null,
      message: input.message ?? null,
      payload: input.payload ?? null,
      sourceInstanceId: input.nativeSource?.sourceInstanceId ?? null,
      sourceEventId: input.nativeSource?.sourceEventId ?? null,
      sourceSeq: input.nativeSource?.sourceSeq ?? null,
      sourcePayloadSha256: sourceHash,
      protocolSchemaVersion: input.nativeSource?.protocolSchemaVersion ?? null,
    }).returning();
    if (!row) throw new Error("heartbeat_run_event_not_persisted");
    await tx.update(heartbeatRuns).set({
      nextEventSeq: seq + 1,
      updatedAt: new Date(),
    }).where(eq(heartbeatRuns.id, input.runId));
    return {
      row,
      disposition: "committed" as const,
      highestContiguousSourceSeq: input.nativeSource
        ? await contiguousCursor(
            tx as unknown as Db,
            input.runId,
            input.nativeSource.sourceInstanceId,
          )
        : 0,
    };
  });
}

async function contiguousCursor(db: Db, runId: string, sourceInstanceId: string): Promise<number> {
  const rows = await db
    .select({ sourceSeq: heartbeatRunEvents.sourceSeq })
    .from(heartbeatRunEvents)
    .where(and(
      eq(heartbeatRunEvents.runId, runId),
      eq(heartbeatRunEvents.sourceInstanceId, sourceInstanceId),
    ))
    .orderBy(asc(heartbeatRunEvents.sourceSeq));
  let cursor = 0;
  for (const row of rows) {
    if (row.sourceSeq === cursor + 1) cursor += 1;
    else if (row.sourceSeq !== null && row.sourceSeq > cursor + 1) break;
  }
  return cursor;
}
