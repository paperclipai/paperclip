import { eq, sql } from "drizzle-orm";
import { pgTable, uuid } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import type { Sql } from "postgres";
import { createDatabaseResponseCapture, installDatabaseResponseCapture, withDatabaseOperation } from "../response-capture.js";

const table = pgTable("diagnostic_fixture", { id: uuid("id") });
const privateParameter = "00000000-0000-4000-8000-000000000001";
function firstApplicationCaller(db: Pick<ReturnType<typeof drizzle>, "select">, id: string) {
  return db.select({ id: table.id }).from(table).where(eq(table.id, id)).execute();
}
function secondApplicationCaller(db: Pick<ReturnType<typeof drizzle>, "select">, id: string) {
  return db.select({ id: table.id }).from(table).where(eq(table.id, id)).execute();
}
function prepareApplicationCaller(db: Pick<ReturnType<typeof drizzle>, "select">) {
  return db.select({ id: table.id }).from(table).where(eq(table.id, sql.placeholder("id"))).prepare("fixture");
}
function executeApplicationCaller(db: ReturnType<typeof drizzle>) {
  return db.execute(sql`select 1`);
}
export async function runBundleProof() {
  const cases = [];
  for (const mode of ["disabled", "future", "expired", "unowned", "http.request", "response.presentation"]) {
    let clock = mode === "future" ? 998 : 1000, driverCalls = 0, stacks = 0;
    const events: Array<Record<string, unknown>> = [];
    const capture = mode === "disabled" ? undefined : createDatabaseResponseCapture(
      { start: 999, end: 2000 }, event => events.push(event), () => clock);
    const client = {
      options: { parsers: {}, serializers: {} },
      unsafe() {
        driverCalls += 1;
        return { values() { return this; }, then(ok: (value: unknown) => unknown, bad: (error: unknown) => unknown) {
          return Promise.resolve(Object.assign([], { columns: [{ name: "id" }] })).then(ok, bad);
        } };
      },
      begin(callback: (value: unknown) => unknown) { return callback(client); },
      savepoint(callback: (value: unknown) => unknown) { return callback(client); },
    };
    const db = drizzle(client as unknown as Sql, { logger: false, schema: { table } });
    installDatabaseResponseCapture(db, { table }, capture);
    if (mode === "expired") clock = 2000;
    const original = Error.captureStackTrace;
    Error.captureStackTrace = (target, boundary) => { stacks += 1; original(target, boundary); };
    try {
      const action = async () => {
        await firstApplicationCaller(db, privateParameter);
        await firstApplicationCaller(db, "00000000-0000-4000-8000-000000000002");
        await secondApplicationCaller(db, privateParameter);
        const prepared = prepareApplicationCaller(db);
        await prepared.execute({ id: privateParameter });
        await executeApplicationCaller(db);
        await db.transaction(async tx => {
          await secondApplicationCaller(tx, privateParameter);
          await tx.transaction(async nested => { await firstApplicationCaller(nested, privateParameter); });
        });
        // These have no trusted builder boundary. Do not label bundled ORM
        // internals (or their driver bridge) as an application caller.
        await db.$client.unsafe("select 1");
        await db.query.table.findMany();
      };
      await (mode.includes(".") ? withDatabaseOperation(mode, action) : action());
    } finally { Error.captureStackTrace = original; capture?.flush(); }
    cases.push({ mode, driverCalls, stacks, events });
  }
  return { node: process.version, cases };
}

// Serial, finite fake-driver measurement: includes real ORM compilation and
// active census costs, but no database/network latency or result sizing work.
export async function measureBundleCapture(mode: string, count: number) {
  const events: Array<Record<string, unknown>> = [];
  const now = Date.now();
  const capture = mode === "disabled" ? undefined : createDatabaseResponseCapture(
    { start: now - 1, end: now + 59_000 }, event => events.push(event));
  let calls = 0;
  const client = { options: { parsers: {}, serializers: {} }, unsafe() {
    calls += 1;
    return { values() { return this; }, then(ok: (value: unknown) => unknown, bad: (error: unknown) => unknown) {
      return Promise.resolve(Object.assign([], { columns: [{ name: "id" }] })).then(ok, bad);
    } };
  } };
  const db = drizzle(client as unknown as Sql, { logger: false });
  installDatabaseResponseCapture(db, { table }, capture);
  const action = async () => {
    for (let index = 0; index < count; index += 1) {
      await (index % 2 ? firstApplicationCaller(db, privateParameter) : secondApplicationCaller(db, privateParameter));
    }
  };
  const cpu = process.cpuUsage(), wall = performance.now();
  await (mode === "unowned" || mode === "disabled" ? action() : withDatabaseOperation(mode, action));
  const wallUs = (performance.now() - wall) * 1000, used = process.cpuUsage(cpu);
  capture?.flush();
  if (calls !== count) throw new Error("Incomplete measurement");
  return { mode, count, cpuUsPerQuery: (used.user + used.system) / count, wallUsPerQuery: wallUs / count,
    calls, entries: events.filter(event => Array.isArray(event.callers)).map(event => ({ owner: event.owner, calls: event.calls, callers: event.callers })) };
}
