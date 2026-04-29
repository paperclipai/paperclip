import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  companies,
  createDb,
  getEmbeddedPostgresTestSupport,
  rt2EnterpriseConnectorEvidence,
  startEmbeddedPostgresTestDatabase,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { rt2EnterpriseRoutes } from "../routes/rt2-enterprise.js";
import { rt2EnterpriseService } from "../services/rt2-enterprise.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres RT2 phase 39 enterprise connector tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("rt2 phase 39 enterprise connector apply loop", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;
  let companyId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-rt2-phase39-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(rt2EnterpriseConnectorEvidence);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "RT2 Phase 39 Corp",
      issuePrefix: `P${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
  }

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
    app.use("/api", rt2EnterpriseRoutes(db));
    app.use(errorHandler);
    return app;
  }

  it("persists SSO handshake evidence with callback-state failure reasons and hydrates overview", async () => {
    await seedCompany();
    const service = rt2EnterpriseService(db);

    const result = await service.validateSsoHandshake(companyId, {
      provider: "microsoft",
      issuerUrl: "https://login.example.com",
      metadataUrl: "https://login.example.com/.well-known/openid-configuration",
      callbackUrl: "https://rt2.internal/auth/callback",
      expectedCallbackState: "expected-state",
      callbackState: "wrong-state",
    });

    expect(result.evidenceId).toEqual(expect.any(String));
    expect(result.status).toBe("fail");
    expect(result.callbackStateChecks).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "callback-state", status: "fail" }),
    ]));
    expect(result.failureReasons).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "callback-state" }),
    ]));

    const rows = await db.select().from(rt2EnterpriseConnectorEvidence)
      .where(eq(rt2EnterpriseConnectorEvidence.companyId, companyId))
      .orderBy(desc(rt2EnterpriseConnectorEvidence.createdAt));
    expect(rows[0]).toEqual(expect.objectContaining({
      id: result.evidenceId,
      companyId,
      connectorKind: "sso",
      evidenceType: "sso_handshake",
      status: "fail",
    }));

    const overview = await service.getRolloutOverview(companyId);
    expect(overview.ssoValidation).toEqual(expect.objectContaining({
      evidenceId: result.evidenceId,
      status: "fail",
    }));
    expect(overview.evidence.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ area: "sso", status: "missing", recordIds: [result.evidenceId] }),
    ]));
  });

  it("persists deterministic SCIM preview IDs, fingerprints, and stable candidate IDs", async () => {
    await seedCompany();
    const service = rt2EnterpriseService(db);
    const input = {
      users: [
        { externalId: "u-2", email: "former@isens.local", active: false },
        { externalId: "u-1", email: "operator@isens.local", displayName: "Operator", role: "operator" },
      ],
      groups: [{ externalId: "g-1", displayName: "Operators", memberExternalIds: ["u-1"] }],
    };

    const first = await service.createScimPreview(companyId, input);
    const second = await service.createScimPreview(companyId, input);

    expect(first.previewId).toEqual(expect.any(String));
    expect(first.previewFingerprint).toEqual(second.previewFingerprint);
    expect(first.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "user:deactivate:u-2", action: "deactivate" }),
      expect.objectContaining({ id: "user:update:u-1", action: "update" }),
      expect.objectContaining({ id: "group:update:g-1", action: "update" }),
    ]));
  });

  it("rejects stale SCIM apply, enforces deactivate acknowledgement, stores partial results, and updates readiness", async () => {
    await seedCompany();
    const service = rt2EnterpriseService(db);
    const preview = await service.createScimPreview(companyId, {
      users: [
        { externalId: "u-1", email: "operator@isens.local", displayName: "Operator", role: "operator" },
        { externalId: "u-2", email: "invalid-email", displayName: "Invalid User" },
        { externalId: "u-3", email: "former@isens.local", active: false },
      ],
    });
    const selectedCandidateIds = preview.candidates.map((candidate) => candidate.id).filter((id): id is string => Boolean(id));

    const stale = await service.applyScimPreview(companyId, {
      previewId: preview.previewId ?? "",
      previewFingerprint: "stale",
      selectedCandidateIds,
      acknowledgeDeactivations: true,
    });
    expect(stale).toEqual(expect.objectContaining({ ok: false, code: "stale_preview" }));

    const missingAck = await service.applyScimPreview(companyId, {
      previewId: preview.previewId ?? "",
      previewFingerprint: preview.previewFingerprint ?? "",
      selectedCandidateIds,
    });
    expect(missingAck).toEqual(expect.objectContaining({ ok: false, code: "deactivate_acknowledgement_required" }));

    const applied = await service.applyScimPreview(companyId, {
      previewId: preview.previewId ?? "",
      previewFingerprint: preview.previewFingerprint ?? "",
      selectedCandidateIds,
      acknowledgeDeactivations: true,
    });

    expect(applied).toEqual(expect.objectContaining({
      evidenceId: expect.any(String),
      status: "partial",
      summary: expect.objectContaining({ applied: 2, failed: 1, rollbackCandidates: 2 }),
    }));
    if ("ok" in applied) throw new Error("expected SCIM apply result");
    expect(applied.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ candidateId: "user:update:u-2", status: "failed" }),
      expect.objectContaining({ candidateId: "user:deactivate:u-3", status: "applied" }),
    ]));
    expect(applied.rollbackCandidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ candidateId: "user:deactivate:u-3", action: "deactivate" }),
    ]));

    const overview = await service.getRolloutOverview(companyId);
    expect(overview.evidence.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ area: "scim", status: "partial", recordIds: expect.arrayContaining([applied.evidenceId]) }),
    ]));
    expect(overview.readiness.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ area: "scim", status: "warning" }),
    ]));
  });

  it("writes company-scoped route audit evidence for SSO validation and SCIM apply", async () => {
    await seedCompany();
    const app = createApp(companyId);

    const validation = await request(app)
      .post(`/api/companies/${companyId}/rt2/enterprise/sso/validate`)
      .send({
        provider: "microsoft",
        issuerUrl: "https://login.example.com",
        metadataUrl: "https://login.example.com/.well-known/openid-configuration",
        callbackUrl: "https://rt2.internal/auth/callback",
        expectedCallbackState: "state-1",
        callbackState: "state-1",
      });
    expect(validation.status).toBe(200);
    expect(validation.body.evidenceId).toEqual(expect.any(String));

    const preview = await request(app)
      .post(`/api/companies/${companyId}/rt2/enterprise/scim/preview`)
      .send({
        users: [
          { externalId: "u-1", email: "operator@isens.local", displayName: "Operator", role: "operator" },
          { externalId: "u-2", email: "invalid-email", displayName: "Invalid User" },
        ],
      });
    expect(preview.status).toBe(200);

    const apply = await request(app)
      .post(`/api/companies/${companyId}/rt2/enterprise/scim/apply`)
      .send({
        previewId: preview.body.previewId,
        previewFingerprint: preview.body.previewFingerprint,
        selectedCandidateIds: preview.body.candidates.map((candidate: { id: string }) => candidate.id),
      });
    expect(apply.status).toBe(200);
    expect(apply.body.status).toBe("partial");

    const auditRows = await db.select().from(activityLog)
      .where(eq(activityLog.companyId, companyId))
      .orderBy(desc(activityLog.createdAt));
    expect(auditRows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: "rt2.rollout.sso_handshake_validated",
        entityId: validation.body.evidenceId,
      }),
      expect.objectContaining({
        action: "rt2.rollout.scim_applied",
        entityId: apply.body.evidenceId,
      }),
    ]));
    expect(auditRows.find((row) => row.action === "rt2.rollout.scim_applied")?.details).toEqual(expect.objectContaining({
      evidenceId: apply.body.evidenceId,
      previewId: preview.body.previewId,
      rollbackCandidateCount: 1,
    }));
  });
});
