import { allocateRunEventPosition } from "../services/run-event-history.js";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { readRunOutputBody } from "../services/run-output-body.js";
import { readRunEventExcerpt } from "../services/run-event-excerpt.js";
import { describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  agents,
  companies,
  createDb,
  type Db,
  heartbeatRunEvents,
  heartbeatRuns,
  nativeSourceCursors,
  nativeOutputBodyChunks,
} from "@paperclipai/db";
import {
  appendHeartbeatRunEvent,
  HeartbeatRunEventConflictError,
} from "../services/heartbeat-run-events.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

describe("P6-11..13 / P6-17 canonical event allocator", () => {
  it("commits the bounded output catalog with event ACKs and enforces company scope", async () => {
    const storage = mkdtempSync(resolve(tmpdir(), "paperclip-output-objects-"));
    vi.stubEnv("PAPERCLIP_STORAGE_PROVIDER", "local_disk");
    vi.stubEnv("PAPERCLIP_STORAGE_LOCAL_DIR", storage);
    const temporary = await startEmbeddedPostgresTestDatabase("paperclip-output-body-");
    const db = createDb(temporary.connectionString);
    const companyId = "20000000-0000-4000-8000-000000000001";
    const agentId = "20000000-0000-4000-8000-000000000002";
    const runId = "20000000-0000-4000-8000-000000000003";
    const text = "x\0".repeat(24_000);
    const hash = (s: string) => createHash("sha256").update(s).digest("hex");
    const bodyId = hash(text), body = { schema: "paperclip.output.body.v1", bodyId, sha256: bodyId,
      byteLength: String(Buffer.byteLength(text)), mediaType: "text/plain; charset=utf-8" };
    try {
      await db.insert(companies).values({ id: companyId, name: "Output fixture", issuePrefix: "OUT" });
      await db.insert(agents).values({ id: agentId, companyId, name: "Output agent" });
      await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running" });
      let sourceSeq = 0;
      for (let offset = 0; offset < text.length; offset += 8192) {
        const part = text.slice(offset, offset + 8192);
        const event = { payload: { schema: "paperclip.output.body.chunk.v1", body, offset: String(offset), sha256: hash(part), text: part } };
        const input = { companyId, runId, agentId, eventType: "output.body.chunk", payload: { prpEvent: event },
          nativeSource: { sourceInstanceId: "output-runner", sourceEventId: `chunk-${++sourceSeq}`, sourceSeq, protocolSchemaVersion: 1, canonicalPayload: event } };
        expect((await appendHeartbeatRunEvent(db, input)).disposition).toBe("committed");
        expect((await appendHeartbeatRunEvent(db, input)).disposition).toBe("duplicate");
        if (offset === 0) await expect(readRunOutputBody(db, companyId, runId, bodyId)).rejects.toThrow("not complete");
      }
      expect(await readRunOutputBody(db, companyId, runId, bodyId)).toBe(text);
      await expect(readRunOutputBody(db, "20000000-0000-4000-8000-000000000099", runId, bodyId)).rejects.toThrow("not found");
      expect(await db.select().from(nativeOutputBodyChunks)).toHaveLength(sourceSeq);
      const excerpt = await readRunEventExcerpt(db, companyId, runId, { events: 2, bytes: 200_000 });
      expect(excerpt.truncated).toBe(true);
      expect(excerpt.events.map(event => event.seq)).toEqual([sourceSeq - 1, sourceSeq]);
      expect(JSON.stringify(excerpt.events)).not.toContain("\\u0000");
      expect(excerpt.events[0]?.payload).toMatchObject({ prpEvent: { payload: { body } } });
      const [last] = await db.select({ bytes: sql<number>`octet_length(row_to_json(${heartbeatRunEvents})::text)` }).from(heartbeatRunEvents)
        .where(eq(heartbeatRunEvents.seq, sourceSeq));
      expect((await readRunEventExcerpt(db, companyId, runId, { events: 2, bytes: last!.bytes + 3 })).events).toHaveLength(1);
      const stored = await db.select().from(heartbeatRunEvents);
      expect(JSON.stringify(stored)).not.toContain("\\u0000");
      expect(stored[0]?.payload).toMatchObject({ prpEvent: { payload: { textRef: { schema: "paperclip.history-payload.v1", companyId, runId } } } });
      expect(await readRunEventExcerpt(db, companyId, runId, { events: 2, bytes: 1 })).toEqual({ events: [], truncated: true });
      expect(await readRunEventExcerpt(db, "20000000-0000-4000-8000-000000000099", runId)).toEqual({ events: [], truncated: false });
      await expect(appendHeartbeatRunEvent(db, { companyId, runId, agentId, eventType: "output.body.chunk",
        nativeSource: { sourceInstanceId: "output-runner", sourceEventId: "invalid-body", sourceSeq: sourceSeq + 1, protocolSchemaVersion: 1, canonicalPayload: { payload: { body: { bodyId: "invalid" } } } },
      })).rejects.toThrow("native_output_body_binding_invalid");
      expect(await db.select().from(heartbeatRunEvents)).toHaveLength(sourceSeq);
      expect((await db.select().from(heartbeatRuns))[0]?.nextEventSeq).toBe(sourceSeq + 1);
    } finally { await temporary.cleanup(); vi.unstubAllEnvs(); rmSync(storage, { recursive: true, force: true }); }
  }, 60_000);

  it.each([false, true])("deduplicates concurrent retry exhaustion (historical receipt: %s)", async (historical) => {
    const temporary = await startEmbeddedPostgresTestDatabase("paperclip-exhaustion-events-");
    const db = createDb(temporary.connectionString);
    const otherDb = createDb(temporary.connectionString);
    const companyId = "20000000-0000-4000-8000-000000000001";
    const agentId = "20000000-0000-4000-8000-000000000002";
    const runId = "20000000-0000-4000-8000-000000000003";
    const otherRunId = "20000000-0000-4000-8000-000000000004";
    const exhaustion = { retryReason: "transient_failure", scheduledRetryAttempt: 2, maxAttempts: 2 };
    const event = {
      companyId, agentId, runId, eventType: "lifecycle",
      message: "Bounded retry exhausted after 2 scheduled attempts; no further automatic retry will be queued",
      payload: exhaustion,
    };
    try {
      await db.insert(companies).values({ id: companyId, name: "Exhaustion fixture", issuePrefix: "EXH" });
      await db.insert(agents).values({ id: agentId, companyId, name: "Exhaustion agent" });
      await db.insert(heartbeatRuns).values([runId, otherRunId].map((id) => ({
        id, companyId, agentId, status: "failed",
      })));
      if (historical) {
        // Old builds wrote ordinary lifecycle rows with no new idempotency field.
        await appendHeartbeatRunEvent(db, event);
      }
      const receipts = await Promise.all(Array.from({ length: 16 }, (_, index) =>
        appendHeartbeatRunEvent(index % 2 ? db : otherDb, {
          ...event, retryExhaustion: exhaustion,
        })));
      expect(receipts.filter((receipt) => receipt.disposition === "committed"))
        .toHaveLength(historical ? 0 : 1);
      expect(new Set(receipts.map((receipt) => receipt.row.id)).size).toBe(1);
      expect(await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, runId)))
        .toHaveLength(1);
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0]?.nextEventSeq)
        .toBe(2);

      // The key is per run, reason, attempt, and budget. Distinct exhaustion
      // decisions still get their own receipt and an ordinary sequence number.
      for (const changed of [
        { ...exhaustion, retryReason: "bootstrap_failure" },
        { ...exhaustion, scheduledRetryAttempt: 3 },
        { ...exhaustion, maxAttempts: 3 },
      ]) {
        expect((await appendHeartbeatRunEvent(db, {
          ...event, payload: changed, retryExhaustion: changed,
        })).disposition).toBe("committed");
      }
      expect((await appendHeartbeatRunEvent(db, {
        ...event, runId: otherRunId, retryExhaustion: exhaustion,
      })).disposition).toBe("committed");
      const rows = await db.select().from(heartbeatRunEvents)
        .where(eq(heartbeatRunEvents.runId, runId)).orderBy(heartbeatRunEvents.seq);
      expect(rows.map((row) => row.seq)).toEqual([1, 2, 3, 4]);
      await expect(appendHeartbeatRunEvent(db, {
        ...event, companyId: "20000000-0000-4000-8000-000000000099", retryExhaustion: exhaustion,
      })).rejects.toThrow("heartbeat_run_event_binding_mismatch");
    } finally {
      await temporary.cleanup();
    }
  }, 60_000);

  it("serializes concurrent writers and rejects conflicting replay without cursor drift", async () => {
    const temporary = await startEmbeddedPostgresTestDatabase("paperclip-native-events-");
    const db = createDb(temporary.connectionString);
    const companyId = "20000000-0000-4000-8000-000000000001";
    const agentId = "20000000-0000-4000-8000-000000000002";
    const runId = "20000000-0000-4000-8000-000000000003";
    try {
      await db.insert(companies).values({ id: companyId, name: "Allocator fixture", issuePrefix: "SEQ" });
      await db.insert(agents).values({ id: agentId, companyId, name: "Allocator agent" });
      await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running" });
      const eventTypes = ["heartbeat.started", "run.cancel.requested", "item.completed", "stdout"];
      const writes = Array.from({ length: 32 }, (_, index) => appendHeartbeatRunEvent(db, {
        companyId,
        runId,
        agentId,
        eventType: eventTypes[index % eventTypes.length]!,
        message: `event-${index + 1}`,
        payload: { ordinal: index + 1 },
        nativeSource: {
          sourceInstanceId: `writer-${index % 4}`,
          sourceEventId: `source-event-${index + 1}`,
          sourceSeq: Math.floor(index / 4) + 1,
          protocolSchemaVersion: 1,
          canonicalPayload: { ordinal: index + 1 },
        },
      }));
      const receipts = await Promise.all(writes);
      expect(receipts.every((entry) => entry.disposition === "committed")).toBe(true);

      const rows = await db.select().from(heartbeatRunEvents)
        .where(eq(heartbeatRunEvents.runId, runId)).orderBy(heartbeatRunEvents.seq);
      expect(rows.map((row) => row.seq)).toEqual(Array.from({ length: 32 }, (_, index) => index + 1));
      expect(new Set(rows.map((row) => row.sourceEventId)).size).toBe(32);
      expect((await db.select({ nextEventSeq: heartbeatRuns.nextEventSeq }).from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId)))[0]?.nextEventSeq).toBe(33);

      const legacyWrites = Array.from({ length: 16 }, (_, index) => db.transaction(async (tx) => {
        const position = await allocateRunEventPosition(tx as unknown as Db, runId);
        await tx.insert(heartbeatRunEvents).values({
          companyId,
          runId,
          agentId,
          ...position,
          eventType: "stdout",
          message: `legacy-event-${index + 1}`,
        });
        return position.seq;
      }));
      const legacySequences = await Promise.all(legacyWrites);
      expect([...legacySequences].sort((a, b) => a - b)).toEqual(
        Array.from({ length: 16 }, (_, index) => index + 33),
      );
      expect((await db.select({ nextEventSeq: heartbeatRuns.nextEventSeq }).from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId)))[0]?.nextEventSeq).toBe(49);

      const original = rows.find((row) => row.sourceEventId === "source-event-1")!;
      await expect(appendHeartbeatRunEvent(db, {
        companyId,
        runId,
        agentId,
        eventType: original.eventType,
        message: original.message,
        payload: original.payload,
        nativeSource: {
          sourceInstanceId: original.sourceInstanceId!,
          sourceEventId: original.sourceEventId!,
          sourceSeq: original.sourceSeq!,
          protocolSchemaVersion: 1,
          canonicalPayload: { ordinal: 1 },
        },
      })).resolves.toEqual(expect.objectContaining({ disposition: "duplicate" }));
      await expect(appendHeartbeatRunEvent(db, {
        companyId,
        runId,
        agentId,
        eventType: "item.failed",
        nativeSource: {
          sourceInstanceId: original.sourceInstanceId!,
          sourceEventId: original.sourceEventId!,
          sourceSeq: original.sourceSeq!,
          protocolSchemaVersion: 1,
          canonicalPayload: { ordinal: 999 },
        },
      })).rejects.toBeInstanceOf(HeartbeatRunEventConflictError);
      expect(await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, runId))).toHaveLength(48);

      const gapEvent = (sourceSeq: number) => ({
        companyId, runId, agentId, eventType: "stdout",
        nativeSource: { sourceInstanceId: "gap-writer", sourceEventId: `gap-${sourceSeq}`, sourceSeq,
          protocolSchemaVersion: 1, canonicalPayload: { sourceSeq } },
      });
      // Cached cursors advance through the contiguous prefix, never across a
      // gap. Old installations build the same cursor once from existing rows.
      expect((await appendHeartbeatRunEvent(db, gapEvent(2))).highestContiguousSourceSeq).toBe(0);
      expect((await appendHeartbeatRunEvent(db, gapEvent(4))).highestContiguousSourceSeq).toBe(0);
      expect((await appendHeartbeatRunEvent(db, gapEvent(1))).highestContiguousSourceSeq).toBe(2);
      expect((await appendHeartbeatRunEvent(db, gapEvent(3))).highestContiguousSourceSeq).toBe(4);
      await db.delete(nativeSourceCursors).where(eq(nativeSourceCursors.sourceInstanceId, "gap-writer"));
      expect((await appendHeartbeatRunEvent(db, gapEvent(1))).highestContiguousSourceSeq).toBe(4);
    } finally {
      await temporary.cleanup();
    }
  }, 60_000);
});
