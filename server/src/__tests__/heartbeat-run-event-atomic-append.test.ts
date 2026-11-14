import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { agents, companies, createDb, heartbeatRunEvents, heartbeatRuns, issues, nativeRunnerCheckpoints, databaseWorkPending,
  reconcileDatabaseWork, signalDatabaseWork, subscribeDatabaseWork } from "@paperclipai/db";
import { DATABASE_WORK_CHANNEL, enableDatabaseWorkNotifications } from "@paperclipai/db/work-signals";
import { DELIVERY_QUEUES } from "../services/delivery-work-notifications.js";
import { appendHeartbeatRunEvent, appendHeartbeatRunEventBatch } from "../services/heartbeat-run-events.js";
import { nativeSha256 } from "../services/native-runtime/canonical.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const externalTestDatabaseUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_ATOMIC_EVENTS_TEST_DATABASE_URL");
const embeddedPostgresSupport = externalTestDatabaseUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("atomic ordinary run events", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  let otherDb: ReturnType<typeof createDb>;
  const companyId = "30000000-0000-4000-8000-000000000001";
  const agentId = "30000000-0000-4000-8000-000000000002";
  const otherCompanyId = "30000000-0000-4000-8000-000000000003";
  const otherAgentId = "30000000-0000-4000-8000-000000000004";
  let ordinal = 10;

  const makeRun = async () => {
    const id = `30000000-0000-4000-8000-${String(ordinal++).padStart(12, "0")}`;
    await db.insert(heartbeatRuns).values({ id, companyId, agentId, status: "running" });
    return id;
  };
  const readRun = async (id: string) => (await db.select().from(heartbeatRuns)
    .where(eq(heartbeatRuns.id, id)))[0]!;
  const readEvents = (id: string) => db.select().from(heartbeatRunEvents)
    .where(eq(heartbeatRunEvents.runId, id)).orderBy(heartbeatRunEvents.seq);

  beforeAll(async () => {
    if (!externalTestDatabaseUrl) temporary = await startEmbeddedPostgresTestDatabase("paperclip-atomic-events-");
    const connectionString = externalTestDatabaseUrl ?? temporary!.connectionString;
    db = createDb(connectionString);
    otherDb = createDb(connectionString);
    await db.insert(companies).values([
      { id: companyId, name: "Atomic events", issuePrefix: "ATM" },
      { id: otherCompanyId, name: "Other events", issuePrefix: "OTH" },
    ]);
    await db.insert(agents).values([
      { id: agentId, companyId, name: "Event agent" },
      { id: otherAgentId, companyId: otherCompanyId, name: "Other agent" },
    ]);
  }, 60_000);
  afterAll(async () => {
    try {
      if (externalTestDatabaseUrl && db) {
        const fixtureCompanies = [companyId, otherCompanyId];
        await db.delete(heartbeatRunEvents).where(inArray(heartbeatRunEvents.companyId, fixtureCompanies));
        await db.delete(heartbeatRuns).where(inArray(heartbeatRuns.companyId, fixtureCompanies));
        await db.delete(issues).where(inArray(issues.companyId, fixtureCompanies));
        await db.delete(agents).where(inArray(agents.companyId, fixtureCompanies));
        await db.delete(companies).where(inArray(companies.id, fixtureCompanies));
      }
    } finally {
      await otherDb?.$client.end({ timeout: 1 });
      await db?.$client.end({ timeout: 1 });
      await temporary?.cleanup();
    }
  });

  it("persists a decoded receipt in one executed statement", async () => {
    const runId = await makeRun();
    const statements: string[] = [];
    const recorded = drizzle(db.$client, {
      schema: db._.fullSchema,
      logger: { logQuery: query => statements.push(query) },
    }) as typeof db;
    const payload = { nested: ["before\u0000after"], $paperclipRunEventJsonV1: "literal" };
    const receipt = await appendHeartbeatRunEvent(recorded, {
      companyId, agentId, runId, eventType: "run.performance.span", stream: "system",
      level: "info", color: "green", message: "runner span", payload,
    });
    expect(receipt.disposition).toBe("committed");
    expect(receipt.highestContiguousSourceSeq).toBe(0);
    expect(receipt.row).toEqual(expect.objectContaining({
      companyId, agentId, runId, seq: 1, eventType: "run.performance.span", stream: "system",
      level: "info", color: "green", message: "runner span", payload,
      sourceInstanceId: null, sourceEventId: null, sourceSeq: null,
      sourcePayloadSha256: null, protocolSchemaVersion: null,
    }));
    expect(receipt.row.id).toEqual(expect.any(Number));
    expect(receipt.row.createdAt).toBeInstanceOf(Date);
    expect(await readEvents(runId)).toEqual([receipt.row]);
    expect(statements).toHaveLength(1);
  });

  it("shares the run lock and sequence with native writers on separate connections", async () => {
    const runId = await makeRun();
    const receipts = await Promise.all(Array.from({ length: 40 }, (_, index) =>
      appendHeartbeatRunEvent(index % 2 ? db : otherDb, {
        companyId, agentId, runId, eventType: index % 2 ? "run.performance.span" : "item.completed",
        message: `event-${index}`,
        ...(index % 2 ? {} : { nativeSource: {
          sourceInstanceId: "native-writer", sourceEventId: `event-${index}`,
          sourceSeq: index / 2 + 1, protocolSchemaVersion: 1,
          canonicalPayload: { ordinal: index },
        } }),
      })));
    expect(new Set(receipts.map(receipt => receipt.row.id)).size).toBe(40);
    expect((await readEvents(runId)).map(row => row.seq)).toEqual(
      Array.from({ length: 40 }, (_, index) => index + 1),
    );
    expect((await readRun(runId)).nextEventSeq).toBe(41);
    const replay = await appendHeartbeatRunEvent(db, {
      companyId, agentId, runId, eventType: "item.completed", message: "event-0",
      nativeSource: { sourceInstanceId: "native-writer", sourceEventId: "event-0",
        sourceSeq: 1, protocolSchemaVersion: 1, canonicalPayload: { ordinal: 0 } },
    });
    expect(replay.disposition).toBe("duplicate");
    expect(replay.highestContiguousSourceSeq).toBe(20);
    expect((await readRun(runId)).nextEventSeq).toBe(41);
  });

  /** Every statement the driver sends, transaction control included. */
  const sentStatements = async <T>(client: typeof db.$client, action: () => Promise<T>) => {
    const statements: string[] = [];
    const options = client.options as { debug?: unknown };
    const previous = options.debug;
    options.debug = (_connection: number, text: string) => { statements.push(text.trim().replace(/\s+/g, " ")); };
    try { return { result: await action(), statements }; } finally { options.debug = previous; }
  };
  const nativeEvent = (runId: string, sourceSeq: number, eventType = "item.delta") => ({
    companyId, agentId, runId, eventType, stream: "system", level: "info", payload: { prpEvent: { sourceSeq } },
    nativeSource: { sourceInstanceId: "native-writer", sourceEventId: `native-writer:${sourceSeq}`, sourceSeq,
      protocolSchemaVersion: 1, canonicalPayload: { sourceSeq } },
  });

  it("appends an in-order native source event in one statement, and a replay under the run lock", async () => {
    const runId = await makeRun();
    const first = await sentStatements(db.$client, () => appendHeartbeatRunEvent(db, nativeEvent(runId, 1)));
    expect(first.statements).toHaveLength(1);
    expect(first.statements[0]).toMatch(/^with snapshot_run as .* update heartbeat_runs .* insert into heartbeat_run_events /);
    expect(first.result).toMatchObject({ disposition: "committed", highestContiguousSourceSeq: 1 });
    expect(first.result.row.createdAt).toBeInstanceOf(Date);
    expect(await readEvents(runId)).toEqual([first.result.row]);

    const replay = await sentStatements(db.$client, () => appendHeartbeatRunEvent(db, nativeEvent(runId, 1)));
    expect(replay.statements).toHaveLength(5);
    expect(replay.statements[1]).toMatch(/^begin/i);
    expect(replay.statements[2]).toMatch(/^select "company_id", "agent_id", \("native_source_cursors" ->> \$1\)::bigint as "source_cursor" from "heartbeat_runs" .* for no key update$/);
    expect(replay.statements[3]).toMatch(/^with existing as .* insert into heartbeat_run_events /);
    expect(replay.statements[4]).toMatch(/^commit/i);
    expect(replay.result).toEqual({ row: first.result.row, disposition: "duplicate", highestContiguousSourceSeq: 1 });
    expect((await readRun(runId)).nextEventSeq).toBe(2);

    const nested = await sentStatements(db.$client, () => db.transaction(tx =>
      appendHeartbeatRunEvent(tx as unknown as typeof db, nativeEvent(runId, 2))));
    expect(nested.statements).toHaveLength(5);
    let checks = 0;
    const checked = await sentStatements(db.$client, () => appendHeartbeatRunEvent(db, {
      ...nativeEvent(runId, 3), assertWritable: () => { checks += 1; },
    }));
    expect(checked.statements).toHaveLength(1);
    expect(checks).toBe(2);
    expect(checked.result).toMatchObject({ disposition: "committed", highestContiguousSourceSeq: 3 });
    expect((await readEvents(runId)).map(row => [row.seq, row.sourceSeq])).toEqual([[1, 1], [2, 2], [3, 3]]);
  });

  it("keeps the source cursor on the run so an in-order append does not count the run's events", async () => {
    const runId = await makeRun();
    await appendHeartbeatRunEvent(db, nativeEvent(runId, 1));
    for (let sourceSeq = 2; sourceSeq <= 6; sourceSeq += 1) {
      const appended = await sentStatements(db.$client, () => appendHeartbeatRunEvent(db, nativeEvent(runId, sourceSeq)));
      expect(appended.result).toMatchObject({ disposition: "committed", highestContiguousSourceSeq: sourceSeq });
      expect(appended.statements).toHaveLength(1);
      // The append statement reads no other event of the run.
      expect(appended.statements[0]).not.toMatch(/count\(|max\(source_seq\)/);
    }
    const replay = await sentStatements(db.$client, () => appendHeartbeatRunEvent(db, nativeEvent(runId, 3)));
    expect(replay.result).toMatchObject({ disposition: "duplicate", highestContiguousSourceSeq: 6 });
    expect(replay.statements[3]).not.toMatch(/count\(/);
    expect((await readRun(runId)).nativeSourceCursors).toEqual({ "native-writer": 6 });
  });

  it("recounts a source whose run has no cursor or a cursor behind its stored events", async () => {
    const runId = await makeRun();
    const stored = (sourceSeqs: number[], firstSeq: number) => db.insert(heartbeatRunEvents).values(sourceSeqs.map((sourceSeq, index) => ({
      companyId, agentId, runId, seq: firstSeq + index, eventType: "item.delta", stream: "system", level: "info",
      payload: { prpEvent: { sourceSeq } }, sourceInstanceId: "native-writer", sourceEventId: `native-writer:${sourceSeq}`,
      sourceSeq, sourcePayloadSha256: nativeSha256({ sourceSeq }), protocolSchemaVersion: 1,
    })));
    // A server from before the cursor stored events 1 to 3 of a run that is still streaming.
    await stored([1, 2, 3], 1);
    await db.update(heartbeatRuns).set({ nextEventSeq: 4 }).where(eq(heartbeatRuns.id, runId));
    expect(await appendHeartbeatRunEvent(db, nativeEvent(runId, 4))).toMatchObject({ disposition: "committed", highestContiguousSourceSeq: 4 });
    expect((await readRun(runId)).nativeSourceCursors).toEqual({ "native-writer": 4 });
    // A writer that does not keep the cursor stored 5 to 7.
    await stored([5, 6, 7], 5);
    await db.update(heartbeatRuns).set({ nextEventSeq: 8 }).where(eq(heartbeatRuns.id, runId));
    expect(await appendHeartbeatRunEvent(db, nativeEvent(runId, 6))).toMatchObject({ disposition: "duplicate" });
    expect(await appendHeartbeatRunEvent(db, nativeEvent(runId, 8))).toMatchObject({ disposition: "committed", highestContiguousSourceSeq: 8 });
    expect((await readRun(runId)).nativeSourceCursors).toEqual({ "native-writer": 8 });
    // A gap removes the cursor, so the event that fills it recounts.
    expect(await appendHeartbeatRunEvent(db, nativeEvent(runId, 10))).toMatchObject({ highestContiguousSourceSeq: 8 });
    expect((await readRun(runId)).nativeSourceCursors).toEqual({});
    expect(await appendHeartbeatRunEvent(db, nativeEvent(runId, 9))).toMatchObject({ highestContiguousSourceSeq: 10 });
    expect((await readRun(runId)).nativeSourceCursors).toEqual({ "native-writer": 10 });
    expect((await readEvents(runId)).map(row => row.sourceSeq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 10, 9]);
  });

  it("commits a batch of in-order deltas in one statement", async () => {
    const runId = await makeRun();
    await appendHeartbeatRunEvent(db, nativeEvent(runId, 1));
    await appendHeartbeatRunEvent(db, { companyId, agentId, runId, eventType: "stdout", message: "ordinary" });
    const batch = [2, 3, 4, 5, 6].map(sourceSeq => nativeEvent(runId, sourceSeq));
    const appended = await sentStatements(db.$client, () => appendHeartbeatRunEventBatch(db, batch));
    expect(appended.statements).toHaveLength(1);
    expect(appended.statements.filter(text => text.includes("insert into heartbeat_run_events"))).toHaveLength(1);
    expect(appended.result.map(receipt => [receipt.disposition, receipt.row.seq, receipt.row.sourceSeq, receipt.highestContiguousSourceSeq]))
      .toEqual([2, 3, 4, 5, 6].map((sourceSeq, index) => ["committed", index + 3, sourceSeq, sourceSeq]));
    const rows = await readEvents(runId);
    expect(rows.map(row => [row.seq, row.sourceSeq])).toEqual([[1, 1], [2, null], [3, 2], [4, 3], [5, 4], [6, 5], [7, 6]]);
    expect(appended.result.map(receipt => receipt.row)).toEqual(rows.slice(2));
    expect(rows[3]).toMatchObject({ eventType: "item.delta", stream: "system", level: "info", payload: { prpEvent: { sourceSeq: 3 } },
      sourceInstanceId: "native-writer", sourceEventId: "native-writer:3", protocolSchemaVersion: 1,
      sourcePayloadSha256: nativeSha256({ sourceSeq: 3 }) });
    expect(await readRun(runId)).toMatchObject({ nextEventSeq: 8, nativeSourceCursors: { "native-writer": 6 } });
    // A later single append continues from the batch.
    expect(await appendHeartbeatRunEvent(db, nativeEvent(runId, 7))).toMatchObject({ disposition: "committed", highestContiguousSourceSeq: 7 });
  });

  it("replays a batch without new rows and rejects a conflicting replay", async () => {
    const runId = await makeRun();
    await appendHeartbeatRunEvent(db, nativeEvent(runId, 1));
    const batch = [2, 3, 4].map(sourceSeq => nativeEvent(runId, sourceSeq));
    const first = await appendHeartbeatRunEventBatch(db, batch);
    const rows = await readEvents(runId);
    const replay = await appendHeartbeatRunEventBatch(db, batch);
    expect(replay.map(receipt => receipt.disposition)).toEqual(["duplicate", "duplicate", "duplicate"]);
    expect(replay.map(receipt => receipt.row)).toEqual(first.map(receipt => receipt.row));
    expect(replay.every(receipt => receipt.highestContiguousSourceSeq >= 4)).toBe(true);
    // A replay window that overlaps the stored end appends only the new events, in order.
    const overlap = await appendHeartbeatRunEventBatch(db, [3, 4, 5, 6].map(sourceSeq => nativeEvent(runId, sourceSeq)));
    expect(overlap.map(receipt => receipt.disposition)).toEqual(["duplicate", "duplicate", "committed", "committed"]);
    expect(overlap.map(receipt => receipt.highestContiguousSourceSeq)).toEqual([4, 4, 5, 6]);
    const conflicting = nativeEvent(runId, 7);
    await expect(appendHeartbeatRunEventBatch(db, [nativeEvent(runId, 7), { ...nativeEvent(runId, 3),
      nativeSource: { ...conflicting.nativeSource, sourceEventId: "native-writer:3", sourceSeq: 3, canonicalPayload: { sourceSeq: 999 } } }]))
      .rejects.toThrow("native_event_replay_conflict");
    expect((await readEvents(runId)).map(row => row.sourceSeq)).toEqual([...rows.map(row => row.sourceSeq), 5, 6]);
    expect(await readRun(runId)).toMatchObject({ nextEventSeq: 7, nativeSourceCursors: { "native-writer": 6 } });
  });

  it("stores nothing from a batch that fails before its commit, and commits the resent batch", async () => {
    const runId = await makeRun();
    await appendHeartbeatRunEvent(db, nativeEvent(runId, 1));
    const before = await readRun(runId);
    const batch = [2, 3, 4].map(sourceSeq => nativeEvent(runId, sourceSeq));
    const revoked = await sentStatements(db.$client, () => appendHeartbeatRunEventBatch(db, batch, () => {
      throw new Error("writer revoked");
    }).catch((error: Error) => error.message));
    expect(revoked).toEqual({ result: "writer revoked", statements: [] });
    await db.execute(sql`alter table heartbeat_run_events add constraint atomic_batch_failure
      check (source_seq is distinct from 4) not valid`);
    try {
      await expect(appendHeartbeatRunEventBatch(db, batch)).rejects.toThrow();
    } finally {
      await db.execute(sql`alter table heartbeat_run_events drop constraint atomic_batch_failure`);
    }
    expect(await readRun(runId)).toEqual(before);
    expect((await readEvents(runId)).map(row => row.sourceSeq)).toEqual([1]);
    const resent = await appendHeartbeatRunEventBatch(db, batch);
    expect(resent.map(receipt => [receipt.disposition, receipt.row.seq, receipt.highestContiguousSourceSeq]))
      .toEqual([["committed", 2, 2], ["committed", 3, 3], ["committed", 4, 4]]);
  });

  it("rejects the receipts of a writer revoked while its batch commits, and its resend is a replay", async () => {
    const runId = await makeRun();
    await appendHeartbeatRunEvent(db, nativeEvent(runId, 1));
    const batch = [2, 3, 4].map(sourceSeq => nativeEvent(runId, sourceSeq));
    let checks = 0;
    await expect(appendHeartbeatRunEventBatch(db, batch, () => { if (++checks === 2) throw new Error("writer revoked"); }))
      .rejects.toThrow("writer revoked");
    expect((await readEvents(runId)).map(row => [row.seq, row.sourceSeq])).toEqual([[1, 1], [2, 2], [3, 3], [4, 4]]);
    const resent = await appendHeartbeatRunEventBatch(db, batch);
    expect(resent.map(receipt => [receipt.disposition, receipt.row.seq, receipt.highestContiguousSourceSeq]))
      .toEqual([["duplicate", 2, 4], ["duplicate", 3, 4], ["duplicate", 4, 4]]);
    expect(await readRun(runId)).toMatchObject({ nextEventSeq: 5, nativeSourceCursors: { "native-writer": 4 } });
  });

  const holdRun = async (runId: string, work: (tx: typeof db) => Promise<void>) => {
    let release!: () => void, locked!: () => void;
    const released = new Promise<void>(resolve => { release = resolve; });
    const lockedPromise = new Promise<void>(resolve => { locked = resolve; });
    const holder = otherDb.transaction(async tx => {
      await tx.execute(sql`select id from heartbeat_runs where id = ${runId} for update`);
      await work(tx as unknown as typeof db);
      locked();
      await released;
    });
    void holder.catch(() => undefined);
    await lockedPromise;
    return { release: () => { release(); return holder; } };
  };
  const settlesWhileHeld = async (pending: Promise<unknown>) => {
    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });
    await new Promise(resolve => setTimeout(resolve, 200));
    return settled;
  };

  it("waits for Stop on the run row and appends after it, and fails without rows after a run deletion", async () => {
    const runId = await makeRun();
    await appendHeartbeatRunEvent(db, nativeEvent(runId, 1));
    const stop = await holdRun(runId, async tx => {
      await tx.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, runId));
    });
    const batch = appendHeartbeatRunEventBatch(db, [2, 3].map(sourceSeq => nativeEvent(runId, sourceSeq)));
    const batchSettledWhileHeld = await settlesWhileHeld(batch);
    await stop.release();
    expect(batchSettledWhileHeld).toBe(false);
    expect((await batch).map(receipt => [receipt.disposition, receipt.row.seq])).toEqual([["committed", 2], ["committed", 3]]);
    expect(await readRun(runId)).toMatchObject({ status: "cancelled", nextEventSeq: 4, nativeSourceCursors: { "native-writer": 3 } });

    const deletion = await holdRun(runId, async tx => {
      await tx.delete(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, runId));
      await tx.delete(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    });
    const late = appendHeartbeatRunEventBatch(db, [4, 5].map(sourceSeq => nativeEvent(runId, sourceSeq)));
    const lateSingle = appendHeartbeatRunEvent(db, nativeEvent(runId, 4));
    const lateRejected = expect(late).rejects.toThrow("heartbeat_run_event_binding_mismatch");
    const lateSingleRejected = expect(lateSingle).rejects.toThrow("heartbeat_run_event_binding_mismatch");
    const lateSettledWhileHeld = await settlesWhileHeld(late);
    await deletion.release();
    expect(lateSettledWhileHeld).toBe(false);
    await lateRejected;
    await lateSingleRejected;
    expect(await readEvents(runId)).toEqual([]);
  });

  it("appends under the run lock when another writer commits events while the batch waits", async () => {
    const runId = await makeRun();
    await appendHeartbeatRunEvent(db, nativeEvent(runId, 1));
    const older = await holdRun(runId, async tx => {
      await tx.insert(heartbeatRunEvents).values([2, 3].map(sourceSeq => ({
        companyId, agentId, runId, seq: sourceSeq, eventType: "item.delta", stream: "system", level: "info",
        payload: { prpEvent: { sourceSeq } }, sourceInstanceId: "native-writer", sourceEventId: `native-writer:${sourceSeq}`,
        sourceSeq, sourcePayloadSha256: nativeSha256({ sourceSeq }), protocolSchemaVersion: 1,
      })));
      await tx.update(heartbeatRuns).set({ nextEventSeq: 4 }).where(eq(heartbeatRuns.id, runId));
    });
    const batch = sentStatements(db.$client, () => appendHeartbeatRunEventBatch(db, [2, 3, 4].map(sourceSeq => nativeEvent(runId, sourceSeq))));
    const batchSettledWhileHeld = await settlesWhileHeld(batch);
    await older.release();
    expect(batchSettledWhileHeld).toBe(false);
    const { result, statements } = await batch;
    expect(statements[0]).toMatch(/^with snapshot_run as /);
    expect(statements[1]).toMatch(/^begin/i);
    expect(result.map(receipt => [receipt.disposition, receipt.row.seq, receipt.highestContiguousSourceSeq]))
      .toEqual([["duplicate", 2, 2], ["duplicate", 3, 3], ["committed", 4, 4]]);
    expect((await readEvents(runId)).map(row => [row.seq, row.sourceSeq])).toEqual([[1, 1], [2, 2], [3, 3], [4, 4]]);
    expect(await readRun(runId)).toMatchObject({ nextEventSeq: 5, nativeSourceCursors: { "native-writer": 4 } });
  });

  it("keeps every source event once, in order, when two connections append batches of the same stream", async () => {
    const runId = await makeRun();
    const stream = async (connection: typeof db) => {
      const receipts = [];
      for (let firstSeq = 1; firstSeq <= 200; firstSeq += 10) {
        receipts.push(...await appendHeartbeatRunEventBatch(connection,
          Array.from({ length: 10 }, (_, index) => nativeEvent(runId, firstSeq + index))));
      }
      return receipts;
    };
    const [ours, theirs] = await Promise.all([stream(db), stream(otherDb)]);
    const rows = await readEvents(runId);
    expect(rows.map(row => [row.seq, row.sourceSeq])).toEqual(Array.from({ length: 200 }, (_, index) => [index + 1, index + 1]));
    expect(await readRun(runId)).toMatchObject({ nextEventSeq: 201, nativeSourceCursors: { "native-writer": 200 } });
    for (let index = 0; index < 200; index += 1) {
      expect([ours[index]!.disposition, theirs[index]!.disposition].sort()).toEqual(["committed", "duplicate"]);
      for (const receipt of [ours[index]!, theirs[index]!]) {
        expect(receipt.row).toEqual(rows[index]);
        expect(receipt.highestContiguousSourceSeq).toBeGreaterThanOrEqual(index + 1);
      }
    }
  });

  it("commits a batch larger than any bind parameter limit in one statement", async () => {
    const runId = await makeRun();
    const batch = Array.from({ length: 7_000 }, (_, index) => nativeEvent(runId, index + 1));
    const appended = await sentStatements(db.$client, () => appendHeartbeatRunEventBatch(db, batch));
    expect(appended.statements).toHaveLength(1);
    expect(appended.result.at(-1)).toMatchObject({ disposition: "committed", highestContiguousSourceSeq: 7_000, row: { seq: 7_000 } });
    const [stored] = await db.select({ count: sql<number>`count(*)::int`, last: sql<number>`max(seq)::int` })
      .from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, runId));
    expect(stored).toEqual({ count: 7_000, last: 7_000 });
    expect(await readRun(runId)).toMatchObject({ nextEventSeq: 7_001, nativeSourceCursors: { "native-writer": 7_000 } });
  });

  it("starts a source without a cursor at its first event, and recounts a run that holds events from an older server", async () => {
    const fresh = await makeRun();
    expect((await readRun(fresh)).nativeSourceCursors).toBeNull();
    const started = await sentStatements(db.$client, () => appendHeartbeatRunEventBatch(db, [1, 2].map(sourceSeq => nativeEvent(fresh, sourceSeq))));
    expect(started.statements).toHaveLength(1);
    expect((await readRun(fresh)).nativeSourceCursors).toEqual({ "native-writer": 2 });

    const older = await makeRun();
    await db.insert(heartbeatRunEvents).values([1, 2].map(sourceSeq => ({
      companyId, agentId, runId: older, seq: sourceSeq, eventType: "item.delta", stream: "system", level: "info",
      payload: { prpEvent: { sourceSeq } }, sourceInstanceId: "native-writer", sourceEventId: `native-writer:${sourceSeq}`,
      sourceSeq, sourcePayloadSha256: nativeSha256({ sourceSeq }), protocolSchemaVersion: 1,
    })));
    await db.update(heartbeatRuns).set({ nextEventSeq: 3 }).where(eq(heartbeatRuns.id, older));
    const replayed = await appendHeartbeatRunEventBatch(db, [1, 2].map(sourceSeq => nativeEvent(older, sourceSeq)));
    expect(replayed.map(receipt => [receipt.disposition, receipt.highestContiguousSourceSeq])).toEqual([["duplicate", 2], ["duplicate", 2]]);
    const continued = await appendHeartbeatRunEventBatch(db, [3, 4].map(sourceSeq => nativeEvent(older, sourceSeq)));
    expect(continued.map(receipt => [receipt.disposition, receipt.row.seq, receipt.highestContiguousSourceSeq]))
      .toEqual([["committed", 3, 3], ["committed", 4, 4]]);
    expect((await readRun(older)).nativeSourceCursors).toEqual({ "native-writer": 4 });
  });

  it("produces the rows, receipts and cursor of the one-by-one append for random streams", async () => {
    let state = 0x2f6b_1d3a;
    const random = (limit: number) => {
      state = (Math.imul(state ^ (state >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0;
      return state % limit;
    };
    const reference = (event: ReturnType<typeof nativeEvent>) => ({ ...event, eventType: "turn.completed" });
    const appendBoth = async (fast: string, slow: string, sourceSeqs: number[], payloadOffset = 0) => {
      const make = (runId: string, sourceSeq: number) => {
        const event = nativeEvent(runId, sourceSeq);
        return payloadOffset ? { ...event, nativeSource: { ...event.nativeSource, canonicalPayload: { sourceSeq: sourceSeq + payloadOffset } } } : event;
      };
      const outcome = (receipts: Awaited<ReturnType<typeof appendHeartbeatRunEventBatch>>) =>
        receipts.map(receipt => [receipt.disposition, receipt.row.seq, receipt.row.sourceSeq, receipt.highestContiguousSourceSeq]);
      const [ours, theirs] = await Promise.all([
        appendHeartbeatRunEventBatch(db, sourceSeqs.map(sourceSeq => make(fast, sourceSeq))).then(outcome, (error: Error) => error.message),
        appendHeartbeatRunEventBatch(db, sourceSeqs.map(sourceSeq => reference(make(slow, sourceSeq)))).then(outcome, (error: Error) => error.message),
      ]);
      expect(ours).toEqual(theirs);
    };
    let fastStatements = 0;
    for (let stream = 0; stream < 12; stream += 1) {
      const fast = await makeRun(), slow = await makeRun();
      let next = 1;
      const sent: number[] = [];
      for (let step = 0; step < 30; step += 1) {
        const choice = random(10);
        let sourceSeqs: number[];
        if (choice < 5) sourceSeqs = Array.from({ length: 1 + random(8) }, (_, index) => next + index);
        else if (choice < 6) sourceSeqs = Array.from({ length: 1 + random(3) }, (_, index) => next + 1 + random(3) + index);
        else if (choice < 8 && sent.length > 0) {
          const start = sent[random(sent.length)]!;
          sourceSeqs = Array.from({ length: 1 + random(5) }, (_, index) => start + index);
        } else if (choice < 9) {
          const missing = Array.from({ length: next - 1 }, (_, index) => index + 1).filter(sourceSeq => !sent.includes(sourceSeq));
          sourceSeqs = missing.length ? missing.slice(0, 1 + random(3)) : [next];
        } else {
          for (const runId of [fast, slow]) await appendHeartbeatRunEvent(db, { companyId, agentId, runId, eventType: "stdout", message: `step-${step}` });
          if (sent.length > 0 && random(2) === 0) await appendBoth(fast, slow, [sent[random(sent.length)]!], 1_000);
          continue;
        }
        const measured = await sentStatements(db.$client, () => appendBoth(fast, slow, sourceSeqs));
        fastStatements += measured.statements.filter(text => text.startsWith("with snapshot_run as")).length;
        for (const sourceSeq of sourceSeqs) if (!sent.includes(sourceSeq)) sent.push(sourceSeq);
        next = Math.max(next, ...sourceSeqs.map(sourceSeq => sourceSeq + 1));
      }
      const project = (rows: Awaited<ReturnType<typeof readEvents>>) => rows.map(row =>
        [row.seq, row.sourceInstanceId, row.sourceEventId, row.sourceSeq, row.sourcePayloadSha256, row.message]);
      expect(project(await readEvents(fast))).toEqual(project(await readEvents(slow)));
      const [fastRun, slowRun] = [await readRun(fast), await readRun(slow)];
      expect([fastRun.nextEventSeq, fastRun.nativeSourceCursors]).toEqual([slowRun.nextEventSeq, slowRun.nativeSourceCursors]);
    }
    expect(fastStatements).toBeGreaterThan(50);
  });

  it("appends a batch one by one when its run has no cursor or the batch leaves a gap", async () => {
    const runId = await makeRun();
    const fromStart = await appendHeartbeatRunEventBatch(db, [1, 2, 3].map(sourceSeq => nativeEvent(runId, sourceSeq)));
    expect(fromStart.map(receipt => receipt.highestContiguousSourceSeq)).toEqual([1, 2, 3]);
    const gap = await appendHeartbeatRunEventBatch(db, [5, 6].map(sourceSeq => nativeEvent(runId, sourceSeq)));
    expect(gap.map(receipt => [receipt.disposition, receipt.highestContiguousSourceSeq])).toEqual([["committed", 3], ["committed", 3]]);
    const filled = await appendHeartbeatRunEventBatch(db, [4, 7].map(sourceSeq => nativeEvent(runId, sourceSeq)));
    expect(filled.map(receipt => receipt.highestContiguousSourceSeq)).toEqual([6, 7]);
    expect((await readEvents(runId)).map(row => [row.seq, row.sourceSeq])).toEqual([[1, 1], [2, 2], [3, 3], [4, 5], [5, 6], [6, 4], [7, 7]]);
    await expect(appendHeartbeatRunEventBatch(db, [nativeEvent(runId, 8), { ...nativeEvent(runId, 9), runId: await makeRun() }]))
      .rejects.toThrow("heartbeat_run_event_batch_unsupported");
  });

  const finalMessage = (runId: string, sourceSeq: number) => {
    const event = nativeEvent(runId, sourceSeq, "item.completed");
    const prpEvent = { sourceSeq, payload: { kind: "agentMessage", channel: "final", text: "Done" } };
    return { ...event, payload: { prpEvent }, nativeSource: { ...event.nativeSource, canonicalPayload: prpEvent } };
  };
  const nativeTaskRun = async (title: string) => {
    const runId = await makeRun();
    const [issue] = await db.insert(issues).values({ companyId, title }).returning();
    await db.update(heartbeatRuns).set({ nativeIssueId: issue!.id, runtimeMode: "native" }).where(eq(heartbeatRuns.id, runId));
    return runId;
  };

  it("appends an event whose only wake is chat progress in one statement and wakes progress after it commits", async () => {
    const runId = await nativeTaskRun("Progress task");
    const wakes: string[] = [];
    const unsubscribe = subscribeDatabaseWork(db, DELIVERY_QUEUES.chatNativeProgress, event => { wakes.push(event); });
    try {
      const first = await sentStatements(db.$client, () => appendHeartbeatRunEvent(db, nativeEvent(runId, 1, "tool.execution.progressed")));
      expect(first.statements).toHaveLength(1);
      expect(first.statements[0]).toMatch(/^with snapshot_run as .* insert into heartbeat_run_events .* pg_notify/);
      expect(wakes).toEqual(["settled"]);
      expect(first.result).toMatchObject({ disposition: "committed", highestContiguousSourceSeq: 1 });
      wakes.length = 0;
      const replay = await sentStatements(db.$client, () => appendHeartbeatRunEvent(db, nativeEvent(runId, 1, "tool.execution.progressed")));
      expect(wakes).toEqual([]);
      expect(replay.result).toEqual({ row: first.result.row, disposition: "duplicate", highestContiguousSourceSeq: 1 });
      expect(await readEvents(runId)).toEqual([first.result.row]);
    } finally { unsubscribe(); }
  });

  it("keeps a progress-only event inside a caller's transaction on the locked path, and settles its wake only when that transaction ends", async () => {
    const runId = await nativeTaskRun("Progress in a caller transaction");
    const wakes: string[] = [];
    const unsubscribe = subscribeDatabaseWork(db, DELIVERY_QUEUES.chatNativeProgress, event => { wakes.push(event); });
    try {
      const committed = await sentStatements(db.$client, () => db.transaction(async tx => {
        await appendHeartbeatRunEvent(tx as unknown as typeof db, nativeEvent(runId, 1, "tool.execution.progressed"));
        expect(wakes).not.toContain("settled");
      }));
      expect(committed.statements[0]).toMatch(/^begin/i);
      expect(committed.statements.some(text => text.startsWith("with snapshot_run as"))).toBe(false);
      expect(wakes).toEqual(["intent", "settled"]);
      wakes.length = 0;
      await expect(db.transaction(async tx => {
        await appendHeartbeatRunEvent(tx as unknown as typeof db, nativeEvent(runId, 2, "tool.execution.progressed"));
        expect(wakes).not.toContain("settled");
        throw new Error("caller rollback");
      })).rejects.toThrow("caller rollback");
      expect((await readEvents(runId)).map(row => row.sourceSeq)).toEqual([1]);
      await reconcileDatabaseWork(db, DELIVERY_QUEUES.chatNativeProgress);
      expect(databaseWorkPending(db, DELIVERY_QUEUES.chatNativeProgress)).toBe(false);
    } finally { unsubscribe(); }
  });

  it("sends the progress wake to other server processes with the one statement's commit", async () => {
    const runId = await nativeTaskRun("Cross-process progress");
    const notifying = createDb(externalTestDatabaseUrl ?? temporary!.connectionString);
    enableDatabaseWorkNotifications(notifying);
    const received: string[] = [];
    const listener = await otherDb.$client.listen(DATABASE_WORK_CHANNEL, payload => { received.push(payload); });
    try {
      const appended = await sentStatements(notifying.$client, () =>
        appendHeartbeatRunEvent(notifying, nativeEvent(runId, 1, "tool.execution.completed")));
      expect(appended.statements.filter(text => !text.includes("pg_catalog"))).toHaveLength(1);
      await vi.waitFor(() => {
        expect(received.map(payload => JSON.parse(payload).topic)).toEqual([DELIVERY_QUEUES.chatNativeProgress]);
      }, { timeout: 5_000 });
      await appendHeartbeatRunEvent(notifying, nativeEvent(runId, 1, "tool.execution.completed"));
      await new Promise(resolve => setTimeout(resolve, 200));
      expect(received).toHaveLength(1);
    } finally {
      await listener.unlisten();
      await notifying.$client.end({ timeout: 1 });
    }
  });

  it("registers a response wake with chat progress before its write and only when the event is new", async () => {
    const runId = await nativeTaskRun("Response task");
    const wakes: string[] = [];
    const unsubscribe = subscribeDatabaseWork(db, DELIVERY_QUEUES.chatNativeProgress, event => { wakes.push(event); });
    try {
      const first = await sentStatements(db.$client, () => appendHeartbeatRunEvent(db, finalMessage(runId, 1)));
      expect(first.statements).toHaveLength(4);
      expect(first.statements[0]).toMatch(/^begin/i);
      expect(first.statements[1]).toMatch(/^with "snapshot_run" as .*pg_current_xact_id\(\).* for no key update.*"replay_found"/);
      expect(first.statements[2]).toMatch(/insert into heartbeat_run_events/);
      expect(first.statements[3]).toMatch(/^commit/i);
      expect(wakes).toEqual(["intent", "settled"]);
      wakes.length = 0;
      const replay = await sentStatements(db.$client, () => appendHeartbeatRunEvent(db, finalMessage(runId, 1)));
      expect(wakes).toEqual([]);
      expect(replay.statements).toHaveLength(4);
      expect(replay.result).toEqual({ row: first.result.row, disposition: "duplicate", highestContiguousSourceSeq: 1 });
    } finally { unsubscribe(); }
  });

  it("keeps the transaction for the last events of a turn and a run, and one statement for progress-only events", async () => {
    const runId = await nativeTaskRun("Last events");
    const events = [
      ["tool.execution.started", nativeEvent(runId, 1, "tool.execution.started")],
      ["tool.execution.progressed", nativeEvent(runId, 2, "tool.execution.progressed")],
      ["tool.execution.completed", nativeEvent(runId, 3, "tool.execution.completed")],
      ["item.completed (not a final message)", nativeEvent(runId, 4, "item.completed")],
      ["item.completed (final message)", finalMessage(runId, 5)],
      ["run.result.accepted", nativeEvent(runId, 6, "run.result.accepted")],
      ["turn.completed", nativeEvent(runId, 7, "turn.completed")],
      ["turn.failed", nativeEvent(runId, 8, "turn.failed")],
      ["turn.cancelled", nativeEvent(runId, 9, "turn.cancelled")],
      ["turn.interrupted", nativeEvent(runId, 10, "turn.interrupted")],
    ] as const;
    const paths: Array<[string, string]> = [];
    for (const [name, input] of events) {
      const { statements } = await sentStatements(db.$client, () => appendHeartbeatRunEvent(db, input));
      paths.push([name, /^begin/i.test(statements[0] ?? "") ? "transaction" : "one statement"]);
    }
    expect(paths).toEqual([
      ["tool.execution.started", "one statement"],
      ["tool.execution.progressed", "one statement"],
      ["tool.execution.completed", "one statement"],
      ["item.completed (not a final message)", "one statement"],
      ["item.completed (final message)", "transaction"],
      ["run.result.accepted", "transaction"],
      ["turn.completed", "transaction"],
      ["turn.failed", "transaction"],
      ["turn.cancelled", "transaction"],
      ["turn.interrupted", "transaction"],
    ]);
  });

  it("gives the wake the transaction id of the transaction that took the run lock", async () => {
    const runId = await makeRun();
    const [issue] = await db.insert(issues).values({ companyId, title: "Primed wake" }).returning();
    await db.update(heartbeatRuns).set({ nativeIssueId: issue!.id, runtimeMode: "native" }).where(eq(heartbeatRuns.id, runId));
    const topic = DELIVERY_QUEUES.chatNativeProgress;
    const options = db.$client.options as { debug?: unknown };
    const sent: Array<{ text: string; parameters: unknown[] }> = [];
    let ownXid: string | undefined;
    options.debug = (_connection: number, text: string, parameters: unknown[]) => {
      sent.push({ text: text.trim().replace(/\s+/g, " "), parameters });
    };
    try {
      await expect(db.transaction(async tx => {
        await appendHeartbeatRunEvent(tx as unknown as typeof db, nativeEvent(runId, 1, "item.completed"));
        expect(sent.filter(statement => /^select pg_current_xact_id\(\)/.test(statement.text))).toEqual([]);
        expect(sent.filter(statement => statement.text.includes("pg_current_xact_id()"))).toHaveLength(1);
        const [own] = await tx.execute<{ xid: string; pid: number }>(sql`select pg_current_xact_id()::text as xid, pg_backend_pid() as pid`);
        ownXid = own!.xid;
        await otherDb.execute(sql`select pg_terminate_backend(${own!.pid})`);
        await tx.execute(sql`select 1`);
      })).rejects.toThrow();
      expect(databaseWorkPending(db, topic)).toBe(true);
      sent.length = 0;
      await reconcileDatabaseWork(db, topic);
    } finally { options.debug = undefined; }
    const statusRead = sent.find(statement => statement.text.includes("pg_xact_status"));
    expect(ownXid).toMatch(/^\d+$/);
    expect(statusRead?.parameters).toEqual([ownXid]);
    expect(databaseWorkPending(db, topic)).toBe(false);
    expect(await readEvents(runId)).toEqual([]);
  });

  it("primes nothing when the lock read fails, so the transaction is not left uncertain", async () => {
    const runId = await makeRun();
    const [issue] = await db.insert(issues).values({ companyId, title: "Failed lock read" }).returning();
    await db.update(heartbeatRuns).set({ nativeIssueId: issue!.id, runtimeMode: "native" }).where(eq(heartbeatRuns.id, runId));
    let release!: () => void, locked!: () => void;
    const released = new Promise<void>(resolve => { release = resolve; });
    const lockedRun = new Promise<void>(resolve => { locked = resolve; });
    const holder = otherDb.transaction(async tx => {
      await tx.execute(sql`select id from heartbeat_runs where id = ${runId} for update`);
      locked();
      await released;
    });
    void holder.catch(() => undefined);
    await lockedRun;
    const wakes: string[] = [];
    const unsubscribe = subscribeDatabaseWork(db, DELIVERY_QUEUES.chatNativeProgress, wake => { wakes.push(wake); });
    const options = db.$client.options as { debug?: unknown };
    const sent: string[] = [];
    try {
      await expect(db.transaction(async tx => {
        await tx.execute(sql`set local lock_timeout = '100ms'`);
        await appendHeartbeatRunEvent(tx as unknown as typeof db, nativeEvent(runId, 1, "item.completed"));
      })).rejects.toThrow();
      expect(databaseWorkPending(db, DELIVERY_QUEUES.chatNativeProgress)).toBe(false);
      await expect(db.transaction(async tx => {
        await tx.execute(sql`set local lock_timeout = '100ms'`);
        await expect(tx.transaction(savepoint =>
          appendHeartbeatRunEvent(savepoint as unknown as typeof db, nativeEvent(runId, 1, "item.completed")))).rejects.toThrow();
        options.debug = (_connection: number, text: string) => { sent.push(text.trim().replace(/\s+/g, " ")); };
        await signalDatabaseWork(tx, "lock-read-failed");
        options.debug = undefined;
        throw new Error("roll back");
      })).rejects.toThrow("roll back");
    } finally {
      options.debug = undefined;
      unsubscribe();
      release();
      await holder;
    }
    expect(sent.filter(text => /^select pg_current_xact_id\(\)/.test(text))).toHaveLength(1);
    await reconcileDatabaseWork(db, "lock-read-failed");
    expect(databaseWorkPending(db, "lock-read-failed")).toBe(false);
    expect(wakes).toEqual([]);
    expect(databaseWorkPending(db, DELIVERY_QUEUES.chatNativeProgress)).toBe(false);
    expect(await readEvents(runId)).toEqual([]);
  });

  it("finds a replay that another writer committed while the lock read waited, and registers no wake for it", async () => {
    const runId = await makeRun();
    const [issue] = await db.insert(issues).values({ companyId, title: "Progress race" }).returning();
    await db.update(heartbeatRuns).set({ nativeIssueId: issue!.id, runtimeMode: "native" }).where(eq(heartbeatRuns.id, runId));
    const event = finalMessage(runId, 1);
    let release!: () => void, locked!: () => void;
    const released = new Promise<void>(resolve => { release = resolve; });
    const lockedRun = new Promise<void>(resolve => { locked = resolve; });
    const holder = otherDb.transaction(async tx => {
      await tx.execute(sql`select id from heartbeat_runs where id = ${runId} for update`);
      await tx.insert(heartbeatRunEvents).values({ companyId, agentId, runId, seq: 1, eventType: event.eventType, stream: "system",
        level: "info", payload: event.payload, sourceInstanceId: "native-writer", sourceEventId: event.nativeSource.sourceEventId,
        sourceSeq: 1, sourcePayloadSha256: nativeSha256(event.nativeSource.canonicalPayload), protocolSchemaVersion: 1 });
      await tx.update(heartbeatRuns).set({ nextEventSeq: 2 }).where(eq(heartbeatRuns.id, runId));
      locked();
      await released;
    });
    void holder.catch(() => undefined);
    await lockedRun;
    const wakes: string[] = [];
    const unsubscribe = subscribeDatabaseWork(db, DELIVERY_QUEUES.chatNativeProgress, wake => { wakes.push(wake); });
    try {
      const appended = sentStatements(db.$client, () => appendHeartbeatRunEvent(db, event));
      void appended.catch(() => undefined);
      await vi.waitFor(async () => {
        const [waiting] = await otherDb.execute<{ count: number }>(sql`select count(*)::int as count from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock' and query like '%"locked_run"%'`);
        expect(waiting?.count).toBe(1);
      }, { timeout: 10_000, interval: 20 });
      release();
      await holder;
      const { result, statements } = await appended;
      expect(result).toMatchObject({ disposition: "duplicate", row: { seq: 1, sourceSeq: 1 } });
      expect(statements.some(text => /^select \* from heartbeat_run_events/.test(text))).toBe(true);
      expect(wakes).toEqual([]);
    } finally { unsubscribe(); }
    expect((await readEvents(runId)).map(row => row.seq)).toEqual([1]);
    expect((await readRun(runId)).nextEventSeq).toBe(2);
  });

  it("keeps one ordered row per source event when two servers append the same stream", async () => {
    const runId = await makeRun();
    const stream = async (connection: typeof db) => {
      const receipts = [];
      for (let sourceSeq = 1; sourceSeq <= 40; sourceSeq += 1) {
        receipts.push(await appendHeartbeatRunEvent(connection, nativeEvent(runId, sourceSeq)));
      }
      return receipts;
    };
    const [ours, theirs] = await Promise.all([stream(db), stream(otherDb)]);
    const rows = await readEvents(runId);
    // Each writer appends in source order, so the stored order is the source order.
    expect(rows.map(row => [row.seq, row.sourceSeq])).toEqual(Array.from({ length: 40 }, (_, index) => [index + 1, index + 1]));
    expect((await readRun(runId)).nextEventSeq).toBe(41);
    for (let index = 0; index < 40; index += 1) {
      expect([ours[index]!.disposition, theirs[index]!.disposition].sort()).toEqual(["committed", "duplicate"]);
      for (const receipt of [ours[index]!, theirs[index]!]) {
        expect(receipt.row).toEqual(rows[index]);
        // An acknowledgement covers the event and never passes what is stored.
        expect(receipt.highestContiguousSourceSeq).toBeGreaterThanOrEqual(index + 1);
        expect(receipt.highestContiguousSourceSeq).toBeLessThanOrEqual(40);
      }
    }
    const conflicting = nativeEvent(runId, 7);
    await expect(appendHeartbeatRunEvent(otherDb, { ...conflicting,
      nativeSource: { ...conflicting.nativeSource, canonicalPayload: { sourceSeq: 999 } } }))
      .rejects.toThrow("native_event_replay_conflict");
    expect(await readEvents(runId)).toEqual(rows);
    expect((await readRun(runId)).nextEventSeq).toBe(41);
  });

  it("leaves no sequence or row behind when a native append fails in the middle of a stream", async () => {
    const runId = await makeRun();
    const failing = { ...nativeEvent(runId, 3), message: "force-native-event-failure" };
    await appendHeartbeatRunEvent(db, nativeEvent(runId, 1));
    await appendHeartbeatRunEvent(db, nativeEvent(runId, 2));
    await db.execute(sql`alter table heartbeat_run_events add constraint atomic_native_event_failure
      check (message is distinct from 'force-native-event-failure') not valid`);
    try {
      const before = await readRun(runId);
      await expect(appendHeartbeatRunEvent(db, failing)).rejects.toThrow();
      await expect(appendHeartbeatRunEvent(db, { ...nativeEvent(runId, 3),
        assertWritable: () => { throw new Error("writer revoked"); } })).rejects.toThrow("writer revoked");
      expect(await readRun(runId)).toEqual(before);
      expect((await readEvents(runId)).map(row => row.sourceSeq)).toEqual([1, 2]);
      // The stream continues past the failed event. Later events are stored
      // and the acknowledgement stays below the gap.
      expect((await appendHeartbeatRunEvent(db, nativeEvent(runId, 4))).highestContiguousSourceSeq).toBe(2);
      expect((await appendHeartbeatRunEvent(db, nativeEvent(runId, 5))).highestContiguousSourceSeq).toBe(2);
    } finally {
      await db.execute(sql`alter table heartbeat_run_events drop constraint atomic_native_event_failure`);
    }
    expect(await appendHeartbeatRunEvent(db, failing)).toMatchObject({ disposition: "committed", highestContiguousSourceSeq: 5 });
    expect((await readEvents(runId)).map(row => [row.seq, row.sourceSeq])).toEqual([[1, 1], [2, 2], [3, 4], [4, 5], [5, 3]]);
    expect((await readRun(runId)).nextEventSeq).toBe(6);
  });

  it("never reuses a retained sequence when history is ahead of the run cursor", async () => {
    const runId = await makeRun();
    // An older writer stored events without advancing the run's cursor.
    await db.insert(heartbeatRunEvents).values([1, 2].map(seq => ({ companyId, agentId, runId, seq, eventType: "stdout",
      message: `retained-${seq}` })));
    const retained = await readEvents(runId);
    for (const input of [nativeEvent(runId, 1), { companyId, agentId, runId, eventType: "stdout", message: "ordinary" }]) {
      const seq = await appendHeartbeatRunEvent(db, input).then(receipt => receipt.row.seq, () => null);
      const rows = await readEvents(runId);
      expect(rows.slice(0, 2)).toEqual(retained);
      expect(new Set(rows.map(row => row.seq)).size).toBe(rows.length);
      if (seq === null) expect(rows).toHaveLength(2);
      else expect(seq).toBeGreaterThan(2);
    }
  });

  it.each(["native", "retry-exhaustion"])("locks only run bindings for %s events with large run payloads", async (kind) => {
    const runId = await makeRun();
    await db.update(heartbeatRuns).set({
      contextSnapshot: { prompt: randomBytes(128 * 1024).toString("hex") },
      runnerProfileJson: { configuration: randomBytes(128 * 1024).toString("hex") },
      resultJson: { providerData: randomBytes(128 * 1024).toString("hex") },
    }).where(eq(heartbeatRuns.id, runId));
    const statements: string[] = [];
    const recorded = drizzle(db.$client, {
      schema: db._.fullSchema,
      logger: { logQuery: query => statements.push(query) },
    }) as typeof db;
    const exhaustion = { retryReason: "transient_failure", scheduledRetryAttempt: 1, maxAttempts: 1 };
    const input = {
      companyId, agentId, runId, eventType: "lifecycle",
      message: "Bounded retry exhausted after one attempt",
      ...(kind === "native" ? {
        nativeSource: { sourceInstanceId: "native-writer", sourceEventId: "event-one",
          sourceSeq: 1, protocolSchemaVersion: 1, canonicalPayload: { ordinal: 1 } },
      } : { retryExhaustion: exhaustion, payload: exhaustion }),
    };
    const committed = await appendHeartbeatRunEvent(recorded, input);
    const replay = await appendHeartbeatRunEvent(recorded, input);
    expect(committed.disposition).toBe("committed");
    expect(committed.row.seq).toBe(1);
    expect(replay.disposition).toBe("duplicate");
    expect(replay.row.id).toBe(committed.row.id);
    expect(replay.highestContiguousSourceSeq).toBe(kind === "native" ? 1 : 0);
    expect((await readRun(runId)).nextEventSeq).toBe(2);
    expect(await readEvents(runId)).toEqual([committed.row]);
    const lockReads = statements.filter(query => /^(select|with) /.test(query) &&
      query.includes('from "heartbeat_runs"') && query.includes("for no key update"));
    expect(lockReads).toHaveLength(2);
    for (const query of lockReads) {
      expect(query).toMatch(/select "company_id", "agent_id"(, \("native_source_cursors" ->> \$\d+\)::bigint as "source_cursor")?(, pg_current_xact_id\(\)::text as "xid")?(, "next_event_seq")? from "heartbeat_runs" /);
      expect(query).not.toMatch(/context_snapshot|runner_profile_json|result_json|stdout_excerpt/);
    }
  });

  it("serializes appenders without blocking child foreign key checks on the run", async () => {
    const runId = await makeRun();
    const [issue] = await db.insert(issues).values({ companyId, title: "Checkpointed task" }).returning();
    await db.update(heartbeatRuns).set({ nativeIssueId: issue!.id, runtimeMode: "native" })
      .where(eq(heartbeatRuns.id, runId));
    const native = (ordinal: number) => ({
      companyId, agentId, runId, eventType: "item.completed",
      nativeSource: { sourceInstanceId: "native-writer", sourceEventId: `held-${ordinal}`,
        sourceSeq: ordinal, protocolSchemaVersion: 1, canonicalPayload: { ordinal } },
    });
    let releaseHolder!: () => void;
    const held = new Promise<void>(resolve => { releaseHolder = resolve; });
    let holderLocked!: () => void;
    const locked = new Promise<void>(resolve => { holderLocked = resolve; });
    // An append whose transaction is still open holds the run lock, as an
    // event append does while its remaining statements run.
    const holder = otherDb.transaction(async tx => {
      await appendHeartbeatRunEvent(tx as unknown as typeof db, native(1));
      holderLocked();
      await held;
    });
    void holder.catch(() => undefined);
    await locked;
    let secondSettled = false;
    const second = appendHeartbeatRunEvent(db, native(2)).finally(() => { secondSettled = true; });
    void second.catch(() => undefined);
    try {
      // A controller checkpoint row references the run row by foreign key.
      // Its insert must not wait for the open append.
      await db.transaction(async tx => {
        await tx.execute(sql`set local lock_timeout = '2s'`);
        await tx.insert(nativeRunnerCheckpoints).values({ companyId, issueId: issue!.id, runId,
          part: "event:1", material: { fixture: true } });
      });
      // Another appender still waits for the open append.
      await new Promise(resolve => setTimeout(resolve, 200));
      expect(secondSettled).toBe(false);
    } finally {
      releaseHolder();
      await holder;
    }
    expect((await second).row.seq).toBe(2);
    expect((await readEvents(runId)).map(row => [row.seq, row.sourceSeq])).toEqual([[1, 1], [2, 2]]);
    expect((await readRun(runId)).nextEventSeq).toBe(3);
    expect(await db.select({ part: nativeRunnerCheckpoints.part }).from(nativeRunnerCheckpoints)
      .where(eq(nativeRunnerCheckpoints.runId, runId))).toEqual([{ part: "event:1" }]);
    await db.delete(nativeRunnerCheckpoints).where(eq(nativeRunnerCheckpoints.runId, runId));
  });

  it("rejects mismatched authority without changing either run", async () => {
    const runId = await makeRun();
    const otherRunId = "30000000-0000-4000-8000-000000000099";
    await db.insert(heartbeatRuns).values({ id: otherRunId, companyId: otherCompanyId,
      agentId: otherAgentId, status: "running" });
    const before = [await readRun(runId), await readRun(otherRunId)];
    for (const authority of [
      { companyId: otherCompanyId, agentId, runId },
      { companyId, agentId: otherAgentId, runId },
      { companyId, agentId, runId: otherRunId },
      { companyId, agentId, runId: "30000000-0000-4000-8000-000000000098" },
    ]) {
      for (const source of [
        {},
        { nativeSource: { sourceInstanceId: "native-writer", sourceEventId: "mismatched-event",
          sourceSeq: 1, protocolSchemaVersion: 1, canonicalPayload: { ordinal: 1 } } },
        { retryExhaustion: { retryReason: "transient_failure", scheduledRetryAttempt: 1, maxAttempts: 1 } },
      ]) {
        await expect(appendHeartbeatRunEvent(db, { ...authority, ...source, eventType: "stdout" }))
          .rejects.toThrow("heartbeat_run_event_binding_mismatch");
      }
    }
    expect([await readRun(runId), await readRun(otherRunId)]).toEqual(before);
    expect(await readEvents(runId)).toEqual([]);
    expect(await readEvents(otherRunId)).toEqual([]);
  });

  it("rolls back allocation on insertion failure and in an outer transaction", async () => {
    const runId = await makeRun();
    const before = await readRun(runId);
    await db.execute(sql`alter table heartbeat_run_events add constraint atomic_event_failure
      check (message is distinct from 'force-event-failure') not valid`);
    try {
      await expect(appendHeartbeatRunEvent(db, {
        companyId, agentId, runId, eventType: "stdout", message: "force-event-failure",
      })).rejects.toThrow();
      expect(await readRun(runId)).toEqual(before);
      expect(await readEvents(runId)).toEqual([]);
    } finally {
      await db.execute(sql`alter table heartbeat_run_events drop constraint atomic_event_failure`);
    }
    await expect(db.transaction(async tx => {
      await appendHeartbeatRunEvent(tx as unknown as typeof db, {
        companyId, agentId, runId, eventType: "stdout",
      });
      throw new Error("outer rollback");
    })).rejects.toThrow("outer rollback");
    expect(await readRun(runId)).toEqual(before);
    expect(await readEvents(runId)).toEqual([]);
    const receipt = await appendHeartbeatRunEvent(db, { companyId, agentId, runId, eventType: "stdout" });
    expect(receipt.row.seq).toBe(1);
    expect(receipt.row.payload).toBeNull();
  });
});
