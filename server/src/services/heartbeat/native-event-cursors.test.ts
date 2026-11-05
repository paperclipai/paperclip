import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRunEventCursors, heartbeatRunEventSourceRanges,
  heartbeatRunEvents, heartbeatRuns } from "@paperclipai/db";
import { appendHeartbeatRunEvent, type AppendHeartbeatRunEventInput } from "../heartbeat-run-events.js";
import { rebuildNativeEventCursorPage } from "./native-event-cursors.js";
import { nativeEventCursorWork } from "./native-event-cursor-work.js";
import { createDeliveryWorkCoordinator } from "../delivery-work-coordinator.js";
import { idleWorkSnapshot } from "../task-admission.js";
import { nativeSha256 } from "../native-runtime/canonical.js";
import { resolveExternalTestDatabaseUrl } from "../../__tests__/helpers/external-test-database.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_EVENT_CURSORS_TEST_DATABASE_URL");
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("transactional native event cursors", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  let otherDb: ReturnType<typeof createDb>;
  let companyId: string, agentId: string, runId: string;
  let coordinator: ReturnType<typeof createDeliveryWorkCoordinator> | undefined;
  const sourceInstanceId = "source";
  const errors: unknown[] = [];
  beforeAll(async () => {
    if (!external) temporary = await startEmbeddedPostgresTestDatabase("native-event-cursors-");
    const url = external ?? temporary!.connectionString;
    db = createDb(url, { idleTimeoutSeconds: 0 }); otherDb = createDb(url, { idleTimeoutSeconds: 0 });
  }, 60_000);
  beforeEach(async () => {
    companyId = randomUUID(); agentId = randomUUID(); runId = randomUUID(); errors.length = 0;
    await db.insert(companies).values({ id: companyId, name: "Cursor test", issuePrefix: "CUR" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Cursor agent" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running" });
  });
  afterEach(async () => {
    await coordinator?.stop(); coordinator = undefined; vi.useRealTimers(); vi.restoreAllMocks();
    await db.delete(heartbeatRunEvents).where(eq(heartbeatRunEvents.companyId, companyId));
    await db.delete(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
    await db.delete(agents).where(eq(agents.companyId, companyId));
    await db.delete(companies).where(eq(companies.id, companyId));
  });
  afterAll(async () => { await otherDb?.$client.end({ timeout: 1 }); await db?.$client.end({ timeout: 1 }); await temporary?.cleanup(); });
  function input(sourceSeq: number, source = sourceInstanceId): AppendHeartbeatRunEventInput {
    return { companyId, agentId, runId, eventType: "item.delta",
      nativeSource: { sourceInstanceId: source, sourceEventId: `${source}:${sourceSeq}`, sourceSeq,
        protocolSchemaVersion: 1, canonicalPayload: { value: sourceSeq } } };
  }
  const run = async () => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0]!;
  const cursor = async () => (await db.select().from(heartbeatRunEventCursors)
    .where(and(eq(heartbeatRunEventCursors.runId, runId), eq(heartbeatRunEventCursors.sourceInstanceId, sourceInstanceId))))[0];
  const ranges = () => db.select().from(heartbeatRunEventSourceRanges)
    .where(eq(heartbeatRunEventSourceRanges.runId, runId)).orderBy(heartbeatRunEventSourceRanges.startSeq);
  async function rebuild() {
    let result;
    do { result = await rebuildNativeEventCursorPage(db, { companyId, runId }); } while (result.pending);
  }
  async function seedGapHistory(last: number) {
    await db.execute(sql`insert into heartbeat_run_events
      (company_id, run_id, agent_id, seq, event_type, source_instance_id, source_event_id, source_seq)
      select ${companyId}::uuid, ${runId}::uuid, ${agentId}::uuid, value - 1, 'item.delta',
        ${sourceInstanceId}, 'seed:' || value, value from generate_series(2, ${last}::bigint) value`);
    await db.update(heartbeatRuns).set({ nextEventSeq: last, eventCursorRebuildPending: true })
      .where(eq(heartbeatRuns.id, runId));
  }

  it("merges gaps and keeps every event with constant-size source metadata", async () => {
    const results = [];
    for (const seq of [2, 5, 6, 1, 3, 4]) results.push((await appendHeartbeatRunEvent(db, input(seq))).highestContiguousSourceSeq);
    expect(results).toEqual([0, 0, 0, 2, 3, 6]);
    expect(await ranges()).toEqual([]);
    expect(await cursor()).toMatchObject({ contiguousSourceSeq: 6, pendingRangeCount: 0 });
    expect(await run()).toMatchObject({ nextEventSeq: 7, eventCursorProjectionSeq: 6, eventCursorRebuildPending: false });
    expect(await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, runId))).toHaveLength(6);
    expect((await appendHeartbeatRunEvent(otherDb, input(4))).highestContiguousSourceSeq).toBe(6);
  });

  it("rejects collisions on either identity even when canonical hashes match", async () => {
    await appendHeartbeatRunEvent(db, input(1));
    await appendHeartbeatRunEvent(db, input(2));
    const sameDigest = input(1);
    await expect(appendHeartbeatRunEvent(db, { ...sameDigest,
      nativeSource: { ...sameDigest.nativeSource!, sourceSeq: 2 } })).rejects.toThrow("native_event_replay_conflict");
    await expect(appendHeartbeatRunEvent(db, { ...sameDigest,
      nativeSource: { ...sameDigest.nativeSource!, sourceInstanceId: "other" } })).rejects.toThrow("native_event_replay_conflict");
    expect((await run()).nextEventSeq).toBe(3);
    expect(await cursor()).toMatchObject({ contiguousSourceSeq: 2 });
  });

  it("extends a warm-run suffix above a missing prefix in one projection statement", async () => {
    const first = 3_000_000_000;
    await appendHeartbeatRunEvent(db, input(first));
    const statements: string[] = [];
    const observed = drizzle(db.$client, { schema: db._.fullSchema,
      logger: { logQuery: query => statements.push(query) } }) as typeof db;
    expect((await appendHeartbeatRunEvent(observed, input(first + 1))).highestContiguousSourceSeq).toBe(0);
    expect(statements.filter(query => query.includes("heartbeat_run_event_cursors"))).toHaveLength(1);
    expect(await ranges()).toEqual([expect.objectContaining({ startSeq: first, endSeq: first + 1 })]);
    expect(await cursor()).toMatchObject({ contiguousSourceSeq: 0, pendingRangeCount: 1 });
  });

  it("closes a large historical gap without counting or loading its event suffix", async () => {
    await seedGapHistory(10_000); await rebuild();
    expect(await ranges()).toEqual([expect.objectContaining({ startSeq: 2, endSeq: 10_000 })]);
    const statements: string[] = [];
    const observed = drizzle(db.$client, { schema: db._.fullSchema,
      logger: { logQuery: query => statements.push(query) } }) as typeof db;
    expect((await appendHeartbeatRunEvent(observed, input(1))).highestContiguousSourceSeq).toBe(10_000);
    expect(statements.some(query => /count\(\*\)|max\("source_seq"\)/i.test(query))).toBe(false);
    // The only event-history SELECT is the bounded identity lookup.
    expect(statements.filter(query => query.startsWith("select ") && query.includes('from "heartbeat_run_events"')))
      .toEqual([expect.stringMatching(/limit \$\d+$/)]);
    expect(await ranges()).toEqual([]);
    expect(await cursor()).toMatchObject({ contiguousSourceSeq: 10_000, pendingRangeCount: 0 });
  }, 60_000);

  it("uses the correct fallback during partial rebuild and resumes after an older writer", async () => {
    await seedGapHistory(1026);
    expect(await rebuildNativeEventCursorPage(db, { companyId, runId })).toMatchObject({ pending: true, processed: 512 });
    expect(await cursor()).toMatchObject({ contiguousSourceSeq: 0 });
    expect((await appendHeartbeatRunEvent(db, input(1))).highestContiguousSourceSeq).toBe(1026);
    expect((await run()).eventCursorProjectionSeq).toBe(512);
    await rebuild();
    expect(await cursor()).toMatchObject({ contiguousSourceSeq: 1026 });
    const old = input(1028);
    await db.transaction(async tx => {
      const [allocated] = await tx.update(heartbeatRuns).set({ nextEventSeq: sql`${heartbeatRuns.nextEventSeq} + 1` })
        .where(eq(heartbeatRuns.id, runId)).returning({ seq: heartbeatRuns.nextEventSeq });
      await tx.insert(heartbeatRunEvents).values({ companyId, agentId, runId, seq: allocated.seq - 1,
        eventType: old.eventType, sourceInstanceId, sourceEventId: old.nativeSource!.sourceEventId,
        sourceSeq: 1028, sourcePayloadSha256: nativeSha256(old.nativeSource!.canonicalPayload) });
    });
    expect((await appendHeartbeatRunEvent(db, input(1027))).highestContiguousSourceSeq).toBe(1028);
    expect((await run()).eventCursorRebuildPending).toBe(true);
    await rebuild();
    expect(await cursor()).toMatchObject({ contiguousSourceSeq: 1028, pendingRangeCount: 0 });
    expect((await run()).eventCursorRebuildPending).toBe(false);
  });

  it("rolls source state and rebuild intent back with the outer transaction", async () => {
    await expect(db.transaction(async tx => {
      await appendHeartbeatRunEvent(tx as unknown as typeof db, input(1)); throw new Error("outer rollback");
    })).rejects.toThrow("outer rollback");
    expect(await cursor()).toBeUndefined(); expect((await run()).nextEventSeq).toBe(1);
    await seedGapHistory(4);
    await db.update(heartbeatRuns).set({ eventCursorRebuildPending: false }).where(eq(heartbeatRuns.id, runId));
    await expect(db.transaction(async tx => {
      await appendHeartbeatRunEvent(tx as unknown as typeof db, input(1)); throw new Error("outer rollback");
    })).rejects.toThrow("outer rollback");
    expect((await run()).eventCursorRebuildPending).toBe(false);
    expect((await run()).nextEventSeq).toBe(4);
  });

  it("reconstructs explicit pending work, becomes quiet, and reactivates after a stale append", async () => {
    await seedGapHistory(1026);
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, canReconcile: () => true,
      onError: error => errors.push(error) });
    await nativeEventCursorWork(db).register(coordinator, () => true).ready;
    const settle = () => vi.waitFor(async () => {
      await vi.advanceTimersByTimeAsync(1000);
      expect((await run()).eventCursorRebuildPending).toBe(false);
      expect(idleWorkSnapshot().active).toBe(0); expect(coordinator!.nextWakeAt()).toBeNull();
    }, { timeout: 10_000 });
    await settle();
    const select = vi.spyOn(db, "select"), transaction = vi.spyOn(db, "transaction");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(select).not.toHaveBeenCalled(); expect(transaction).not.toHaveBeenCalled();
    select.mockRestore(); transaction.mockRestore();
    // An old binary adds a legacy event without maintaining the marker.
    await db.execute(sql`with allocated as (update heartbeat_runs set next_event_seq = next_event_seq + 1
      where id = ${runId} returning next_event_seq - 1 as seq)
      insert into heartbeat_run_events (company_id, run_id, agent_id, seq, event_type)
      select ${companyId}::uuid, ${runId}::uuid, ${agentId}::uuid, seq, 'log' from allocated`);
    await appendHeartbeatRunEvent(db, input(1));
    await settle(); expect(await cursor()).toMatchObject({ contiguousSourceSeq: 1026 }); expect(errors).toEqual([]);
    await db.delete(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, runId));
    await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(await db.select().from(heartbeatRunEventCursors).where(eq(heartbeatRunEventCursors.runId, runId))).toEqual([]);
    expect(await ranges()).toEqual([]);
  });
});
