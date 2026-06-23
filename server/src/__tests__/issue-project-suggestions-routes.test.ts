import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, issues, projects } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres project-suggestions route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue project-suggestions routes (TON-2266 Phase 2)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-project-suggestions-routes-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(companyId: string) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        userId: "cloud-user-1",
        companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "owner", status: "active" }],
        source: "cloud_tenant",
        isInstanceAdmin: true,
      };
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  let issueCounter = 0;
  async function seedIssue(input: {
    companyId: string;
    projectId: string | null;
    title: string;
    description?: string;
  }): Promise<string> {
    const id = randomUUID();
    issueCounter += 1;
    await db.insert(issues).values({
      id,
      companyId: input.companyId,
      projectId: input.projectId,
      issueNumber: issueCounter,
      identifier: `TST-${issueCounter}`,
      title: input.title,
      description: input.description ?? null,
      status: "backlog",
    });
    return id;
  }

  it("ranks the matching project on top and gates a one-click default", async () => {
    const companyId = randomUUID();
    const chartsProjectId = randomUUID();
    const billingProjectId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Suggestions tenant",
      issuePrefix: "TSA",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values([
      {
        id: chartsProjectId,
        companyId,
        name: "Stock Charting App",
        description: "Flutter candlestick charts, drawing tools, gesture recognizers.",
        status: "in_progress",
      },
      {
        id: billingProjectId,
        companyId,
        name: "Billing Engine",
        description: "Invoices, payment reconciliation, refunds and ledgers.",
        status: "in_progress",
      },
    ]);

    // Anchor each project with already-classified issues that shape its vocabulary.
    await seedIssue({
      companyId,
      projectId: chartsProjectId,
      title: "Candlestick chart zoom flicker on gesture",
      description: "Drawing mode conflicts with zoom in the chart canvas.",
    });
    await seedIssue({
      companyId,
      projectId: chartsProjectId,
      title: "Add Fibonacci drawing tool to charting surface",
    });
    await seedIssue({
      companyId,
      projectId: billingProjectId,
      title: "Refund reconciliation mismatch in invoice ledger",
      description: "Payment ledger drifts after partial refunds.",
    });

    // The issue under classification clearly belongs to the charting project.
    const targetId = await seedIssue({
      companyId,
      projectId: null,
      title: "Candlestick chart drawing tool freezes during zoom gesture",
      description: "The charting canvas locks when a drawing gesture overlaps zoom.",
    });

    const app = createApp(companyId);
    const res = await request(app).get(`/api/issues/${targetId}/project-suggestions`);

    expect(res.status).toBe(200);
    expect(res.body.issueId).toBe(targetId);
    expect(res.body.alreadyClassified).toBe(false);
    expect(res.body.currentProjectId).toBeNull();
    expect(Array.isArray(res.body.suggestions)).toBe(true);
    expect(res.body.suggestions.length).toBeGreaterThan(0);
    // Charting project ranks first with an explainable rationale.
    expect(res.body.suggestions[0].projectId).toBe(chartsProjectId);
    expect(res.body.suggestions[0].matchedTerms.length).toBeGreaterThan(0);
    expect(typeof res.body.suggestions[0].reason).toBe("string");
    // Conservative one-click default points at the same project.
    expect(res.body.topConfident?.projectId).toBe(chartsProjectId);
  });

  it("excludes the issue's current project from its own suggestions", async () => {
    const companyId = randomUUID();
    const projectId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Already-classified tenant",
      issuePrefix: "TSB",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Data Pipeline",
      description: "ETL ingestion, schema migration, backfill jobs.",
      status: "in_progress",
    });
    const classifiedId = await seedIssue({
      companyId,
      projectId,
      title: "Backfill ingestion job for schema migration",
    });

    const app = createApp(companyId);
    const res = await request(app).get(`/api/issues/${classifiedId}/project-suggestions`);

    expect(res.status).toBe(200);
    expect(res.body.alreadyClassified).toBe(true);
    expect(res.body.currentProjectId).toBe(projectId);
    const suggestedIds = res.body.suggestions.map((s: { projectId: string }) => s.projectId);
    expect(suggestedIds).not.toContain(projectId);
  });

  it("404s for an unknown issue", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Empty tenant",
      issuePrefix: "TSC",
      requireBoardApprovalForNewAgents: false,
    });
    const app = createApp(companyId);
    const res = await request(app).get(`/api/issues/${randomUUID()}/project-suggestions`);
    expect(res.status).toBe(404);
  });
});
