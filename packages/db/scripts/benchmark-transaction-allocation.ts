// What one transaction or savepoint costs on the Paperclip database client,
// measured against a local PostgreSQL.
//
//   cd packages/db
//   TSX_DISABLE_CACHE=1 node --expose-gc --import tsx scripts/benchmark-transaction-allocation.ts [iterations] [passes]
//
// Three clients run the same scenarios: `createDb`, Drizzle given the schema
// directly (one relational query builder per table for every transaction, which
// is what `createDb` did before transactions built `tx.query` on first read),
// and Drizzle without a schema (the floor).
//
// Each scenario runs `passes` times for `iterations` iterations, with a forced
// collection before every pass, and reports the median pass. Allocation is
// V8's total_allocated_bytes counter, CPU is process.cpuUsage(), and a
// collection counts only when it starts inside the measured window. The
// allocation profile attributes an empty transaction's bytes to named frames.
// TSX_DISABLE_CACHE keeps tsx from scanning its shared cache while passes run.
//
// Needs Node.js 25 or later: Node.js 24 has no total_allocated_bytes counter,
// and the script stops with that message instead of printing empty numbers.
import inspector from "node:inspector/promises";
import { cpus, loadavg } from "node:os";
import { PerformanceObserver, performance } from "node:perf_hooks";
import v8 from "node:v8";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { createDb } from "../src/client.js";
import * as schema from "../src/schema/index.js";
import { startEmbeddedPostgresTestDatabase } from "../src/test-embedded-postgres.js";

const iterations = Number(process.argv[2] ?? 3000);
const passes = Number(process.argv[3] ?? 5);
if (!Number.isInteger(iterations) || iterations < 1 || !Number.isInteger(passes) || passes < 1) {
  throw new Error("Usage: benchmark-transaction-allocation.ts [iterations] [passes]");
}
const collect = (globalThis as { gc?: () => void }).gc;
if (!collect) throw new Error("Run node with --expose-gc");

type Sample = { allocatedBytes: number; cpuMicros: number; wallMicros: number; collections: number; collectionMs: number };
const allocated = () => (v8.getHeapStatistics() as unknown as { total_allocated_bytes: number }).total_allocated_bytes;
if (typeof allocated() !== "number") {
  throw new Error(`This benchmark needs Node.js 25 or later; ${process.version} has no v8 total_allocated_bytes counter`);
}
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
const settle = () => new Promise<void>(resolve => setImmediate(resolve));

const collectionEntries: { start: number; duration: number }[] = [];
const observer = new PerformanceObserver(list => {
  for (const entry of list.getEntries()) collectionEntries.push({ start: entry.startTime, duration: entry.duration });
});
observer.observe({ entryTypes: ["gc"] });

async function pass(action: () => Promise<unknown> | unknown): Promise<Sample> {
  collect!(); collect!();
  await settle();
  const startedAt = performance.now(), cpu = process.cpuUsage(), before = allocated();
  for (let index = 0; index < iterations; index += 1) await action();
  const allocatedBytes = allocated() - before, used = process.cpuUsage(cpu), endedAt = performance.now();
  await settle(); await settle();
  const inWindow = collectionEntries.filter(entry => entry.start >= startedAt && entry.start < endedAt);
  return {
    allocatedBytes: allocatedBytes / iterations,
    cpuMicros: (used.user + used.system) / iterations,
    wallMicros: (endedAt - startedAt) * 1000 / iterations,
    collections: inWindow.length * 1000 / iterations,
    collectionMs: inWindow.reduce((sum, entry) => sum + entry.duration, 0) * 1000 / iterations,
  };
}

async function measure(client: string, scenario: string, action: () => Promise<unknown> | unknown) {
  for (let index = 0; index < 300; index += 1) await action();
  const samples: Sample[] = [];
  for (let index = 0; index < passes; index += 1) samples.push(await pass(action));
  const result = {
    kind: "scenario", client, scenario,
    allocatedBytesPerIteration: Math.round(median(samples.map(sample => sample.allocatedBytes))),
    cpuMicrosPerIteration: Number(median(samples.map(sample => sample.cpuMicros)).toFixed(1)),
    cpuMicrosMin: Number(Math.min(...samples.map(sample => sample.cpuMicros)).toFixed(1)),
    wallMicrosPerIteration: Number(median(samples.map(sample => sample.wallMicros)).toFixed(1)),
    collectionsPer1000: Number(median(samples.map(sample => sample.collections)).toFixed(1)),
    collectionMsPer1000: Number(median(samples.map(sample => sample.collectionMs)).toFixed(2)),
  };
  console.log(JSON.stringify(result));
  return result;
}

type AnyDb = {
  execute(query: unknown): Promise<unknown>;
  transaction<T>(callback: (tx: AnyDb) => Promise<T>, config?: unknown): Promise<T>;
};

async function scenarios(client: string, db: AnyDb) {
  const statement = sql`select 1`;
  await measure(client, "statement outside a transaction", () => db.execute(statement));
  await measure(client, "empty transaction", () => db.transaction(async () => {}));
  await measure(client, "transaction with one statement", () => db.transaction(async tx => { await tx.execute(statement); }));
  await measure(client, "transaction with an empty savepoint", () => db.transaction(async tx => { await tx.transaction(async () => {}); }));
  await measure(client, "transaction with a savepoint of one statement",
    () => db.transaction(async tx => { await tx.transaction(async inner => { await inner.execute(statement); }); }));
}

type Node = { callFrame: { functionName: string; url: string; lineNumber: number }; selfSize: number; children?: Node[] };

async function allocationProfile(client: string, db: AnyDb, count: number) {
  for (let index = 0; index < 300; index += 1) await db.transaction(async () => {});
  collect!(); collect!();
  const session = new inspector.Session();
  session.connect();
  await session.post("HeapProfiler.enable");
  await session.post("HeapProfiler.startSampling", {
    samplingInterval: 256, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true,
  } as never);
  for (let index = 0; index < count; index += 1) await db.transaction(async () => {});
  const { profile } = await session.post("HeapProfiler.stopSampling") as unknown as { profile: { head: Node } };
  session.disconnect();
  const self = new Map<string, number>(), inclusive = new Map<string, number>();
  let total = 0;
  const label = (node: Node) => {
    const file = node.callFrame.url.replace(/^.*node_modules\//, "").replace(/^file:\/\/.*\/packages\//, "packages/");
    return `${node.callFrame.functionName || "(anonymous)"} ${file}:${node.callFrame.lineNumber + 1}`;
  };
  const walk = (node: Node, ancestors: string[]): number => {
    const name = label(node);
    let size = node.selfSize;
    for (const child of node.children ?? []) size += walk(child, [...ancestors, name]);
    self.set(name, (self.get(name) ?? 0) + node.selfSize);
    // Count a frame once per stack so recursion does not double its share.
    if (!ancestors.includes(name)) inclusive.set(name, (inclusive.get(name) ?? 0) + size);
    total += node.selfSize;
    return size;
  };
  walk(profile.head, []);
  const top = (map: Map<string, number>, limit: number) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit)
    .map(([frame, bytes]) => ({ frame, bytesPerTransaction: Math.round(bytes / count), share: Number((bytes / total).toFixed(3)) }));
  console.log(JSON.stringify({ kind: "allocation-profile", client, scenario: "empty transaction", transactions: count,
    sampledBytesPerTransaction: Math.round(total / count), self: top(self, 6), inclusive: top(inclusive, 10) }));
}

const database = await startEmbeddedPostgresTestDatabase("paperclip-db-transaction-allocation-");
// These two pools are not registered with createDb, so database.cleanup() does
// not end them. End them before PostgreSQL stops, also when a scenario throws.
const eagerSql = postgres(database.connectionString, { max: 10, onnotice: () => {} });
const bareSql = postgres(database.connectionString, { max: 10, onnotice: () => {} });
try {
  const db = createDb(database.connectionString) as unknown as AnyDb & { _: { schema: Record<string, unknown> } };
  const eager = drizzle(eagerSql, { schema }) as unknown as AnyDb;
  const bare = drizzle(bareSql) as unknown as AnyDb;
  console.log(JSON.stringify({ kind: "host", node: process.version, logicalCpus: cpus().length, loadavg: loadavg().map(value => Number(value.toFixed(1))),
    iterations, passes, schemaTables: Object.keys(db._.schema).length,
    boundary: "three clients on one local PostgreSQL; allocation = V8 total_allocated_bytes; CPU = process user+system; median pass" }));
  await scenarios("paperclip createDb", db);
  await scenarios("drizzle with the schema", eager);
  await scenarios("drizzle without a schema", bare);
  await allocationProfile("paperclip createDb", db, Math.min(iterations, 2000));
  await allocationProfile("drizzle with the schema", eager, Math.min(iterations, 2000));
} finally {
  observer.disconnect();
  await Promise.allSettled([eagerSql.end({ timeout: 1 }), bareSql.end({ timeout: 1 })]);
  await database.cleanup();
}
