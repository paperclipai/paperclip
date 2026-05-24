import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  agentWakeupRequests,
  activityLog,
  companies,
  createDb,
  environmentLeases,
  environments,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { recoveryActionRoutes } from "../routes/recovery-actions.js";
import { issueRecoveryActionService } from "../services/issue-recovery-actions.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres recovery action route tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("recovery action routes", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-recovery-action-routes-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(issueRecoveryActions);
    await db.delete(issueComments);
    await db.delete(environmentLeases);
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(environments);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const assigneeAgentId = randomUUID();
    const previousOwnerAgentId = randomUUID();
    const strangerAgentId = randomUUID();
    const sourceIssueId = randomUUID();
    const prefix = `RR${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Recovery Routes Co",
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: ownerAgentId,
        companyId,
        name: "Recovery Owner",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: assigneeAgentId,
        companyId,
        name: "Source Assignee",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: previousOwnerAgentId,
        companyId,
        name: "Previous Owner",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: strangerAgentId,
        companyId,
        name: "Stranger",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(issues).values({
      id: sourceIssueId,
      companyId,
      title: "Stranded source issue",
      status: "blocked",
      priority: "medium",
      assigneeAgentId,
      issueNumber: 1,
      identifier: `${prefix}-1`,
    });
    return {
      companyId,
      ownerAgentId,
      assigneeAgentId,
      previousOwnerAgentId,
      strangerAgentId,
      sourceIssueId,
    };
  }

  function createApp(actor: any = { type: "board", source: "local_implicit" }) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    app.use("/api", recoveryActionRoutes(db));
    app.use(errorHandler);
    return app;
  }

  async function seedAction(input: {
    companyId: string;
    sourceIssueId: string;
    ownerAgentId: string;
    previousOwnerAgentId?: string | null;
  }) {
    const svc = issueRecoveryActionService(db);
    return svc.upsertSourceScoped({
      companyId: input.companyId,
      sourceIssueId: input.sourceIssueId,
      kind: "stranded_assigned_issue",
      ownerType: "agent",
      ownerAgentId: input.ownerAgentId,
      previousOwnerAgentId: input.previousOwnerAgentId ?? null,
      cause: "stranded_assigned_issue",
      fingerprint: `route-test:${randomUUID()}`,
      evidence: { source: "test" },
      nextAction: "Restore a live execution path.",
    });
  }

  it("returns 200 for GET /recovery-actions/:id when the action exists", async () => {
    const seed = await seedCompany();
    const action = await seedAction({
      companyId: seed.companyId,
      sourceIssueId: seed.sourceIssueId,
      ownerAgentId: seed.ownerAgentId,
    });
    const app = createApp();
    const res = await request(app).get(`/api/recovery-actions/${action.id}`).expect(200);
    expect(res.body.action).toMatchObject({
      id: action.id,
      companyId: seed.companyId,
      sourceIssueId: seed.sourceIssueId,
      status: "active",
    });
  });

  it("returns 404 for GET /recovery-actions/:id with an unknown UUID", async () => {
    await seedCompany();
    const app = createApp();
    await request(app).get(`/api/recovery-actions/${randomUUID()}`).expect(404);
  });

  it("returns 404 for GET /recovery-actions/:id with a non-UUID id", async () => {
    const app = createApp();
    await request(app).get(`/api/recovery-actions/not-a-uuid`).expect(404);
  });

  it("lists active recovery actions scoped to companyId", async () => {
    const seed = await seedCompany();
    const action = await seedAction({
      companyId: seed.companyId,
      sourceIssueId: seed.sourceIssueId,
      ownerAgentId: seed.ownerAgentId,
    });
    const app = createApp();
    const res = await request(app)
      .get(`/api/recovery-actions?companyId=${seed.companyId}`)
      .expect(200);
    expect(res.body.actions).toHaveLength(1);
    expect(res.body.actions[0]).toMatchObject({ id: action.id });
  });

  it("returns 400 when listing without companyId for a board user", async () => {
    const app = createApp();
    await request(app).get(`/api/recovery-actions`).expect(400);
  });

  it("resolves an active recovery action via POST /recovery-actions/:id/resolve", async () => {
    const seed = await seedCompany();
    const action = await seedAction({
      companyId: seed.companyId,
      sourceIssueId: seed.sourceIssueId,
      ownerAgentId: seed.ownerAgentId,
    });
    const app = createApp();
    const res = await request(app)
      .post(`/api/recovery-actions/${action.id}/resolve`)
      .send({ outcome: "restored", resolutionNote: "fixed by hand" })
      .expect(200);
    expect(res.body.action).toMatchObject({
      id: action.id,
      status: "resolved",
      outcome: "restored",
      resolutionNote: "fixed by hand",
    });
    expect(res.body.action.resolvedAt).toBeTruthy();
  });

  it("returns 403 when an unrelated agent attempts to resolve the action", async () => {
    const seed = await seedCompany();
    const action = await seedAction({
      companyId: seed.companyId,
      sourceIssueId: seed.sourceIssueId,
      ownerAgentId: seed.ownerAgentId,
    });
    const app = createApp({
      type: "agent",
      agentId: seed.strangerAgentId,
      companyId: seed.companyId,
    });
    await request(app)
      .post(`/api/recovery-actions/${action.id}/resolve`)
      .send({ outcome: "restored" })
      .expect(403);
  });

  it("allows the source issue assignee agent to resolve", async () => {
    const seed = await seedCompany();
    const action = await seedAction({
      companyId: seed.companyId,
      sourceIssueId: seed.sourceIssueId,
      ownerAgentId: seed.ownerAgentId,
    });
    const app = createApp({
      type: "agent",
      agentId: seed.assigneeAgentId,
      companyId: seed.companyId,
    });
    await request(app)
      .post(`/api/recovery-actions/${action.id}/resolve`)
      .send({ outcome: "restored" })
      .expect(200);
  });

  it("allows the recovery owner agent to resolve", async () => {
    const seed = await seedCompany();
    const action = await seedAction({
      companyId: seed.companyId,
      sourceIssueId: seed.sourceIssueId,
      ownerAgentId: seed.ownerAgentId,
    });
    const app = createApp({
      type: "agent",
      agentId: seed.ownerAgentId,
      companyId: seed.companyId,
    });
    await request(app)
      .post(`/api/recovery-actions/${action.id}/resolve`)
      .send({ outcome: "restored" })
      .expect(200);
  });

  it("returns 404 when resolving an unknown action id", async () => {
    await seedCompany();
    const app = createApp();
    await request(app)
      .post(`/api/recovery-actions/${randomUUID()}/resolve`)
      .send({ outcome: "restored" })
      .expect(404);
  });

  it("rejects a second resolve attempt with 422 (resolved action does not re-fire)", async () => {
    const seed = await seedCompany();
    const action = await seedAction({
      companyId: seed.companyId,
      sourceIssueId: seed.sourceIssueId,
      ownerAgentId: seed.ownerAgentId,
    });
    const app = createApp();
    await request(app)
      .post(`/api/recovery-actions/${action.id}/resolve`)
      .send({ outcome: "restored" })
      .expect(200);
    await request(app)
      .post(`/api/recovery-actions/${action.id}/resolve`)
      .send({ outcome: "restored" })
      .expect(422);
    expect(
      await issueRecoveryActionService(db).getActiveForIssue(seed.companyId, seed.sourceIssueId),
    ).toBeNull();
  });

  it("wakes previousOwnerAgentId and posts a mention comment when outcome=escalated", async () => {
    const seed = await seedCompany();
    const action = await seedAction({
      companyId: seed.companyId,
      sourceIssueId: seed.sourceIssueId,
      ownerAgentId: seed.ownerAgentId,
      previousOwnerAgentId: seed.previousOwnerAgentId,
    });
    const app = createApp();
    const res = await request(app)
      .post(`/api/recovery-actions/${action.id}/resolve`)
      .send({ outcome: "escalated", resolutionNote: "kicking back to original owner" })
      .expect(200);
    expect(res.body.action).toMatchObject({
      id: action.id,
      status: "resolved",
      outcome: "escalated",
      previousOwnerAgentId: seed.previousOwnerAgentId,
    });

    const wakeups = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, seed.previousOwnerAgentId));
    expect(wakeups.length).toBeGreaterThanOrEqual(1);
    const escalationWake = wakeups.find((row) => row.reason === "recovery_action_escalated");
    expect(escalationWake).toBeDefined();
    expect(escalationWake?.payload).toMatchObject({
      recoveryActionId: action.id,
      sourceIssueId: seed.sourceIssueId,
    });

    const comments = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, seed.sourceIssueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain(`agent://${seed.previousOwnerAgentId}`);
    expect(comments[0]?.authorType).toBe("system");
  });

  it("does not wake when outcome=escalated but previousOwnerAgentId is null", async () => {
    const seed = await seedCompany();
    const action = await seedAction({
      companyId: seed.companyId,
      sourceIssueId: seed.sourceIssueId,
      ownerAgentId: seed.ownerAgentId,
      previousOwnerAgentId: null,
    });
    const app = createApp();
    await request(app)
      .post(`/api/recovery-actions/${action.id}/resolve`)
      .send({ outcome: "escalated" })
      .expect(200);
    const wakeups = await db.select().from(agentWakeupRequests);
    expect(wakeups).toHaveLength(0);
  });
});
