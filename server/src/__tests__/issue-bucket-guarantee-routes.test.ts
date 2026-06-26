import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
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
    `Skipping embedded Postgres bucket-guarantee route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// FUS-765: guarantee "every task lives in a bucket".
//  - req 1 (soft auto-file): an agent-created orphan is filed under the
//    company's configured triage bucket at creation.
//  - req 2 (CEO re-parent): a CEO may re-parent an agent-owned issue (structural
//    only) without the broader issue:mutate authority.
describeEmbeddedPostgres("issue bucket guarantee routes (FUS-765)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-bucket-guarantee-routes-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(companyId: string, agentId: string, runId: string) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "agent",
        agentId,
        companyId,
        runId,
        source: "agent_key",
      };
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  // The agent issue-create/patch path records activity against the actor's
  // heartbeat run, which is an FK into heartbeat_runs. Seed a real run so the
  // route hits its happy path instead of a foreign-key violation.
  async function createRun(companyId: string, agentId: string) {
    const [run] = await db
      .insert(heartbeatRuns)
      .values({ companyId, agentId, status: "running", contextSnapshot: {} })
      .returning();
    return run!;
  }

  async function createCompany(triageParentIssueId: string | null = null) {
    const [company] = await db
      .insert(companies)
      .values({
        name: `Bucket ${randomUUID()}`,
        issuePrefix: `BK${randomUUID().slice(0, 6).toUpperCase()}`,
        triageParentIssueId,
      })
      .returning();
    return company!;
  }

  async function createAgent(companyId: string, role: string) {
    const [agent] = await db
      .insert(agents)
      .values({
        companyId,
        name: `Agent ${randomUUID()}`,
        role,
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
      })
      .returning();
    return agent!;
  }

  async function createIssue(
    companyId: string,
    input: { parentId?: string | null; assigneeAgentId?: string | null } = {},
  ) {
    const [issue] = await db
      .insert(issues)
      .values({
        companyId,
        title: `Issue ${randomUUID()}`,
        status: "todo",
        priority: "medium",
        parentId: input.parentId ?? null,
        assigneeAgentId: input.assigneeAgentId ?? null,
      })
      .returning();
    return issue!;
  }

  it("auto-files an agent-created orphan under the configured triage bucket", async () => {
    const company = await createCompany();
    const ceo = await createAgent(company.id, "ceo");
    const run = await createRun(company.id, ceo.id);
    const triageBucket = await createIssue(company.id);
    await db
      .update(companies)
      .set({ triageParentIssueId: triageBucket.id })
      .where(eq(companies.id, company.id));

    const res = await request(createApp(company.id, ceo.id, run.id))
      .post(`/api/companies/${company.id}/issues`)
      .send({ title: "Orphan task" });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.parentId).toBe(triageBucket.id);
  });

  it("ignores a triage-bucket setting that points at a non-top-level issue", async () => {
    const company = await createCompany();
    const ceo = await createAgent(company.id, "ceo");
    const run = await createRun(company.id, ceo.id);
    const topBucket = await createIssue(company.id);
    const childIssue = await createIssue(company.id, { parentId: topBucket.id });
    // Stale/misconfigured: the setting points at a child, not a top-level bucket.
    await db
      .update(companies)
      .set({ triageParentIssueId: childIssue.id })
      .where(eq(companies.id, company.id));

    const res = await request(createApp(company.id, ceo.id, run.id))
      .post(`/api/companies/${company.id}/issues`)
      .send({ title: "Should stay top-level" });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.parentId).toBeNull();
  });

  it("leaves a top-level issue orphaned when no triage bucket is configured", async () => {
    const company = await createCompany();
    const ceo = await createAgent(company.id, "ceo");
    const run = await createRun(company.id, ceo.id);

    const res = await request(createApp(company.id, ceo.id, run.id))
      .post(`/api/companies/${company.id}/issues`)
      .send({ title: "Still top-level" });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.parentId).toBeNull();
  });

  it("lets a CEO re-parent an agent-owned issue but not otherwise mutate it", async () => {
    const company = await createCompany();
    const ceo = await createAgent(company.id, "ceo");
    const run = await createRun(company.id, ceo.id);
    const worker = await createAgent(company.id, "engineer");
    const bucket = await createIssue(company.id);
    const orphan = await createIssue(company.id, { assigneeAgentId: worker.id });

    const app = createApp(company.id, ceo.id, run.id);

    // A content edit on another agent's issue is still rejected.
    const blockedEdit = await request(app)
      .patch(`/api/issues/${orphan.id}`)
      .send({ title: "CEO should not rename this" });
    expect(blockedEdit.status).toBe(403);

    // Re-parenting (structural only) is allowed.
    const reparent = await request(app)
      .patch(`/api/issues/${orphan.id}`)
      .send({ parentId: bucket.id });
    expect(reparent.status, JSON.stringify(reparent.body)).toBe(200);
    expect(reparent.body.parentId).toBe(bucket.id);

    const stored = await db
      .select({ parentId: issues.parentId })
      .from(issues)
      .where(eq(issues.id, orphan.id))
      .then((rows) => rows[0] ?? null);
    expect(stored?.parentId).toBe(bucket.id);
  });
});
