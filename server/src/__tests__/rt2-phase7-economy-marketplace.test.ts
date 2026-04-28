import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  companies,
  createDb,
  getEmbeddedPostgresTestSupport,
  issueWorkProducts,
  issues,
  projects,
  rt2AgentMarketplace,
  rt2AgentSubscriptions,
  rt2AntiGamingSignals,
  rt2CoinLedger,
  rt2CollaborationEvents,
  rt2CollaborationRewards,
  rt2PersonalPnL,
  rt2QualityScores,
  rt2SettlementGovernance,
  rt2SettlementThresholds,
  rt2V33TaskParticipants,
  rt2V33TaskProfiles,
  startEmbeddedPostgresTestDatabase,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { rt2AgentMarketplaceRoutes } from "../routes/rt2-agent-marketplace.js";
import { rt2CollaborationRewardsRoutes } from "../routes/rt2-collaboration-rewards.js";
import { rt2PersonalPnLRoutes } from "../routes/rt2-personal-pnl.js";
import { rt2PersonalPnLService } from "../services/rt2-personal-pnl.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres RT2 phase 7 economy tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("rt2 phase 7 economy, collaboration, and marketplace", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;
  let companyId!: string;
  let projectId!: string;
  let taskIssueId!: string;
  let workProductId!: string;
  let listingId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-rt2-phase7-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(rt2AgentSubscriptions);
    await db.delete(rt2AgentMarketplace);
    await db.delete(rt2CollaborationEvents);
    await db.delete(rt2CollaborationRewards);
    await db.delete(rt2AntiGamingSignals);
    await db.delete(rt2SettlementGovernance);
    await db.delete(rt2SettlementThresholds);
    await db.delete(rt2CoinLedger);
    await db.delete(rt2PersonalPnL);
    await db.delete(rt2QualityScores);
    await db.delete(issueWorkProducts);
    await db.delete(rt2V33TaskParticipants);
    await db.delete(rt2V33TaskProfiles);
    await db.delete(issues);
    await db.delete(activityLog);
    await db.delete(projects);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(actorCompanyId: string) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        userId: "board-user",
        source: "session",
        isInstanceAdmin: false,
        companyIds: [actorCompanyId],
      };
      next();
    });
    app.use("/api", rt2PersonalPnLRoutes(db));
    app.use("/api", rt2CollaborationRewardsRoutes(db));
    app.use("/api", rt2AgentMarketplaceRoutes(db));
    app.use(errorHandler);
    return app;
  }

  async function seedPhase7Evidence() {
    companyId = randomUUID();
    projectId = randomUUID();
    taskIssueId = randomUUID();
    workProductId = randomUUID();
    listingId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "RT2 Phase 7 Corp",
      issuePrefix: `P${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Amoeba Project",
      status: "in_progress",
    });
    await db.insert(issues).values({
      id: taskIssueId,
      companyId,
      projectId,
      title: "Build marketplace pricing automation",
      description: "Approved deliverable should feed P&L and marketplace evidence",
      status: "completed",
      priority: "high",
      assigneeUserId: "owner-user",
      createdByUserId: "board-user",
    });
    await db.insert(rt2V33TaskProfiles).values({
      issueId: taskIssueId,
      companyId,
      projectId,
      taskMode: "collab",
      capacity: 2,
    });
    await db.insert(rt2V33TaskParticipants).values([
      { companyId, taskIssueId, userId: "owner-user", state: "active" },
      { companyId, taskIssueId, userId: "reviewer-user", state: "active" },
    ]);
    await db.insert(issueWorkProducts).values({
      id: workProductId,
      companyId,
      projectId,
      issueId: taskIssueId,
      type: "pricing",
      provider: "rt2",
      title: "Marketplace pricing automation",
      status: "submitted",
      reviewState: "approved",
      summary: "Pricing workflow and deliverable performance model",
      metadata: {
        rt2Deliverable: true,
        rt2Type: "pricing",
        rt2BasePrice: 240,
      },
    });
    await db.insert(rt2QualityScores).values({
      companyId,
      taskIssueId,
      evaluator: "jarvis",
      evalType: "ai_auto",
      score: 96,
      direction: "positive",
      category: "quality",
      rationale: "Approved high-quality pricing automation",
      isActive: 1,
      managerDecision: "approved",
      isFinalized: 1,
      basePrice: 240,
      evaluationMode: "auto",
    });
    await db.insert(rt2AgentMarketplace).values({
      id: listingId,
      creatorCompanyId: companyId,
      name: "Pricing Jarvis",
      description: "Automates marketplace pricing evidence",
      category: "pricing",
      tags: ["pricing", "automation"],
      pricingType: "per_task",
      pricePerTaskCents: 12000,
      capabilities: JSON.stringify({ skills: ["pricing", "forecast"] }),
      adapterType: "process",
    });
    await db.insert(rt2CollaborationRewards).values({
      companyId,
      actorId: listingId,
      actorType: "agent",
      reputationIndex: 720,
      multiplier: 1.3,
      aiContributionScore: 80,
      totalCollaborations: 4,
      successfulCollaborations: 4,
    });
    await db.insert(rt2AgentSubscriptions).values({
      companyId,
      marketplaceListingId: listingId,
      subscriptionType: "per_task",
      status: "active",
      tasksUsed: 3,
      currentPeriodStart: new Date(),
    });
  }

  it("materializes P&L from approved deliverable evidence and exposes actor drilldowns", async () => {
    await seedPhase7Evidence();
    const app = createApp(companyId);

    const summary = await request(app).get(`/api/companies/${companyId}/rt2/pnl/summary`);
    expect(summary.status).toBe(200);
    expect(summary.body).toEqual(expect.objectContaining({
      approvedDeliverableRevenue: 240,
      approvedDeliverableCount: 1,
      ledgerEntryCount: 2,
      calculationEvidence: expect.objectContaining({
        settlementStatus: "ready",
        approvedDeliverableRevenue: 240,
        sourceTables: expect.arrayContaining(["rt2_coin_ledger", "rt2_quality_scores"]),
      }),
    }));

    const drilldown = await request(app)
      .get(`/api/companies/${companyId}/rt2/pnl/drilldown/owner-user`)
      .query({ actorType: "user" });
    expect(drilldown.status).toBe(200);
    expect(drilldown.body.approvedDeliverables[0]).toEqual(expect.objectContaining({
      workProductId,
      revenue: 120,
      qualityScore: 96,
    }));
  });

  it("hardens settlement governance with thresholds, duplicate guard, and ledger evidence", async () => {
    await seedPhase7Evidence();
    const app = createApp(companyId);

    const thresholdUpdate = await request(app)
      .put(`/api/companies/${companyId}/rt2/pnl/settlements/thresholds`)
      .send({ qualityBiasAutoScore: 90, highValueGold: 500 });
    expect(thresholdUpdate.status).toBe(200);
    expect(thresholdUpdate.body).toEqual(expect.objectContaining({ qualityBiasAutoScore: 90, highValueGold: 500 }));

    const firstOverview = await request(app).get(`/api/companies/${companyId}/rt2/pnl/settlements`);
    expect(firstOverview.status).toBe(200);
    expect(firstOverview.body.thresholds).toEqual(expect.objectContaining({ qualityBiasAutoScore: 90 }));
    expect(firstOverview.body.settlements[0]).toEqual(expect.objectContaining({
      workProductId,
      ledgerEvidence: null,
      antiGamingSignals: expect.arrayContaining([
        expect.objectContaining({ key: "quality_score_bias", thresholdBasis: expect.stringContaining("90") }),
      ]),
    }));

    const secondOverview = await request(app).get(`/api/companies/${companyId}/rt2/pnl/settlements`);
    expect(secondOverview.status).toBe(200);
    const rows = await db
      .select({ id: rt2SettlementGovernance.id })
      .from(rt2SettlementGovernance)
      .where(and(
        eq(rt2SettlementGovernance.companyId, companyId),
        eq(rt2SettlementGovernance.workProductId, workProductId),
      ));
    expect(rows).toHaveLength(1);

    const approval = await request(app)
      .post(`/api/companies/${companyId}/rt2/pnl/settlements/${firstOverview.body.settlements[0].id}/approve`)
      .send({ decisionReason: "threshold evidence reviewed" });
    expect(approval.status).toBe(200);
    expect(approval.body.ledgerEntryId).toBeTruthy();
    expect(approval.body.ledgerEvidence).toEqual(expect.objectContaining({
      amount: 120,
      balanceAfter: expect.any(Number),
      transactionType: "earned",
    }));
  });

  it("records expense ledger rows as debit legs", async () => {
    companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "RT2 Ledger Legs Corp",
      issuePrefix: `L${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const app = createApp(companyId);

    const income = await request(app)
      .post(`/api/companies/${companyId}/rt2/pnl/income`)
      .send({ actorId: "operator-user", actorType: "user", amount: 100, description: "seed balance" });
    expect(income.status).toBe(200);

    const expense = await request(app)
      .post(`/api/companies/${companyId}/rt2/pnl/expense`)
      .send({ actorId: "operator-user", actorType: "user", amount: 25, description: "tool spend" });
    expect(expense.status).toBe(200);

    const history = await request(app)
      .get(`/api/companies/${companyId}/rt2/coins/history/operator-user`)
      .query({ actorType: "user" });
    expect(history.status).toBe(200);
    expect(history.body).toEqual(expect.arrayContaining([
      expect.objectContaining({ transactionType: "earned", amount: 100, leg: "credit" }),
      expect.objectContaining({ transactionType: "spent", amount: -25, leg: "debit", balanceAfter: 75 }),
    ]));
  });

  it("serializes concurrent ledger writes for one actor balance scope", async () => {
    companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "RT2 Ledger Atomicity Corp",
      issuePrefix: `A${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const svc = rt2PersonalPnLService(db);
    const entries = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        svc.recordCoinTransaction(
          companyId,
          "company",
          "company",
          "operator-user",
          "user",
          1,
          "reward",
          `concurrent reward ${index}`,
          `concurrent-${index}`,
          "test",
          "2026-04",
        ),
      ),
    );

    expect(entries.map((entry) => entry.balanceAfter).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("returns marketplace listings with live skill, pricing, quality, reputation, and subscription evidence", async () => {
    await seedPhase7Evidence();
    const app = createApp(companyId);

    const response = await request(app).get(`/api/companies/${companyId}/rt2/marketplace/agents`);
    expect(response.status).toBe(200);
    expect(response.body[0]).toEqual(expect.objectContaining({
      id: listingId,
      evidence: expect.objectContaining({
        skills: expect.arrayContaining(["pricing", "automation", "forecast"]),
        deliverableCount: 1,
        approvedDeliverableCount: 1,
        averageQualityScore: 96,
        approvedBasePriceGold: 240,
        earnedGoldEstimate: 240,
        reputationIndex: 720,
        collaborationMultiplier: 1.3,
        subscriptionCount: 1,
        evidenceStatus: "ready",
        latestApprovedDeliverables: [
          expect.objectContaining({ workProductId, basePriceGold: 240, qualityScore: 96 }),
        ],
      }),
    }));
  });

  it("derives collaboration rewards from persisted cross-contribution evidence idempotently", async () => {
    await seedPhase7Evidence();
    const app = createApp(companyId);

    const first = await request(app).post(`/api/companies/${companyId}/rt2/collaboration/derive-rewards`);
    expect(first.status).toBe(200);
    expect(first.body.createdEvents).toBe(2);

    const second = await request(app).post(`/api/companies/${companyId}/rt2/collaboration/derive-rewards`);
    expect(second.status).toBe(200);
    expect(second.body.createdEvents).toBe(0);

    const history = await request(app).get(`/api/companies/${companyId}/rt2/collaboration/history/owner-user`);
    expect(history.status).toBe(200);
    expect(history.body[0]).toEqual(expect.objectContaining({
      collaborationType: "pair_work",
      successful: "yes",
      description: expect.stringContaining(workProductId),
    }));
  });
});
