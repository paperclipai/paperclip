import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
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
import { DURABLE_WRITE_DENIED_ERROR_CODE } from "../services/agent-run-authority.js";

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
    const unfinished = status === "running" || status === "queued" || status === "scheduled_retry";
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      status,
      invocationSource: "manual",
      startedAt: new Date(),
      finishedAt: unfinished ? null : new Date(),
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
    // Not terminal, and deliberately not executing: recovery parks a run here
    // while it waits to retry, so it has no process to speak for the agent.
    const scheduledRetryRunId = await seedRun({
      companyId,
      agentId,
      status: "scheduled_retry",
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
      scheduledRetryRunId,
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

  /**
   * Waits until some other session is parked on a row lock. That is the signal
   * that the request under test has passed every unlocked gate and is waiting
   * for the run row — polling it instead of sleeping keeps the interleaving
   * deterministic rather than timing-dependent.
   */
  async function waitForBlockedSession() {
    for (let attempt = 0; attempt < 150; attempt += 1) {
      const rows = await db.execute(sql`
        select count(*)::int as waiting
        from pg_stat_activity
        where wait_event_type = 'Lock' and state = 'active' and datname = current_database()
      `);
      if (Number((rows as unknown as Array<{ waiting: number }>)[0]?.waiting ?? 0) > 0) return true;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
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
    // Write authority is an allowlist of queued/running, not "anything that has
    // not finished": a parked scheduled_retry run has no process behind it.
    ["inactive/scheduled-retry", (s: Scenario) => s.scheduledRetryRunId],
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

  /**
   * The blocker/resume controls take a richer PATCH path that resolves agent
   * trust from the run row before the cap transaction runs. That lookup used to
   * hand the raw header to a uuid column, so a forged id answered 500 — an
   * unaudited error class instead of the fail-closed denial contract.
   */
  it("denies a malformed run id on the blocker PATCH path with an audited 403 and no mutation", async () => {
    const scenario = await seedScenario();
    const before = await readIssue(scenario.issueId);
    const forgedRunId = "../../not-a-run-id";

    const res = await request(createApp(agentActor(scenario.companyId, scenario.agentId, forgedRunId)))
      .patch(`/api/issues/${scenario.issueId}`)
      .send({ blockedByIssueIds: [] });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.details?.code, JSON.stringify(res.body)).toBe("cross_issue_influence_run_context_required");
    expect(await readIssue(scenario.issueId)).toEqual(before);
    expect(await db.select({ id: issueRelations.id }).from(issueRelations)).toHaveLength(0);

    const denials = await db
      .select({ runId: activityLog.runId, details: activityLog.details })
      .from(activityLog)
      .where(eq(activityLog.action, "issue.agent_run_context_denied"));
    expect(denials).toHaveLength(1);
    // The column is a foreign key, so an unpersisted id survives only in details.
    expect(denials[0]?.runId).toBeNull();
    expect(denials[0]?.details).toMatchObject({
      runId: forgedRunId,
      runExists: false,
      reason: "malformed_run_id",
    });
  });

  /**
   * The route gate reads the run without holding it, so a run can terminalize
   * between that decision and the durable write. The mutation transaction
   * re-locks the run row, so the terminalization either wins outright or waits
   * behind the write — it can never land in between.
   */
  it("refuses a release when the run is terminalized before the issue write lands", async () => {
    const companyId = await seedCompany("Paperclip");
    const agentId = await seedAgent(companyId, "CodexCoder");
    const issueId = randomUUID();
    const runId = await seedRun({ companyId, agentId, contextSnapshot: { issueId, taskId: issueId } });
    // No execution lock on the issue: stale-lock recovery would otherwise clear
    // it and answer 409, which would prove lock hygiene rather than this gate.
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Racing release",
      status: "in_review",
      priority: "medium",
      assigneeAgentId: agentId,
    });
    const before = await readIssue(issueId);

    const lockDb = createDb(tempDb!.connectionString);
    let signalLocked!: () => void;
    const locked = new Promise<void>((resolve) => {
      signalLocked = resolve;
    });
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const lockHeld = lockDb.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM heartbeat_runs WHERE id = ${runId} FOR UPDATE`);
      signalLocked();
      // Terminalize only once the release request is parked behind this lock,
      // so the interleaving under test is the real one: the route gate has
      // already admitted a live run, and the durable write has not happened.
      await gate;
      await tx.execute(
        sql`UPDATE heartbeat_runs SET status = 'failed', finished_at = now() WHERE id = ${runId}`,
      );
    });

    const app = createApp(agentActor(companyId, agentId, runId));
    // Warm the route stack first: a cold first request can take seconds to
    // issue its first query, which would let the terminalization land before
    // the gate instead of between the gate and the write.
    await request(app).get(`/api/issues/${issueId}`);

    await locked;
    // `.then` is what actually dispatches a supertest request; without it the
    // request would sit unsent while this test waits for it to block.
    const pending = request(app).post(`/api/issues/${issueId}/release`).send({}).then((res) => res);
    expect(await waitForBlockedSession(), "release never blocked on the run row").toBe(true);
    releaseGate();
    await lockHeld;

    const res = await pending;
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.code, JSON.stringify(res.body)).toBe("agent_run_context_invalid");
    // Proves the refusal came from the write-time lock, not the route gate:
    // the gate had already admitted this run while it was still live.
    expect(res.body.details?.stage, JSON.stringify(res.body)).toBe("durable_write");
    expect(await readIssue(issueId)).toEqual(before);

    await lockDb.$client.end();
  }, 60_000);

  /**
   * FAI-9903 — the denial has to survive the request that caused it.
   *
   * An agent whose writes were all refused still finished as a `succeeded`
   * heartbeat, because finalization reads the adapter's exit code and an
   * adapter that never inspected the 403s exits 0. Marking the run at the
   * denial site is what lets finalization contradict that exit code.
   *
   * The marker is deliberately hard to aim. The run id comes from a caller
   * controlled header, so marking whatever run it names would let any agent-key
   * holder fail *another* agent's run by quoting its id — a denial-of-service
   * traded for the write-authorization hole above.
   */
  async function readRunErrorCode(runId: string) {
    return db
      .select({ errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0]?.errorCode ?? null);
  }

  it("marks the caller's own live run when its context does not name the target issue", async () => {
    const scenario = await seedScenario();
    const app = createApp(agentActor(scenario.companyId, scenario.agentId, scenario.wrongIssueRunId));

    const res = await request(app)
      .post(`/api/issues/${scenario.issueId}/checkout`)
      .send({ agentId: scenario.agentId, expectedStatuses: ["todo"] });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(await readRunErrorCode(scenario.wrongIssueRunId)).toBe(DURABLE_WRITE_DENIED_ERROR_CODE);
  });

  it("marks the caller's own live run when a comment is refused for missing context", async () => {
    const scenario = await seedScenario();
    const app = createApp(agentActor(scenario.companyId, scenario.agentId, scenario.emptyContextRunId));

    const res = await request(app)
      .post(`/api/issues/${scenario.issueId}/comments`)
      .send({ body: "Write that must not land." });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(await countComments(scenario.issueId)).toBe(0);
    expect(await readRunErrorCode(scenario.emptyContextRunId)).toBe(DURABLE_WRITE_DENIED_ERROR_CODE);
  });

  it("never marks a live run belonging to a different agent", async () => {
    const scenario = await seedScenario();
    const app = createApp(agentActor(scenario.companyId, scenario.agentId, scenario.otherAgentRunId));

    const res = await request(app)
      .post(`/api/issues/${scenario.issueId}/checkout`)
      .send({ agentId: scenario.agentId, expectedStatuses: ["todo"] });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    // Quoting a peer's run id must not be a way to fail that peer's heartbeat.
    expect(await readRunErrorCode(scenario.otherAgentRunId)).toBeNull();
  });

  it("never marks a run that has already finished", async () => {
    const scenario = await seedScenario();
    const app = createApp(agentActor(scenario.companyId, scenario.agentId, scenario.staleRunId));

    const res = await request(app)
      .post(`/api/issues/${scenario.issueId}/checkout`)
      .send({ agentId: scenario.agentId, expectedStatuses: ["todo"] });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    // A finished run has no finalization left to correct, and rewriting its
    // terminal error would destroy the record of why it actually ended.
    expect(await readRunErrorCode(scenario.staleRunId)).toBeNull();
  });

  it("keeps the error code an earlier, more specific denial already wrote", async () => {
    const scenario = await seedScenario();
    await db
      .update(heartbeatRuns)
      .set({ errorCode: "RESPONSIBLE_USER_UNAUTHORIZED" })
      .where(eq(heartbeatRuns.id, scenario.wrongIssueRunId));
    const app = createApp(agentActor(scenario.companyId, scenario.agentId, scenario.wrongIssueRunId));

    const res = await request(app)
      .post(`/api/issues/${scenario.issueId}/checkout`)
      .send({ agentId: scenario.agentId, expectedStatuses: ["todo"] });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    // Both codes finalize the run the same way, so first writer wins and the
    // more specific reason survives.
    expect(await readRunErrorCode(scenario.wrongIssueRunId)).toBe("RESPONSIBLE_USER_UNAUTHORIZED");
  });
});
