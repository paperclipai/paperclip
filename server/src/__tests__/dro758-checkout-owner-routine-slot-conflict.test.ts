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

// Regression coverage for DRO-758.
//
// Reported symptom: PATCH /api/issues/:id and DELETE /api/issues/:id/comments/:id
// both returned a bare 500 for a routine_execution-origin issue whose own
// checkout/execution lock columns had been cleared (e.g. by
// clearExecutionRunIfTerminal after its run went terminal) while a sibling
// issue from the *same* routine dispatch (same companyId + originKind +
// originId + originFingerprint) still legitimately held the single "live
// execution slot" enforced by the issues_open_routine_execution_uq partial
// unique index.
//
// Root cause: assertAgentIssueMutationAllowed -> svc.assertCheckoutOwner tries
// to adopt the unowned/stale checkout lock for the acting agent's live run by
// writing a non-null executionRunId onto the target issue. That write collides
// with the sibling's slot and throws a raw Postgres unique-violation wrapped in
// drizzle-orm's DrizzleQueryError, uncaught, producing a bare 500 on ANY
// mutating route that funnels through assertCheckoutOwner (PATCH, DELETE
// comment, and /release all share this call).
//
// Fix: adoptStaleCheckoutRun / adoptUnownedCheckoutRun now catch specifically
// this constraint conflict (walking the DrizzleQueryError -> PostgresError
// cause chain, since the top-level error's .code/.constraint are undefined)
// and treat it as "adoption failed" -- the same outcome as any other
// lock-adoption precondition miss. The caller's existing fallback path then
// surfaces a real 409 "Issue run ownership conflict" instead of an uncaught
// 500.
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping DRO-758 regression coverage on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("DRO-758: checkout-owner adoption vs. sibling routine-execution slot", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-dro758-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

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

  async function seedConflictingSiblingIssues() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const routineId = randomUUID();
    const fingerprint = "test-fingerprint";

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    // Sibling run + issue: currently holds the "live execution slot" for this
    // routine+fingerprint (mirrors DRO-788 relative to DRO-745 in the original
    // report).
    const siblingRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: siblingRunId,
      companyId,
      agentId,
      status: "running",
      invocationSource: "automation",
      startedAt: new Date(),
    });
    await db.insert(issues).values({
      id: randomUUID(),
      companyId,
      title: "Sibling supervisor run (live)",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      checkoutRunId: siblingRunId,
      executionRunId: siblingRunId,
      executionLockedAt: new Date(),
      originKind: "routine_execution",
      originId: routineId,
      originRunId: siblingRunId,
      originFingerprint: fingerprint,
    });

    // Target issue: mirrors DRO-745 exactly -- in_progress, assigned, but
    // checkoutRunId/executionRunId both cleared, same routine+fingerprint as
    // the sibling above.
    const targetIssueId = randomUUID();
    await db.insert(issues).values({
      id: targetIssueId,
      companyId,
      title: "M4 goal supervisor (stuck)",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      checkoutRunId: null,
      executionRunId: null,
      originKind: "routine_execution",
      originId: routineId,
      originRunId: siblingRunId,
      originFingerprint: fingerprint,
    });

    // Actor's own live run, used as actorRunId for lock adoption.
    const actorRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: actorRunId,
      companyId,
      agentId,
      status: "running",
      invocationSource: "automation",
      startedAt: new Date(),
    });

    return { companyId, agentId, targetIssueId, actorRunId };
  }

  it("returns 409 (not 500) on PATCH when a sibling issue holds the routine's open-execution slot", async () => {
    const { companyId, agentId, targetIssueId, actorRunId } = await seedConflictingSiblingIssues();

    const res = await request(createApp(agentActor(companyId, agentId, actorRunId)))
      .patch(`/api/issues/${targetIssueId}`)
      .send({});

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error).toBe("Issue run ownership conflict");

    // The target issue's lock columns must remain untouched -- the conflicting
    // write must have rolled back cleanly, not partially applied.
    const row = await db
      .select({ checkoutRunId: issues.checkoutRunId, executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, targetIssueId))
      .then((rows) => rows[0]);
    expect(row?.checkoutRunId).toBeNull();
    expect(row?.executionRunId).toBeNull();
  });

  it("returns 409 (not 500) on DELETE /comments/:id when a sibling issue holds the routine's open-execution slot", async () => {
    const { companyId, agentId, targetIssueId, actorRunId } = await seedConflictingSiblingIssues();

    // Posting a comment does NOT go through assertCheckoutOwner (it uses
    // assertAgentIssueCommentAllowed instead), so this must still succeed even
    // while the issue is in the conflicting state -- matching the original
    // report's observation that POST /comments worked fine.
    const postRes = await request(createApp(agentActor(companyId, agentId, actorRunId)))
      .post(`/api/issues/${targetIssueId}/comments`)
      .send({ body: "probe comment" });
    expect(postRes.status, JSON.stringify(postRes.body)).toBe(201);
    const commentId = postRes.body.id as string;

    const deleteRes = await request(createApp(agentActor(companyId, agentId, actorRunId)))
      .delete(`/api/issues/${targetIssueId}/comments/${commentId}`)
      .send();

    expect(deleteRes.status, JSON.stringify(deleteRes.body)).toBe(409);
    expect(deleteRes.body.error).toBe("Issue run ownership conflict");
  });

  it("still allows a board (human) actor to PATCH the same issue, since assertAgentIssueMutationAllowed short-circuits for non-agent actors", async () => {
    const { companyId, targetIssueId } = await seedConflictingSiblingIssues();

    const res = await request(
      createApp({
        type: "board",
        userId: "board-user",
        companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "admin", status: "active" }],
        isInstanceAdmin: false,
        source: "session",
      }),
    )
      .patch(`/api/issues/${targetIssueId}`)
      .send({ title: "Manually retitled by a human" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.title).toBe("Manually retitled by a human");
  });
});
