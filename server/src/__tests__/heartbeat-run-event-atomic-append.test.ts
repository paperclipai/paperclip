import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { agents, companies, createDb, heartbeatRunEvents, heartbeatRuns, issues, nativeRunnerCheckpoints } from "@paperclipai/db";
import { appendHeartbeatRunEvent } from "../services/heartbeat-run-events.js";
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

  it("appends a native source event with one lock read and one write statement", async () => {
    const runId = await makeRun();
    const first = await sentStatements(db.$client, () => appendHeartbeatRunEvent(db, nativeEvent(runId, 1)));
    // BEGIN, the run lock, the append, COMMIT. The lock is a statement of its
    // own so that the append reads a snapshot taken after the lock was granted.
    expect(first.statements).toHaveLength(4);
    expect(first.statements[0]).toMatch(/^begin/i);
    expect(first.statements[1]).toMatch(/^select "company_id", "agent_id" from "heartbeat_runs" .* for no key update$/);
    expect(first.statements[2]).toMatch(/^with existing as .* insert into heartbeat_run_events /);
    expect(first.statements[3]).toMatch(/^commit/i);
    expect(first.result).toMatchObject({ disposition: "committed", highestContiguousSourceSeq: 1 });
    expect(first.result.row.createdAt).toBeInstanceOf(Date);
    expect(await readEvents(runId)).toEqual([first.result.row]);

    const replay = await sentStatements(db.$client, () => appendHeartbeatRunEvent(db, nativeEvent(runId, 1)));
    expect(replay.statements).toHaveLength(4);
    expect(replay.result).toEqual({ row: first.result.row, disposition: "duplicate", highestContiguousSourceSeq: 1 });
    expect((await readRun(runId)).nextEventSeq).toBe(2);

    // A caller's transaction adds only its SAVEPOINT; a writer check adds nothing.
    const nested = await sentStatements(db.$client, () => db.transaction(tx =>
      appendHeartbeatRunEvent(tx as unknown as typeof db, nativeEvent(runId, 2))));
    expect(nested.statements).toHaveLength(5);
    let checks = 0;
    const checked = await sentStatements(db.$client, () => appendHeartbeatRunEvent(db, {
      ...nativeEvent(runId, 3), assertWritable: () => { checks += 1; },
    }));
    expect(checked.statements).toHaveLength(4);
    expect(checks).toBe(2);
    expect(checked.result).toMatchObject({ disposition: "committed", highestContiguousSourceSeq: 3 });
    expect((await readEvents(runId)).map(row => [row.seq, row.sourceSeq])).toEqual([[1, 1], [2, 2], [3, 3]]);
  });

  it("registers a native event's wakes before its write and only when the event is new", async () => {
    const runId = await makeRun();
    const [issue] = await db.insert(issues).values({ companyId, title: "Progress task" }).returning();
    await db.update(heartbeatRuns).set({ nativeIssueId: issue!.id, runtimeMode: "native" }).where(eq(heartbeatRuns.id, runId));
    const first = await sentStatements(db.$client, () => appendHeartbeatRunEvent(db, nativeEvent(runId, 1, "item.completed")));
    // BEGIN, lock, duplicate probe, the wake's transaction id, the append, COMMIT.
    expect(first.statements).toHaveLength(6);
    const wake = first.statements.findIndex(text => text.includes("pg_current_xact_id"));
    expect(wake).toBeGreaterThan(0);
    expect(wake).toBeLessThan(first.statements.findIndex(text => text.includes("insert into heartbeat_run_events")));
    expect(first.result).toMatchObject({ disposition: "committed", highestContiguousSourceSeq: 1 });
    const replay = await sentStatements(db.$client, () => appendHeartbeatRunEvent(db, nativeEvent(runId, 1, "item.completed")));
    expect(replay.statements.some(text => text.includes("pg_current_xact_id"))).toBe(false);
    expect(replay.result).toEqual({ row: first.result.row, disposition: "duplicate", highestContiguousSourceSeq: 1 });
    expect(await readEvents(runId)).toEqual([first.result.row]);
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
      // A writer revoked while its append ran rolls the append back before the commit.
      let checks = 0;
      await expect(appendHeartbeatRunEvent(db, { ...nativeEvent(runId, 3),
        assertWritable: () => { if (++checks === 2) throw new Error("writer revoked"); } })).rejects.toThrow("writer revoked");
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
    const lockReads = statements.filter(query => query.startsWith("select ") &&
      query.includes('from "heartbeat_runs"') && query.endsWith("for no key update"));
    expect(lockReads).toHaveLength(2);
    for (const query of lockReads) {
      expect(query).toMatch(/^select "company_id", "agent_id" from "heartbeat_runs" /);
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
    await locked;
    let secondSettled = false;
    const second = appendHeartbeatRunEvent(db, native(2)).finally(() => { secondSettled = true; });
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
