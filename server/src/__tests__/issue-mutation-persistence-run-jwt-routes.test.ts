import { createHash, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
  issueComments,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { issueRoutes } from "../routes/issues.js";

/**
 * ETS-475: regression guard for the P0 "silent no-op on mutations" failure
 * class (discovered in ETS-471): an agent PATCHes an issue status / posts a
 * comment / creates a subtask, receives 200/201, but nothing was persisted.
 *
 * These tests exercise the exact surface the agent harness uses: the real
 * `actorMiddleware` validating a run-scoped local agent JWT (as minted for
 * local adapters, see services/heartbeat.ts), the real issue routes, and a real
 * embedded Postgres. Every assertion reads state back from the database after
 * the HTTP call, so a response that 200s without committing fails the suite.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue mutation persistence tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue mutation persistence via run-scoped agent JWT (ETS-475)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const previousAgentJwtSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
  const previousInstanceId = process.env.PAPERCLIP_INSTANCE_ID;

  beforeAll(async () => {
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "issue-mutation-persistence-test-secret";
    // Mint and verify must derive the same key; pin a known instance id.
    process.env.PAPERCLIP_INSTANCE_ID = "ets475-test";
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-mutation-persistence-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
    if (previousAgentJwtSecret === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    else process.env.PAPERCLIP_AGENT_JWT_SECRET = previousAgentJwtSecret;
    if (previousInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
    else process.env.PAPERCLIP_INSTANCE_ID = previousInstanceId;
  });

  function createApp() {
    const app = express();
    app.use(express.json());
    app.use(actorMiddleware(db, { deploymentMode: "authenticated" }));
    app.use("/api", issueRoutes(db, {
      provider: "local_disk",
      putFile: async (input) => ({
        provider: "local_disk",
        objectKey: `${input.namespace}/${randomUUID()}`,
        contentType: input.contentType,
        byteSize: input.body.length,
        sha256: createHash("sha256").update(input.body).digest("hex"),
        originalFilename: input.originalFilename,
      }),
      getObject: async () => {
        throw new Error("not used");
      },
      headObject: async () => ({ exists: false }),
      deleteObject: async () => {},
    } as any));
    app.use(errorHandler);
    return app;
  }

  async function seed() {
    const [company] = await db.insert(companies).values({
      name: "ETS475 Co",
      issuePrefix: `E${randomUUID().replace(/-/g, "").slice(0, 4)}`,
    }).returning();
    if (!company) throw new Error("seed: company insert returned no row");
    const [agent] = await db.insert(agents).values({
      companyId: company.id,
      name: "ETS475 Agent",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    }).returning();
    if (!agent) throw new Error("seed: agent insert returned no row");
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: company.id,
      agentId: agent.id,
      status: "running",
    });
    const [issue] = await db.insert(issues).values({
      companyId: company.id,
      title: "Persistence probe issue",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agent.id,
      checkoutRunId: runId,
      executionRunId: runId,
    }).returning();
    if (!issue) throw new Error("seed: issue insert returned no row");
    const token = createLocalAgentJwt(agent.id, company.id, agent.adapterType, runId);
    if (!token) throw new Error("seed: createLocalAgentJwt returned null");
    return { company, agent, runId, issue, token };
  }

  it("PATCH /issues/:id with a run-scoped JWT persists the new status — read-back proves the commit", async () => {
    const { issue, token, runId } = await seed();
    const app = createApp();
    const before = (await db.select().from(issues).where((t) => t.id === issue.id || true)).find((row) => row.id === issue.id)!;
    const beforeStatus = before.status;
    const beforeUpdatedAt = before.updatedAt;

    // Use "done" instead of "in_review" to avoid the review-path disposition validation
    // (agent-authored in_review requires a human assignee, interaction, approval, or monitor).
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("PATCH did not settle within 30s")), 30_000);
      request(app)
        .patch(`/api/issues/${issue.id}`)
        .set("Authorization", `Bearer ${token}`)
        .set("X-Paperclip-Run-Id", runId)
        .send({ status: "done" })
        .then((res) => {
          clearTimeout(timer);
          resolve(res);
        })
        .catch((err) => {
          clearTimeout(timer);
          reject(err);
        });
    }).then((res: any) => {
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    });

    const after = (await db.select().from(issues)).find((row) => row.id === issue.id)!;
    expect(after.status).toBe("done");
    expect(after.status).not.toBe(beforeStatus);
    expect(new Date(after.updatedAt).getTime()).toBeGreaterThanOrEqual(new Date(beforeUpdatedAt).getTime());

    // The HTTP read must also see the persisted value (not a stale in-memory copy).
    const res = await request(app)
      .get(`/api/issues/${issue.id}`)
      .set("Authorization", `Bearer ${token}`)
      .set("X-Paperclip-Run-Id", runId)
      .expect(200);
    expect(res.body.status).toBe("done");
  });

  it("POST /issues/:id/comments with a run-scoped JWT persists the comment — count and body read back", async () => {
    const { issue, token, runId } = await seed();
    const app = createApp();
    const body = "Persisted comment from ETS-475 run-scoped JWT harness";

    const before = await db.select().from(issueComments).where((t) => t.issueId === issue.id);
    expect(before).toHaveLength(0);

    const created = await request(app)
      .post(`/api/issues/${issue.id}/comments`)
      .set("Authorization", `Bearer ${token}`)
      .set("X-Paperclip-Run-Id", runId)
      .send({ body })
      .expect(201);

    const rows = await db.select().from(issueComments).where((t) => t.issueId === issue.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.issueId).toBe(issue.id);
    expect(rows[0]!.body).toBe(body);
    expect(rows[0]!.authorAgentId).toBeDefined();

    // HTTP read-back: the comment list endpoint must show the persisted row.
    const listed = await request(app)
      .get(`/api/issues/${issue.id}/comments`)
      .set("Authorization", `Bearer ${token}`)
      .set("X-Paperclip-Run-Id", runId)
      .expect(200);
    expect(listed.body).toHaveLength(1);
    expect(listed.body[0].body).toBe(body);
    expect(listed.body[0].id).toBe(created.body.id);
  });

  it("POST /issues/:id/children with a run-scoped JWT persists the subtask — parent link visible on fetch", async () => {
    const { issue, token, runId } = await seed();
    const app = createApp();

    const created = await request(app)
      .post(`/api/issues/${issue.id}/children`)
      .set("Authorization", `Bearer ${token}`)
      .set("X-Paperclip-Run-Id", runId)
      .send({ title: "Subtask persisted by ETS-475 test" })
      .expect(201);

    const childId = created.body.id as string;
    const child = (await db.select().from(issues)).find((row) => row.id === childId)!;
    expect(child).toBeDefined();
    expect(child.parentId).toBe(issue.id);
    expect(child.companyId).toBe(issue.companyId);
    expect(child.title).toBe("Subtask persisted by ETS-475 test");
    expect(child.createdByAgentId ?? null).toBeTruthy();

    // Fetch by returned id: the parent link must be visible through the API.
    const fetched = await request(app)
      .get(`/api/issues/${childId}`)
      .set("Authorization", `Bearer ${token}`)
      .set("X-Paperclip-Run-Id", runId)
      .expect(200);
    expect(fetched.body.id).toBe(childId);
    expect(fetched.body.parentId ?? fetched.body.parent?.id).toBe(issue.id);
  });
});
