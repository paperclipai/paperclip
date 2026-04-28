import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  budgetPolicies,
  companies,
  createDb,
  getEmbeddedPostgresTestSupport,
  routineTriggers,
  routines,
  rt2BindingModes,
  rt2CompanyTemplates,
  rt2SsoConnections,
  rt2TenantPolicies,
  startEmbeddedPostgresTestDatabase,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { rt2EnterpriseRoutes } from "../routes/rt2-enterprise.js";
import { rt2TemplateApplicationRoutes } from "../routes/rt2-template-application.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres RT2 phase 13 enterprise tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("rt2 phase 13 enterprise rollout", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;
  let companyId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-rt2-phase13-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(routineTriggers);
    await db.delete(routines);
    await db.delete(budgetPolicies);
    await db.delete(rt2BindingModes);
    await db.delete(rt2TenantPolicies);
    await db.delete(rt2SsoConnections);
    await db.delete(rt2CompanyTemplates);
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
    app.use("/api", rt2EnterpriseRoutes(db));
    app.use("/api", rt2TemplateApplicationRoutes(db));
    app.use(errorHandler);
    return app;
  }

  async function seedCompany() {
    companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "RT2 Phase 13 Corp",
      issuePrefix: `P${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
  }

  it("saves RT2-labeled rollout settings and returns one admin overview", async () => {
    await seedCompany();
    const app = createApp(companyId);

    const saved = await request(app)
      .post(`/api/companies/${companyId}/rt2/enterprise/rollout`)
      .send({
        sso: {
          provider: "microsoft",
          issuerUrl: "https://login.example.com",
          autoProvision: true,
          defaultRole: "member",
        },
        binding: {
          mode: "authenticated",
          environment: "production",
          bindHost: "0.0.0.0",
          port: 3100,
          requireAuth: true,
          allowedHosts: ["rt2.internal"],
        },
        policy: {
          policyDefault: "operator_safe",
          dataResidency: "kr",
          retentionDays: 730,
          auditLogging: true,
        },
        template: {
          name: "iSens RT2 운영 템플릿",
          category: "enterprise",
          description: "Phase 13 template",
        },
      });

    expect(saved.status).toBe(200);
    expect(saved.body.changed).toEqual(expect.arrayContaining(["sso", "binding", "policy", "template"]));
    expect(saved.body.overview).toEqual(expect.objectContaining({
      companyId,
      ssoConnections: [expect.objectContaining({ provider: "microsoft", autoProvision: true })],
      bindingModes: [expect.objectContaining({ mode: "authenticated", requireAuth: true })],
      tenantPolicy: expect.objectContaining({ dataResidency: "kr", retentionDays: 730 }),
      templates: [expect.objectContaining({ name: "iSens RT2 운영 템플릿", category: "enterprise" })],
      evidence: expect.objectContaining({
        overallStatus: "ready",
        readyCount: 4,
        items: expect.arrayContaining([
          expect.objectContaining({ area: "sso", status: "ready" }),
          expect.objectContaining({ area: "binding", status: "ready" }),
          expect.objectContaining({ area: "policy", status: "ready" }),
          expect.objectContaining({ area: "template", status: "ready" }),
        ]),
      }),
    }));

    const overview = await request(app).get(`/api/companies/${companyId}/rt2/enterprise/rollout`);
    expect(overview.status).toBe(200);
    expect(overview.body.recommendedDefaults).toEqual(expect.objectContaining({
      bindingMode: "authenticated",
      policyDefault: "operator_safe",
    }));
  });

  it("previews create, skip, and error objects before applying a template", async () => {
    await seedCompany();
    const app = createApp(companyId);

    const saved = await request(app)
      .post(`/api/companies/${companyId}/rt2/enterprise/rollout`)
      .send({
        template: {
          name: "Apply Preview Template",
          category: "enterprise",
        },
      });
    const templateId = saved.body.overview.templates[0].id;

    const preview = await request(app).get(`/api/companies/${companyId}/rt2/templates/${templateId}/preview`);
    expect(preview.status).toBe(200);
    expect(preview.body.summary).toEqual(expect.objectContaining({ create: 2, skip: 6, error: 0 }));
    expect(preview.body.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "budget_policy", action: "create" }),
      expect.objectContaining({ kind: "routine", action: "create" }),
      expect.objectContaining({ kind: "skill", action: "skip" }),
    ]));

    const applied = await request(app).post(`/api/companies/${companyId}/rt2/templates/${templateId}/apply`);
    expect(applied.status).toBe(201);
    expect(applied.body.success).toBe(true);
    expect(applied.body.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "budget_policy", action: "create", createdId: expect.any(String) }),
      expect.objectContaining({ kind: "routine", action: "create", createdId: expect.any(String) }),
    ]));

    const afterApply = await request(app).get(`/api/companies/${companyId}/rt2/templates/${templateId}/preview`);
    expect(afterApply.status).toBe(200);
    expect(afterApply.body.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "budget_policy", action: "skip", existingId: expect.any(String) }),
      expect.objectContaining({ kind: "routine", action: "skip", existingId: expect.any(String) }),
    ]));
  });
});
