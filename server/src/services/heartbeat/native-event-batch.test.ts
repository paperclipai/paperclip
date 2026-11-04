import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { agents, companies, createDb, heartbeatRunEventCursors, heartbeatRunEvents, heartbeatRuns } from "@paperclipai/db";
import { appendHeartbeatRunEvent, appendHeartbeatRunEvents, type AppendHeartbeatRunEventInput } from "../heartbeat-run-events.js";
import { rebuildNativeEventCursorPage } from "./native-event-cursors.js";
import { startRecoveryPostgres } from "../../__tests__/helpers/recovery-postgres.js";

describe("bounded native text batch persistence", () => {
  let temporary: Awaited<ReturnType<typeof startRecoveryPostgres>>;
  let db: ReturnType<typeof createDb>, otherDb: ReturnType<typeof createDb>;
  const companyId = randomUUID(), agentId = randomUUID();
  beforeAll(async () => {
    temporary = await startRecoveryPostgres("paperclip-native-event-batch-");
    db = createDb(temporary.connectionString); otherDb = createDb(temporary.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Batch events", issuePrefix: "BCH" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Batch agent" });
  }, 60_000);
  afterAll(async () => {
    await otherDb?.$client.end({ timeout: 1 });
    await db?.$client.end({ timeout: 1 });
    await temporary?.cleanup();
  });
  async function makeRun() {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", runtimeMode: "native" });
    return runId;
  }
  function event(runId: string, sourceSeq: number, text = `chunk-${sourceSeq}`, sourceInstanceId = "runner"): AppendHeartbeatRunEventInput {
    const canonicalPayload = {
      schema: "paperclip.prp.event.v1", schemaVersion: 1, sourceEventId: `${sourceInstanceId}:${sourceSeq}`,
      sourceSeq, sourceInstanceId, sourceKind: "runner", runId, normalizedSessionId: "session",
      turnId: "turn", itemId: "message", eventType: "item.delta", priority: 1,
      emittedAt: "2026-11-03T00:00:00.000Z", payload: { kind: "agentMessage", text },
    };
    return { companyId, agentId, runId, eventType: "item.delta", stream: "system", level: "info",
      payload: { prpEvent: canonicalPayload }, nativeSource: { sourceInstanceId,
        sourceEventId: canonicalPayload.sourceEventId, sourceSeq, protocolSchemaVersion: 1, canonicalPayload } };
  }
  async function read(runId: string) {
    return {
      run: (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0]!,
      events: await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, runId)).orderBy(heartbeatRunEvents.seq),
      cursors: await db.select().from(heartbeatRunEventCursors).where(eq(heartbeatRunEventCursors.runId, runId)),
    };
  }

  it("uses one run lock, reservation, insert and contiguous interval projection", async () => {
    const runId = await makeRun(), statements: string[] = [];
    const recorded = drizzle(db.$client, { schema: db._.fullSchema, logger: { logQuery: query => statements.push(query) } }) as typeof db;
    const inputs = [event(runId, 1), event(runId, 2, "before\u0000after"), event(runId, 3)];
    const receipts = await appendHeartbeatRunEvents(recorded, inputs);
    expect(receipts.map(value => [value.row.seq, value.disposition, value.highestContiguousSourceSeq]))
      .toEqual([[1, "committed", 3], [2, "committed", 3], [3, "committed", 3]]);
    expect(receipts.map(value => value.row.payload)).toEqual(inputs.map(value => value.payload));
    expect(statements.filter(query => query.includes('from "heartbeat_runs"') && query.includes("for update"))).toHaveLength(1);
    expect(statements.filter(query => query.startsWith('update "heartbeat_runs"'))).toHaveLength(1);
    expect(statements.filter(query => query.startsWith('insert into "heartbeat_run_events"'))).toHaveLength(1);
    expect(statements.filter(query => query.includes("insert into heartbeat_run_event_cursors"))).toHaveLength(1);
    expect(statements.some(query => query.includes("count(*)"))).toBe(false);
    const state = await read(runId);
    expect(state.events).toEqual(receipts.map(value => value.row));
    expect(state.run).toMatchObject({ nextEventSeq: 4, eventCursorProjectionSeq: 3, eventCursorRebuildPending: false });
  });

  it("returns input-order receipts for stored and in-batch duplicates without allocating for them", async () => {
    const runId = await makeRun();
    const [one, two] = await appendHeartbeatRunEvents(db, [event(runId, 1), event(runId, 2)]);
    const receipts = await appendHeartbeatRunEvents(db, [event(runId, 2), event(runId, 3), event(runId, 3), event(runId, 1), event(runId, 4)]);
    expect(receipts.map(value => [value.row.seq, value.disposition, value.highestContiguousSourceSeq]))
      .toEqual([[2, "duplicate", 4], [3, "committed", 4], [3, "duplicate", 4], [1, "duplicate", 4], [4, "committed", 4]]);
    expect(receipts[0]!.row).toEqual(two!.row); expect(receipts[3]!.row).toEqual(one!.row);
    expect((await read(runId)).run.nextEventSeq).toBe(5);
  });

  it.each(["changed payload", "event id", "sequence"])("rejects an in-batch %s conflict without any writes", async conflict => {
    const runId = await makeRun(), first = event(runId, 1), second = event(runId, 1, conflict === "changed payload" ? "changed" : "chunk-1");
    if (conflict === "event id") {
      second.nativeSource!.sourceEventId = "other-id";
      second.nativeSource!.canonicalPayload.sourceEventId = "other-id";
    }
    if (conflict === "sequence") {
      second.nativeSource!.sourceSeq = 2;
      second.nativeSource!.canonicalPayload.sourceSeq = 2;
    }
    await expect(appendHeartbeatRunEvents(db, [first, second])).rejects.toThrow("native_event_replay_conflict");
    expect(await read(runId)).toMatchObject({ run: { nextEventSeq: 1, eventCursorProjectionSeq: 0 }, events: [], cursors: [] });
  });

  it("checks both stored replay identities and rolls back the fresh batch prefix", async () => {
    const runId = await makeRun();
    await appendHeartbeatRunEvents(db, [event(runId, 1), event(runId, 2)]);
    const bridge = event(runId, 2);
    bridge.nativeSource!.sourceEventId = "runner:1";
    bridge.nativeSource!.canonicalPayload.sourceEventId = "runner:1";
    const before = await read(runId);
    await expect(appendHeartbeatRunEvents(db, [event(runId, 3), bridge])).rejects.toThrow("native_event_replay_conflict");
    expect(await read(runId)).toEqual(before);
  });

  it("shares sequence allocation with concurrent singleton and legacy writers on separate connections", async () => {
    const runId = await makeRun();
    await Promise.all(Array.from({ length: 10 }, (_, index) => index % 2
      ? appendHeartbeatRunEvent(otherDb, { companyId, agentId, runId, eventType: "log", message: `legacy-${index}` })
      : appendHeartbeatRunEvents(db, Array.from({ length: 4 }, (_, offset) => event(runId, index / 2 * 4 + offset + 1)))));
    await appendHeartbeatRunEvent(otherDb, event(runId, 21));
    const state = await read(runId);
    expect(state.events.map(row => row.seq)).toEqual(Array.from({ length: 26 }, (_, index) => index + 1));
    expect(state.run).toMatchObject({ nextEventSeq: 27, eventCursorProjectionSeq: 26 });
    expect((await appendHeartbeatRunEvents(db, [event(runId, 1), event(runId, 21)])).map(value => value.highestContiguousSourceSeq))
      .toEqual([21, 21]);
  });

  it("keeps independent source gaps and merges a late bridging batch", async () => {
    const runId = await makeRun();
    const initial = await appendHeartbeatRunEvents(db, [event(runId, 2), event(runId, 5), event(runId, 6), event(runId, 1, "other", "other-source")]);
    expect(initial.map(value => value.highestContiguousSourceSeq)).toEqual([0, 0, 0, 1]);
    const filled = await appendHeartbeatRunEvents(db, [event(runId, 1), event(runId, 4), event(runId, 3)]);
    expect(filled.map(value => value.highestContiguousSourceSeq)).toEqual([6, 6, 6]);
    expect((await read(runId)).cursors.map(row => [row.sourceInstanceId, row.contiguousSourceSeq, row.pendingRangeCount]).sort())
      .toEqual([["other-source", 1, 0], ["runner", 6, 0]]);
  });

  it("uses the correct fallback for old writes and the ready cursor after rebuild", async () => {
    const runId = await makeRun();
    const old = event(runId, 1);
    await db.insert(heartbeatRunEvents).values({ companyId, agentId, runId, seq: 1, eventType: old.eventType,
      sourceInstanceId: "runner", sourceSeq: 1, sourceEventId: "old-writer:1" });
    await db.update(heartbeatRuns).set({ nextEventSeq: 2 }).where(eq(heartbeatRuns.id, runId));
    expect((await appendHeartbeatRunEvents(db, [event(runId, 2), event(runId, 3)])).map(value => value.highestContiguousSourceSeq)).toEqual([3, 3]);
    expect((await read(runId)).run).toMatchObject({ eventCursorProjectionSeq: 0, eventCursorRebuildPending: true });
    expect(await rebuildNativeEventCursorPage(db, { companyId, runId })).toMatchObject({ pending: false });
    const statements: string[] = [];
    const recorded = drizzle(db.$client, { schema: db._.fullSchema, logger: { logQuery: query => statements.push(query) } }) as typeof db;
    expect((await appendHeartbeatRunEvents(recorded, [event(runId, 4), event(runId, 5)])).map(value => value.highestContiguousSourceSeq)).toEqual([5, 5]);
    expect(statements.some(query => query.includes("count(*)"))).toBe(false);
  });

  it("rolls back rows, source cursors and reservation with its outer transaction", async () => {
    const runId = await makeRun();
    await expect(db.transaction(async tx => {
      await appendHeartbeatRunEvents(tx as unknown as typeof db, [event(runId, 1), event(runId, 2)]);
      throw new Error("outer rollback");
    })).rejects.toThrow("outer rollback");
    expect(await read(runId)).toMatchObject({ run: { nextEventSeq: 1, eventCursorProjectionSeq: 0 }, events: [], cursors: [] });
  });

  it("rolls back the whole reservation when an insertion fails", async () => {
    const runId = await makeRun();
    await db.execute(sql`create function reject_native_batch_fixture() returns trigger language plpgsql as $$
      begin if new.source_event_id = 'reject-batch-fixture' then raise exception 'batch insert rejected'; end if; return new; end; $$`);
    await db.execute(sql`create trigger reject_native_batch_fixture before insert on heartbeat_run_events
      for each row execute function reject_native_batch_fixture()`);
    try {
      const bad = event(runId, 2);
      bad.nativeSource!.sourceEventId = "reject-batch-fixture";
      bad.nativeSource!.canonicalPayload.sourceEventId = "reject-batch-fixture";
      await expect(appendHeartbeatRunEvents(db, [event(runId, 1), bad])).rejects.toMatchObject({
        cause: { message: "batch insert rejected" },
      });
      expect(await read(runId)).toMatchObject({ run: { nextEventSeq: 1, eventCursorProjectionSeq: 0 }, events: [], cursors: [] });
    } finally {
      await db.execute(sql`drop trigger reject_native_batch_fixture on heartbeat_run_events`);
      await db.execute(sql`drop function reject_native_batch_fixture()`);
    }
  });

  it("rejects control, mixed binding, oversized and over-count batches", async () => {
    const runId = await makeRun();
    const control = event(runId, 1);
    control.nativeSource!.canonicalPayload.sourceKind = "control_plane";
    (control.nativeSource!.canonicalPayload.payload as Record<string, unknown>).evidenceOutcome = "accepted";
    const invalid = [
      [{ ...event(runId, 1), eventType: "turn.completed" }],
      [control],
      [event(runId, 1), event(randomUUID(), 2)],
      [event(runId, 1, "x".repeat(64 * 1024))],
      Array.from({ length: 65 }, (_, index) => event(runId, index + 1)),
    ];
    for (const batch of invalid) await expect(appendHeartbeatRunEvents(db, batch)).rejects.toThrow("native_event_batch_invalid");
    expect((await read(runId)).events).toEqual([]);
  });
});
