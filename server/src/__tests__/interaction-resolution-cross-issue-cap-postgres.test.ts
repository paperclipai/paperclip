import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issueThreadInteractions,
  issues,
  principalPermissionGrants,
  projects,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import {
  assertCrossIssueWriteFence,
  CROSS_ISSUE_INFLUENCE_LIMIT,
  observeCrossIssueInfluence,
} from "../services/cross-issue-influence-limit.js";
import { CROSS_ISSUE_WRITE_GRANT_ENFORCE_AT_ENV } from "../services/cross-issue-write-basis.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres interaction-resolution cap tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

/**
 * Route-level proof for the per-run cross-issue influence cap on issue-thread
 * interaction resolution, against the real routes, real services, and a real
 * database: the mocked route harness can prove ordering, but only this can prove
 * that a capped run leaves no interaction result, child task, activity receipt,
 * or wake behind, and that concurrent resolutions cannot race past the cap.
 */
describeEmbeddedPostgres("cross-issue interaction resolution cap (routes + postgres)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-interaction-cap-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  // An allowed resolution wakes the assignee, and that wake can land a heartbeat
  // run row just after the response, so teardown is best-effort in foreign-key
  // order. Every assertion below is scoped to its own seeded company instead of
  // relying on an empty database.
  afterEach(async () => {
    const cleanups = [
      () => db.delete(issueThreadInteractions),
      () => db.delete(activityLog),
      () => db.delete(heartbeatRuns),
      () => db.delete(agentWakeupRequests),
      () => db.delete(heartbeatRuns),
      () => db.delete(principalPermissionGrants),
      () => db.delete(issues),
      () => db.delete(projects),
      () => db.delete(companyMemberships),
      () => db.delete(agents),
      () => db.delete(companies),
    ];
    for (const cleanup of cleanups) await cleanup().catch(() => undefined);
  });

  afterAll(async () => {
    // End the postgres.js pool before stopping the embedded server. Stopping
    // the server first tears the TCP connection down under the still-open
    // client, and a batched write the driver scheduled via setImmediate can
    // then fire after the connection dropped its socket — an unhandled
    // `Cannot read properties of null (reading 'write')` that fails the run
    // even though every test passed. `end()` waits for in-flight queries
    // (including a fire-and-forget wake landing just after a response) and
    // closes the sockets from the client side first.
    await db.$client.end();
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

  function boardActor(companyId: string, userId: string) {
    return {
      type: "board",
      source: "session",
      userId,
      companyIds: [companyId],
      memberships: [{ companyId, status: "active", membershipRole: "operator" }],
      isInstanceAdmin: false,
    };
  }

  const INTERACTION_FIXTURES = {
    accept: {
      // A suggested-task card proves the 429 also stops the child-task effect.
      kind: "suggest_tasks",
      payload: {
        version: 1,
        tasks: [{ clientKey: "spawned", title: "Spawned by a capped run" }],
      },
      body: { selectedClientKeys: ["spawned"] },
    },
    reject: {
      kind: "request_confirmation",
      payload: { version: 1, prompt: "Proceed?" },
      body: { reason: "Not now" },
    },
    respond: {
      kind: "ask_user_questions",
      payload: {
        version: 1,
        questions: [{
          id: "scope",
          prompt: "Which scope?",
          selectionMode: "single",
          options: [{ id: "phase-1", label: "Phase 1" }],
        }],
      },
      body: { answers: [{ questionId: "scope", optionIds: ["phase-1"] }] },
    },
    verdicts: {
      kind: "request_item_verdicts",
      payload: {
        version: 1,
        prompt: "Review these",
        items: [{ id: "item-1", label: "Item one" }],
        verdicts: ["approve", "reject"],
      },
      body: { verdicts: [{ id: "item-1", verdict: "approve" }] },
    },
  } as const;

  type ResolutionRoute = keyof typeof INTERACTION_FIXTURES;

  async function seedCompanyAndAgent(prefix: string) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const userId = `${prefix.toLowerCase()}-operator`;
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
      principalId: userId,
      status: "active",
      membershipRole: "operator",
    });
    return { companyId, agentId, userId };
  }

  let issueSequence = 0;

  async function seedIssue(companyId: string, prefix: string, assigneeAgentId: string | null) {
    const issueId = randomUUID();
    issueSequence += 1;
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: `${prefix}-${issueSequence}`,
      title: `${prefix} issue ${issueSequence}`,
      status: "in_progress",
      priority: "medium",
      assigneeAgentId,
    });
    return issueId;
  }

  /** A run whose persisted context names `sourceIssueId`, not the target issue. */
  async function seedRun(companyId: string, agentId: string, sourceIssueId: string) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      contextSnapshot: { issueId: sourceIssueId, wakeReason: "issue_assigned" },
    });
    return runId;
  }

  async function seedInteraction(
    companyId: string,
    issueId: string,
    route: ResolutionRoute,
    createdByAgentId: string | null = null,
  ) {
    const fixture = INTERACTION_FIXTURES[route];
    const [row] = await db.insert(issueThreadInteractions).values({
      companyId,
      issueId,
      kind: fixture.kind,
      status: "pending",
      continuationPolicy: "wake_assignee",
      requestedResolverPolicy: "anyone",
      effectiveResolverPolicy: "anyone",
      payload: fixture.payload as never,
      createdByAgentId,
    }).returning({ id: issueThreadInteractions.id });
    return row.id;
  }

  async function seedAgent(companyId: string, name: string) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name,
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return agentId;
  }

  async function spendBudget(companyId: string, agentId: string, runId: string, attempts: number) {
    if (attempts === 0) return;
    await db.insert(activityLog).values(Array.from({ length: attempts }, () => ({
      companyId,
      actorType: "agent" as const,
      actorId: agentId,
      agentId,
      runId,
      action: "issue.cross_issue_influence_observed",
      entityType: "issue",
      entityId: runId,
    })));
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

  it.each(["accept", "reject", "respond", "verdicts"] as const)(
    "fails a capped run closed on cross-issue %s with no interaction, task, activity, or wake",
    async (route) => {
      const { companyId, agentId } = await seedCompanyAndAgent("CAP");
      const sourceIssueId = await seedIssue(companyId, "CAP", agentId);
      const targetIssueId = await seedIssue(companyId, "CAP", agentId);
      const runId = await seedRun(companyId, agentId, sourceIssueId);
      await spendBudget(companyId, agentId, runId, CROSS_ISSUE_INFLUENCE_LIMIT);
      const interactionId = await seedInteraction(companyId, targetIssueId, route);

      const res = await request(app(agentActor(companyId, agentId, runId)))
        .post(`/api/issues/${targetIssueId}/interactions/${interactionId}/${route}`)
        .send(INTERACTION_FIXTURES[route].body);

      expect(res.status, JSON.stringify(res.body)).toBe(429);
      expect(res.body.details).toMatchObject({
        code: "cross_issue_influence_cap_exceeded",
        cap: CROSS_ISSUE_INFLUENCE_LIMIT,
        count: CROSS_ISSUE_INFLUENCE_LIMIT + 1,
        mode: "enforce",
      });
      // The refusal must not leak the run's own (possibly inaccessible) source
      // issue or the resolver policy it passed.
      expect(JSON.stringify(res.body)).not.toContain(sourceIssueId);
      expect(JSON.stringify(res.body)).not.toContain("anyone");

      const [interaction] = await db
        .select({ status: issueThreadInteractions.status, result: issueThreadInteractions.result })
        .from(issueThreadInteractions)
        .where(eq(issueThreadInteractions.id, interactionId));
      expect(interaction).toMatchObject({ status: "pending", result: null });

      const childIssues = await db
        .select({ id: issues.id })
        .from(issues)
        .where(and(eq(issues.companyId, companyId), eq(issues.parentId, targetIssueId)));
      expect(childIssues).toEqual([]);

      const wakes = await db
        .select({ id: agentWakeupRequests.id })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.companyId, companyId));
      expect(wakes).toEqual([]);

      const resolutionActivity = await db
        .select({ action: activityLog.action })
        .from(activityLog)
        .where(and(eq(activityLog.companyId, companyId), eq(activityLog.entityId, targetIssueId)));
      expect(resolutionActivity.map((row) => row.action)).toEqual([
        "issue.cross_issue_influence_cap_rejected",
      ]);
      expect(await countInfluenceRows(companyId, runId, "issue.cross_issue_influence_observed"))
        .toBe(CROSS_ISSUE_INFLUENCE_LIMIT);
    },
    30_000,
  );

  it("charges one budget slot for an allowed cross-issue resolution", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent("ALW");
    const sourceIssueId = await seedIssue(companyId, "ALW", agentId);
    const targetIssueId = await seedIssue(companyId, "ALW", agentId);
    const runId = await seedRun(companyId, agentId, sourceIssueId);
    const interactionId = await seedInteraction(companyId, targetIssueId, "respond");

    const res = await request(app(agentActor(companyId, agentId, runId)))
      .post(`/api/issues/${targetIssueId}/interactions/${interactionId}/respond`)
      .send(INTERACTION_FIXTURES.respond.body);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ status: "answered" });
    expect(await countInfluenceRows(companyId, runId, "issue.cross_issue_influence_observed")).toBe(1);

    const [observed] = await db
      .select({ details: activityLog.details })
      .from(activityLog)
      .where(and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.action, "issue.cross_issue_influence_observed"),
      ));
    expect(observed.details).toMatchObject({
      kind: "interaction_resolution",
      sourceIssueId,
      targetIssueId,
      count: 1,
    });
  }, 30_000);

  it("leaves same-issue and board resolutions outside the counter", async () => {
    const { companyId, agentId, userId } = await seedCompanyAndAgent("SME");
    const issueId = await seedIssue(companyId, "SME", agentId);
    const boardIssueId = await seedIssue(companyId, "SME", agentId);
    const runId = await seedRun(companyId, agentId, issueId);
    await spendBudget(companyId, agentId, runId, CROSS_ISSUE_INFLUENCE_LIMIT);
    const sameIssueInteractionId = await seedInteraction(companyId, issueId, "respond");
    const boardInteractionId = await seedInteraction(companyId, boardIssueId, "respond");

    const sameIssue = await request(app(agentActor(companyId, agentId, runId)))
      .post(`/api/issues/${issueId}/interactions/${sameIssueInteractionId}/respond`)
      .send(INTERACTION_FIXTURES.respond.body);
    expect(sameIssue.status, JSON.stringify(sameIssue.body)).toBe(200);

    const board = await request(app(boardActor(companyId, userId)))
      .post(`/api/issues/${boardIssueId}/interactions/${boardInteractionId}/respond`)
      .send(INTERACTION_FIXTURES.respond.body);
    expect(board.status, JSON.stringify(board.body)).toBe(200);

    expect(await countInfluenceRows(companyId, runId, "issue.cross_issue_influence_observed"))
      .toBe(CROSS_ISSUE_INFLUENCE_LIMIT);
    expect(await countInfluenceRows(companyId, runId, "issue.cross_issue_influence_cap_rejected")).toBe(0);
  }, 30_000);

  it("cannot let concurrent cross-issue resolutions race past the cap", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent("RCE");
    const sourceIssueId = await seedIssue(companyId, "RCE", agentId);
    const firstTargetId = await seedIssue(companyId, "RCE", agentId);
    const secondTargetId = await seedIssue(companyId, "RCE", agentId);
    const runId = await seedRun(companyId, agentId, sourceIssueId);
    // One slot left in the shared budget for two simultaneous resolutions.
    await spendBudget(companyId, agentId, runId, CROSS_ISSUE_INFLUENCE_LIMIT - 1);
    const firstInteractionId = await seedInteraction(companyId, firstTargetId, "respond");
    const secondInteractionId = await seedInteraction(companyId, secondTargetId, "respond");
    const client = app(agentActor(companyId, agentId, runId));

    const results = await Promise.all([
      request(client)
        .post(`/api/issues/${firstTargetId}/interactions/${firstInteractionId}/respond`)
        .send(INTERACTION_FIXTURES.respond.body),
      request(client)
        .post(`/api/issues/${secondTargetId}/interactions/${secondInteractionId}/respond`)
        .send(INTERACTION_FIXTURES.respond.body),
    ]);

    expect(results.map((res) => res.status).sort()).toEqual([200, 429]);
    expect(await countInfluenceRows(companyId, runId, "issue.cross_issue_influence_observed"))
      .toBe(CROSS_ISSUE_INFLUENCE_LIMIT);
    expect(await countInfluenceRows(companyId, runId, "issue.cross_issue_influence_cap_rejected")).toBe(1);

    const answered = await db
      .select({ status: issueThreadInteractions.status })
      .from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.companyId, companyId));
    expect(answered.map((row) => row.status).sort()).toEqual(["answered", "pending"]);
  }, 30_000);

  /**
   * Withdrawal is a resolution in everything but name: it cancels the target's
   * pending decision, revokes the tool-action requests linked to it and wakes the
   * peer issue's assignee. It used to be the one interaction route a live run
   * could reach on an unrelated visible issue without a named basis or a budget
   * slot — `assertIssueThreadInteractionWithdrawalAllowed` returned allowed for a
   * non-assignee *creator* before the gate, and the route built an unguarded
   * service so nothing re-checked authority at write time (FAI-10134 finding 3).
   */
  describe("cross-issue interaction withdrawal (FAI-10134 finding 3)", () => {
    it("counts a creator's cross-issue withdrawal against the run cap and refuses it with zero effects", async () => {
      const { companyId, agentId } = await seedCompanyAndAgent("WDC");
      const sourceIssueId = await seedIssue(companyId, "WDC", agentId);
      // Board-held: the actor is emphatically not the assignee, so only the
      // creator branch can carry this withdrawal.
      const targetIssueId = await seedIssue(companyId, "WDC", null);
      const runId = await seedRun(companyId, agentId, sourceIssueId);
      await spendBudget(companyId, agentId, runId, CROSS_ISSUE_INFLUENCE_LIMIT);
      const interactionId = await seedInteraction(companyId, targetIssueId, "reject", agentId);

      const res = await request(app(agentActor(companyId, agentId, runId)))
        .post(`/api/issues/${targetIssueId}/interactions/${interactionId}/withdraw`)
        .send({ reason: "Superseded by a newer card" });

      // Before the fix this was a 200: the creator branch returned allowed
      // without ever reaching the counter.
      expect(res.status, JSON.stringify(res.body)).toBe(429);
      expect(res.body.details).toMatchObject({
        code: "cross_issue_influence_cap_exceeded",
        cap: CROSS_ISSUE_INFLUENCE_LIMIT,
        mode: "enforce",
      });

      const [interaction] = await db
        .select({ status: issueThreadInteractions.status, result: issueThreadInteractions.result })
        .from(issueThreadInteractions)
        .where(eq(issueThreadInteractions.id, interactionId));
      expect(interaction).toMatchObject({ status: "pending", result: null });

      const wakes = await db
        .select({ id: agentWakeupRequests.id })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.companyId, companyId));
      expect(wakes).toEqual([]);

      const targetActivity = await db
        .select({ action: activityLog.action })
        .from(activityLog)
        .where(and(eq(activityLog.companyId, companyId), eq(activityLog.entityId, targetIssueId)));
      // The shadow grade rides along: the grant check runs before the counter,
      // so an attempt the cap refuses is still recorded as one enforcement
      // would have denied. Both rows land in one transaction with no ordering
      // guarantee between them, so compare them as a set.
      expect(targetActivity.map((row) => row.action).sort()).toEqual([
        "issue.cross_issue_influence_cap_rejected",
        "issue.cross_issue_write_grant_would_deny",
      ]);
    }, 30_000);

    it("refuses a creator's withdrawal on an unrelated peer issue under enforcement, with an audited basis", async () => {
      const previous = process.env[CROSS_ISSUE_WRITE_GRANT_ENFORCE_AT_ENV];
      process.env[CROSS_ISSUE_WRITE_GRANT_ENFORCE_AT_ENV] = "2026-01-01T00:00:00.000Z";
      try {
        const { companyId, agentId } = await seedCompanyAndAgent("WDE");
        const peerAgentId = await seedAgent(companyId, "Peer Owner");
        const sourceIssueId = await seedIssue(companyId, "WDE", agentId);
        // Held by another agent, unrelated by tree or routine origin: nothing
        // names authority over it, so creating the card earlier is the only
        // thing the actor could point at — and that is not a basis.
        const targetIssueId = await seedIssue(companyId, "WDE", peerAgentId);
        const runId = await seedRun(companyId, agentId, sourceIssueId);
        const interactionId = await seedInteraction(companyId, targetIssueId, "reject", agentId);

        const res = await request(app(agentActor(companyId, agentId, runId)))
          .post(`/api/issues/${targetIssueId}/interactions/${interactionId}/withdraw`)
          .send({ reason: "Superseded by a newer card" });

        expect(res.status, JSON.stringify(res.body)).toBe(403);
        expect(res.body.details).toMatchObject({ code: "cross_issue_write_grant_required" });

        const [interaction] = await db
          .select({ status: issueThreadInteractions.status, result: issueThreadInteractions.result })
          .from(issueThreadInteractions)
          .where(eq(issueThreadInteractions.id, interactionId));
        expect(interaction).toMatchObject({ status: "pending", result: null });

        const wakes = await db
          .select({ id: agentWakeupRequests.id })
          .from(agentWakeupRequests)
          .where(eq(agentWakeupRequests.companyId, companyId));
        expect(wakes).toEqual([]);

        // The refusal is evidence, so it survives outside the gate's rolled-back
        // transaction and names what was actually attempted.
        const denials = await db
          .select({ details: activityLog.details })
          .from(activityLog)
          .where(and(
            eq(activityLog.companyId, companyId),
            eq(activityLog.action, "issue.cross_issue_write_grant_denied"),
          ));
        expect(denials).toHaveLength(1);
        expect(denials[0]?.details).toMatchObject({
          kind: "interaction_resolution",
          operation: "mutation",
          sourceIssueId,
          targetIssueId,
          basis: null,
        });
        // Refused before the counter, so the run's budget is untouched.
        expect(await countInfluenceRows(companyId, runId, "issue.cross_issue_influence_observed")).toBe(0);
      } finally {
        if (previous === undefined) delete process.env[CROSS_ISSUE_WRITE_GRANT_ENFORCE_AT_ENV];
        else process.env[CROSS_ISSUE_WRITE_GRANT_ENFORCE_AT_ENV] = previous;
      }
    }, 30_000);

    /**
     * The gate's answer is time-of-check. `withdrawInteraction` opens its own
     * transaction — one that cancels the linked tool-action requests before it
     * resolves the card — so the route now builds the service with the same
     * `preCommitAuthorityGuard` the resolution paths use. Revoke the grant after
     * the gate said yes and the whole withdrawal has to roll back, not just the
     * card update.
     */
    it("rolls a withdrawal back whole when the grant is revoked between the gate and the write", async () => {
      const { companyId, agentId } = await seedCompanyAndAgent("WDR");
      const peerAgentId = await seedAgent(companyId, "Peer Owner");
      const projectId = randomUUID();
      await db.insert(projects).values({ id: projectId, companyId, name: "Sweeps" });
      const sourceIssueId = await seedIssue(companyId, "WDR", agentId);
      const targetIssueId = await seedIssue(companyId, "WDR", peerAgentId);
      await db.update(issues).set({ projectId }).where(eq(issues.id, targetIssueId));
      const runId = await seedRun(companyId, agentId, sourceIssueId);
      const interactionId = await seedInteraction(companyId, targetIssueId, "reject", agentId);
      // The grant only confers while the agent is an active member, the same
      // rule `decidePrincipalGrant` applies to every other permission key
      // (FAI-10144 round 3). Without this row the grant names no authority.
      await db.insert(companyMemberships).values({
        companyId,
        principalType: "agent",
        principalId: agentId,
        status: "active",
        membershipRole: "member",
      });
      await db.insert(principalPermissionGrants).values({
        companyId,
        principalType: "agent",
        principalId: agentId,
        permissionKey: "issues:cross-write",
        scope: { projectId },
      });

      const decision = await observeCrossIssueInfluence(db, {
        companyId,
        runId,
        agentId,
        targetIssueId,
        targetIssueIdentifier: null,
        kind: "interaction_resolution",
        enforceGrantAt: new Date("2026-01-01T00:00:00.000Z"),
      });
      expect(decision?.fence).toMatchObject({ basisAtCheck: "explicit_permission_grant" });

      // The grant goes away after the gate allowed the write.
      await db.delete(principalPermissionGrants).where(eq(principalPermissionGrants.companyId, companyId));

      const guarded = issueThreadInteractionService(db, {
        preCommitAuthorityGuard: (tx) => assertCrossIssueWriteFence(db, tx, decision?.fence),
      });
      await expect(guarded.withdrawInteraction(
        { id: targetIssueId, companyId, status: "in_progress" },
        interactionId,
        { reason: "Superseded" },
        { agentId, runId, userId: null },
      )).rejects.toMatchObject({
        status: 403,
        details: { code: "cross_issue_write_grant_required" },
      });

      const [interaction] = await db
        .select({ status: issueThreadInteractions.status, result: issueThreadInteractions.result })
        .from(issueThreadInteractions)
        .where(eq(issueThreadInteractions.id, interactionId));
      expect(interaction).toMatchObject({ status: "pending", result: null });
    }, 30_000);
  });
});
