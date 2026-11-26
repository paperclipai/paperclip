import { randomUUID } from "node:crypto";
import { cpus, loadavg } from "node:os";
import { and, eq, inArray, mapResultRow, sql } from "drizzle-orm";
import { tracer } from "drizzle-orm/tracing";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { createDb } from "../src/client.js";
import * as schema from "../src/schema/index.js";
import { activityLog, agents, companies, companyMemberships, issues } from "../src/schema/index.js";
import { startEmbeddedPostgresTestDatabase } from "../src/test-embedded-postgres.js";

const iterations = Number(process.env.ITERATIONS ?? 2000);
const passes = Number(process.env.PASSES ?? 5);
const concurrency = Number(process.env.CONCURRENCY ?? 1);
const only = process.env.ONLY?.split(",").filter(Boolean);
const variants = process.env.VARIANTS?.split("|").filter(Boolean);
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;

async function pass(action: () => Promise<unknown> | unknown) {
  const cpu = process.cpuUsage(), startedAt = performance.now();
  let next = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next < iterations) { next += 1; await action(); }
  }));
  const used = process.cpuUsage(cpu);
  return { cpu: (used.user + used.system) / iterations, wall: (performance.now() - startedAt) * 1000 / iterations };
}

const results: Record<string, Record<string, { median: number; min: number; max: number }>> = {};
async function measure(statement: string, variant: string, action: () => Promise<unknown> | unknown) {
  if (only && !only.includes(statement)) return;
  if (variants && !variants.some(name => variant.startsWith(name))) return;
  for (let index = 0; index < Math.min(500, iterations); index += 1) await action();
  const samples = [];
  for (let index = 0; index < passes; index += 1) samples.push(await pass(action));
  const cpu = samples.map(sample => sample.cpu);
  (results[statement] ??= {})[variant] = { median: Number(median(cpu).toFixed(1)), min: Number(Math.min(...cpu).toFixed(1)),
    max: Number(Math.max(...cpu).toFixed(1)) };
  console.log(JSON.stringify({ statement, variant, cpuMicros: results[statement][variant],
    wallMicros: Number(median(samples.map(sample => sample.wall)).toFixed(1)) }));
}

type Query = { toSQL(): { sql: string; params: unknown[] }; _: { selectedFields?: unknown } };
type Case = {
  name: string;
  build: (db: ReturnType<typeof createDb>) => Query & PromiseLike<unknown>;
  prepare: (db: ReturnType<typeof createDb>) => { execute(values: Record<string, unknown>): Promise<unknown> };
  values: Record<string, unknown>;
  fields?: (query: Query) => unknown;
};

const database = await startEmbeddedPostgresTestDatabase("paperclip-statement-cpu-");
const db = createDb(database.connectionString, { maxConnections: 4 });
const plainSql = postgres(database.connectionString, { max: 4, onnotice: () => {} });
const plain = drizzle(plainSql, { schema });
try {
  const [company] = await db.insert(companies).values({ name: "Bench", issuePrefix: "BEN" }).returning({ id: companies.id });
  const companyId = company!.id;
  const [agent] = await db.insert(agents).values({ companyId, name: "Agent" }).returning({ id: agents.id });
  const issueIds: string[] = [];
  for (let index = 0; index < 20; index += 1) {
    const [issue] = await db.insert(issues).values({ companyId, title: `Issue ${index}`, assigneeAgentId: agent!.id,
      description: "x".repeat(400) }).returning({ id: issues.id });
    issueIds.push(issue!.id);
  }
  const userId = "user-1";
  await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, status: "active",
    membershipRole: "owner" });
  const listIds = issueIds.slice(0, 10);

  const cases: Case[] = [
    {
      name: "issue parent by id",
      build: d => d.select({ parentId: issues.parentId }).from(issues).where(eq(issues.id, issueIds[0]!)),
      prepare: d => d.select({ parentId: issues.parentId }).from(issues).where(eq(issues.id, sql.placeholder("id"))).prepare("p1"),
      values: { id: issueIds[0] },
    },
    {
      name: "issue row by id",
      build: d => d.select().from(issues).where(eq(issues.id, issueIds[1]!)),
      prepare: d => d.select().from(issues).where(eq(issues.id, sql.placeholder("id"))).prepare("p2"),
      values: { id: issueIds[1] },
    },
    {
      name: "membership by principal",
      build: d => d.select({ companyId: companyMemberships.companyId, membershipRole: companyMemberships.membershipRole,
        status: companyMemberships.status }).from(companyMemberships).where(and(eq(companyMemberships.companyId, companyId),
        eq(companyMemberships.principalType, "user"), eq(companyMemberships.principalId, userId),
        eq(companyMemberships.status, "active"))),
      prepare: d => d.select({ companyId: companyMemberships.companyId, membershipRole: companyMemberships.membershipRole,
        status: companyMemberships.status }).from(companyMemberships).where(and(
        eq(companyMemberships.companyId, sql.placeholder("companyId")), eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.principalId, sql.placeholder("userId")), eq(companyMemberships.status, "active"))).prepare("p3"),
      values: { companyId, userId },
    },
    {
      name: "join with in-list of 10",
      build: d => d.select({ id: issues.id, title: issues.title, status: issues.status, agentName: agents.name })
        .from(issues).leftJoin(agents, eq(issues.assigneeAgentId, agents.id))
        .where(and(eq(issues.companyId, companyId), inArray(issues.id, listIds))),
      prepare: d => d.select({ id: issues.id, title: issues.title, status: issues.status, agentName: agents.name })
        .from(issues).leftJoin(agents, eq(issues.assigneeAgentId, agents.id))
        .where(and(eq(issues.companyId, sql.placeholder("companyId")), sql`${issues.id} = any(${sql.placeholder("ids")}::uuid[])`)).prepare("p4"),
      values: { companyId, ids: listIds },
    },
    {
      name: "update by id",
      build: d => d.update(issues).set({ updatedAt: new Date(), checkoutRunId: null }).where(eq(issues.id, issueIds[2]!)) as never,
      prepare: d => d.update(issues).set({ updatedAt: sql.placeholder("now") as never, checkoutRunId: null })
        .where(eq(issues.id, sql.placeholder("id"))).prepare("p5"),
      values: { id: issueIds[2], now: new Date() },
    },
    {
      name: "insert activity",
      build: d => d.insert(activityLog).values({ companyId, actorType: "agent", actorId: agent!.id, action: "issue.updated",
        entityType: "issue", entityId: issueIds[3]!, agentId: agent!.id, details: { field: "status", from: "todo", to: "done" } }) as never,
      prepare: d => d.insert(activityLog).values({ companyId: sql.placeholder("companyId"), actorType: "agent",
        actorId: sql.placeholder("actorId"), action: "issue.updated", entityType: "issue", entityId: sql.placeholder("entityId"),
        agentId: sql.placeholder("actorId"), details: sql.placeholder("details") }).prepare("p6"),
      values: { companyId, actorId: agent!.id, entityId: issueIds[3], details: { field: "status", from: "todo", to: "done" } },
    },
  ];

  await measure("tracer", "no-op startActiveSpan (async callback)", () => tracer.startActiveSpan("x", async () => 1));
  for (const item of cases) {
    const sample = item.build(db);
    const { sql: text, params } = sample.toSQL();
    const ordered = (sample as unknown as { _prepare(): { fields?: unknown; joinsNotNullableMap?: unknown } })._prepare();
    const mapFields = ordered.fields as Parameters<typeof mapResultRow>[0] | undefined;
    const joins = ordered.joinsNotNullableMap as Parameters<typeof mapResultRow>[2];
    await measure(item.name, "build only (toSQL)", () => item.build(db).toSQL());
    await measure(item.name, "drizzle builder, createDb", () => item.build(db));
    await measure(item.name, "drizzle builder, plain drizzle()", () => item.build(plain as never));
    const prepared = item.prepare(db);
    await measure(item.name, "drizzle .prepare() reused", () => prepared.execute(item.values));
    if (mapFields) {
      await measure(item.name, "unsafe .values() + mapResultRow", async () => {
        const rows = await db.$client.unsafe(text, params as never[]).values();
        return rows.map(row => mapResultRow(mapFields, row as unknown[], joins));
      });
    }
    await measure(item.name, "unsafe(text, params)", () => db.$client.unsafe(text, params as never[]));
    await measure(item.name, "unsafe(text, params, {prepare:true})", () => db.$client.unsafe(text, params as never[], { prepare: true }));
  }
  console.log(JSON.stringify({ kind: "summary", node: process.version, cpus: cpus().length, loadavg: loadavg(), iterations,
    passes, concurrency, results }));
} finally {
  await plainSql.end({ timeout: 1 });
  await db.$client.end({ timeout: 1 });
  await database.cleanup();
}
