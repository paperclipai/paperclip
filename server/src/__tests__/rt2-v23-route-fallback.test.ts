import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { rt2AgentMarketplaceRoutes } from "../routes/rt2-agent-marketplace.js";
import { rt2CollaborationRewardsRoutes } from "../routes/rt2-collaboration-rewards.js";
import { rt2EnterpriseRoutes } from "../routes/rt2-enterprise.js";
import { rt2KnowledgeRoutes } from "../routes/rt2-knowledge.js";
import { rt2PersonalPnLRoutes } from "../routes/rt2-personal-pnl.js";
import { rt2TaskRoutes } from "../routes/rt2-tasks.js";

const mocks = vi.hoisted(() => ({
  knowledge: {
    projectAll: vi.fn(),
    listWikiPages: vi.fn(),
    getWikiPage: vi.fn(),
    exportObsidianVault: vi.fn(),
    getVaultWriterSettings: vi.fn(),
    saveVaultWriterSettings: vi.fn(),
    dryRunVaultWriter: vi.fn(),
    previewObsidianVaultImport: vi.fn(),
    applyObsidianVaultImport: vi.fn(),
    resolveObsidianVaultConflict: vi.fn(),
  },
  pnl: {
    getCompanyPnLSummary: vi.fn(),
    getActorPnLDrilldown: vi.fn(),
    getSettlementOverview: vi.fn(),
    addSettlementComment: vi.fn(),
    approveSettlement: vi.fn(),
    rejectSettlement: vi.fn(),
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
    validateSsoProviderMetadata: vi.fn(),
    validateSsoHandshake: vi.fn(),
    previewScimSync: vi.fn(),
    createScimPreview: vi.fn(),
    applyScimPreview: vi.fn(),
  },
  workBoard: {
    createInboundDraft: vi.fn(),
    getBoardOverview: vi.fn(),
    updateCard: vi.fn(),
    addChecklistItem: vi.fn(),
    updateChecklistItem: vi.fn(),
    reorderChecklist: vi.fn(),
    addAttachment: vi.fn(),
    listCaptureQueue: vi.fn(),
    promoteCaptureDraft: vi.fn(),
    failCaptureDraft: vi.fn(),
  },
  taskEngine: {
    listByProject: vi.fn(),
    createTask: vi.fn(),
    getTaskMeta: vi.fn(),
    getDetail: vi.fn(),
    listAssignableUsers: vi.fn(),
  },
  taskExecution: {},
  issues: {
    getById: vi.fn(),
  },
  logActivity: vi.fn(),
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

vi.mock("../services/rt2-work-board.js", () => ({
  rt2WorkBoardService: () => mocks.workBoard,
}));

vi.mock("../services/rt2-task-engine.js", () => ({
  rt2TaskEngineService: () => mocks.taskEngine,
}));

vi.mock("../services/rt2-task-execution.js", () => ({
  rt2TaskExecutionService: () => mocks.taskExecution,
}));

vi.mock("../services/issues.js", () => ({
  issueService: () => mocks.issues,
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: mocks.logActivity,
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
  app.use("/api", rt2TaskRoutes(null as never));
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
      candidates: [
        { id: "wiki:index.md", kind: "wiki_page", action: "update", targetKey: "index.md", label: "Index", status: "ready" },
      ],
      conflicts: [],
      warnings: [],
    });
    mocks.knowledge.getVaultWriterSettings.mockResolvedValue(null);
    mocks.knowledge.saveVaultWriterSettings.mockResolvedValue({
      companyId,
      vaultName: "RT2 Knowledge Vault",
      rootPath: "C:/vault",
      exportSubdirectory: "rt2-export",
      exportPath: "C:/vault/rt2-export",
      writerMode: "dry_run",
      lastDryRun: { fileCount: 1, conflictCount: 0 },
      updatedAt: "2026-04-25T00:00:00.000Z",
    });
    mocks.knowledge.dryRunVaultWriter.mockResolvedValue({
      companyId,
      vaultName: "RT2 Knowledge Vault",
      rootPath: "C:/vault",
      exportPath: "C:/vault/rt2-export",
      writerMode: "dry_run",
      fileCount: 1,
      conflictCount: 0,
      files: [],
      warnings: [],
      generatedAt: "2026-04-25T00:00:00.000Z",
    });
    mocks.knowledge.applyObsidianVaultImport.mockResolvedValue({
      companyId,
      appliedCandidateIds: ["wiki:index.md"],
      skippedCandidateIds: [],
      updatedWikiPages: 1,
      updatedGraphNodes: 1,
      updatedGraphEdges: 0,
      auditId: "audit-import-1",
      appliedAt: "2026-04-25T00:00:00.000Z",
    });
    mocks.knowledge.resolveObsidianVaultConflict.mockResolvedValue({
      companyId,
      pageKey: "index.md",
      decision: "rt2_wins",
      applied: false,
      auditId: "audit-conflict-1",
      resolvedAt: "2026-04-25T00:00:00.000Z",
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
    mocks.pnl.getSettlementOverview.mockResolvedValue({
      companyId,
      period: "2026-04",
      summary: { total: 1, proposed: 0, approvalRequired: 1, approved: 0, rejected: 0, highRisk: 1 },
      settlements: [
        {
          id: "settlement-1",
          companyId,
          workProductId: "work-product-1",
          taskIssueId: "task-1",
          ownerActorId: "owner-user",
          ownerActorType: "user",
          proposedPriceGold: 1200,
          finalPriceGold: null,
          rationale: "High value approved deliverable.",
          negotiationComments: [],
          status: "approval_required",
          approvalRequired: true,
          approvalGateReason: "High-value deliverable settlement.",
          riskLevel: "high",
          antiGamingSignals: [
            { key: "abnormal_gold_farming", label: "Gold farming 이상치", severity: "warning", evidence: "Earned ledger spike." },
          ],
          approverId: null,
          decisionReason: null,
          ledgerEntryId: null,
          pnlPeriod: "2026-04",
        },
      ],
    });
    mocks.pnl.addSettlementComment.mockResolvedValue({ id: "settlement-1", status: "approval_required" });
    mocks.pnl.approveSettlement.mockResolvedValue({
      id: "settlement-1",
      status: "approved",
      workProductId: "work-product-1",
      finalPriceGold: 1200,
      ledgerEntryId: "ledger-1",
      antiGamingSignals: [{ key: "abnormal_gold_farming" }],
    });
    mocks.pnl.rejectSettlement.mockResolvedValue({
      id: "settlement-1",
      status: "rejected",
      workProductId: "work-product-1",
      antiGamingSignals: [{ key: "abnormal_gold_farming" }],
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
      readiness: {
        overallStatus: "pass",
        items: [],
      },
      auditLog: [],
    });
    mocks.enterprise.validateSsoProviderMetadata.mockReturnValue({
      provider: "microsoft",
      status: "warning",
      checkedAt: "2026-04-25T00:00:00.000Z",
      certificateExpiresAt: null,
      checks: [
        { key: "issuer", label: "Issuer URL", status: "pass", detail: "HTTPS issuer accepted." },
        { key: "certificate", label: "Certificate expiry", status: "warning", detail: "Certificate was not provided." },
      ],
      warnings: ["Certificate was not provided."],
    });
    mocks.enterprise.validateSsoHandshake.mockResolvedValue({
      evidenceId: "sso-evidence-1",
      provider: "microsoft",
      status: "pass",
      checkedAt: "2026-04-25T00:00:00.000Z",
      certificateExpiresAt: null,
      checks: [
        { key: "issuer", label: "Issuer URL", status: "pass", detail: "HTTPS issuer accepted." },
        { key: "callback-state", label: "Callback state", status: "pass", detail: "Callback state matches." },
      ],
      callbackStateChecks: [
        { key: "callback-state", label: "Callback state", status: "pass", detail: "Callback state matches." },
      ],
      failureReasons: [],
      warnings: [],
    });
    mocks.enterprise.previewScimSync.mockReturnValue({
      status: "warning",
      checkedAt: "2026-04-25T00:00:00.000Z",
      summary: { create: 1, update: 1, deactivate: 1, warnings: 1 },
      candidates: [
        { kind: "user", action: "deactivate", externalId: "u-2", label: "former@isens.local", reason: "Inactive source user.", warnings: ["Requires review."] },
      ],
      warnings: ["1 deactivate candidate(s) require operator approval before apply."],
    });
    mocks.enterprise.createScimPreview.mockResolvedValue({
      previewId: "scim-preview-1",
      previewFingerprint: "fingerprint-1",
      status: "warning",
      checkedAt: "2026-04-25T00:00:00.000Z",
      summary: { create: 1, update: 1, deactivate: 1, warnings: 1 },
      candidates: [
        { id: "user:deactivate:u-2", kind: "user", action: "deactivate", externalId: "u-2", label: "former@isens.local", reason: "Inactive source user.", warnings: ["Requires review."] },
      ],
      warnings: ["1 deactivate candidate(s) require operator approval before apply."],
    });
    mocks.enterprise.applyScimPreview.mockResolvedValue({
      evidenceId: "scim-apply-1",
      previewId: "scim-preview-1",
      previewFingerprint: "fingerprint-1",
      status: "partial",
      appliedAt: "2026-04-25T00:01:00.000Z",
      summary: { applied: 1, skipped: 0, failed: 1, rollbackCandidates: 1 },
      candidates: [
        { candidateId: "user:deactivate:u-2", kind: "user", action: "deactivate", externalId: "u-2", label: "former@isens.local", status: "applied", reason: "Candidate apply evidence recorded." },
        { candidateId: "user:update:u-3", kind: "user", action: "update", externalId: "u-3", label: "bad", status: "failed", reason: "User email is not a valid address.", failureReason: { code: "candidate_validation_failed", message: "User email is not a valid address." } },
      ],
      rollbackCandidates: [
        { candidateId: "user:deactivate:u-2", kind: "user", externalId: "u-2", action: "deactivate", priorState: { externalId: "u-2" }, targetState: { action: "deactivate" }, reason: "Operator review." },
      ],
      failureReasons: [{ code: "candidate_validation_failed", message: "User email is not a valid address." }],
    });

    mocks.workBoard.getBoardOverview.mockResolvedValue({
      companyId,
      cards: [{
        issueId: "task-1",
        dueDate: "2026-04-30",
        qualityStatus: "pending_review",
        priceGold: 900,
        detailNotes: null,
        checklist: [{ id: "check-1", issueId: "task-1", title: "계약서 확인", checked: false, position: 0 }],
        attachments: [{ id: "att-1", issueId: "task-1", label: "제안서", url: "https://example.com/proposal.pdf", contentType: "application/pdf", previewKind: "document", position: 0 }],
        checklistDone: 0,
        checklistTotal: 1,
        checklistProgress: 0,
      }],
      filters: {
        lanes: ["todo"],
        assigneeIds: ["user:board-user"],
        okrIds: ["goal-1"],
        qualityStatuses: ["pending_review"],
        due: ["upcoming"],
      },
    });
    mocks.workBoard.updateCard.mockResolvedValue({ issueId: "task-1", dueDate: "2026-04-30", qualityStatus: "reviewed" });
    mocks.workBoard.addChecklistItem.mockResolvedValue({ id: "check-2", issueId: "task-1", title: "견적 확인", checked: false, position: 1 });
    mocks.workBoard.updateChecklistItem.mockResolvedValue({ id: "check-1", issueId: "task-1", title: "계약서 확인", checked: true, position: 0 });
    mocks.workBoard.reorderChecklist.mockResolvedValue([{ id: "check-1", position: 0 }]);
    mocks.workBoard.addAttachment.mockResolvedValue({ id: "att-2", issueId: "task-1", label: "시안", url: "https://example.com/mock.png", previewKind: "image" });
    mocks.workBoard.createInboundDraft.mockResolvedValue({
      id: "draft-1",
      companyId,
      source: "native",
      channel: "ios-share",
      externalUserId: "mobile-user",
      rawText: "제안서 보완",
      parsedDraft: { taskTitle: "제안서 보완", deliverableTitle: "제안서" },
      status: "review_required",
      duplicateOfDraftId: null,
      permissionStatus: "allowed",
    });
    mocks.workBoard.listCaptureQueue.mockResolvedValue({
      companyId,
      summary: { reviewRequired: 1, duplicate: 1, permissionBlocked: 1, failed: 0, promoted: 0 },
      drafts: [{ id: "draft-1", source: "native", status: "review_required", duplicateOfDraftId: null, permissionStatus: "allowed" }],
    });
    mocks.workBoard.promoteCaptureDraft.mockResolvedValue({ id: "draft-1", status: "promoted", promotionTarget: "task", promotedIssueId: "task-2" });
    mocks.workBoard.failCaptureDraft.mockResolvedValue({ id: "draft-1", status: "failed", failureCode: "source_failure" });
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

    const writer = await request(app)
      .post(`/api/companies/${companyId}/rt2/knowledge/vault-writer`)
      .send({ rootPath: "C:/vault", exportSubdirectory: "rt2-export" });
    expect(writer.status).toBe(200);
    expect(writer.body.exportPath).toBe("C:/vault/rt2-export");

    const apply = await request(app)
      .post(`/api/companies/${companyId}/rt2/knowledge/vault-import-apply`)
      .send({ vaultName: vault.body.vaultName, files: vault.body.files, approvedCandidateIds: ["wiki:index.md"] });
    expect(apply.status).toBe(200);
    expect(apply.body.updatedWikiPages).toBe(1);

    const conflict = await request(app)
      .post(`/api/companies/${companyId}/rt2/knowledge/vault-conflict-resolve`)
      .send({ file: vault.body.files[0], decision: "rt2_wins", reason: "keep RT2 truth" });
    expect(conflict.status).toBe(200);
    expect(conflict.body).toEqual(expect.objectContaining({ decision: "rt2_wins", auditId: "audit-conflict-1" }));
  });

  it("validates economy, marketplace, and collaboration route contracts without embedded Postgres", async () => {
    const app = createApp();

    const summary = await request(app).get(`/api/companies/${companyId}/rt2/pnl/summary`);
    expect(summary.status).toBe(200);
    expect(summary.body.calculationEvidence).toEqual(expect.objectContaining({ settlementStatus: "ready" }));

    const settlements = await request(app).get(`/api/companies/${companyId}/rt2/pnl/settlements`);
    expect(settlements.status).toBe(200);
    expect(settlements.body.summary).toEqual(expect.objectContaining({ approvalRequired: 1 }));

    const comment = await request(app)
      .post(`/api/companies/${companyId}/rt2/pnl/settlements/settlement-1/comment`)
      .send({ comment: "worker asked for high-value settlement review" });
    expect(comment.status).toBe(200);
    expect(mocks.pnl.addSettlementComment).toHaveBeenCalledWith(companyId, "settlement-1", expect.objectContaining({
      comment: "worker asked for high-value settlement review",
    }));

    const approval = await request(app)
      .post(`/api/companies/${companyId}/rt2/pnl/settlements/settlement-1/approve`)
      .send({ finalPriceGold: 1200, decisionReason: "basis accepted" });
    expect(approval.status).toBe(200);
    expect(approval.body).toEqual(expect.objectContaining({ status: "approved", ledgerEntryId: "ledger-1" }));

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

    const validation = await request(app)
      .post(`/api/companies/${companyId}/rt2/enterprise/sso/validate`)
      .send({ provider: "microsoft", issuerUrl: "https://login.example.com", callbackUrl: "https://rt2.internal/auth/callback" });
    expect(validation.status).toBe(200);
    expect(validation.body.evidenceId).toBe("sso-evidence-1");
    expect(validation.body.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "issuer", status: "pass" }),
    ]));
    expect(validation.body.callbackStateChecks).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "callback-state", status: "pass" }),
    ]));
    expect(validation.body.failureReasons).toEqual([]);
    expect(mocks.enterprise.validateSsoHandshake).toHaveBeenCalledWith(companyId, expect.objectContaining({
      provider: "microsoft",
      callbackUrl: "https://rt2.internal/auth/callback",
    }));
    expect(mocks.logActivity).toHaveBeenCalledWith(null, expect.objectContaining({
      action: "rt2.rollout.sso_handshake_validated",
      companyId,
      entityId: "sso-evidence-1",
      details: expect.objectContaining({ evidenceId: "sso-evidence-1", status: "pass" }),
    }));

    const scim = await request(app)
      .post(`/api/companies/${companyId}/rt2/enterprise/scim/preview`)
      .send({
        users: [{ externalId: "u-2", email: "former@isens.local", active: false }],
        groups: [],
      });
    expect(scim.status).toBe(200);
    expect(scim.body.previewId).toBe("scim-preview-1");
    expect(scim.body.previewFingerprint).toBe("fingerprint-1");
    expect(scim.body.summary).toEqual(expect.objectContaining({ deactivate: 1 }));
    expect(scim.body.candidates[0]).toEqual(expect.objectContaining({
      id: "user:deactivate:u-2",
      action: "deactivate",
      externalId: "u-2",
    }));
    expect(mocks.logActivity).toHaveBeenCalledWith(null, expect.objectContaining({
      action: "rt2.rollout.scim_previewed",
      companyId,
      details: expect.objectContaining({ previewId: "scim-preview-1", previewFingerprint: "fingerprint-1" }),
    }));

    const apply = await request(app)
      .post(`/api/companies/${companyId}/rt2/enterprise/scim/apply`)
      .send({
        previewId: "scim-preview-1",
        previewFingerprint: "fingerprint-1",
        selectedCandidateIds: ["user:deactivate:u-2"],
        acknowledgeDeactivations: true,
      });
    expect(apply.status).toBe(200);
    expect(apply.body).toEqual(expect.objectContaining({
      evidenceId: "scim-apply-1",
      status: "partial",
      summary: expect.objectContaining({ rollbackCandidates: 1 }),
    }));
    expect(apply.body.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ candidateId: "user:deactivate:u-2", status: "applied" }),
      expect.objectContaining({
        candidateId: "user:update:u-3",
        status: "failed",
        failureReason: expect.objectContaining({ code: "candidate_validation_failed" }),
      }),
    ]));
    expect(apply.body.rollbackCandidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ candidateId: "user:deactivate:u-2", action: "deactivate" }),
    ]));
    expect(apply.body.failureReasons).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "candidate_validation_failed" }),
    ]));
    expect(mocks.enterprise.applyScimPreview).toHaveBeenCalledWith(companyId, expect.objectContaining({
      previewId: "scim-preview-1",
      acknowledgeDeactivations: true,
    }));
    expect(mocks.logActivity).toHaveBeenCalledWith(null, expect.objectContaining({
      action: "rt2.rollout.scim_applied",
      companyId,
      entityId: "scim-apply-1",
      details: expect.objectContaining({
        evidenceId: "scim-apply-1",
        previewId: "scim-preview-1",
        rollbackCandidateCount: 1,
      }),
    }));
  });

  it("checks enterprise company access before SCIM apply mutation", async () => {
    const app = createApp();

    const apply = await request(app)
      .post("/api/companies/other-company/rt2/enterprise/scim/apply")
      .send({
        previewId: "scim-preview-1",
        previewFingerprint: "fingerprint-1",
        selectedCandidateIds: ["user:deactivate:u-2"],
        acknowledgeDeactivations: true,
      });

    expect(apply.status).toBe(500);
    expect(mocks.enterprise.applyScimPreview).not.toHaveBeenCalled();
    expect(mocks.logActivity).not.toHaveBeenCalledWith(null, expect.objectContaining({
      action: "rt2.rollout.scim_applied",
      companyId: "other-company",
    }));
  });

  it("validates advanced work board and native capture route contracts without embedded Postgres", async () => {
    const app = createApp();

    const board = await request(app)
      .get(`/api/companies/${companyId}/rt2/work-board`)
      .query({ issueIds: "task-1" });
    expect(board.status).toBe(200);
    expect(board.body.cards[0]).toEqual(expect.objectContaining({ checklistTotal: 1, priceGold: 900 }));

    const card = await request(app)
      .patch(`/api/companies/${companyId}/rt2/work-board/cards/task-1`)
      .send({ dueDate: "2026-04-30", qualityStatus: "reviewed", priceGold: 1200 });
    expect(card.status).toBe(200);
    expect(mocks.workBoard.updateCard).toHaveBeenCalledWith(companyId, "task-1", "board-user", expect.objectContaining({ qualityStatus: "reviewed" }));

    const checklist = await request(app)
      .post(`/api/companies/${companyId}/rt2/work-board/cards/task-1/checklist`)
      .send({ title: "견적 확인" });
    expect(checklist.status).toBe(201);
    expect(checklist.body).toEqual(expect.objectContaining({ title: "견적 확인" }));

    const inbound = await request(app)
      .post(`/api/companies/${companyId}/rt2/one-liner/inbound-draft`)
      .send({ source: "native", text: "제안서 보완", channel: "ios-share", externalUserId: "mobile-user" });
    expect(inbound.status).toBe(201);
    expect(inbound.body.inbound).toEqual(expect.objectContaining({ id: "draft-1", status: "review_required" }));

    const queue = await request(app).get(`/api/companies/${companyId}/rt2/capture-drafts`);
    expect(queue.status).toBe(200);
    expect(queue.body.summary).toEqual(expect.objectContaining({ duplicate: 1, permissionBlocked: 1 }));

    const promote = await request(app)
      .post(`/api/companies/${companyId}/rt2/capture-drafts/draft-1/promote`)
      .send({ target: "task", projectId: "00000000-0000-0000-0000-000000000001", priority: "medium", taskMode: "solo", capacity: 1 });
    expect(promote.status).toBe(200);
    expect(promote.body).toEqual(expect.objectContaining({ status: "promoted", promotedIssueId: "task-2" }));

    const failed = await request(app)
      .post(`/api/companies/${companyId}/rt2/capture-drafts/draft-1/fail`)
      .send({ failureCode: "source_failure", failureMessage: "Native share extension payload was malformed." });
    expect(failed.status).toBe(200);
    expect(failed.body).toEqual(expect.objectContaining({ status: "failed", failureCode: "source_failure" }));
  });
});
