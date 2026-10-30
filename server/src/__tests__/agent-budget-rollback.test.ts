import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { activityLog, agentConfigRevisions, agents, budgetPolicies, companies, createDb } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.js";

describe("agent rollback budget authority", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("agent-budget-rollback-");
    db = createDb(database.connectionString);
  }, 90_000);
  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(agentConfigRevisions);
    await db.delete(budgetPolicies);
    await db.delete(agents);
    await db.delete(companies);
  });
  afterAll(async () => { await database?.cleanup(); });

  async function history(historicalBudget: number) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Budget boundary", issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Current", role: "engineer", adapterType: "http", status: "paused", budgetMonthlyCents: 10 });
    const service = agentService(db);
    await service.update(agentId, { name: "Historical", budgetMonthlyCents: historicalBudget }, { recordRevision: { source: "test", createdByUserId: "board-user" } });
    const [revision] = await service.listConfigRevisions(agentId);
    await service.update(agentId, { name: "Current", budgetMonthlyCents: 10 }, { recordRevision: { createdByUserId: "board-user" } });
    async function policy() {
      const [row] = await db.select().from(budgetPolicies).where(and(eq(budgetPolicies.scopeId, agentId), eq(budgetPolicies.scopeType, "agent")));
      return row;
    }
    return { service, agentId, revision, policy };
  }

  it.each([0, 1000])("rejects agent rollback to historical budget %s before changing configuration or policy", async (historicalBudget) => {
    const { service, agentId, revision, policy } = await history(historicalBudget);
    const before = await policy();
    const revisions = await service.listConfigRevisions(agentId);
    await expect(service.rollbackConfigRevision(agentId, revision.id, { agentId })).rejects.toMatchObject({ status: 403 });
    expect(await service.getById(agentId)).toMatchObject({ name: "Current", budgetMonthlyCents: 10 });
    expect(await policy()).toEqual(before);
    expect(await service.listConfigRevisions(agentId)).toEqual(revisions);
  });

  it.each([0, 1000])("board-authorized rollback restores historical budget %s", async (historicalBudget) => {
    const { service, agentId, revision, policy } = await history(historicalBudget);
    const restored = await service.rollbackConfigRevision(agentId, revision.id, { userId: "board-user" });
    expect(restored).toMatchObject({ name: "Historical", budgetMonthlyCents: historicalBudget });
    expect(await policy()).toMatchObject({ amount: historicalBudget, isActive: historicalBudget > 0 });
  });

  it("does not reactivate a policy even when the revision budget equals the current amount", async () => {
    const { service, agentId, revision, policy } = await history(10);
    await db.update(budgetPolicies).set({ isActive: false }).where(eq(budgetPolicies.scopeId, agentId));
    const before = await policy();
    await service.rollbackConfigRevision(agentId, revision.id, { agentId });
    expect(await policy()).toEqual(before);
    expect(await service.getById(agentId)).toMatchObject({ name: "Historical", budgetMonthlyCents: 10 });
  });
});
