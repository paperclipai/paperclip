import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, costEvents, createDb, financeEvents, heartbeatRuns, inboxDismissals } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { companyService } from "../services/companies.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("company deletion with activity", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-company-deletion-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(financeEvents);
    await db.delete(costEvents);
    await db.delete(heartbeatRuns);
    await db.delete(inboxDismissals);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it.each(["dismiss", "snooze"] as const)("deletes a company with a %s inbox record and preserves another company", async (kind) => {
    const [company, other] = await db.insert(companies).values([
      { name: "Delete activity", issuePrefix: "DEL" },
      { name: "Keep activity", issuePrefix: "KEEP" },
    ]).returning();
    for (const row of [company, other]) {
      await db.insert(inboxDismissals).values({
        companyId: row.id, userId: "test-user", itemKey: "attention:test", kind,
        snoozedUntil: kind === "snooze" ? new Date("2099-01-01T00:00:00Z") : null,
      });
    }

    expect(await companyService(db).remove(company.id)).toMatchObject({ id: company.id });
    expect(await db.select().from(companies).where(eq(companies.id, company.id))).toEqual([]);
    expect(await db.select().from(inboxDismissals).where(eq(inboxDismissals.companyId, company.id))).toEqual([]);
    expect(await db.select().from(companies).where(eq(companies.id, other.id))).toHaveLength(1);
    expect(await db.select().from(inboxDismissals).where(eq(inboxDismissals.companyId, other.id))).toMatchObject([
      { companyId: other.id, kind, itemKey: "attention:test" },
    ]);
  });

  it("deletes heartbeat runs with linked cost and finance events", async () => {
    const [company] = await db.insert(companies).values({ name: "Run activity", issuePrefix: "RUN" }).returning();
    const [agent] = await db.insert(agents).values({
      companyId: company.id, name: "Finished agent", status: "terminated", lifecycleState: "terminated",
    }).returning();
    const [run] = await db.insert(heartbeatRuns).values({
      companyId: company.id, agentId: agent.id, invocationSource: "timer", status: "succeeded",
    }).returning();
    const [cost] = await db.insert(costEvents).values({
      companyId: company.id, agentId: agent.id, heartbeatRunId: run.id,
      provider: "test", model: "test", costCents: 1, occurredAt: new Date(),
    }).returning();
    await db.insert(financeEvents).values({
      companyId: company.id, agentId: agent.id, heartbeatRunId: run.id, costEventId: cost.id,
      eventKind: "usage", biller: "test", amountCents: 1, occurredAt: new Date(),
    });

    expect(await companyService(db).remove(company.id)).toMatchObject({ id: company.id });
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, company.id))).toEqual([]);
    expect(await db.select().from(costEvents).where(eq(costEvents.companyId, company.id))).toEqual([]);
    expect(await db.select().from(financeEvents).where(eq(financeEvents.companyId, company.id))).toEqual([]);
  });
});
