import { randomUUID } from "node:crypto";
import { compileFunction } from "node:vm";
import { eq, sql } from "drizzle-orm";
import { pgTable, text } from "drizzle-orm/pg-core";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb, withDedicatedDbConnection } from "./client.js";
import { createDatabaseResponseCapture, databaseResponseCaptureFromEnv, installDatabaseResponseCapture, withDatabaseOperation } from "./response-capture.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";
import { runEventPayload } from "./run-event-payload.js";
import { databaseWorkPending, reconcileDatabaseWork, signalDatabaseWork, subscribeDatabaseWork } from "./work-signals.js";

const table = pgTable("response_capture_fixture", { id: text("id").primaryKey(), payload: text("payload").notNull() });
const encodedTable = pgTable("response_capture_encoded_fixture", { id: text("id").primaryKey(), payload: runEventPayload("payload") });
const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("database response capture PostgreSQL behavior", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  const clients: Array<ReturnType<typeof createDb>> = [];
  const captures: Array<ReturnType<typeof createDatabaseResponseCapture>> = [];
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("response-capture-");
    const db = createDb(temporary.connectionString);
    try {
      await db.execute(sql`create table response_capture_fixture (id text primary key, payload text not null)`);
      await db.execute(sql`create table response_capture_encoded_fixture (id text primary key, payload jsonb not null)`);
    }
    finally { await db.$client.end(); }
  }, 90_000);
  afterEach(async () => {
    for (const capture of captures.splice(0)) capture.flush();
    for (const client of clients.splice(0)) await client.$client.end();
    vi.restoreAllMocks(); vi.unstubAllEnvs();
  });
  afterAll(async () => { await temporary?.cleanup(); });
  function fixture(prepare?: boolean, maxConnections?: number, clock?: () => number) {
    const events: Array<Record<string, unknown>> = [];
    const now = Date.now();
    const capture = createDatabaseResponseCapture({ start: now - 100, end: now + 59_000 }, event => events.push(event), clock);
    const db = createDb(temporary.connectionString, { prepare, maxConnections });
    clients.push(db); captures.push(capture);
    expect(installDatabaseResponseCapture(db, { table, encodedTable }, capture)).toBe(db);
    expect(installDatabaseResponseCapture(db, { table, encodedTable }, capture)).toBe(db);
    return { db, capture, events };
  }
  function summary(events: Array<Record<string, unknown>>) { return events.find(event => event.event === "paperclip.db_response_capture.summary.v2")!; }

  it("retains capture counts when ORM preparation is enabled", async () => {
    const f = fixture(true), id = randomUUID(), payload = "prepared-capture-value";
    await f.db.insert(table).values({ id, payload });
    await f.db.transaction(async tx => {
      expect(await tx.select().from(table).where(eq(table.id, id))).toEqual([{ id, payload }]);
    });
    f.capture.flush();
    expect(summary(f.events)).toMatchObject({ startedQueries: 2, completedQueries: 2 });
    expect(JSON.stringify(f.events)).not.toContain(payload);
    expect(JSON.stringify(f.events)).not.toContain(id);
  });

  it("keeps rows and builder identity through lazy select and write returning", async () => {
    const f = fixture(), id = randomUUID(), payload = "sentinel-result-and-parameter-value🙂\n\"";
    const insert = f.db.insert(table).values({ id, payload });
    expect(insert.returning()).toBe(insert);
    expect(await insert).toEqual([{ id, payload }]);
    const query = f.db.select().from(table);
    expect(query.where(eq(table.id, id))).toBe(query);
    expect(await query).toEqual([{ id, payload }]);
    const updated = await f.db.update(table).set({ payload: "changed" }).where(eq(table.id, id)).returning();
    expect(updated).toEqual([{ id, payload: "changed" }]);
    expect(await f.db.delete(table).where(eq(table.id, id)).returning()).toEqual([{ id, payload: "changed" }]);
    f.capture.flush();
    expect(summary(f.events)).toMatchObject({ startedQueries: 4, completedQueries: 4 });
    expect(f.events.filter(event => event.event === "paperclip.db_response_capture.entry.v2").map(event => event.operation).sort())
      .toEqual(["delete", "insert", "select", "update"]);
    expect(JSON.stringify(f.events)).not.toContain(payload);
    expect(JSON.stringify(f.events)).not.toContain(id);
  });
  it("skips complex stored values before a custom column decoder changes them", async () => {
    const setup = createDb(temporary.connectionString); clients.push(setup);
    const id = randomUUID(), payload = { text: "codec-payload-sentinel\u0000value".repeat(512) };
    await setup.insert(encodedTable).values({ id, payload });
    const f = fixture();
    expect(await f.db.select().from(encodedTable).where(eq(encodedTable.id, id))).toEqual([{ id, payload }]);
    f.capture.flush();
    const entry = f.events.find(event => event.table === "response_capture_encoded_fixture")!;
    expect(entry).toMatchObject({ sampledValueBytes: Buffer.byteLength(id), measuredValues: 1, unmeasuredValues: 1, incompleteSamples: 1 });
    expect(JSON.stringify(f.events)).not.toContain("codec-payload-sentinel");
  });
  it("keeps a raw driver query lazy and counts repeated awaits without replay", async () => {
    const f = fixture(), id = randomUUID();
    const observer = createDb(temporary.connectionString); clients.push(observer);
    const pending = f.db.$client.unsafe("insert into response_capture_fixture (id, payload) values ($1, $2) returning id", [id, "raw-lazy-sentinel"]);
    expect(await observer.select().from(table).where(eq(table.id, id))).toEqual([]);
    const first = await pending;
    expect(await pending).toBe(first);
    expect(first).toEqual([{ id }]);
    expect(await observer.select().from(table).where(eq(table.id, id))).toEqual([{ id, payload: "raw-lazy-sentinel" }]);
    f.capture.flush();
    expect(summary(f.events)).toMatchObject({ startedQueries: 1, completedQueries: 1 });
    expect(JSON.stringify(f.events)).not.toContain("raw-lazy-sentinel");
    expect(JSON.stringify(f.events)).not.toContain(id);
  });
  it("counts prepared executions once and retains their parameter bindings", async () => {
    const f = fixture(), id = randomUUID();
    await f.db.insert(table).values({ id, payload: "prepared-value" });
    const prepared = f.db.select().from(table).where(eq(table.id, sql.placeholder("id"))).prepare("response_capture_prepared");
    expect(await prepared.execute({ id })).toEqual([{ id, payload: "prepared-value" }]);
    expect(await prepared.execute({ id: randomUUID() })).toEqual([]);
    f.capture.flush();
    expect(summary(f.events)).toMatchObject({ startedQueries: 3, completedQueries: 3 });
    expect(JSON.stringify(f.events)).not.toContain("prepared-value");
  });
  it("attributes concurrent prepared reuse, pooled queries, and transaction errors to their execution owners", async () => {
    const setup = createDb(temporary.connectionString); clients.push(setup);
    const id = randomUUID();
    await setup.insert(table).values({ id, payload: "owner-private-value" });
    const f = fixture(true, 1);
    const prepared = withDatabaseOperation("builder.only", () =>
      f.db.select().from(table).where(eq(table.id, sql.placeholder("id"))).prepare("owner_reused"));
    await Promise.all([
      withDatabaseOperation("response.presentation", async () => {
        expect(await prepared.execute({ id })).toEqual([{ id, payload: "owner-private-value" }]);
        await f.db.transaction(async tx => {
          expect(await tx.select().from(table).where(eq(table.id, id))).toEqual([{ id, payload: "owner-private-value" }]);
        });
      }),
      withDatabaseOperation("budget.admission", async () => {
        expect(await prepared.execute({ id })).toEqual([{ id, payload: "owner-private-value" }]);
        await expect(f.db.execute(sql`select 1/0`)).rejects.toThrow();
      }),
    ]);
    f.capture.flush();
    const entries = f.events.filter(event => event.event === "paperclip.db_response_capture.entry.v2");
    const counts = (owner: string) => entries.filter(event => event.owner === owner).reduce((n, event) => n + Number(event.calls), 0);
    expect(counts("response.presentation")).toBe(2);
    expect(counts("budget.admission")).toBe(2);
    expect(counts("builder.only")).toBe(0);
    expect(entries.every(event => (event.callers as string[]).length === 0)).toBe(true);
    expect(entries.find(event => event.queryErrors === 1)).toMatchObject({ owner: "budget.admission", rows: 0, sampledResults: 0 });
    expect(summary(f.events)).toMatchObject({ startedQueries: 4, completedQueries: 4, rows: 3 });
    expect(JSON.stringify(f.events)).not.toContain("owner-private-value");
  });
  it("attributes a lazy raw query to its first consumer rather than its builder or repeated await", async () => {
    const f = fixture();
    const query = withDatabaseOperation("builder.only", () => f.db.$client.unsafe("select 42 as answer"));
    const result = await withDatabaseOperation("consumer.first", async () => await query);
    expect(result).toEqual([{ answer: 42 }]);
    expect(await withDatabaseOperation("consumer.again", async () => await query)).toBe(result);
    f.capture.flush();
    expect(f.events[0]).toMatchObject({ owner: "consumer.first", calls: 1, rows: 1 });
    expect(summary(f.events)).toMatchObject({ startedQueries: 1, completedQueries: 1 });
  });
  it("samples bounded driver values while retaining every query and row", async () => {
    const f = fixture();
    await withDatabaseOperation("sampling.owner", async () => {
      for (let index = 0; index < 33; index += 1) {
        expect(await f.db.execute(sql`select 42 as answer`)).toEqual([{ answer: 42 }]);
      }
    });
    f.capture.flush();
    expect(f.events[0]).toMatchObject({ owner: "sampling.owner", calls: 33, rows: 33, sampledResults: 3,
      sampledRows: 3, sampledValueBytes: 6, measuredValues: 3, unmeasuredValues: 0 });
    expect(summary(f.events)).toMatchObject({ completedQueries: 33, rows: 33, sampledResults: 3, sampledValueBytes: 6 });
  });
  it("leaves a real in-flight query running when the capture deadline passes", async () => {
    let clock = Date.now();
    const f = fixture(undefined, 1, () => clock);
    const pending = withDatabaseOperation("ending.owner", async () => await f.db.execute(sql`select pg_sleep(0.05), 42 as answer`));
    await new Promise<void>(resolve => setImmediate(resolve));
    clock += 60_000;
    f.capture.flush();
    expect(summary(f.events)).toMatchObject({ startedQueries: 1, completedQueries: 0, inFlightAtEnd: 1 });
    expect((await pending)[0].answer).toBe(42);
    expect(f.events).toHaveLength(1);
  });
  it("retains distinct builder callers through normal, prepared, and transaction execution", async () => {
    const f = fixture(), id = randomUUID();
    const setup = createDb(temporary.connectionString); clients.push(setup);
    await setup.insert(table).values({ id, payload: "caller-sentinel" });
    const shape = f.db.select().from(table);
    const caller = (name: string) => compileFunction(
      "return db.select().from(table).where(eq(table.id, id))", ["db", "id"],
      { filename: `/fixture/server/src/services/${name}.ts`, contextExtensions: [{ table, eq }] },
    ) as (db: Pick<typeof f.db, "select">, id: string) => typeof shape;
    const fromA = caller("capture-caller-a"), fromB = caller("capture-caller-b");
    const normalA = fromA(f.db, id), normalB = fromB(f.db, id);
    expect(await normalA).toEqual([{ id, payload: "caller-sentinel" }]);
    expect(await normalB).toEqual([{ id, payload: "caller-sentinel" }]);
    const prepared = fromA(f.db, id).prepare("capture_caller_prepared");
    expect(await prepared.execute()).toEqual([{ id, payload: "caller-sentinel" }]);
    await f.db.transaction(async tx => {
      expect(await fromB(tx, id)).toEqual([{ id, payload: "caller-sentinel" }]);
    });
    f.capture.flush();
    const entries = f.events.filter(event => event.event === "paperclip.db_response_capture.entry.v2");
    expect(entries).toHaveLength(2);
    for (const name of ["a", "b"]) {
      expect(entries.find(event => (event.callers as string[]).some(location => location.startsWith(`services/capture-caller-${name}.ts:`))))
        .toMatchObject({ operation: "select", table: "response_capture_fixture", calls: 2, rows: 2 });
    }
    expect(summary(f.events)).toMatchObject({ startedQueries: 4, completedQueries: 4 });
    expect(JSON.stringify(f.events)).not.toContain("/fixture/");
    expect(JSON.stringify(f.events)).not.toContain("caller-sentinel");
    expect(JSON.stringify(f.events)).not.toContain(id);
  });
  it("records the executed CTE rather than its unexecuted inner select", async () => {
    const f = fixture(), id = randomUUID();
    await f.db.insert(table).values({ id, payload: "cte-value" });
    const cte = f.db.$with("capture_cte").as(f.db.select().from(table).where(eq(table.id, id)));
    expect(await f.db.with(cte).select().from(cte)).toEqual([{ id, payload: "cte-value" }]);
    f.capture.flush();
    expect(summary(f.events)).toMatchObject({ startedQueries: 2, completedQueries: 2 });
  });
  it("keeps raw execute results and rejection behavior without logging SQL or errors", async () => {
    const f = fixture();
    expect(await f.db.execute(sql`select ${"sentinel-sql-parameter"}::text as value`)).toEqual([{ value: "sentinel-sql-parameter" }]);
    await expect(f.db.execute(sql`select 1/0`)).rejects.toThrow();
    f.capture.flush();
    expect(summary(f.events)).toMatchObject({ startedQueries: 2, completedQueries: 2 });
    expect(f.events.find(event => event.operation === "execute")).toMatchObject({ queryErrors: 1 });
    expect(JSON.stringify(f.events)).not.toContain("sentinel-sql-parameter");
    expect(JSON.stringify(f.events)).not.toContain("select 1/0");
  });
  it("preserves nested commit, rollback, and durable work-signal boundaries", async () => {
    const f = fixture(), id = randomUUID(), events: string[] = [];
    const unsubscribe = subscribeDatabaseWork(f.db, "capture-topic", event => events.push(event));
    try {
      expect(await f.db.transaction(async tx => {
        await tx.transaction(async nested => {
          await signalDatabaseWork(nested, "capture-topic");
          await nested.insert(table).values({ id, payload: "committed" });
        });
        expect(events).toEqual(["intent"]); expect(databaseWorkPending(f.db, "capture-topic")).toBe(true);
        return 42;
      })).toBe(42);
      expect(events).toEqual(["intent", "settled"]);
      expect(databaseWorkPending(f.db, "capture-topic")).toBe(false);
      const rolledBack = randomUUID();
      await expect(f.db.transaction(async tx => {
        await signalDatabaseWork(tx, "capture-topic");
        await tx.insert(table).values({ id: rolledBack, payload: "rolled-back" });
        throw new Error("rollback fixture");
      })).rejects.toThrow("rollback fixture");
      await reconcileDatabaseWork(f.db, "capture-topic");
      expect(databaseWorkPending(f.db, "capture-topic")).toBe(false);
      expect(await f.db.select().from(table).where(eq(table.id, rolledBack))).toEqual([]);
      expect(await f.db.select().from(table).where(eq(table.id, id))).toEqual([{ id, payload: "committed" }]);
    } finally { unsubscribe(); }
    f.capture.flush();
    expect(summary(f.events).completedQueries).toBeGreaterThan(4);
  });
  it.each([undefined, true])("covers automatically created dedicated pools with prepare %s and retains owner identity", async prepare => {
    const logs: string[] = [], now = Date.now();
    vi.spyOn(console, "info").mockImplementation(value => logs.push(String(value)));
    vi.stubEnv("PAPERCLIP_DB_RESPONSE_CAPTURE_WINDOW", `${new Date(now - 100).toISOString()}/${new Date(now + 59_000).toISOString()}`);
    const db = createDb(temporary.connectionString, { prepare }); clients.push(db);
    const capture = databaseResponseCaptureFromEnv()!; captures.push(capture);
    expect(await withDatabaseOperation("dedicated.owner", () => withDedicatedDbConnection(db, async dedicated => dedicated.execute(sql`select ${"dedicated-value"}::text as value`))))
      .toEqual([{ value: "dedicated-value" }]);
    capture.flush();
    await vi.waitFor(() => expect(logs.some(line => JSON.parse(line).event === "paperclip.db_response_capture.summary.v2")).toBe(true),
      { timeout: 1_000, interval: 5 });
    const events = logs.map(line => JSON.parse(line) as Record<string, unknown>);
    expect(summary(events)).toMatchObject({ startedQueries: 1, completedQueries: 1 });
    expect(events.find(event => event.event === "paperclip.db_response_capture.entry.v2")).toMatchObject({ owner: "dedicated.owner" });
    expect(logs.join("\n")).not.toContain("dedicated-value");
    expect(logs.join("\n")).not.toContain(temporary.connectionString);
  });
});
