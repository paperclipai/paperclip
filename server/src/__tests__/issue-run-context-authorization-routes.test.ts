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
  issueRelations,
  issues,
} from "@paperclipai/db";
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
    `Skipping embedded Postgres run-context authorization route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

/**
 * FAI-9983 — fail-closed run-context authorization.
 *
 * `X-Paperclip-Run-Id` is a claim, not an authority. Every agent mutation route
 * must prove the supplied run is persisted, live, owned by the actor agent, in
 * the issue's company, and already bound to an issue before anything durable
 * happens. Checkout and release enforce it through
 * `assertCanonicalAgentRunContext`; comment and PATCH through the locked
 * `observeCrossIssueInfluence` transaction. Each negative case below asserts the
 * denial *and* that no issue field, execution lock, assignee, status, comment,
 * or run context changed.
 */
describeEmbeddedPostgres("issue run-context authorization routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-run-context-authorization-routes-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issueRelations);
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

  function agentActor(companyId: string, agentId: string, runId: string): Express.Request["actor"] {
    return {
      type: "agent",
      agentId,
      companyId,
      runId,
      source: "agent_jwt",
    };
  }

  async function seedCompany(name: string) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name,
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedAgent(companyId: string, name: string) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name,
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return agentId;
  }

  async function seedRun(input: {
    companyId: string;
    agentId: string;
    status?: string;
    contextSnapshot?: Record<string, unknown> | null;
  }) {
    const runId = randomUUID();
    const status = input.status ?? "running";
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      status,
      invocationSource: "manual",
      startedAt: new Date(),
      finishedAt: status === "running" ? null : new Date(),
      contextSnapshot: input.contextSnapshot ?? null,
    });
    return runId;
  }

  /**
   * One canonical live run plus every way a run id can be illegitimate. The
   * target issue is idle and self-assigned so that only the run id under test
   * decides the outcome — no checkout-lock or assignee guard fires first.
   */
  async function seedScenario() {
    const companyId = await seedCompany("Paperclip");
    const otherCompanyId = await seedCompany("Rival");
    const agentId = await seedAgent(companyId, "CodexCoder");
    const otherAgentId = await seedAgent(companyId, "PeerCoder");
    const issueId = randomUUID();
    const otherIssueId = randomUUID();

    const liveRunId = await seedRun({ companyId, agentId, contextSnapshot: { issueId, taskId: issueId } });
    const staleRunId = await seedRun({
      companyId,
      agentId,
      status: "failed",
      contextSnapshot: { issueId, taskId: issueId },
    });
    const emptyContextRunId = await seedRun({ companyId, agentId, contextSnapshot: {} });
    const otherAgentRunId = await seedRun({
      companyId,
      agentId: otherAgentId,
      contextSnapshot: { issueId, taskId: issueId },
    });
    const otherCompanyRunId = await seedRun({
      companyId: otherCompanyId,
      agentId,
      contextSnapshot: { issueId, taskId: issueId },
    });
    const wrongIssueRunId = await seedRun({
      companyId,
      agentId,
      contextSnapshot: { issueId: otherIssueId, taskId: otherIssueId },
    });

    await db.insert(issues).values([
      {
        id: issueId,
        companyId,
        title: "Run context target",
        status: "todo",
        priority: "high",
        assigneeAgentId: agentId,
      },
      {
        id: otherIssueId,
        companyId,
        title: "Unrelated issue",
        status: "todo",
        priority: "medium",
      },
    ]);

    return {
      companyId,
      agentId,
      issueId,
      otherIssueId,
      liveRunId,
      staleRunId,
      emptyContextRunId,
      otherAgentRunId,
      otherCompanyRunId,
      wrongIssueRunId,
      unknownRunId: randomUUID(),
    };
  }

  async function readIssue(issueId: string) {
    return db
      .select({
        title: issues.title,
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
  }

  async function readRunContext(runId: string) {
    // A forged run id need not be a uuid, and then there is nothing to read.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(runId)) return null;
    return db
      .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0]?.contextSnapshot ?? null);
  }

  async function countComments(issueId: string) {
    return db
      .select({ id: issueComments.id })
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId))
      .then((rows) => rows.length);
  }

  it("lets a live canonical run check out, comment on, patch and release its issue", async () => {
    const companyId = await seedCompany("Paperclip");
    const agentId = await seedAgent(companyId, "CodexCoder");
    const issueId = randomUUID();
    const runId = await seedRun({ companyId, agentId, contextSnapshot: { issueId, taskId: issueId } });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Canonical lifecycle",
      status: "todo",
      priority: "medium",
    });
    const app = createApp(agentActor(companyId, agentId, runId));

    const checkout = await request(app)
      .post(`/api/issues/${issueId}/checkout`)
      .send({ agentId, expectedStatuses: ["todo"] });
    expect(checkout.status, JSON.stringify(checkout.body)).toBe(200);
    expect(await readIssue(issueId)).toMatchObject({
      status: "in_progress",
      assigneeAgentId: agentId,
      checkoutRunId: runId,
      executionRunId: runId,
    });

    const comment = await request(app)
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "Progress from the canonical run." });
    expect(comment.status, JSON.stringify(comment.body)).toBe(201);

    const patch = await request(app)
      .patch(`/api/issues/${issueId}`)
      .send({ title: "Canonical lifecycle (updated)" });
    expect(patch.status, JSON.stringify(patch.body)).toBe(200);

    const release = await request(app).post(`/api/issues/${issueId}/release`).send({});
    expect(release.status, JSON.stringify(release.body)).toBe(200);
    expect(await readIssue(issueId)).toEqual({
      title: "Canonical lifecycle (updated)",
      status: "todo",
      assigneeAgentId: null,
      checkoutRunId: null,
      executionRunId: null,
    });
  });

  type Scenario = Awaited<ReturnType<typeof seedScenario>>;

  const invalidRunCases = [
    ["unknown", (s: Scenario) => s.unknownRunId],
    ["terminal/stale", (s: Scenario) => s.staleRunId],
    ["unassigned/empty-context", (s: Scenario) => s.emptyContextRunId],
    ["mismatched-agent", (s: Scenario) => s.otherAgentRunId],
    ["mismatched-company", (s: Scenario) => s.otherCompanyRunId],
    // A forged header is an arbitrary string, not necessarily a uuid: it has to
    // deny like any other bad run id rather than surface a uuid cast error.
    ["forged/non-uuid", () => "../../not-a-run-id"],
  ] as const;

  /**
   * `code` is where each route reports the run-context denial: the checkout and
   * release gate answers with a top-level `code`, the comment/PATCH cap
   * transaction with the shared issue-write denial `details.code`.
   */
  const mutationRoutes = [
    [
      "checkout",
      (app: express.Express, s: Scenario) =>
        request(app).post(`/api/issues/${s.issueId}/checkout`).send({
          agentId: s.agentId,
          expectedStatuses: ["todo"],
        }),
      (body: any) => body.code,
      "agent_run_context_invalid",
    ],
    [
      "release",
      (app: express.Express, s: Scenario) =>
        request(app).post(`/api/issues/${s.issueId}/release`).send({}),
      (body: any) => body.code,
      "agent_run_context_invalid",
    ],
    [
      "comment",
      (app: express.Express, s: Scenario) =>
        request(app).post(`/api/issues/${s.issueId}/comments`).send({ body: "Forged run comment" }),
      (body: any) => body.details?.code,
      "cross_issue_influence_run_context_required",
    ],
    [
      "patch",
      (app: express.Express, s: Scenario) =>
        request(app).patch(`/api/issues/${s.issueId}`).send({ title: "Forged run title" }),
      (body: any) => body.details?.code,
      "cross_issue_influence_run_context_required",
    ],
  ] as const;

  for (const [routeName, sendRequest, readCode, expectedCode] of mutationRoutes) {
    for (const [caseName, pickRunId] of invalidRunCases) {
      it(`denies ${routeName} from a ${caseName} run without mutating anything`, async () => {
        const scenario = await seedScenario();
        const before = await readIssue(scenario.issueId);
        const runId = pickRunId(scenario);
        const contextBefore = await readRunContext(runId);

        const res = await sendRequest(
          createApp(agentActor(scenario.companyId, scenario.agentId, runId)),
          scenario,
        );

        expect(res.status, JSON.stringify(res.body)).toBe(403);
        expect(readCode(res.body), JSON.stringify(res.body)).toBe(expectedCode);
        expect(await readIssue(scenario.issueId)).toEqual(before);
        expect(await countComments(scenario.issueId)).toBe(0);
        expect(await readRunContext(runId)).toEqual(contextBefore);
      });
    }
  }

  it("denies checkout from a run bound to a different issue and creates no lock", async () => {
    const scenario = await seedScenario();
    const before = await readIssue(scenario.otherIssueId);

    const res = await request(createApp(agentActor(scenario.companyId, scenario.agentId, scenario.liveRunId)))
      .post(`/api/issues/${scenario.otherIssueId}/checkout`)
      .send({ agentId: scenario.agentId, expectedStatuses: ["todo"] });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.code).toBe("agent_run_context_invalid");
    expect(await readIssue(scenario.otherIssueId)).toEqual(before);
    // The run it authenticated with must not have been re-pointed at the target.
    expect(await readRunContext(scenario.liveRunId)).toEqual({
      issueId: scenario.issueId,
      taskId: scenario.issueId,
    });
  });

  it("denies release of an idle self-assigned issue from a run bound elsewhere", async () => {
    const scenario = await seedScenario();

    const res = await request(createApp(agentActor(scenario.companyId, scenario.agentId, scenario.wrongIssueRunId)))
      .post(`/api/issues/${scenario.issueId}/release`)
      .send({});

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.code).toBe("agent_run_context_invalid");
    expect(await readIssue(scenario.issueId)).toMatchObject({
      status: "todo",
      assigneeAgentId: scenario.agentId,
    });
  });

  it("lets a queued run act: it is the heartbeat about to execute, not a spent one", async () => {
    const companyId = await seedCompany("Paperclip");
    const agentId = await seedAgent(companyId, "CodexCoder");
    const issueId = randomUUID();
    const runId = await seedRun({
      companyId,
      agentId,
      status: "queued",
      contextSnapshot: { issueId, taskId: issueId },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Queued run target",
      status: "todo",
      priority: "medium",
    });
    const app = createApp(agentActor(companyId, agentId, runId));

    const checkout = await request(app)
      .post(`/api/issues/${issueId}/checkout`)
      .send({ agentId, expectedStatuses: ["todo"] });
    expect(checkout.status, JSON.stringify(checkout.body)).toBe(200);

    const comment = await request(app)
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "Claimed from the queued run." });
    expect(comment.status, JSON.stringify(comment.body)).toBe(201);
  });

  it("preserves status when an authorized run releases an issue it never checked out", async () => {
    const companyId = await seedCompany("Paperclip");
    const agentId = await seedAgent(companyId, "CodexCoder");
    const issueId = randomUUID();
    const runId = await seedRun({ companyId, agentId, contextSnapshot: { issueId, taskId: issueId } });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Awaiting review",
      status: "in_review",
      priority: "medium",
      assigneeAgentId: agentId,
    });

    const res = await request(createApp(agentActor(companyId, agentId, runId)))
      .post(`/api/issues/${issueId}/release`)
      .send({});

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // in_progress -> todo is the only transition release is allowed to make;
    // every other status survives the lock being dropped.
    expect(await readIssue(issueId)).toMatchObject({
      status: "in_review",
      assigneeAgentId: null,
      checkoutRunId: null,
      executionRunId: null,
    });
  });

  it("audits every run-context denial with the run id and the failing check", async () => {
    const scenario = await seedScenario();

    const res = await request(createApp(agentActor(scenario.companyId, scenario.agentId, scenario.unknownRunId)))
      .post(`/api/issues/${scenario.issueId}/release`)
      .send({});
    expect(res.status, JSON.stringify(res.body)).toBe(403);

    const denials = await db
      .select({ entityId: activityLog.entityId, details: activityLog.details })
      .from(activityLog)
      .where(eq(activityLog.action, "issue.agent_run_context_denied"));
    expect(denials).toHaveLength(1);
    expect(denials[0]?.entityId).toBe(scenario.issueId);
    expect(denials[0]?.details).toMatchObject({
      runId: scenario.unknownRunId,
      runExists: false,
    });
  });
});
