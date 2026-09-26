import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { issueService } from "../services/issues.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres same-agent live sibling checkout tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("same-agent live sibling checkout lock", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-same-agent-live-sibling-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(actor: Express.Request["actor"]) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  async function seedCompanyAgentsAndRuns() {
    const companyId = randomUUID();
    const assigneeAgentId = randomUUID();
    const otherAgentId = randomUUID();
    const siblingRunId = randomUUID();
    const actorRunId = randomUUID();
    const otherAgentRunId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: assigneeAgentId,
        companyId,
        name: "Assignee",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: otherAgentId,
        companyId,
        name: "Other",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    // The holder is a LIVE run of the SAME agent; the actor is a second live run
    // of that same agent. The other agent's run is also live so the negative case
    // cannot pass merely because the run is missing.
    await db.insert(heartbeatRuns).values([
      {
        id: siblingRunId,
        companyId,
        agentId: assigneeAgentId,
        status: "running",
        invocationSource: "manual",
        startedAt: new Date(),
      },
      {
        id: actorRunId,
        companyId,
        agentId: assigneeAgentId,
        status: "running",
        invocationSource: "manual",
        startedAt: new Date(),
      },
      {
        id: otherAgentRunId,
        companyId,
        agentId: otherAgentId,
        status: "running",
        invocationSource: "manual",
        startedAt: new Date(),
      },
    ]);

    return {
      companyId,
      assigneeAgentId,
      otherAgentId,
      siblingRunId,
      actorRunId,
      otherAgentRunId,
    };
  }

  function agentActor(
    companyId: string,
    agentId: string,
    runId: string,
  ): Express.Request["actor"] {
    return { type: "agent", agentId, companyId, runId, source: "agent_jwt" };
  }

  async function seedIssue(input: {
    companyId: string;
    assigneeAgentId: string;
    checkoutRunId: string;
  }) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId: input.companyId,
      title: "Sibling-held issue",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: input.assigneeAgentId,
      checkoutRunId: input.checkoutRunId,
      executionRunId: input.checkoutRunId,
      executionLockedAt: new Date(),
    });
    return issueId;
  }

  // TES-114 / TES-116: the assignee must be able to write its own issue even
  // when a concurrently live run of the SAME agent holds the checkout.
  it("lets a live sibling run of the same assignee agent PATCH the issue", async () => {
    const seed = await seedCompanyAgentsAndRuns();
    const issueId = await seedIssue({
      companyId: seed.companyId,
      assigneeAgentId: seed.assigneeAgentId,
      checkoutRunId: seed.siblingRunId,
    });
    // The cross-issue influence guard attributes writes to the run's source issue.
    await db
      .update(heartbeatRuns)
      .set({ contextSnapshot: { issueId } })
      .where(eq(heartbeatRuns.id, seed.actorRunId));

    const res = await request(
      createApp(agentActor(seed.companyId, seed.assigneeAgentId, seed.actorRunId)),
    )
      .patch(`/api/issues/${issueId}`)
      .send({ title: "Written by sibling run" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.title).toBe("Written by sibling run");

    const row = await db
      .select({ title: issues.title, checkoutRunId: issues.checkoutRunId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row?.title).toBe("Written by sibling run");
    expect(row?.checkoutRunId).toBe(seed.actorRunId);
  });

  it("lets the same assignee agent comment on an issue held by a live sibling run", async () => {
    const seed = await seedCompanyAgentsAndRuns();
    const issueId = await seedIssue({
      companyId: seed.companyId,
      assigneeAgentId: seed.assigneeAgentId,
      checkoutRunId: seed.siblingRunId,
    });
    // The cross-issue influence guard attributes writes to the run's source issue.
    await db
      .update(heartbeatRuns)
      .set({ contextSnapshot: { issueId } })
      .where(eq(heartbeatRuns.id, seed.actorRunId));

    const res = await request(
      createApp(agentActor(seed.companyId, seed.assigneeAgentId, seed.actorRunId)),
    )
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "Sibling run comment" });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });

  it("still refuses a live checkout held by a DIFFERENT agent", async () => {
    const seed = await seedCompanyAgentsAndRuns();
    const issueId = await seedIssue({
      companyId: seed.companyId,
      assigneeAgentId: seed.assigneeAgentId,
      checkoutRunId: seed.otherAgentRunId,
    });

    const res = await request(
      createApp(agentActor(seed.companyId, seed.assigneeAgentId, seed.actorRunId)),
    )
      .patch(`/api/issues/${issueId}`)
      .send({ title: "Should be refused" });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("Issue run ownership conflict");
  });

  // TES-118 required test. The case the researcher could not test: a correct
  // cross-agent lock must still refuse. The actor is NOT the assignee, so the
  // same-agent sibling admission must not apply.
  it("refuses a PATCH from a DIFFERENT agent than the assignee, even when a live same-agent sibling holds the lock", async () => {
    const seed = await seedCompanyAgentsAndRuns();
    // The assignee's own live sibling run holds the checkout.
    const issueId = await seedIssue({
      companyId: seed.companyId,
      assigneeAgentId: seed.assigneeAgentId,
      checkoutRunId: seed.siblingRunId,
    });
    await db
      .update(heartbeatRuns)
      .set({ contextSnapshot: { issueId } })
      .where(eq(heartbeatRuns.id, seed.otherAgentRunId));

    // The actor is the OTHER agent — not the assignee.
    const res = await request(
      createApp(agentActor(seed.companyId, seed.otherAgentId, seed.otherAgentRunId)),
    )
      .patch(`/api/issues/${issueId}`)
      .send({ title: "Cross-agent write must be refused" });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.details?.code).toBe("issue_write_assignee_run_lock");
    // The falsification discriminator at the route layer: a correct refusal names
    // a different actor than the assignee.
    expect(res.body.details?.actorAgentId).toBe(seed.otherAgentId);
    expect(res.body.details?.assigneeAgentId).toBe(seed.assigneeAgentId);
    expect(res.body.details?.actorAgentId).not.toBe(
      res.body.details?.assigneeAgentId,
    );

    const row = await db
      .select({ title: issues.title })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row?.title).toBe("Sibling-held issue");
  });

  // The same cross-agent refusal asserted directly against the service, so the
  // guarantee is pinned to assertCheckoutOwner itself and not only to whichever
  // route guard happens to run first. This is the falsification discriminator:
  // a correct refusal names a different actor than the assignee, while the
  // TES-114 defect refuses with actor == assignee.
  it("assertCheckoutOwner refuses a non-assignee agent even when a live same-agent sibling holds the lock", async () => {
    const seed = await seedCompanyAgentsAndRuns();
    const issueId = await seedIssue({
      companyId: seed.companyId,
      assigneeAgentId: seed.assigneeAgentId,
      checkoutRunId: seed.siblingRunId,
    });
    const svc = issueService(db);

    // The assignee's sibling run: admitted.
    await expect(
      svc.assertCheckoutOwner(issueId, seed.assigneeAgentId, seed.actorRunId),
    ).resolves.toMatchObject({ checkoutRunId: seed.actorRunId });

    // A different agent: refused, and the refusal names the true actor.
    await expect(
      svc.assertCheckoutOwner(issueId, seed.otherAgentId, seed.otherAgentRunId),
    ).rejects.toMatchObject({
      status: 409,
      details: {
        actorAgentId: seed.otherAgentId,
        assigneeAgentId: seed.assigneeAgentId,
      },
    });
  });

  it("lets the assignee release a lock held by a live sibling run of the same agent", async () => {
    const seed = await seedCompanyAgentsAndRuns();
    const issueId = await seedIssue({
      companyId: seed.companyId,
      assigneeAgentId: seed.assigneeAgentId,
      checkoutRunId: seed.siblingRunId,
    });

    const res = await request(
      createApp(agentActor(seed.companyId, seed.assigneeAgentId, seed.actorRunId)),
    )
      .post(`/api/issues/${issueId}/release`);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const row = await db
      .select({ checkoutRunId: issues.checkoutRunId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row?.checkoutRunId).toBeNull();
  });

  it("still refuses to release when the holder is a live run of a DIFFERENT agent", async () => {
    const seed = await seedCompanyAgentsAndRuns();
    const issueId = await seedIssue({
      companyId: seed.companyId,
      assigneeAgentId: seed.assigneeAgentId,
      checkoutRunId: seed.otherAgentRunId,
    });

    const res = await request(
      createApp(agentActor(seed.companyId, seed.assigneeAgentId, seed.actorRunId)),
    )
      .post(`/api/issues/${issueId}/release`);

    expect(res.status, JSON.stringify(res.body)).toBe(409);
  });
});
