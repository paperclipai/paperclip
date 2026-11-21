import { eq, sql } from "drizzle-orm";
import postgres from "postgres";
import { integer, jsonb, pgTable, text } from "drizzle-orm/pg-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closeLivenessDb, createDb, databaseClientOptionsFromEnv, livenessDb, preparedStatementStats, withDedicatedDbConnection, type DatabaseClientOptions, type Db } from "./client.js";
import { createPreparedQueryState, installPreparedQueries, preparedQueryStats } from "./prepared-queries.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";
import { runEventPayload } from "./run-event-payload.js";

const records = pgTable("prepared_query_fixture", { id: text("id").primaryKey(), companyId: text("company_id").notNull(), value: integer("value").notNull(), payload: jsonb("payload") });
const stale = pgTable("prepared_stale_fixture", { id: text("id").primaryKey(), value: integer("value").notNull() });
const encoded = pgTable("prepared_encoded_fixture", { id: text("id").primaryKey(), payload: runEventPayload("payload") });
const support = await getEmbeddedPostgresTestSupport();

describe.skipIf(!support.supported)("explicit ORM prepared statements on PostgreSQL", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let setup: Db;
  const clients: Db[] = [];
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("prepared-orm-");
    setup = createDb(temporary.connectionString, { prepare: false, maxConnections: 1 });
    await setup.execute(sql`create table prepared_query_fixture(id text primary key, company_id text not null, value integer not null, payload jsonb)`);
    await setup.execute(sql`create table prepared_encoded_fixture(id text primary key, payload jsonb)`);
    await setup.execute(sql`create table prepared_schema_change_fixture(id text primary key)`);
    await setup.execute(sql`create table prepared_stale_fixture(id text primary key, value integer not null)`);
    await setup.execute(sql`insert into prepared_stale_fixture(id, value) values ('stale', 5)`);
    await setup.execute(sql`insert into prepared_schema_change_fixture(id) values ('retained')`);
  }, 90_000);
  beforeEach(async () => {
    await setup.execute(sql`truncate prepared_query_fixture, prepared_encoded_fixture`);
    await setup.insert(records).values([
      { id: "a", companyId: "company-a", value: 1, payload: { owner: "a" } },
      { id: "b", companyId: "company-b", value: 2, payload: { owner: "b" } },
    ]);
  });
  afterEach(async () => {
    for (const db of clients.splice(0)) {
      await closeLivenessDb(db, 2);
      await db.$client.end();
    }
  });
  afterAll(async () => { await setup?.$client.end(); await temporary?.cleanup(); });
  function fixture(options: DatabaseClientOptions = {}) {
    const db = createDb(temporary.connectionString, { ...options, maxConnections: 1 });
    clients.push(db); return db;
  }
  async function statements(db: Db, pattern = '%"prepared_query_fixture"%') {
    return db.$client.unsafe("select name,statement from pg_prepared_statements where statement like $1", [pattern]);
  }

  it.each([undefined, false])("keeps the existing ORM mode when prepare is %s", async prepare => {
    const db = fixture({ prepare });
    expect(await db.select().from(records).where(eq(records.companyId, "company-a"))).toEqual([
      { id: "a", companyId: "company-a", value: 1, payload: { owner: "a" } },
    ]);
    expect(await statements(db)).toHaveLength(0);
  });

  it("honors the explicit environment opt-in for ORM queries with fresh company bindings", async () => {
    const db = fixture(databaseClientOptionsFromEnv({ DATABASE_PREPARED_STATEMENTS: "true" }));
    for (let i = 0; i < 12; i++) {
      const companyId = i % 2 ? "company-b" : "company-a";
      const rows = await db.select().from(records).where(eq(records.companyId, companyId));
      expect(rows).toEqual([{ id: i % 2 ? "b" : "a", companyId, value: i % 2 ? 2 : 1, payload: { owner: i % 2 ? "b" : "a" } }]);
    }
    expect(await statements(db)).toHaveLength(1);
  });

  it("preserves explicit per-query opt-out", async () => {
    const db = fixture({ prepare: true });
    expect((await db.$client.unsafe("select $1::integer as explicit_opt_out_marker", [7], { prepare: false }))[0].explicit_opt_out_marker).toBe(7);
    expect(await statements(db, "%explicit_opt_out_marker%")).toHaveLength(0);
  });

  it("preserves simple queries and the two-argument options overload", async () => {
    const db = fixture({ prepare: true });
    const simpleOptions = { prepare: true, simple: true };
    const simple = await db.$client.unsafe("select 1 as first; select 2 as second", [], simpleOptions);
    expect(simple).toEqual([[{ first: 1 }], [{ second: 2 }]]);
    const unsafe = db.$client.unsafe as unknown as (query: string, options: { simple: boolean }) => Promise<unknown>;
    expect(await unsafe("select 3 as third; select 4 as fourth", { simple: true }))
      .toEqual([[{ third: 3 }], [{ fourth: 4 }]]);
  });

  it("does not replay a rejected prepared write", async () => {
    const db = fixture({ prepare: true });
    await expect(db.insert(records).values({ id: "a", companyId: "company-b", value: 9 }))
      .rejects.toMatchObject({ cause: { code: "23505" } });
    expect(await db.select({ companyId: records.companyId, value: records.value }).from(records).where(eq(records.id, "a")))
      .toEqual([{ companyId: "company-a", value: 1 }]);
  });

  it("keeps write queries lazy and repeated awaits from repeating writes", async () => {
    const db = fixture({ prepare: true });
    const pending = db.$client.unsafe("insert into prepared_query_fixture(id,company_id,value) values ($1,$2,$3) returning id", ["lazy", "company-a", 3]);
    expect(typeof pending.values).toBe("function");
    expect(await setup.select().from(records).where(eq(records.id, "lazy"))).toEqual([]);
    expect(await pending).toEqual([{ id: "lazy" }]);
    expect(await pending).toEqual([{ id: "lazy" }]);
    expect(await setup.select({ id: records.id }).from(records).where(eq(records.id, "lazy"))).toEqual([{ id: "lazy" }]);
    expect(await statements(db, "%insert into prepared_query_fixture%")).toHaveLength(1);
  });

  it("preserves transaction commits, nested savepoint rollback, and scoped reads", async () => {
    const db = fixture({ prepare: true });
    await db.transaction(async tx => {
      expect(await tx.select({ value: records.value }).from(records).where(eq(records.companyId, "company-a"))).toEqual([{ value: 1 }]);
      await expect(tx.transaction(async nested => {
        await nested.update(records).set({ value: 99 }).where(eq(records.companyId, "company-a"));
        throw new Error("rollback savepoint");
      })).rejects.toThrow("rollback savepoint");
      expect(await tx.select({ value: records.value }).from(records).where(eq(records.companyId, "company-a"))).toEqual([{ value: 1 }]);
      await tx.insert(records).values({ id: "committed", companyId: "company-b", value: 3 });
      const names = await tx.execute(sql`select statement from pg_prepared_statements`);
      expect(names.some(row => String(row.statement).includes('"prepared_query_fixture"'))).toBe(true);
    }, { isolationLevel: "serializable" });
    expect(await db.select({ value: records.value }).from(records).where(eq(records.id, "committed"))).toEqual([{ value: 3 }]);
  });

  it("rolls back failed outer transactions without replay", async () => {
    const db = fixture({ prepare: true });
    await expect(db.transaction(async tx => {
      await tx.update(records).set({ value: 42 }).where(eq(records.id, "a"));
      throw new Error("rollback outer transaction");
    })).rejects.toThrow("rollback outer transaction");
    expect(await db.select({ value: records.value }).from(records).where(eq(records.id, "a"))).toEqual([{ value: 1 }]);
  });

  it("prepares reserved-client queries and keeps their bound values fresh", async () => {
    const db = fixture({ prepare: true });
    const reserved = await db.$client.reserve();
    try {
      for (const marker of [1, 2, 3]) {
        expect((await reserved.unsafe("select $1::integer as reserved_prepared_marker", [marker]))[0].reserved_prepared_marker).toBe(marker);
      }
      const names = await reserved.unsafe("select statement from pg_prepared_statements where statement like $1", ["%reserved_prepared_marker%"]);
      expect(names).toHaveLength(1);
    } finally { reserved.release(); }
  });

  it("preserves object and array results for the same prepared shape", async () => {
    const db = fixture({ prepare: true });
    expect(await db.$client.unsafe("select $1::integer as result_mode_marker", [41]).values()).toEqual([[41]]);
    expect(await db.$client.unsafe("select $1::integer as result_mode_marker", [42])).toEqual([{ result_mode_marker: 42 }]);
  });

  it("keeps custom stored-payload decoding fresh", async () => {
    const db = fixture({ prepare: true });
    const first = { text: "encoded first payload🙂".repeat(2048) };
    const second = { text: "encoded second payload🙂".repeat(2048) };
    await setup.insert(encoded).values({ id: "encoded", payload: first });
    expect((await db.select().from(encoded).where(eq(encoded.id, "encoded")))[0].payload).toEqual(first);
    await setup.update(encoded).set({ payload: second }).where(eq(encoded.id, "encoded"));
    expect((await db.select().from(encoded).where(eq(encoded.id, "encoded")))[0].payload).toEqual(second);
    expect(await statements(db, '%"prepared_encoded_fixture"%')).toHaveLength(1);
  });

  it("inherits the opt-in in dedicated and liveness clients", async () => {
    const db = fixture({ prepare: true });
    await withDedicatedDbConnection(db, async dedicated => {
      expect(await dedicated.select({ value: records.value }).from(records).where(eq(records.companyId, "company-b"))).toEqual([{ value: 2 }]);
      expect(await statements(dedicated)).toHaveLength(1);
    });
    const live = livenessDb(db);
    expect(await live.select({ value: records.value }).from(records).where(eq(records.companyId, "company-a"))).toEqual([{ value: 1 }]);
    expect(await statements(live)).toHaveLength(1);
  });

  it("refreshes prepared result metadata after a schema change", async () => {
    const db = fixture({ prepare: true });
    const query = "select * from prepared_schema_change_fixture where id=$1";
    expect(await db.$client.unsafe(query, ["retained"])).toEqual([{ id: "retained" }]);
    try {
      await setup.execute(sql`alter table prepared_schema_change_fixture add column extra text`);
      expect(await db.$client.unsafe(query, ["retained"])).toEqual([{ id: "retained", extra: null }]);
    } finally {
      await setup.execute(sql`alter table prepared_schema_change_fixture drop column if exists extra`);
    }
  });

  async function changeStaleValueType(type: "bigint" | "integer") {
    await setup.execute(sql.raw(`alter table prepared_stale_fixture alter column value type ${type}`));
  }

  it("restarts a transaction whose first statement meets an invalidated plan without running the callback again", async () => {
    const db = fixture({ prepare: true });
    let calls = 0;
    const read = () => db.transaction(tx => { calls++; return tx.select().from(stale).where(eq(stale.id, "stale")); });
    expect(await read()).toEqual([{ id: "stale", value: 5 }]);
    await changeStaleValueType("bigint");
    try {
      expect(await read()).toEqual([{ id: "stale", value: 5 }]);
      expect(calls).toBe(2);
      expect(preparedStatementStats(db)).toMatchObject({ restartedTransactions: 1, demoted: 1 });
    } finally {
      await changeStaleValueType("integer");
    }
  });

  it("restarts a transaction whose first statement lost its prepared statement and keeps its later work", async () => {
    const db = fixture({ prepare: true });
    const run = (value: number) => db.transaction(async tx => {
      const [row] = await tx.select({ value: records.value }).from(records).where(eq(records.id, "a"));
      await tx.execute(sql`update prepared_query_fixture set value = ${value} where id = ${"b"} ${sql.raw(`/* run ${value} */`)}`);
      return row;
    });
    expect(await run(3)).toEqual({ value: 1 });
    const [{ name }] = await statements(db, 'select "value" from "prepared_query_fixture"%');
    await db.$client.unsafe(`deallocate "${String(name)}"`);
    expect(await run(4)).toEqual({ value: 1 });
    expect(await setup.select({ value: records.value }).from(records).where(eq(records.id, "b"))).toEqual([{ value: 4 }]);
    expect(preparedStatementStats(db)).toMatchObject({ restartedTransactions: 1, demoted: 1 });
  });

  it("keeps the isolation level and access mode of a restarted transaction", async () => {
    const db = fixture({ prepare: true });
    const settings = "select current_setting('transaction_isolation') as isolation, current_setting('transaction_read_only') as read_only, $1::integer as marker";
    const snapshot = { isolation: "repeatable read", read_only: "on", marker: 1 };
    const readDriver = () => db.$client.begin("isolation level repeatable read read only", async tx => {
      const rows = await tx.unsafe("select id, value from prepared_stale_fixture where id = $1", ["stale"]);
      return [rows, await tx.unsafe(settings, [1])];
    });
    const readOrm = () => db.transaction(async tx => [
      await tx.select().from(stale).where(eq(stale.id, "stale")),
      await tx.execute(sql`select current_setting('transaction_isolation') as isolation, current_setting('transaction_read_only') as read_only, ${1}::integer as marker`),
    ], { isolationLevel: "repeatable read", accessMode: "read only" });
    expect(await readDriver()).toEqual([[{ id: "stale", value: 5 }], [snapshot]]);
    expect(await readOrm()).toEqual([[{ id: "stale", value: 5 }], [snapshot]]);
    await changeStaleValueType("bigint");
    try {
      expect(await readDriver()).toEqual([[{ id: "stale", value: "5" }], [snapshot]]);
      expect(await readOrm()).toEqual([[{ id: "stale", value: 5 }], [snapshot]]);
      expect(preparedStatementStats(db)).toMatchObject({ restartedTransactions: 2, demoted: 2 });
    } finally {
      await changeStaleValueType("integer");
    }
  });

  it("does not restart a transaction after its first statement and runs the invalidated text unprepared", async () => {
    const db = fixture({ prepare: true });
    let calls = 0;
    const update = () => db.transaction(async tx => {
      calls++;
      await tx.update(records).set({ value: 7 }).where(eq(records.id, "b"));
      return tx.select().from(stale).where(eq(stale.id, "stale"));
    });
    expect(await update()).toEqual([{ id: "stale", value: 5 }]);
    await changeStaleValueType("bigint");
    try {
      await expect(update()).rejects.toMatchObject({ cause: { code: "0A000" } });
      expect(calls).toBe(2);
      expect(await update()).toEqual([{ id: "stale", value: 5 }]);
      expect(await statements(db, '%"prepared_stale_fixture"%')).toHaveLength(1);
      expect(preparedStatementStats(db)).toMatchObject({ restartedTransactions: 0, demoted: 1 });
    } finally {
      await changeStaleValueType("integer");
    }
  });

  it("counts a tagged statement as the first statement of a transaction", async () => {
    const db = fixture({ prepare: true });
    const read = "select id, value from prepared_stale_fixture where id = $1";
    expect(await db.$client.unsafe(read, ["stale"])).toEqual([{ id: "stale", value: 5 }]);
    await changeStaleValueType("bigint");
    try {
      await expect(db.$client.begin(async tx => {
        await tx`update prepared_query_fixture set value = value + 1 where id = 'a'`;
        return tx.unsafe(read, ["stale"]);
      })).rejects.toMatchObject({ code: "0A000" });
      expect(await setup.select({ value: records.value }).from(records).where(eq(records.id, "a"))).toEqual([{ value: 1 }]);
      expect(preparedStatementStats(db)).toMatchObject({ restartedTransactions: 0, demoted: 1 });
    } finally {
      await changeStaleValueType("integer");
    }
  });

  it("rolls back only the savepoint whose first statement fails and continues the outer transaction once", async () => {
    const db = fixture({ prepare: true });
    const nestedRead = (tx: Parameters<Parameters<Db["transaction"]>[0]>[0]) =>
      tx.transaction(nested => nested.select().from(stale).where(eq(stale.id, "stale")));
    await db.transaction(async tx => { await nestedRead(tx); });
    await changeStaleValueType("bigint");
    let outerCalls = 0;
    try {
      const result = await db.transaction(async tx => {
        outerCalls++;
        await tx.execute(sql`update prepared_query_fixture set value = value + 10 where id = ${"a"}`);
        const nested = await nestedRead(tx).catch((error: { cause?: { code?: string } }) => error.cause?.code);
        await tx.execute(sql`update prepared_query_fixture set value = value + 100 where id = ${"b"}`);
        return [nested, await tx.select().from(stale).where(eq(stale.id, "stale"))];
      });
      expect(result).toEqual(["0A000", [{ id: "stale", value: 5 }]]);
      expect(outerCalls).toBe(1);
      expect(await setup.select({ id: records.id, value: records.value }).from(records).orderBy(records.id))
        .toEqual([{ id: "a", value: 11 }, { id: "b", value: 102 }]);
      expect(preparedStatementStats(db)).toMatchObject({ restartedTransactions: 0, demoted: 1 });
    } finally {
      await changeStaleValueType("integer");
    }
  });

  async function occupyNextStatementName(db: Db) {
    const names = (await statements(db, "%")).map(row => String(row.name));
    const prefix = names.find(name => /\d$/.test(name) && !name.includes(" "))!.replace(/\d+$/, "");
    const counters = names.filter(name => name.startsWith(prefix)).map(name => Number(name.slice(prefix.length)));
    await db.$client.unsafe(`prepare "${prefix}${Math.max(...counters) + 1}" as select 1`, [], { prepare: false });
  }

  it("retries a pooled statement unprepared when its prepared statement cannot be created", async () => {
    const db = fixture({ prepare: true });
    await statements(db, "%");
    await occupyNextStatementName(db);
    expect(await db.select({ value: records.value }).from(records).where(eq(records.id, "b"))).toEqual([{ value: 2 }]);
    await occupyNextStatementName(db);
    expect(await db.$client.unsafe("select $1::integer as raw_retry_marker", [3]).values()).toEqual([[3]]);
    expect(await statements(db)).toHaveLength(0);
    expect(await statements(db, "%raw_retry_marker%")).toHaveLength(0);
    expect(preparedStatementStats(db)).toMatchObject({ retried: 2, demoted: 2 });
  });

  it("does not restart a transaction when a query created first executes after another statement", async () => {
    const db = fixture({ prepare: true });
    const read = "select id, value from prepared_stale_fixture where id = $1";
    expect(await db.$client.unsafe(read, ["stale"])).toEqual([{ id: "stale", value: 5 }]);
    await changeStaleValueType("bigint");
    let calls = 0;
    try {
      await expect(db.$client.begin(async tx => {
        calls++;
        const saved = tx.unsafe(read, ["stale"]);
        await tx.unsafe("select $1::integer as ordering_marker", [1]);
        return await saved;
      })).rejects.toMatchObject({ code: "0A000" });
      expect(calls).toBe(1);
      expect(preparedStatementStats(db)).toMatchObject({ restartedTransactions: 0, demoted: 1 });
    } finally {
      await changeStaleValueType("integer");
    }
  });

  it("prepares at most the configured number of distinct texts and skips long texts", async () => {
    const raw = postgres(temporary.connectionString, { max: 1, prepare: true, onnotice: () => {} });
    const state = createPreparedQueryState({ limit: 2, maxLength: 80 });
    installPreparedQueries(raw, state);
    try {
      for (const marker of ["cap_a", "cap_b", "cap_c", "cap_d"]) {
        expect(await raw.unsafe(`select $1::integer as ${marker}`, [1])).toEqual([{ [marker]: 1 }]);
      }
      const long = `select $1::integer as cap_long /* ${"x".repeat(80)} */`;
      expect(await raw.unsafe(long, [2])).toEqual([{ cap_long: 2 }]);
      expect((await raw.unsafe("select name from pg_prepared_statements where statement like 'select $1::integer as cap_%'", [], { prepare: false })).length).toBe(2);
      expect(preparedQueryStats(state)).toMatchObject({ texts: 2, unprepared: 3 });
    } finally {
      await raw.end();
    }
  });
});
