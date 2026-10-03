import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres cross-issue-influence checkout route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

/**
 * Route-level proof for a bare `heartbeat_timer` run (no recorded source
 * issue in `contextSnapshot`) writing to the issue it actually checked out
 * through the real `/checkout` route, then the real `/comments` route — not
 * `observeCrossIssueInfluence` called directly with a hand-built fake db and
 * an asserted-away checkout state. The unit test in
 * cross-issue-influence-limit.test.ts proves the counter math; this proves
 * checkout ownership and the checkout-to-write route integration actually
 * hold end to end. See the Greptile review on PR #11500.
 */
describeEmbeddedPostgres("cross-issue influence cap for a source-less run (checkout + comment routes)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-cross-issue-checkout-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    const cleanups = [
      () => db.delete(activityLog),
      () => db.delete(heartbeatRuns),
      () => db.delete(issues),
      () => db.delete(companyMemberships),
      () => db.delete(agents),
      () => db.delete(companies),
    ];
    for (const cleanup of cleanups) await cleanup().catch(() => undefined);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function app(actor: Record<string, unknown>) {
    const testApp = express();
    testApp.use(express.json());
    testApp.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    testApp.use("/api", issueRoutes(db, {} as any, {}));
    testApp.use(errorHandler);
    return testApp;
  }

  function agentActor(companyId: string, agentId: string, runId: string) {
    return { type: "agent", source: "agent_key", companyId, agentId, runId };
  }

  async function seedCompanyAndAgent(prefix: string) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `${prefix} Company`,
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: `${prefix} Resolver`,
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: `${prefix.toLowerCase()}-operator`,
      status: "active",
      membershipRole: "operator",
    });
    return { companyId, agentId };
  }

  async function seedUnassignedIssue(companyId: string, prefix: string) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: `${prefix}-1`,
      title: `${prefix} issue`,
      status: "todo",
      priority: "medium",
      assigneeAgentId: null,
    });
    return issueId;
  }

  /**
   * The plain `heartbeat_timer` scheduler wake shape (services/heartbeat.js
   * `enqueueWakeup`): no `issueId`/`taskId` at all, because the scheduler does
   * not know which issue the agent will pick until its own inbox/checkout
   * logic runs.
   */
  async function seedSourcelessRun(companyId: string, agentId: string) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "timer",
      triggerDetail: "heartbeat_timer",
      status: "running",
      contextSnapshot: { source: "scheduler", reason: "interval_elapsed" },
    });
    return runId;
  }

  async function countInfluenceRows(companyId: string, runId: string, action: string) {
    const rows = await db
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.runId, runId),
        eq(activityLog.action, action),
      ));
    return rows.length;
  }

  it("allows a source-less run to comment on the issue it actually checked out through the real checkout route", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent("SLS");
    const issueId = await seedUnassignedIssue(companyId, "SLS");
    const runId = await seedSourcelessRun(companyId, agentId);
    const client = request(app(agentActor(companyId, agentId, runId)));

    // Real checkout: the run has no recorded source issue, so this is the
    // only place its ownership of `issueId` is ever established.
    const checkoutRes = await client
      .post(`/api/issues/${issueId}/checkout`)
      .send({ agentId, expectedStatuses: ["todo"] });
    expect(checkoutRes.status, JSON.stringify(checkoutRes.body)).toBe(200);

    const [checkedOut] = await db
      .select({ checkoutRunId: issues.checkoutRunId, assigneeAgentId: issues.assigneeAgentId })
      .from(issues)
      .where(eq(issues.id, issueId));
    expect(checkedOut).toMatchObject({ checkoutRunId: runId, assigneeAgentId: agentId });

    // Real write against the checked-out issue, through the real comments
    // route — not a direct service call.
    const commentRes = await client
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "Picked this up from the inbox." });
    expect(commentRes.status, JSON.stringify(commentRes.body)).toBe(201);

    expect(await countInfluenceRows(companyId, runId, "issue.cross_issue_influence_observed")).toBe(1);
    expect(await countInfluenceRows(companyId, runId, "issue.cross_issue_influence_cap_rejected")).toBe(0);
  }, 30_000);
});
