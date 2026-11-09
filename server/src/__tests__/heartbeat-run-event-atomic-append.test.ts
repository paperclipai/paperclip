import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { agents, companies, createDb, heartbeatRunEvents, heartbeatRuns } from "@paperclipai/db";
import { appendHeartbeatRunEvent } from "../services/heartbeat-run-events.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("atomic ordinary run events", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
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
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-atomic-events-");
    db = createDb(temporary.connectionString);
    otherDb = createDb(temporary.connectionString);
    await db.insert(companies).values([
      { id: companyId, name: "Atomic events", issuePrefix: "ATM" },
      { id: otherCompanyId, name: "Other events", issuePrefix: "OTH" },
    ]);
    await db.insert(agents).values([
      { id: agentId, companyId, name: "Event agent" },
      { id: otherAgentId, companyId: otherCompanyId, name: "Other agent" },
    ]);
  }, 60_000);
  afterAll(async () => { await temporary?.cleanup(); });

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
      await expect(appendHeartbeatRunEvent(db, { ...authority, eventType: "stdout" }))
        .rejects.toThrow("heartbeat_run_event_binding_mismatch");
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
