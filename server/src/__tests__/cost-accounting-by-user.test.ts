import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { agents, authUsers, companies, companyMemberships, costEvents, createDb, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { costService } from "../services/costs.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

describe("cost attribution by user (PostgreSQL)", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: Db;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("accounting-by-user-"); db = createDb(database.connectionString); }, 30_000);
  afterAll(async () => { await database?.cleanup(); });

  async function fixture() {
    const [company] = await db.insert(companies).values({ name: "User costs", issuePrefix: `U${randomUUID().slice(0, 7)}` }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Shared worker", role: "engineer", adapterType: "process" }).returning();
    return { companyId: company.id, agentId: agent.id };
  }
  async function member(companyId: string, name: string, status = "active") {
    const userId = randomUUID();
    await db.insert(authUsers).values({ id: userId, name, email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, status });
    return userId;
  }
  async function run(f: Awaited<ReturnType<typeof fixture>>, responsibleUserId: string | null) {
    return (await db.insert(heartbeatRuns).values({ ...f, responsibleUserId, status: "succeeded" }).returning())[0];
  }
  async function charge(f: Awaited<ReturnType<typeof fixture>>, overrides: Partial<typeof costEvents.$inferInsert> = {}) {
    await db.insert(costEvents).values({ ...f, provider: "openai", model: "fixture", costCents: 1,
      billingType: "metered_api", occurredAt: new Date(), ...overrides });
  }
  function trace() {
    const queries: string[] = [];
    const traced = drizzle(db.$client, { logger: { logQuery(query) { queries.push(query); } } }) as unknown as Db;
    return { service: costService(traced), ledgerReads: () => queries.filter(query => query.startsWith("select") && query.includes('from "cost_events"')) };
  }

  it("reports spend for any number of users and only includes active humans with zero spend", async () => {
    const f = await fixture(), foreign = await fixture();
    const { service, ledgerReads } = trace();
    expect(await service.byUser(f.companyId)).toEqual({ activeUserCount: 0, rows: [] });
    await member(f.companyId, "Alice");
    await member(f.companyId, "Invited", "pending");
    await member(f.companyId, "Suspended", "suspended");
    await member(f.companyId, "Former", "archived");
    await member(foreign.companyId, "Foreign");
    await db.insert(companyMemberships).values({ companyId: f.companyId, principalType: "agent", principalId: f.agentId });
    await charge(f);
    expect(await service.byUser(f.companyId)).toMatchObject({ activeUserCount: 1, rows: [
      { userId: null, costCents: 1 }, { userName: "Alice", costCents: 0 },
    ] });
    expect(ledgerReads()).toHaveLength(2);
    await member(f.companyId, "Bob");
    expect(await service.byUser(f.companyId)).toMatchObject({ activeUserCount: 2, rows: [
      { userId: null, costCents: 1 }, { userName: "Alice", costCents: 0 }, { userName: "Bob", costCents: 0 },
    ] });
    expect(ledgerReads()).toHaveLength(3);
  });

  it("excludes the Board principal by ID and preserves its historical charges as unattributed", async () => {
    const f = await fixture();
    await db.insert(authUsers).values({ id: "local-board", name: "Board", email: "local@paperclip.local", createdAt: new Date(), updatedAt: new Date() }).onConflictDoNothing();
    await db.insert(companyMemberships).values({ companyId: f.companyId, principalType: "user", principalId: "local-board" });
    const service = costService(db);
    expect(await service.byUser(f.companyId)).toEqual({ activeUserCount: 0, rows: [] });
    // A real person is never filtered by their display name.
    const human = await member(f.companyId, "Board");
    const humanRun = await run(f, human), boardRun = await run(f, "local-board");
    await charge(f, { heartbeatRunId: humanRun.id, costCents: 0.25 });
    await charge(f, { heartbeatRunId: boardRun.id, costCents: 1 });
    const report = await service.byUser(f.companyId);
    expect(report).toMatchObject({ activeUserCount: 1, rows: [
      { userId: null, userName: null, costCentsExact: "1.0000000", runCount: 1 },
      { userId: human, userName: "Board", costCentsExact: "0.2500000", runCount: 1 },
    ] });
    expect(report.rows.some(row => row.userId === "local-board")).toBe(false);
    expect((await service.summary(f.companyId)).spendCentsExact).toBe("1.2500000");
  });

  it("preserves exact spend, legacy cache semantics, zero-spend members and distinct runs", async () => {
    const f = await fixture();
    const alice = await member(f.companyId, "Alice"), bob = await member(f.companyId, "Bob");
    const former = await member(f.companyId, "Former", "archived");
    const a = await run(f, alice), b = await run(f, former);
    const [otherAgent] = await db.insert(agents).values({ companyId: f.companyId, name: "Second worker", role: "engineer", adapterType: "process" }).returning();
    const c = await run({ ...f, agentId: otherAgent.id }, alice);
    await charge(f, { heartbeatRunId: a.id, costCents: 0.1000001, inputTokens: 100, cachedInputTokens: 40, outputTokens: 5 });
    await charge(f, { heartbeatRunId: a.id, costCents: 0.2000002, receiptHash: "modern", costStatus: "estimated", inputTokens: 100, cachedInputTokens: 40, outputTokens: 10 });
    await charge(f, { heartbeatRunId: b.id, costCents: 0.4 });
    await charge(f, { heartbeatRunId: c.id, agentId: otherAgent.id, costCents: 0, costStatus: "unpriced", inputTokens: 9 });
    await charge(f, { heartbeatRunId: a.id, costCents: 0, costStatus: "unpriced", billingType: "subscription_included" });
    await charge(f, { costCents: 0.0000001 });
    const { service, ledgerReads } = trace();
    const report = await service.byUser(f.companyId, { allTime: true });
    expect(ledgerReads()).toHaveLength(1);
    expect(report.rows.find(row => row.userId === alice)).toMatchObject({
      costCentsExact: "0.3000003", eventCount: 4, estimatedEventCount: 1, unpricedEventCount: 1,
      inputTokens: 169, cachedInputTokens: 80, outputTokens: 15, runCount: 2,
    });
    expect(report.rows.find(row => row.userId === bob)).toMatchObject({ costCentsExact: "0.0000000", eventCount: 0, runCount: 0 });
    expect(report.rows.find(row => row.userId === former)).toMatchObject({ userName: "Former", costCentsExact: "0.4000000", runCount: 1 });
    expect(report.rows.find(row => row.userId === null)).toMatchObject({ costCentsExact: "0.0000001", runCount: 0 });
    const sum = report.rows.reduce((total, row) => total + BigInt(row.costCentsExact.replace(".", "")), 0n);
    expect(sum).toBe(7000004n);
    expect((await service.summary(f.companyId, { allTime: true })).spendCentsExact).toBe("0.7000004");
  });

  it("retains charges and active memberships when user profiles are missing", async () => {
    const f = await fixture();
    const missing = [randomUUID(), randomUUID()].sort();
    const former = randomUUID();
    for (const userId of [...missing, former]) {
      await db.insert(companyMemberships).values({ companyId: f.companyId, principalType: "user", principalId: userId,
        status: userId === former ? "archived" : "active" });
    }
    const ownerRun = await run(f, former);
    await charge(f, { heartbeatRunId: ownerRun.id, costCents: 0.125 });
    const report = await costService(db).byUser(f.companyId);
    expect(report).toMatchObject({ activeUserCount: 2, rows: [
      { userId: former, userName: "Former user", userImage: null, costCentsExact: "0.1250000", runCount: 1 },
      ...missing.map(userId => ({ userId, userName: "Unknown user", userImage: null, costCentsExact: "0.0000000", runCount: 0 })),
    ] });
    expect((await costService(db).summary(f.companyId)).spendCentsExact).toBe("0.1250000");
  });

  it("keeps every company charge but never attributes through a foreign run, agent or user", async () => {
    const f = await fixture(), foreign = await fixture();
    const alice = await member(f.companyId, "Alice"); await member(f.companyId, "Bob");
    const outsider = await member(foreign.companyId, "Secret foreign name");
    const foreignRun = await run(foreign, alice);
    const wrongUser = await run(f, outsider);
    const unowned = await run(f, null);
    const [otherAgent] = await db.insert(agents).values({ companyId: f.companyId, name: "Other", role: "engineer", adapterType: "process" }).returning();
    const wrongAgent = await run({ ...f, agentId: otherAgent.id }, alice);
    for (const r of [foreignRun, wrongUser, unowned, wrongAgent]) await charge(f, { heartbeatRunId: r.id });
    await charge(foreign, { heartbeatRunId: foreignRun.id, costCents: 999 });
    const report = await costService(db).byUser(f.companyId, { allTime: true });
    expect(report.rows.find(row => row.userId === null)).toMatchObject({ costCentsExact: "4.0000000", eventCount: 4, runCount: 2 });
    expect(report.rows.find(row => row.userId === alice)?.costCents).toBe(0);
    expect(JSON.stringify(report)).not.toContain(outsider);
    expect(JSON.stringify(report)).not.toContain("Secret foreign name");
  });

  it("filters receipt dates inclusively and never reassigns history when the issue owner changes", async () => {
    const f = await fixture();
    const alice = await member(f.companyId, "Alice"), bob = await member(f.companyId, "Bob");
    const [issue] = await db.insert(issues).values({ companyId: f.companyId, title: "Shared work", responsibleUserId: alice }).returning();
    const r = await run(f, alice);
    const from = new Date("2001-01-01T00:00:00Z"), to = new Date("2001-01-02T00:00:00Z");
    for (const occurredAt of [new Date(from.getTime() - 1), from, to, new Date(to.getTime() + 1)]) {
      await charge(f, { heartbeatRunId: r.id, issueId: issue.id, occurredAt });
    }
    await db.update(issues).set({ responsibleUserId: bob }).where(eq(issues.id, issue.id));
    const service = costService(db);
    expect((await service.byUser(f.companyId, { from, to })).rows.find(row => row.userId === alice)).toMatchObject({ costCents: 2, runCount: 1 });
    expect((await service.byUser(f.companyId, { allTime: true })).rows.find(row => row.userId === alice)?.costCents).toBe(4);
    expect((await service.byUser(f.companyId)).rows.every(row => row.costCents === 0)).toBe(true);
    await charge(f, { heartbeatRunId: r.id });
    expect((await service.byUser(f.companyId)).rows.find(row => row.userId === alice)?.costCents).toBe(1);
    await expect(service.byUser(randomUUID())).rejects.toThrow("Company not found");
  });
});
