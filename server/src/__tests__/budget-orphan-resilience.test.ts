import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  budgetIncidents,
  budgetPolicies,
  companies,
  createDb,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { dashboardService } from "../services/dashboard.ts";
import { agentService } from "../services/agents.ts";
import { budgetService } from "../services/budgets.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres budget-orphan tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("budget orphan resilience", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-budget-orphan-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(budgetIncidents);
    await db.delete(budgetPolicies);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndAgent() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values([
      {
        id: companyId,
        name: "Paperclip",
        issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
    ]);
    await db.insert(agents).values([
      {
        id: agentId,
        companyId,
        name: "CodexCoder",
        role: "engineer",
        status: "running",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    return { companyId, agentId };
  }

  it("cascade-deletes agent-scoped budget policies when the agent is removed", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const policyId = randomUUID();
    await db.insert(budgetPolicies).values({
      id: policyId,
      companyId,
      scopeType: "agent",
      scopeId: agentId,
      metric: "billed_cents",
      windowKind: "calendar_month_utc",
      amount: 100,
      warnPercent: 80,
      hardStopEnabled: true,
      notifyEnabled: true,
      isActive: true,
    });

    await agentService(db).remove(agentId);

    const remaining = await db
      .select()
      .from(budgetPolicies)
      .where(eq(budgetPolicies.scopeId, agentId));
    expect(remaining).toHaveLength(0);
  });

  it("does not throw from the dashboard summary when a budget policy references a missing agent", async () => {
    const { companyId } = await seedCompanyAndAgent();
    // Pre-existing orphan: a policy pointing at an agent id that does not exist.
    await db.insert(budgetPolicies).values({
      id: randomUUID(),
      companyId,
      scopeType: "agent",
      scopeId: randomUUID(),
      metric: "billed_cents",
      windowKind: "calendar_month_utc",
      amount: 100,
      warnPercent: 80,
      hardStopEnabled: true,
      notifyEnabled: true,
      isActive: true,
    });

    const summary = await dashboardService(db).summary(companyId);
    expect(summary.companyId).toBe(companyId);
    expect(summary.budgets.activeIncidents).toBe(0);

    // The budget overview itself must tolerate the orphan too.
    const overview = await budgetService(db).overview(companyId);
    expect(overview.pausedAgentCount).toBe(0);
  });
});
