import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, approvals, budgetIncidents, budgetPolicies, companies, costEvents, createDb, projects, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@paperclipai/db";
import { budgetService } from "../services/budgets.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

vi.mock("../services/activity-log.js", () => ({ logActivity: vi.fn() }));
const support = await getEmbeddedPostgresTestSupport();

describe.skipIf(!support.supported)("budget history for deleted scopes", () => {
  let db: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-budget-history-");
    db = createDb(database.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterEach(async () => {
    await db.delete(budgetIncidents); await db.delete(approvals); await db.delete(budgetPolicies); await db.delete(costEvents);
    await db.delete(projects); await db.delete(agents); await db.delete(companies);
  });
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await database?.cleanup(); });

  async function fixture() {
    const companyId = randomUUID(), agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "History company", issuePrefix: `B${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Current agent", role: "engineer" });
    const [policy] = await db.insert(budgetPolicies).values({ companyId, scopeType: "agent", scopeId: agentId,
      metric: "billed_cents", windowKind: "calendar_month_utc", amount: 300 }).returning();
    await db.insert(costEvents).values({ companyId, agentId, provider: "openai", model: "history-fixture", inputTokens: 1, outputTokens: 1, costCents: 17, occurredAt: new Date() });
    return { companyId, agentId, policy: policy! };
  }

  it.each(["agent", "project"] as const)("keeps current budgets and deleted %s policy/incident history readable without changing stored rows", async scopeType => {
    const { companyId, policy } = await fixture(), deletedId = randomUUID();
    if (scopeType === "agent") await db.insert(agents).values({ id: deletedId, companyId, name: "Former agent", role: "engineer" });
    else await db.insert(projects).values({ id: deletedId, companyId, name: "Former project" });
    const [historical] = await db.insert(budgetPolicies).values({ companyId, scopeType, scopeId: deletedId,
      metric: "billed_cents", windowKind: "calendar_month_utc", amount: 200 }).returning();
    await db.insert(budgetIncidents).values({ companyId, policyId: historical!.id, scopeType, scopeId: deletedId,
      metric: "billed_cents", windowKind: "calendar_month_utc", windowStart: new Date("2020-01-01"), windowEnd: new Date("2020-02-01"),
      thresholdType: "hard", amountLimit: 200, amountObserved: 201 });
    if (scopeType === "agent") await db.delete(agents).where(eq(agents.id, deletedId));
    else await db.delete(projects).where(eq(projects.id, deletedId));
    const policiesBefore = await db.select().from(budgetPolicies), incidentsBefore = await db.select().from(budgetIncidents), costsBefore = await db.select().from(costEvents);

    const overview = await budgetService(db).overview(companyId);
    expect(overview.policies).toHaveLength(2);
    expect(overview.policies.find(row => row.policyId === policy.id)).toMatchObject({ companyId, scopeName: "Current agent", amount: 300, observedAmount: 17 });
    expect(overview.policies.find(row => row.policyId === historical!.id)).toMatchObject({ companyId, scopeType, scopeId: deletedId, scopeName: `Deleted ${scopeType}`, amount: 200 });
    expect(overview.activeIncidents).toMatchObject([{ companyId, policyId: historical!.id, scopeId: deletedId, scopeName: `Deleted ${scopeType}`, status: "open", amountObserved: 201 }]);
    expect(await db.select().from(budgetPolicies)).toEqual(policiesBefore);
    expect(await db.select().from(budgetIncidents)).toEqual(incidentsBefore);
    expect(await db.select().from(costEvents)).toEqual(costsBefore);
  });
  it("rejects missing-scope budget grants but can dismiss their historical incidents", async () => {
    const { companyId, agentId } = await fixture(), missingId = randomUUID(), service = budgetService(db);
    await expect(service.evaluateAdmission(companyId, missingId)).rejects.toThrow("Agent not found");
    await expect(service.evaluateAdmission(companyId, agentId, { projectId: missingId })).rejects.toThrow("Project not found");
    for (const scopeType of ["agent", "project"] as const) {
      await expect(service.upsertPolicy(companyId, { scopeType, scopeId: missingId, amount: 100 }, "board")).rejects.toThrow(`${scopeType === "agent" ? "Agent" : "Project"} not found`);
      const [policy] = await db.insert(budgetPolicies).values({ companyId, scopeType, scopeId: missingId,
        windowKind: "calendar_month_utc", amount: 100 }).returning();
      const [approval] = await db.insert(approvals).values({ companyId, type: "budget_override_required", payload: {} }).returning();
      const [incident] = await db.insert(budgetIncidents).values({ companyId, policyId: policy!.id, approvalId: approval!.id, scopeType, scopeId: missingId,
        metric: "billed_cents", windowKind: "calendar_month_utc", windowStart: new Date("2020-01-01"), windowEnd: new Date("2020-02-01"),
        thresholdType: "hard", amountLimit: 100, amountObserved: 101 }).returning();
      const before = { policies: await db.select().from(budgetPolicies), incidents: await db.select().from(budgetIncidents),
        agents: await db.select().from(agents), costs: await db.select().from(costEvents), approvals: await db.select().from(approvals) };
      await expect(service.resolveIncident(companyId, incident!.id, { action: "raise_budget_and_resume", amount: 200 }, "board"))
        .rejects.toThrow(`${scopeType === "agent" ? "Agent" : "Project"} not found`);
      expect({ policies: await db.select().from(budgetPolicies), incidents: await db.select().from(budgetIncidents),
        agents: await db.select().from(agents), costs: await db.select().from(costEvents), approvals: await db.select().from(approvals) }).toEqual(before);
      const dismissed = await service.resolveIncident(companyId, incident!.id, { action: "keep_paused" }, "board");
      expect(dismissed).toMatchObject({ companyId, policyId: policy!.id, scopeId: missingId, scopeName: `Deleted ${scopeType}`, status: "dismissed" });
      const { status: _status, resolvedAt: _resolvedAt, updatedAt: _updatedAt, ...preserved } = incident!;
      const [saved] = await db.select().from(budgetIncidents).where(eq(budgetIncidents.id, incident!.id));
      expect(saved).toMatchObject({ ...preserved, status: "dismissed", resolvedAt: expect.any(Date) });
      expect((await db.select().from(approvals).where(eq(approvals.id, approval!.id)))[0]).toMatchObject({ status: "rejected" });
      expect(await db.select().from(budgetPolicies)).toEqual(before.policies);
      expect(await db.select().from(agents)).toEqual(before.agents);
      expect(await db.select().from(costEvents)).toEqual(before.costs);
      expect((await service.overview(companyId)).activeIncidents.some(row => row.id === incident!.id)).toBe(false);
    }
  });

  it("rejects a corrupted policy pointing to another company's scope instead of exposing its name", async () => {
    const { companyId } = await fixture(), foreignCompanyId = randomUUID(), foreignAgentId = randomUUID();
    await db.insert(companies).values({ id: foreignCompanyId, name: "Other company", issuePrefix: `F${foreignCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}` });
    await db.insert(agents).values({ id: foreignAgentId, companyId: foreignCompanyId, name: "Private other-company agent", role: "engineer" });
    const [policy] = await db.insert(budgetPolicies).values({ companyId, scopeType: "agent", scopeId: foreignAgentId, windowKind: "calendar_month_utc", amount: 200 }).returning();
    const [incident] = await db.insert(budgetIncidents).values({ companyId, policyId: policy!.id, scopeType: "agent", scopeId: foreignAgentId,
      metric: "billed_cents", windowKind: "calendar_month_utc", windowStart: new Date("2020-01-01"), windowEnd: new Date("2020-02-01"),
      thresholdType: "hard", amountLimit: 200, amountObserved: 201 }).returning();
    const service = budgetService(db);
    await expect(service.overview(companyId)).rejects.toThrow("Budget scope not found");
    for (const scopeId of [foreignAgentId, randomUUID()]) {
      await db.update(budgetIncidents).set({ scopeId }).where(eq(budgetIncidents.id, incident!.id));
      const before = { policies: await db.select().from(budgetPolicies), incidents: await db.select().from(budgetIncidents),
        agents: await db.select().from(agents), costs: await db.select().from(costEvents) };
      for (const action of ["raise_budget_and_resume", "keep_paused"] as const) {
        await expect(service.resolveIncident(companyId, incident!.id, { action, amount: 300 }, "board")).rejects.toThrow("Budget scope not found");
        expect({ policies: await db.select().from(budgetPolicies), incidents: await db.select().from(budgetIncidents),
          agents: await db.select().from(agents), costs: await db.select().from(costEvents) }).toEqual(before);
      }
    }
  });

});
