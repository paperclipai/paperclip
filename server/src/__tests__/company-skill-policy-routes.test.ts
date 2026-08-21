import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agents, companies, companySkillPolicies, createDb } from "@paperclipai/db";
import { errorHandler } from "../middleware/error-handler.js";
import { companySkillPolicyRoutes } from "../routes/company-skill-policy.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("company skill policy routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;
  let otherCompanyId: string;
  let agentId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-skill-policy-routes-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(companySkillPolicies);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function setupApp() {
    companyId = randomUUID();
    otherCompanyId = randomUUID();
    agentId = randomUUID();
    await db.insert(companies).values([
      {
        id: companyId,
        name: "Policy Co",
        issuePrefix: `P${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
      {
        id: otherCompanyId,
        name: "Other Co",
        issuePrefix: `O${otherCompanyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
    ]);
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Builder",
      role: "engineer",
      adapterType: "process",
      adapterConfig: {},
      status: "idle",
    });

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      const actor = req.header("x-test-actor");
      req.actor = actor === "board"
        ? {
            type: "board",
            source: "local_implicit",
            userId: "board",
            companyIds: [],
            isInstanceAdmin: true,
          }
        : actor === "none"
          ? { type: "none", source: "none" }
          : {
              type: "agent",
              source: "agent_key",
              agentId,
              companyId: actor === "cross-company" ? otherCompanyId : companyId,
              runId: null,
            };
      next();
    });
    app.use(companySkillPolicyRoutes(db));
    app.use(errorHandler);
    return app;
  }

  it("returns the open default and stable authentication/company boundary errors", async () => {
    const app = await setupApp();
    await request(app)
      .get(`/companies/${companyId}/skill-policy`)
      .expect(200)
      .expect(({ body }) => expect(body).toMatchObject({ revision: 0, materialized: false, defaultEffect: "allow" }));
    await request(app)
      .get(`/companies/${companyId}/skill-policy`)
      .set("x-test-actor", "none")
      .expect(401)
      .expect(({ body }) => expect(body.code).toBe("skill_authentication_required"));
    await request(app)
      .get(`/companies/${companyId}/skill-policy`)
      .set("x-test-actor", "cross-company")
      .expect(403)
      .expect(({ body }) => expect(body.code).toBe("skill_company_boundary_denied"));
  });

  it("restricts policy administration, persists revisions, evaluates denials, and logs mutations", async () => {
    const app = await setupApp();
    const body = {
      schemaVersion: 1,
      expectedRevision: 0,
      defaultEffect: "allow",
      rules: [{
        id: "deny-remove",
        priority: 1,
        effect: "deny",
        subject: { type: "all_agents" },
        actions: ["skills.remove"],
      }],
    };
    await request(app)
      .put(`/companies/${companyId}/skill-policy`)
      .send(body)
      .expect(403)
      .expect(({ body: responseBody }) => expect(responseBody.code).toBe("skill_policy_admin_required"));
    await request(app)
      .put(`/companies/${companyId}/skill-policy`)
      .set("x-test-actor", "board")
      .send(body)
      .expect(200)
      .expect(({ body: responseBody }) => expect(responseBody).toMatchObject({ revision: 1, materialized: true }));
    await request(app)
      .put(`/companies/${companyId}/skill-policy`)
      .set("x-test-actor", "board")
      .send(body)
      .expect(409)
      .expect(({ body: responseBody }) => expect(responseBody.code).toBe("skill_policy_revision_conflict"));
    await request(app)
      .post(`/companies/${companyId}/skill-policy/evaluate`)
      .send({ action: "skills.remove", resource: {} })
      .expect(200)
      .expect(({ body: responseBody }) => expect(responseBody).toMatchObject({
        allowed: false,
        reason: "explicit_rule",
        matchedRuleId: "deny-remove",
      }));
    await request(app)
      .post(`/companies/${companyId}/skill-policy/evaluate`)
      .send({ action: "skills.remove", resource: {}, principal: { agentId } })
      .expect(403)
      .expect(({ body: responseBody }) => expect(responseBody.code).toBe("skill_policy_admin_required"));
    await request(app)
      .delete(`/companies/${companyId}/skill-policy`)
      .set("x-test-actor", "board")
      .expect(200)
      .expect(({ body: responseBody }) => expect(responseBody).toMatchObject({ revision: 0, materialized: false }));
    const activities = await db.select().from(activityLog);
    expect(activities).toEqual(expect.arrayContaining([
      expect.objectContaining({
        companyId,
        action: "company.skill_policy_replaced",
        entityType: "company_skill_policy",
      }),
      expect.objectContaining({
        companyId,
        action: "company.skill_policy_reset",
        entityType: "company_skill_policy",
      }),
    ]));
  });

  it("rejects unknown actions and secret-bearing policy locators with 422", async () => {
    const app = await setupApp();
    await request(app)
      .post(`/companies/${companyId}/skill-policy/evaluate`)
      .send({ action: "skills.publish", resource: {} })
      .expect(422)
      .expect(({ body }) => expect(body.code).toBe("skill_policy_validation_failed"));
    await request(app)
      .put(`/companies/${companyId}/skill-policy`)
      .set("x-test-actor", "board")
      .send({
        schemaVersion: 1,
        expectedRevision: 0,
        defaultEffect: "allow",
        rules: [{
          id: "secret-locator",
          priority: 1,
          effect: "deny",
          subject: { type: "all_agents" },
          actions: ["skills.import"],
          resources: { sourceLocators: ["https://example.com/skill?token=do-not-store"] },
        }],
      })
      .expect(422)
      .expect(({ body }) => expect(body.code).toBe("skill_policy_validation_failed"));
  });
});
