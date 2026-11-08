import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agents, companies, createDb } from "@paperclipai/db";
import { applyAgentBudgetHoldInTransaction } from "./agent-lifecycle.js";
import {
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();

// H1 bug A: a budget hard stop paused the agent with no activity entry and
// no recorded reason. A governance stop must be explainable from the log.
describe.skipIf(!support.supported)("agent budget hold activity", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-budget-hold-activity-");
    db = createDb(tempDb.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => {
    await db?.$client.end();
    await tempDb?.cleanup();
  });

  it("records the budget pause and its release with the reason", async () => {
    const [company] = await db.insert(companies).values({ name: "Hold", issuePrefix: "HLD" }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Worker" }).returning();
    const publications: unknown[] = [];
    await db.transaction(tx => applyAgentBudgetHoldInTransaction(tx as never, company.id, agent.id, true, publications as never));
    // The entry is handed to the caller's post-commit publications.
    expect(publications).toEqual([expect.objectContaining({ companyId: company.id })]);
    const [paused] = await db.select().from(agents).where(eq(agents.id, agent.id));
    expect(paused).toMatchObject({ pauseReason: "budget", lifecycleHolds: ["budget"] });
    const entries = () => db.select({ action: activityLog.action, details: activityLog.details }).from(activityLog)
      .where(and(eq(activityLog.companyId, company.id), eq(activityLog.entityId, agent.id)));
    expect(await entries()).toEqual([{ action: "agent.paused",
      details: expect.objectContaining({ reason: "budget", holds: ["budget"] }) }]);
    // Applying the same hold again records nothing new.
    await db.transaction(tx => applyAgentBudgetHoldInTransaction(tx as never, company.id, agent.id, true));
    expect(await entries()).toHaveLength(1);
    await db.transaction(tx => applyAgentBudgetHoldInTransaction(tx as never, company.id, agent.id, false));
    expect((await entries()).map(entry => entry.action)).toEqual(["agent.paused", "agent.resumed"]);
  });

  it("records a budget hold release, not a resume, while another hold keeps the agent paused", async () => {
    const [company] = await db.insert(companies).values({ name: "Held", issuePrefix: "HLE" }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Worker" }).returning();
    await db.transaction(tx => applyAgentBudgetHoldInTransaction(tx as never, company.id, agent.id, true));
    await db.update(agents).set({ lifecycleHolds: ["budget", "manual"] }).where(eq(agents.id, agent.id));
    await db.transaction(tx => applyAgentBudgetHoldInTransaction(tx as never, company.id, agent.id, false));
    const actions = (await db.select({ action: activityLog.action }).from(activityLog)
      .where(and(eq(activityLog.companyId, company.id), eq(activityLog.entityId, agent.id)))).map(row => row.action);
    expect(actions).toEqual(["agent.paused", "agent.budget_hold_released"]);
  });
});
