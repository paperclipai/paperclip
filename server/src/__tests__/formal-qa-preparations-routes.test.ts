import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  formalQaPolicies,
  formalQaPreparations,
  heartbeatRuns,
  projectWorkspaces,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { formalQaPreparationRoutes } from "../routes/formal-qa-preparations.js";
import { formalQaReviewRoutes } from "../routes/formal-qa-reviews.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function boardActor(companyId: string): Express.Request["actor"] {
  return {
    type: "board",
    userId: "board-user",
    source: "session",
    isInstanceAdmin: true,
    companyIds: [companyId],
    memberships: [{ companyId, membershipRole: "admin", status: "active" }],
  };
}

function agentActor(companyId: string): Express.Request["actor"] {
  return {
    type: "agent",
    agentId: randomUUID(),
    companyId,
    source: "agent_key",
    keyScope: { kind: "agent" },
  };
}

function createApp(db: ReturnType<typeof createDb>, actor: Express.Request["actor"]) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", formalQaPreparationRoutes(db));
  app.use("/api", formalQaReviewRoutes(db));
  app.use(errorHandler);
  return app;
}

describeEmbeddedPostgres("formal-QA preparation authority routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-formal-qa-preparations-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(formalQaPolicies);
    await db.delete(formalQaPreparations);
    await db.delete(agents);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const workspaceId = randomUUID();
    const reviewerAgentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({ id: projectId, companyId, name: "Music Tracker", status: "in_progress" });
    await db.insert(projectWorkspaces).values({
      id: workspaceId,
      companyId,
      projectId,
      name: "Tracked repository",
      repoUrl: "https://github.com/vivus-tech/music-tracker.git",
      isPrimary: true,
    });
    await db.insert(agents).values({
      id: reviewerAgentId,
      companyId,
      name: "formal-qa-reviewer",
      role: "reviewer",
      status: "idle",
    });
    await db.insert(formalQaPolicies).values({
      companyId,
      projectId,
      projectWorkspaceId: workspaceId,
      reviewerAgentId,
      repository: "vivus-tech/music-tracker",
      requiredWorkflowId: "99",
      requiredCheckName: "PR Policy",
      requiredCheckAppId: 15368,
      enabled: true,
      createdByUserId: "board-user",
      updatedByUserId: "board-user",
    });
    return { companyId, projectId, workspaceId };
  }

  function payload(projectId: string, workspaceId: string, idempotencyKey = "operation-1") {
    return {
      projectId,
      projectWorkspaceId: workspaceId,
      prNumber: 1902,
      idempotencyKey,
    };
  }

  it("creates an inert tenant-scoped request without calling GitHub or creating a run", async () => {
    const { companyId, projectId, workspaceId } = await seed();
    const response = await request(createApp(db, boardActor(companyId)))
      .post(`/api/companies/${companyId}/formal-qa-preparations`)
      .send(payload(projectId, workspaceId));

    expect(response.status).toBe(202);
    expect(response.body.replayed).toBe(false);
    expect(response.body.preparation.status).toBe("prepared");
    expect(response.body.preparation.projectWorkspaceId).toBe(workspaceId);
    expect(response.body.preparation.headSha).toBe("0".repeat(40));
    expect(response.body.preparation.requestSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await db.select().from(heartbeatRuns)).toEqual([]);
    const reviews = await request(createApp(db, boardActor(companyId)))
      .get(`/api/companies/${companyId}/formal-qa-reviews`);
    expect(reviews.status).toBe(200);
    expect(reviews.body).toEqual([]);
  });

  it("replays the exact receipt but rejects a changed payload under the same idempotency key", async () => {
    const { companyId, projectId, workspaceId } = await seed();
    const app = createApp(db, boardActor(companyId));
    const first = payload(projectId, workspaceId);
    const created = await request(app).post(`/api/companies/${companyId}/formal-qa-preparations`).send(first);
    const replayed = await request(app).post(`/api/companies/${companyId}/formal-qa-preparations`).send(first);
    const changed = await request(app)
      .post(`/api/companies/${companyId}/formal-qa-preparations`)
      .send({ ...first, prNumber: 1903 });

    expect(created.status).toBe(202);
    expect(replayed.status).toBe(200);
    expect(replayed.body.preparation.id).toBe(created.body.preparation.id);
    expect(changed.status).toBe(409);
    expect(changed.body.details.code).toBe("formal_qa_preparation_idempotency_conflict");
  });

  it("rejects a workspace from another company and agent issuance", async () => {
    const { companyId, projectId, workspaceId } = await seed();
    const otherCompanyId = randomUUID();
    const otherProjectId = randomUUID();
    await db.insert(companies).values({
      id: otherCompanyId,
      name: "Other",
      issuePrefix: `T${otherCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({ id: otherProjectId, companyId: otherCompanyId, name: "Other project", status: "in_progress" });

    const wrongWorkspace = await request(createApp(db, boardActor(companyId)))
      .post(`/api/companies/${companyId}/formal-qa-preparations`)
      .send(payload(otherProjectId, workspaceId, "operation-wrong-project"));
    const agentIssue = await request(createApp(db, agentActor(companyId)))
      .post(`/api/companies/${companyId}/formal-qa-preparations`)
      .send(payload(projectId, workspaceId, "operation-agent"));

    expect(wrongWorkspace.status).toBe(409);
    expect(wrongWorkspace.body.details.code).toBe("formal_qa_policy_unavailable");
    expect(agentIssue.status).toBe(403);
  });
});
