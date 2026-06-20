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

describeEmbeddedPostgres("budget hard-stop grace band", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-budget-grace-band-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  // Delete order is bottom-up by FK dependency (children before parents) so
  // teardown stays clean even under RESTRICT constraints.
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

  // total_tokens = inputTokens + cachedInputTokens + outputTokens
  async function recordTokens(
    seedResult: { companyId: string; agentId: string; childId: string },
    inputTokens: number,
    outputTokens: number,
  ) {
    const [event] = await db
      .insert(costEvents)
      .values({
        companyId: seedResult.companyId,
        agentId: seedResult.agentId,
        issueId: seedResult.childId,
        provider: "anthropic",
        biller: "anthropic",
        billingType: "subscription",
        model: "claude",
        inputTokens,
        cachedInputTokens: 0,
        outputTokens,
        costCents: 0,
        occurredAt: new Date(),
      })
      .returning();
    return event;
  }

  async function tokenCap(planId: string, companyId: string, amount: number) {
    await db.insert(budgetPolicies).values({
      companyId,
      scopeType: "issue",
      scopeId: planId,
      metric: "total_tokens",
      windowKind: "lifetime",
      amount,
      warnPercent: 80,
      hardStopEnabled: true,
      notifyEnabled: true,
      isActive: true,
    });
  }

  it("within the grace band: pauses (stops plan) but does NOT cancel in-flight work", async () => {
    const s = await seed();
    await tokenCap(s.planId, s.companyId, 100); // ceiling at 1.25x = 125
    const event = await recordTokens(s, 60, 50); // observed 110 → over cap, under ceiling

    const cancelWorkForScope = vi.fn().mockResolvedValue(undefined);
    const budgets = budgetService(db, { cancelWorkForScope }, { hardStopGraceFactor: 1.25 });
    await budgets.evaluateCostEvent(event);

    // In-flight work survives — no cancellation hook fired.
    expect(cancelWorkForScope).not.toHaveBeenCalled();
    // Plan is stopped so NO new subtree work can start (boundary stop).
    const [plan] = await db.select().from(planDetails).where(eq(planDetails.issueId, s.planId));
    expect(plan.state).toBe("stopped");
    expect(plan.stopReason).toBe("budget_cap");
    // A hard incident was still opened for the board.
    const incidents = await db.select().from(budgetIncidents).where(eq(budgetIncidents.companyId, s.companyId));
    expect(incidents.some((i) => i.thresholdType === "hard")).toBe(true);
  });

  it("past the grace ceiling: full pause-and-cancel (runaway)", async () => {
    const s = await seed();
    await tokenCap(s.planId, s.companyId, 100); // ceiling at 1.25x = 125
    const event = await recordTokens(s, 120, 80); // observed 200 → over ceiling

    const cancelWorkForScope = vi.fn().mockResolvedValue(undefined);
    const budgets = budgetService(db, { cancelWorkForScope }, { hardStopGraceFactor: 1.25 });
    await budgets.evaluateCostEvent(event);

    expect(cancelWorkForScope).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: s.companyId, scopeType: "issue", scopeId: s.planId }),
    );
    const [plan] = await db.select().from(planDetails).where(eq(planDetails.issueId, s.planId));
    expect(plan.state).toBe("stopped");
  });

  it("at exactly the grace ceiling: full pause-and-cancel (ceiling is exclusive)", async () => {
    const s = await seed();
    await tokenCap(s.planId, s.companyId, 100); // ceiling at 1.25x = 125
    const event = await recordTokens(s, 75, 50); // observed exactly 125 = ceiling

    const cancelWorkForScope = vi.fn().mockResolvedValue(undefined);
    const budgets = budgetService(db, { cancelWorkForScope }, { hardStopGraceFactor: 1.25 });
    await budgets.evaluateCostEvent(event);

    // At exactly cap*graceFactor the grace check (strict `<`) is false → cancel.
    expect(cancelWorkForScope).toHaveBeenCalledWith(
      expect.objectContaining({ scopeType: "issue", scopeId: s.planId }),
    );
  });

  it("reads the grace factor from PAPERCLIP_BUDGET_HARDSTOP_GRACE_FACTOR when no option is passed", async () => {
    const s = await seed();
    await tokenCap(s.planId, s.companyId, 100); // env factor 1.5 → ceiling 150
    const event = await recordTokens(s, 70, 50); // observed 120 → over cap, under env ceiling

    const prev = process.env.PAPERCLIP_BUDGET_HARDSTOP_GRACE_FACTOR;
    process.env.PAPERCLIP_BUDGET_HARDSTOP_GRACE_FACTOR = "1.5";
    try {
      const cancelWorkForScope = vi.fn().mockResolvedValue(undefined);
      const budgets = budgetService(db, { cancelWorkForScope }); // no options → env path
      await budgets.evaluateCostEvent(event);
      // 120 < 150 → grace: no cancel, plan stopped.
      expect(cancelWorkForScope).not.toHaveBeenCalled();
      const [plan] = await db.select().from(planDetails).where(eq(planDetails.issueId, s.planId));
      expect(plan.state).toBe("stopped");
    } finally {
      if (prev === undefined) delete process.env.PAPERCLIP_BUDGET_HARDSTOP_GRACE_FACTOR;
      else process.env.PAPERCLIP_BUDGET_HARDSTOP_GRACE_FACTOR = prev;
    }
  });

  it("graceFactor 1.0 reproduces pre-grace behavior: cancels at exactly the cap", async () => {
    const s = await seed();
    await tokenCap(s.planId, s.companyId, 100); // ceiling at 1.0x = 100
    const event = await recordTokens(s, 60, 40); // observed exactly 100

    const cancelWorkForScope = vi.fn().mockResolvedValue(undefined);
    const budgets = budgetService(db, { cancelWorkForScope }, { hardStopGraceFactor: 1.0 });
    await budgets.evaluateCostEvent(event);

    expect(cancelWorkForScope).toHaveBeenCalledWith(
      expect.objectContaining({ scopeType: "issue", scopeId: s.planId }),
    );
  });
});
