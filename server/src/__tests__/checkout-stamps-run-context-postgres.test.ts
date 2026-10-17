/**
 * Verifies that checking out an issue via POST /issues/:id/checkout stamps the
 * heartbeat run's contextSnapshot with the issueId.  This is the fix for the
 * heartbeat_timer run write-operation blockage: timer-triggered runs start with
 * no issueId in their contextSnapshot, so the cross-issue-influence check
 * rejects any write attempt with cross_issue_influence_run_context_required.
 * Stamping the issueId at checkout time lets the check recognise that the run
 * is working on its checked-out issue and allows writes to it.
 */
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issues,
  issueComments,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping checkout-stamps-run-context tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres(
  "checkout stamps heartbeat run contextSnapshot with issueId (routes + postgres)",
  () => {
    let db!: ReturnType<typeof createDb>;
    let tempDb: Awaited<
      ReturnType<typeof startEmbeddedPostgresTestDatabase>
    > | null = null;

    beforeAll(async () => {
      tempDb = await startEmbeddedPostgresTestDatabase(
        "paperclip-checkout-stamp-",
      );
      db = createDb(tempDb.connectionString);
    }, 30_000);

    afterEach(async () => {
      const cleanups = [
        () => db.delete(issueComments),
        () => db.delete(agentWakeupRequests),
        () => db.delete(heartbeatRuns),
        () => db.delete(issues),
        () => db.delete(companyMemberships),
        () => db.delete(agents),
        () => db.delete(companies),
      ];
      for (const cleanup of cleanups) await cleanup().catch(() => undefined);
    });

    afterAll(async () => {
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

    function agentActor(
      companyId: string,
      agentId: string,
      runId: string,
    ) {
      return {
        type: "agent",
        source: "agent_key",
        companyId,
        agentId,
        runId,
      };
    }

    async function seedCompanyAndAgent() {
      const companyId = randomUUID();
      const agentId = randomUUID();
      const prefix = `CS${companyId.replace(/-/g, "").slice(0, 4).toUpperCase()}`;
      await db.insert(companies).values({
        id: companyId,
        name: "Stamp Test Company",
        issuePrefix: prefix,
        requireBoardApprovalForNewAgents: false,
        defaultResponsibleUserId: "board-user",
      });
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "Stamp Test Agent",
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
        principalId: "board-user",
        status: "active",
        membershipRole: "operator",
      });
      return { companyId, agentId, prefix };
    }

    let issueSeq = 0;

    async function seedIssue(
      companyId: string,
      prefix: string,
      assigneeAgentId: string,
    ) {
      issueSeq += 1;
      const issueId = randomUUID();
      await db.insert(issues).values({
        id: issueId,
        companyId,
        identifier: `${prefix}-${issueSeq}`,
        title: `Stamp test issue ${issueSeq}`,
        status: "todo",
        priority: "medium",
        assigneeAgentId,
      });
      return issueId;
    }

    async function seedTimerRun(companyId: string, agentId: string) {
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        invocationSource: "timer",
        triggerDetail: "system",
        status: "running",
        // Timer-triggered contextSnapshot — deliberately omits issueId / taskId,
        // which is the root cause of the heartbeat write-operation blockage.
        contextSnapshot: {
          source: "scheduler",
          reason: "interval_elapsed",
          now: new Date().toISOString(),
          timerClaimWasFirstHeartbeat: false,
        },
      });
      return runId;
    }

    async function getRunContextSnapshot(runId: string) {
      const row = await db
        .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      return row?.contextSnapshot ?? null;
    }

    it("stamps issueId into a timer run contextSnapshot on checkout", async () => {
      const { companyId, agentId, prefix } = await seedCompanyAndAgent();
      const issueId = await seedIssue(companyId, prefix, agentId);
      const runId = await seedTimerRun(companyId, agentId);

      // Confirm the timer run has no issueId before checkout.
      const before = await getRunContextSnapshot(runId);
      expect(before).not.toHaveProperty("issueId");

      const res = await request(app(agentActor(companyId, agentId, runId)))
        .post(`/api/issues/${issueId}/checkout`)
        .send({ agentId, expectedStatuses: ["todo"] });

      expect(res.status).toBe(200);

      // After checkout the run contextSnapshot must contain the checked-out issueId.
      const after = await getRunContextSnapshot(runId);
      expect(after).toMatchObject({ issueId });
    });

    it("does not overwrite an existing issueId in contextSnapshot on checkout", async () => {
      const { companyId, agentId, prefix } = await seedCompanyAndAgent();
      const issueId = await seedIssue(companyId, prefix, agentId);

      // A run already scoped to a different source issue (assignment-based wake).
      const existingSourceIssueId = randomUUID();
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "running",
        contextSnapshot: {
          issueId: existingSourceIssueId,
          wakeReason: "issue_assigned",
        },
      });

      const res = await request(app(agentActor(companyId, agentId, runId)))
        .post(`/api/issues/${issueId}/checkout`)
        .send({ agentId, expectedStatuses: ["todo"] });

      expect(res.status).toBe(200);

      // Pre-existing issueId must be preserved.
      const after = await getRunContextSnapshot(runId);
      expect(after).toMatchObject({ issueId: existingSourceIssueId });
    });

    it("stamps issueId into a run with null contextSnapshot on checkout", async () => {
      const { companyId, agentId, prefix } = await seedCompanyAndAgent();
      const issueId = await seedIssue(companyId, prefix, agentId);
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        invocationSource: "timer",
        triggerDetail: "system",
        status: "running",
        contextSnapshot: null,
      });

      const res = await request(app(agentActor(companyId, agentId, runId)))
        .post(`/api/issues/${issueId}/checkout`)
        .send({ agentId, expectedStatuses: ["todo"] });

      expect(res.status).toBe(200);

      const after = await getRunContextSnapshot(runId);
      expect(after).toMatchObject({ issueId });
    });

    it("allows a write to the checked-out issue after contextSnapshot is stamped", async () => {
      const { companyId, agentId, prefix } = await seedCompanyAndAgent();
      const issueId = await seedIssue(companyId, prefix, agentId);
      const runId = await seedTimerRun(companyId, agentId);

      // Checkout stamps the run.
      await request(app(agentActor(companyId, agentId, runId)))
        .post(`/api/issues/${issueId}/checkout`)
        .send({ agentId, expectedStatuses: ["todo"] })
        .expect(200);

      // Writing a comment to the checked-out issue must succeed (not 403).
      const commentRes = await request(
        app(agentActor(companyId, agentId, runId)),
      )
        .post(`/api/issues/${issueId}/comments`)
        .send({ body: "Heartbeat write test comment" });

      expect(commentRes.status).toBe(201);
    });
  },
);
