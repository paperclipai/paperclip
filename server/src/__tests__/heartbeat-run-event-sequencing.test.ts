import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createDatabaseResponseCapture, installDatabaseResponseCapture } from "@paperclipai/db/response-capture";
import {
  agents,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  allocateHeartbeatRunEventSeq,
  appendHeartbeatRunEvent,
  HeartbeatRunEventConflictError,
} from "../services/heartbeat-run-events.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const externalUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_EVENT_SEQUENCING_TEST_DATABASE_URL");
async function clearExternalFixture(db: ReturnType<typeof createDb>, companyId: string) {
  if (!externalUrl) return;
  await db.delete(heartbeatRunEvents).where(eq(heartbeatRunEvents.companyId, companyId));
  await db.delete(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
  await db.delete(agents).where(eq(agents.companyId, companyId));
  await db.delete(companies).where(eq(companies.id, companyId));
}

describe("P6-11..13 / P6-17 canonical event allocator", () => {
  it("keeps native cursor responses bounded with long histories and a late gap fill", async () => {
    const temporary = await startEmbeddedPostgresTestDatabase("paperclip-native-cursor-budget-");
    const db = createDb(temporary.connectionString);
    const companyId = "20000000-0000-4000-8000-000000000001";
    const agentId = "20000000-0000-4000-8000-000000000002";
    const runId = "20000000-0000-4000-8000-000000000003";
    const otherRunId = "20000000-0000-4000-8000-000000000004";
    try {
      await db.insert(companies).values({ id: companyId, name: "Cursor budget", issuePrefix: "CBG" });
      await db.insert(agents).values({ id: agentId, companyId, name: "Cursor agent" });
      await db.insert(heartbeatRuns).values([
        { id: runId, companyId, agentId, status: "running", nextEventSeq: 5005 },
        { id: otherRunId, companyId, agentId, status: "running" },
      ]);
      for (let batch = 0; batch < 10; batch += 1) {
        await db.insert(heartbeatRunEvents).values(Array.from({ length: 500 }, (_, index) => {
          const seq = batch * 500 + index + 1;
          return { companyId, agentId, runId, seq, eventType: "item.delta", sourceInstanceId: "runner-a",
            sourceSeq: seq, sourceEventId: `seed:${seq}` };
        }));
      }
      await db.insert(heartbeatRunEvents).values([
        ...[-1, 0, null].map((sourceSeq, index) => ({
          companyId, agentId, runId, seq: 5001 + index, eventType: "item.delta",
          sourceInstanceId: "runner-a", sourceSeq, sourceEventId: `legacy:${index}`,
        })),
        { companyId, agentId, runId, seq: 5004, eventType: "item.delta", sourceInstanceId: "runner-b",
          sourceSeq: 5001, sourceEventId: "other-source:5001" },
        { companyId, agentId, runId: otherRunId, seq: 1, eventType: "item.delta", sourceInstanceId: "runner-a",
          sourceSeq: 5001, sourceEventId: "other-run:5001" },
      ]);
      const append = (sourceSeq: number) => appendHeartbeatRunEvent(db, {
        companyId, agentId, runId, eventType: "item.delta", payload: { sourceSeq },
        nativeSource: { sourceInstanceId: "runner-a", sourceSeq, sourceEventId: `runner-a:${sourceSeq}`,
          protocolSchemaVersion: 1, canonicalPayload: { sourceSeq } },
      });
      const events: Array<Record<string, unknown>> = [], now = Date.now();
      const capture = createDatabaseResponseCapture({ start: now - 100, end: now + 59_000 }, event => events.push(event));
      installDatabaseResponseCapture(db, { heartbeatRunEvents }, capture);
      try { expect((await append(5002)).highestContiguousSourceSeq).toBe(5000); }
      finally { capture.flush(); }
      const reads = events.filter(event => event.event === "paperclip.db_response_capture.entry.v1"
        && event.table === "heartbeat_run_events" && (event.operation === "select" || event.operation === "execute"));
      expect(reads.reduce((sum, event) => sum + Number(event.calls), 0)).toBeGreaterThan(0);
      expect(reads.reduce((sum, event) => sum + Number(event.rows), 0)).toBeLessThan(16);
      expect(reads.reduce((sum, event) => sum + Number(event.responseValueBytes), 0)).toBeLessThan(2048);
      expect((await append(5001)).highestContiguousSourceSeq).toBe(5002);
      const replay = await append(5002);
      expect(replay.disposition).toBe("duplicate");
      expect(replay.highestContiguousSourceSeq).toBe(5002);
      const [remaining] = await db.select({ count: sql<number>`count(*)::int` }).from(heartbeatRunEvents)
        .where(eq(heartbeatRunEvents.runId, runId));
      expect(remaining?.count).toBe(5006);
    } finally { await temporary.cleanup(); }
  }, 60_000);

  it.each([false, true])("deduplicates concurrent retry exhaustion (historical receipt: %s)", async (historical) => {
    const temporary = externalUrl ? undefined : await startEmbeddedPostgresTestDatabase("paperclip-exhaustion-events-");
    const db = createDb(externalUrl ?? temporary!.connectionString);
    const otherDb = createDb(externalUrl ?? temporary!.connectionString);
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
      await clearExternalFixture(db, companyId);
      await otherDb.$client.end({ timeout: 1 });
      await db.$client.end({ timeout: 1 });
      await temporary?.cleanup();
    }
  }, 60_000);

  it("serializes concurrent writers and rejects conflicting replay without cursor drift", async () => {
    const temporary = externalUrl ? undefined : await startEmbeddedPostgresTestDatabase("paperclip-native-events-");
    const db = createDb(externalUrl ?? temporary!.connectionString);
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

      const legacyWrites = Array.from({ length: 16 }, (_, index) => (async () => {
        const seq = await allocateHeartbeatRunEventSeq(db, runId);
        await db.insert(heartbeatRunEvents).values({
          companyId,
          runId,
          agentId,
          seq,
          eventType: "stdout",
          message: `legacy-event-${index + 1}`,
        });
        return seq;
      })());
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
    } finally {
      await clearExternalFixture(db, companyId);
      await db.$client.end({ timeout: 1 });
      await temporary?.cleanup();
    }
  }, 60_000);

  it("reports the highest contiguous source seq per source instance across gaps and late arrivals", async () => {
    const temporary = await startEmbeddedPostgresTestDatabase("paperclip-native-cursor-");
    const db = createDb(temporary.connectionString);
    const companyId = "20000000-0000-4000-8000-000000000001";
    const agentId = "20000000-0000-4000-8000-000000000002";
    const runId = "20000000-0000-4000-8000-000000000003";
    try {
      await db.insert(companies).values({ id: companyId, name: "Cursor fixture", issuePrefix: "CUR" });
      await db.insert(agents).values({ id: agentId, companyId, name: "Cursor agent" });
      await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running" });
      const append = async (sourceInstanceId: string, sourceSeq: number) => (await appendHeartbeatRunEvent(db, {
        companyId,
        runId,
        agentId,
        eventType: "item.delta",
        payload: { sourceInstanceId, sourceSeq },
        nativeSource: {
          sourceInstanceId,
          sourceEventId: `${sourceInstanceId}:${sourceSeq}`,
          sourceSeq,
          protocolSchemaVersion: 1,
          canonicalPayload: { sourceInstanceId, sourceSeq },
        },
      })).highestContiguousSourceSeq;

      expect(await append("runner-a", 2)).toBe(0);
      expect(await append("runner-a", 1)).toBe(2);
      expect(await append("runner-a", 3)).toBe(3);
      expect(await append("runner-a", 5)).toBe(3);
      expect(await append("runner-a", 6)).toBe(3);
      expect(await append("runner-b", 1)).toBe(1);
      expect(await append("runner-a", 4)).toBe(6);
      for (let sourceSeq = 7; sourceSeq <= 200; sourceSeq += 1) {
        expect(await append("runner-a", sourceSeq)).toBe(sourceSeq);
      }
      expect(await append("runner-b", 3)).toBe(1);
      expect(await append("runner-b", 2)).toBe(3);
    } finally {
      await temporary.cleanup();
    }
  }, 60_000);
});
