import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { createDb, companies, agents, costEvents } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { subscriptionShadowSync } from "../services/routine-checks/checks/subscription-shadow-sync.ts";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

const noopLogger = { info: () => {}, warn: () => {}, error: () => {} };
const fsStub = {} as unknown as typeof import("node:fs/promises");

interface UtilRow {
  company: string;
  used: number;
  limit: number;
  utilization_pct: number | null;
}

interface ShadowSyncPayload {
  inserted_shadow_events: number;
  utilization: UtilRow[];
  spike: boolean;
  error?: string;
}

describeDb("subscription-shadow-sync", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("pc-shadow-sync-");
    db = createDb(tempDb.connectionString);
  });
  afterAll(async () => {
    await tempDb?.cleanup();
  });
  afterEach(async () => {
    await db.execute(
      sql`TRUNCATE TABLE cost_events, agents, companies RESTART IDENTITY CASCADE`,
    );
    delete process.env.PAPERCLIP_SHADOW_SYNC_P95;
  });

  async function makeCompany(name: string, budgetCents = 100_00): Promise<string> {
    const r = await db
      .insert(companies)
      .values({
        name,
        issuePrefix:
          name.replace(/\W/g, "").slice(0, 5).toUpperCase() + randomUUID().slice(0, 4),
        budgetMonthlyCents: budgetCents,
      })
      .returning();
    return r[0]!.id;
  }

  async function makeAgent(companyId: string, name = "agent-x"): Promise<string> {
    const r = await db
      .insert(agents)
      .values({
        companyId,
        name,
        role: "general",
        adapterType: "process",
        adapterConfig: {},
      })
      .returning();
    return r[0]!.id;
  }

  it("returns ok with 0 inserted when no eligible cost_events", async () => {
    await makeCompany("HAPPYGANG");
    await makeCompany("TechOps Marco");
    const r = await subscriptionShadowSync.run({
      db,
      fs: fsStub,
      logger: noopLogger,
      now: () => new Date(),
    });
    expect(r.status).toBe("ok");
    const payload = r.payload as ShadowSyncPayload;
    expect(payload.inserted_shadow_events).toBe(0);
    expect(payload.spike).toBe(false);
    expect(Array.isArray(payload.utilization)).toBe(true);
  });

  it("inserts shadow events for subscription_included cost_events without existing shadow", async () => {
    const happy = await makeCompany("HAPPYGANG");
    await makeCompany("TechOps Marco");
    const agent = await makeAgent(happy);
    await db.insert(costEvents).values({
      companyId: happy,
      agentId: agent,
      provider: "anthropic",
      model: "claude-opus",
      biller: "anthropic",
      billingType: "subscription_included",
      inputTokens: 50_000,
      outputTokens: 5_000,
      costCents: 0,
      occurredAt: new Date(),
    });
    const r = await subscriptionShadowSync.run({
      db,
      fs: fsStub,
      logger: noopLogger,
      now: () => new Date(),
    });
    const payload = r.payload as ShadowSyncPayload;
    expect(payload.inserted_shadow_events).toBe(1);

    const all = await db.select().from(costEvents);
    const shadow = all.find((e) => e.billingType === "subscription_shadow_v1");
    expect(shadow).toBeDefined();
    expect(shadow!.costCents).toBe(Math.ceil(55_000 / 10_000)); // = 6
    expect(shadow!.inputTokens).toBe(0);
    expect(shadow!.outputTokens).toBe(0);
    expect(shadow!.billingCode).toMatch(/^shadow-src:/);
  });

  it("does NOT re-insert shadow when one already exists for same source", async () => {
    const happy = await makeCompany("HAPPYGANG");
    await makeCompany("TechOps Marco");
    const agent = await makeAgent(happy);
    await db.insert(costEvents).values({
      companyId: happy,
      agentId: agent,
      provider: "anthropic",
      model: "claude-opus",
      biller: "anthropic",
      billingType: "subscription_included",
      inputTokens: 10_000,
      outputTokens: 0,
      costCents: 0,
      occurredAt: new Date(),
    });
    const first = await subscriptionShadowSync.run({
      db,
      fs: fsStub,
      logger: noopLogger,
      now: () => new Date(),
    });
    expect((first.payload as ShadowSyncPayload).inserted_shadow_events).toBe(1);
    const second = await subscriptionShadowSync.run({
      db,
      fs: fsStub,
      logger: noopLogger,
      now: () => new Date(),
    });
    expect((second.payload as ShadowSyncPayload).inserted_shadow_events).toBe(0);
  });

  it("ignores cost_events outside current month", async () => {
    const happy = await makeCompany("HAPPYGANG");
    await makeCompany("TechOps Marco");
    const agent = await makeAgent(happy);
    const lastMonth = new Date();
    lastMonth.setMonth(lastMonth.getMonth() - 2);
    await db.insert(costEvents).values({
      companyId: happy,
      agentId: agent,
      provider: "anthropic",
      model: "claude-opus",
      biller: "anthropic",
      billingType: "subscription_included",
      inputTokens: 10_000,
      outputTokens: 0,
      costCents: 0,
      occurredAt: lastMonth,
    });
    const r = await subscriptionShadowSync.run({
      db,
      fs: fsStub,
      logger: noopLogger,
      now: () => new Date(),
    });
    expect((r.payload as ShadowSyncPayload).inserted_shadow_events).toBe(0);
  });

  it("ignores cost_events with non-subscription billing_type", async () => {
    const happy = await makeCompany("HAPPYGANG");
    await makeCompany("TechOps Marco");
    const agent = await makeAgent(happy);
    await db.insert(costEvents).values({
      companyId: happy,
      agentId: agent,
      provider: "anthropic",
      model: "x",
      biller: "anthropic",
      billingType: "metered",
      inputTokens: 10_000,
      outputTokens: 0,
      costCents: 100,
      occurredAt: new Date(),
    });
    const r = await subscriptionShadowSync.run({
      db,
      fs: fsStub,
      logger: noopLogger,
      now: () => new Date(),
    });
    expect((r.payload as ShadowSyncPayload).inserted_shadow_events).toBe(0);
  });

  it("flags spike when inserts exceed P95*3 threshold from ENV", async () => {
    process.env.PAPERCLIP_SHADOW_SYNC_P95 = "1"; // P95*3 = 3
    const happy = await makeCompany("HAPPYGANG");
    await makeCompany("TechOps Marco");
    const agent = await makeAgent(happy);
    for (let i = 0; i < 4; i++) {
      await db.insert(costEvents).values({
        companyId: happy,
        agentId: agent,
        provider: "anthropic",
        model: "claude-opus",
        biller: "anthropic",
        billingType: "subscription_included",
        inputTokens: 1_000,
        outputTokens: 0,
        costCents: 0,
        occurredAt: new Date(),
      });
    }
    const r = await subscriptionShadowSync.run({
      db,
      fs: fsStub,
      logger: noopLogger,
      now: () => new Date(),
    });
    const payload = r.payload as ShadowSyncPayload;
    expect(payload.inserted_shadow_events).toBe(4);
    expect(payload.spike).toBe(true);
    expect(r.status).toBe("warn");
    expect(r.findings).toBe(4);
    expect(r.summary).toContain("SPIKE");
  });

  it("returns utilization rows for both target companies", async () => {
    const happy = await makeCompany("HAPPYGANG", 1000_00);
    await makeCompany("TechOps Marco", 500_00);
    const agent = await makeAgent(happy);
    await db.insert(costEvents).values({
      companyId: happy,
      agentId: agent,
      provider: "anthropic",
      model: "x",
      biller: "anthropic",
      billingType: "metered",
      inputTokens: 0,
      outputTokens: 0,
      costCents: 250_00,
      occurredAt: new Date(),
    });
    const r = await subscriptionShadowSync.run({
      db,
      fs: fsStub,
      logger: noopLogger,
      now: () => new Date(),
    });
    const util = (r.payload as ShadowSyncPayload).utilization;
    expect(util).toHaveLength(2);
    const happyRow = util.find((u) => u.company === "HAPPYGANG");
    expect(happyRow!.used).toBe(250_00);
    expect(happyRow!.limit).toBe(1000_00);
    expect(happyRow!.utilization_pct).toBe(25.0);
    const techops = util.find((u) => u.company === "TechOps Marco");
    expect(techops!.used).toBe(0);
    expect(techops!.limit).toBe(500_00);
  });

  it("returns error status when DB query fails", async () => {
    const brokenDb = {
      execute: async () => {
        throw new Error("simulated db failure");
      },
    } as unknown as typeof db;
    const r = await subscriptionShadowSync.run({
      db: brokenDb,
      fs: fsStub,
      logger: noopLogger,
      now: () => new Date(),
    });
    expect(r.status).toBe("error");
    expect((r.payload as ShadowSyncPayload).error).toContain("simulated db failure");
    expect(r.summary).toContain("ERROR");
  });
});
