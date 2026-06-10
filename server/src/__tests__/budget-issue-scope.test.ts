import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createDb,
  companies,
  agents,
  issues,
  planDetails,
  costEvents,
  budgetPolicies,
  budgetIncidents,
  activityLog,
  approvals,
} from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { budgetService } from "../services/budgets.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("budget issue-scope hard stop", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-budget-issue-scope-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(budgetIncidents);
    await db.delete(approvals);
    await db.delete(budgetPolicies);
    await db.delete(costEvents);
    await db.delete(planDetails);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const planId = randomUUID();
    const childId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Hive",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "QA",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values([
      { id: planId, companyId, title: "Plan", status: "backlog", workMode: "planning" },
      { id: childId, companyId, title: "Child", status: "in_progress", planRootIssueId: planId, assigneeAgentId: agentId },
    ]);
    await db.insert(planDetails).values({ issueId: planId, companyId, state: "active" });
    return { companyId, agentId, planId, childId };
  }

  it("hard-stops on a token cap, cancels the subtree, and stops the plan", async () => {
    const { companyId, agentId, planId, childId } = await seed();
    // Token cap of 100 on the plan root (lifetime).
    await db.insert(budgetPolicies).values({
      companyId,
      scopeType: "issue",
      scopeId: planId,
      metric: "total_tokens",
      windowKind: "lifetime",
      amount: 100,
      warnPercent: 80,
      hardStopEnabled: true,
      notifyEnabled: true,
      isActive: true,
    });
    // A cost event on the CHILD (counts toward the plan root via plan_root_issue_id).
    const [event] = await db
      .insert(costEvents)
      .values({
        companyId,
        agentId,
        issueId: childId,
        provider: "anthropic",
        biller: "anthropic",
        billingType: "subscription",
        model: "claude",
        inputTokens: 80,
        cachedInputTokens: 10,
        outputTokens: 50,
        costCents: 0,
        occurredAt: new Date(),
      })
      .returning();

    const cancelWorkForScope = vi.fn().mockResolvedValue(undefined);
    const budgets = budgetService(db, { cancelWorkForScope });

    await budgets.evaluateCostEvent(event);

    // Subtree work cancellation invoked with issue scope on the plan root.
    expect(cancelWorkForScope).toHaveBeenCalledWith(
      expect.objectContaining({ companyId, scopeType: "issue", scopeId: planId }),
    );
    // Plan marked stopped by the budget cap.
    const [plan] = await db.select().from(planDetails).where(eq(planDetails.issueId, planId));
    expect(plan.state).toBe("stopped");
    expect(plan.stopReason).toBe("budget_cap");
    // A hard incident was opened.
    const incidents = await db.select().from(budgetIncidents).where(eq(budgetIncidents.companyId, companyId));
    expect(incidents.length).toBeGreaterThan(0);
  });

  it("blocks new invocations once the plan is stopped", async () => {
    const { companyId, agentId, planId, childId } = await seed();
    await db
      .update(planDetails)
      .set({ state: "stopped", stopReason: "budget_cap" })
      .where(eq(planDetails.issueId, planId));

    const budgets = budgetService(db, {});
    const block = await budgets.getInvocationBlock(companyId, agentId, { issueId: childId });
    expect(block).not.toBeNull();
    expect(block?.scopeType).toBe("issue");
  });

  it("does not hard-stop below the token cap", async () => {
    const { companyId, agentId, planId, childId } = await seed();
    await db.insert(budgetPolicies).values({
      companyId,
      scopeType: "issue",
      scopeId: planId,
      metric: "total_tokens",
      windowKind: "lifetime",
      amount: 1_000_000,
      warnPercent: 80,
      hardStopEnabled: true,
      notifyEnabled: true,
      isActive: true,
    });
    const [event] = await db
      .insert(costEvents)
      .values({
        companyId,
        agentId,
        issueId: childId,
        provider: "anthropic",
        biller: "anthropic",
        billingType: "subscription",
        model: "claude",
        inputTokens: 10,
        cachedInputTokens: 0,
        outputTokens: 10,
        costCents: 0,
        occurredAt: new Date(),
      })
      .returning();

    const cancelWorkForScope = vi.fn().mockResolvedValue(undefined);
    const budgets = budgetService(db, { cancelWorkForScope });
    await budgets.evaluateCostEvent(event);

    expect(cancelWorkForScope).not.toHaveBeenCalled();
    const [plan] = await db.select().from(planDetails).where(eq(planDetails.issueId, planId));
    expect(plan.state).toBe("active");
  });
});
