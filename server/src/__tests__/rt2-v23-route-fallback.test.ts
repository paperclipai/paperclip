import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { rt2AgentMarketplaceRoutes } from "../routes/rt2-agent-marketplace.js";
import { rt2CollaborationRewardsRoutes } from "../routes/rt2-collaboration-rewards.js";
import { rt2EnterpriseRoutes } from "../routes/rt2-enterprise.js";
import { rt2KnowledgeRoutes } from "../routes/rt2-knowledge.js";
import { rt2PersonalPnLRoutes } from "../routes/rt2-personal-pnl.js";

const mocks = vi.hoisted(() => ({
  knowledge: {
    projectAll: vi.fn(),
    listWikiPages: vi.fn(),
    getWikiPage: vi.fn(),
    exportObsidianVault: vi.fn(),
    previewObsidianVaultImport: vi.fn(),
  },
  pnl: {
    getCompanyPnLSummary: vi.fn(),
    getActorPnLDrilldown: vi.fn(),
  },
  marketplace: {
    listCompanyMarketplaceAgents: vi.fn(),
  },
  collaboration: {
    deriveCollaborationRewardsFromEvidence: vi.fn(),
    getActorCollaborationHistory: vi.fn(),
  },
  enterprise: {
    saveRolloutSettings: vi.fn(),
    getRolloutOverview: vi.fn(),
  },
}));

vi.mock("../services/rt2-knowledge-projector.js", () => ({
  rt2KnowledgeProjectorService: () => mocks.knowledge,
}));

vi.mock("../services/rt2-personal-pnl.js", () => ({
  rt2PersonalPnLService: () => mocks.pnl,
}));

vi.mock("../services/rt2-agent-marketplace.js", () => ({
  rt2AgentMarketplaceService: () => mocks.marketplace,
}));

vi.mock("../services/rt2-collaboration-rewards.js", () => ({
  rt2CollaborationRewardsService: () => mocks.collaboration,
}));

vi.mock("../services/rt2-enterprise.js", () => ({
  rt2EnterpriseService: () => mocks.enterprise,
}));

const companyId = "company-v23-route-fallback";

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: [companyId],
    };
    next();
  });
  app.use("/api", rt2KnowledgeRoutes(null as never));
  app.use("/api", rt2PersonalPnLRoutes(null as never));
  app.use("/api", rt2AgentMarketplaceRoutes(null as never));
  app.use("/api", rt2CollaborationRewardsRoutes(null as never));
  app.use("/api", rt2EnterpriseRoutes(null as never));
  app.use(errorHandler);
  return app;
}

describe("RT2 v2.3 fallback route contracts", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mocks.knowledge.projectAll.mockResolvedValue({
      companyId,
      processedEvents: 1,
      pendingEvents: 0,
      wikiPages: 1,
      graphNodes: 1,
      graphEdges: 0,
      lastProjectedAt: "2026-04-25T00:00:00.000Z",
    });
    mocks.knowledge.exportObsidianVault.mockResolvedValue({
      companyId,
      vaultName: "RT2 Knowledge Vault",
      files: [{ path: "index.md", content: "---\nrt2_source_event_ids: [evt-1]\n---\n# Index" }],
    });
    mocks.knowledge.previewObsidianVaultImport.mockResolvedValue({
      companyId,
      evidenceStatus: "ready",
      fileCount: 1,
      missingEventIds: [],
      candidates: [],
      warnings: [],
    });

    mocks.pnl.getCompanyPnLSummary.mockResolvedValue({
      companyId,
      approvedDeliverableRevenue: 240,
      approvedDeliverableCount: 1,
      ledgerEntryCount: 2,
      calculationEvidence: {
        settlementStatus: "ready",
        approvedDeliverableRevenue: 240,
        sourceTables: ["rt2_coin_ledger", "rt2_quality_scores"],
      },
    });
    mocks.pnl.getActorPnLDrilldown.mockResolvedValue({
      companyId,
      actorId: "owner-user",
      actorType: "user",
      approvedDeliverables: [{ workProductId: "work-product-1", revenue: 120, qualityScore: 96 }],
    });
    mocks.marketplace.listCompanyMarketplaceAgents.mockResolvedValue([
      {
        id: "listing-1",
        evidence: {
          approvedBasePriceGold: 240,
          earnedGoldEstimate: 240,
          evidenceStatus: "ready",
        },
      },
    ]);
    mocks.collaboration.deriveCollaborationRewardsFromEvidence.mockResolvedValue({ createdEvents: 2 });
    mocks.collaboration.getActorCollaborationHistory.mockResolvedValue([
      { actorId: "owner-user", collaborationType: "pair_work", successful: "yes" },
    ]);
    mocks.enterprise.saveRolloutSettings.mockResolvedValue({
      changed: ["sso", "binding", "policy", "template"],
      overview: {
        companyId,
        evidence: {
          overallStatus: "ready",
          readyCount: 4,
          items: [
            { area: "sso", status: "ready" },
            { area: "binding", status: "ready" },
            { area: "policy", status: "ready" },
            { area: "template", status: "ready" },
          ],
        },
      },
    });
    mocks.enterprise.getRolloutOverview.mockResolvedValue({
      companyId,
      recommendedDefaults: {
        bindingMode: "authenticated",
        policyDefault: "operator_safe",
      },
    });
  });

  it("validates Knowledge Bridge route contracts without embedded Postgres", async () => {
    const app = createApp();

    const project = await request(app)
      .post(`/api/companies/${companyId}/rt2/knowledge/project`)
      .send({ limit: 10 });
    expect(project.status).toBe(200);
    expect(project.body).toEqual(expect.objectContaining({ companyId, processedEvents: 1 }));

    const vault = await request(app)
      .get(`/api/companies/${companyId}/rt2/knowledge/vault-export`)
      .query({ limit: 5 });
    expect(vault.status).toBe(200);
    expect(vault.body.files[0]).toEqual(expect.objectContaining({ path: "index.md" }));

    const preview = await request(app)
      .post(`/api/companies/${companyId}/rt2/knowledge/vault-import-preview`)
      .send({ vaultName: vault.body.vaultName, files: vault.body.files });
    expect(preview.status).toBe(200);
    expect(preview.body).toEqual(expect.objectContaining({ evidenceStatus: "ready", missingEventIds: [] }));
  });

  it("validates economy, marketplace, and collaboration route contracts without embedded Postgres", async () => {
    const app = createApp();

    const summary = await request(app).get(`/api/companies/${companyId}/rt2/pnl/summary`);
    expect(summary.status).toBe(200);
    expect(summary.body.calculationEvidence).toEqual(expect.objectContaining({ settlementStatus: "ready" }));

    const marketplace = await request(app).get(`/api/companies/${companyId}/rt2/marketplace/agents`);
    expect(marketplace.status).toBe(200);
    expect(marketplace.body[0].evidence).toEqual(expect.objectContaining({ evidenceStatus: "ready" }));

    const rewards = await request(app).post(`/api/companies/${companyId}/rt2/collaboration/derive-rewards`);
    expect(rewards.status).toBe(200);
    expect(rewards.body).toEqual({ createdEvents: 2 });
  });

  it("validates enterprise rollout route contracts without embedded Postgres", async () => {
    const app = createApp();

    const saved = await request(app)
      .post(`/api/companies/${companyId}/rt2/enterprise/rollout`)
      .send({
        sso: { provider: "microsoft", issuerUrl: "https://login.example.com" },
        binding: { mode: "authenticated" },
        policy: { policyDefault: "operator_safe" },
        template: { name: "iSens RT2 운영 템플릿", category: "enterprise" },
      });
    expect(saved.status).toBe(200);
    expect(saved.body.overview.evidence).toEqual(expect.objectContaining({ overallStatus: "ready" }));

    const overview = await request(app).get(`/api/companies/${companyId}/rt2/enterprise/rollout`);
    expect(overview.status).toBe(200);
    expect(overview.body.recommendedDefaults).toEqual(expect.objectContaining({ bindingMode: "authenticated" }));
  });
});
