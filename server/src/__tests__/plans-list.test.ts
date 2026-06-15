/**
 * Route coverage for GET /api/companies/:companyId/plans (HIVA-17 / HIVA-16).
 *
 * Lists a company's plan roots joined to their plan_details lifecycle:
 *   - 200 [] when the company has no plans
 *   - 200 [row] for a single draft plan, with the documented projection
 *   - ?state= filters on plan_details.state
 *   - 403 when an agent actor requests another company's plans
 *
 * Uses the embedded Postgres harness so the issues<->plan_details join and the
 * authz 403 path run against real SQL rather than mocks.
 */

import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { companies, createDb, issues, planDetails } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { planRoutes } from "../routes/plans.js";
import { planService } from "../services/plans.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres plans-list tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("GET /api/companies/:companyId/plans", () => {
  let db!: ReturnType<typeof createDb>;
  let plans!: ReturnType<typeof planService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  // Mutable per-request actor; the injection middleware reads it so each test
  // can pose as an agent scoped to a specific company.
  let actor: Record<string, unknown> = {};

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    app.use("/api", planRoutes(db));
    app.use(errorHandler);
    return app;
  }

  function asAgentOf(companyId: string) {
    actor = { type: "agent", companyId, agentId: randomUUID(), runId: null };
  }

  async function seedCompany(prefix: string) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Company ${prefix}`,
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plans-list-");
    db = createDb(tempDb.connectionString);
    plans = planService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(planDetails);
    await db.delete(issues);
    await db.delete(companies);
    actor = {};
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("returns 200 [] when the company has no plans", async () => {
    const companyId = await seedCompany("EMP");
    asAgentOf(companyId);

    const res = await request(buildApp()).get(`/api/companies/${companyId}/plans`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("returns a single draft plan with the documented projection", async () => {
    const companyId = await seedCompany("DRF");
    const { issue } = await plans.createPlan(companyId, {
      title: "Pilot: rate-limit upload route",
      assigneeAgentId: null,
      gateProfile: "dev_team",
    });
    // assigneeAgentId left null above; the projection still surfaces the column.
    asAgentOf(companyId);

    const res = await request(buildApp()).get(`/api/companies/${companyId}/plans`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      issueId: issue.id,
      title: "Pilot: rate-limit upload route",
      state: "draft",
      gateProfile: "dev_team",
      assigneeAgentId: null,
    });
    expect(typeof res.body[0].createdAt).toBe("string");
  });

  it("filters by ?state= and sorts newest first", async () => {
    const companyId = await seedCompany("FLT");
    const { issue: draft } = await plans.createPlan(companyId, { title: "Draft plan" });
    const { issue: active } = await plans.createPlan(companyId, { title: "Active plan" });
    // Promote the second plan's lifecycle directly (avoids the activate() tier path).
    await db.update(planDetails).set({ state: "active" }).where(eq(planDetails.issueId, active.id));
    asAgentOf(companyId);

    const all = await request(buildApp()).get(`/api/companies/${companyId}/plans`);
    expect(all.status).toBe(200);
    expect(all.body).toHaveLength(2);
    // Newest first: the active plan was created after the draft.
    expect(all.body.map((r: { issueId: string }) => r.issueId)).toEqual([active.id, draft.id]);

    const activeOnly = await request(buildApp()).get(`/api/companies/${companyId}/plans?state=active`);
    expect(activeOnly.status).toBe(200);
    expect(activeOnly.body).toHaveLength(1);
    expect(activeOnly.body[0].issueId).toBe(active.id);

    const draftOnly = await request(buildApp()).get(`/api/companies/${companyId}/plans?state=draft`);
    expect(draftOnly.status).toBe(200);
    expect(draftOnly.body).toHaveLength(1);
    expect(draftOnly.body[0].issueId).toBe(draft.id);
  });

  it("returns 403 when an agent requests another company's plans", async () => {
    const companyA = await seedCompany("AAA");
    const companyB = await seedCompany("BBB");
    await plans.createPlan(companyB, { title: "B's plan" });
    asAgentOf(companyA);

    const res = await request(buildApp()).get(`/api/companies/${companyB}/plans`);

    expect(res.status).toBe(403);
  });
});
