import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issueComments,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { mergeRunRuntimeServicesIntoSnapshot } from "../services/run-context-snapshot.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres taskless-checkout bind tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

/**
 * Route-level proof for the taskless checkout bind: a timer-woken heartbeat run
 * with no task context (no `issueId`/`taskId` in its persisted `contextSnapshot`) is read-only
 * for every issue write until it checks out an issue. `POST /api/issues/:id/checkout`
 * must anchor the run to the claimed issue, after which same-issue comments and
 * status updates pass the cross-issue influence gate. This ties the real routes,
 * the real checkout bind, the real gate, and a real database together end to end —
 * the piecewise unit tests prove each half, this proves the whole path a taskless
 * run actually takes (checkout → write disposition).
 */
describeEmbeddedPostgres(
  "taskless checkout binds run context so same-issue writes pass the gate (routes + postgres)",
  () => {
    let db!: ReturnType<typeof createDb>;
    let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

    beforeAll(async () => {
      tempDb = await startEmbeddedPostgresTestDatabase("paperclip-taskless-checkout-bind-");
      db = createDb(tempDb.connectionString);
    }, 30_000);

    // A successful checkout/comment can enqueue wakes that land rows just after
    // the response, so teardown is best-effort in foreign-key order. Every
    // assertion is scoped to its own seeded company rather than an empty DB.
    afterEach(async () => {
      const cleanups = [
        () => db.delete(issueThreadInteractions),
        () => db.delete(issueComments),
        () => db.delete(activityLog),
        () => db.delete(heartbeatRuns),
        () => db.delete(agentWakeupRequests),
        () => db.delete(issues),
        () => db.delete(companyMemberships),
        () => db.delete(agents),
        () => db.delete(companies),
      ];
      for (const cleanup of cleanups) await cleanup().catch(() => undefined);
    });

    afterAll(async () => {
      // End the postgres.js pool before stopping the embedded server so a
      // fire-and-forget wake cannot write after the socket is torn down.
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

    let issueSequence = 0;

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
        name: `${prefix} Agent`,
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
      return { companyId, agentId };
    }

    async function seedIssue(companyId: string, prefix: string, assigneeAgentId: string) {
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

    /** A taskless timer run: persisted context has neither issueId nor taskId. */
    async function seedTasklessRun(companyId: string, agentId: string) {
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        invocationSource: "scheduler",
        triggerDetail: "system",
        status: "running",
        contextSnapshot: { source: "timer", wakeReason: "heartbeat_timer" },
      });
      return runId;
    }

    it("lets a taskless run comment on and re-disposition the issue it checked out", async () => {
      const { companyId, agentId } = await seedCompanyAndAgent("TLB");
      const issueId = await seedIssue(companyId, "TLB", agentId);
      const blockerId = await seedIssue(companyId, "TLB", agentId);
      const runId = await seedTasklessRun(companyId, agentId);
      const client = app(agentActor(companyId, agentId, runId));

      // Before checkout there is no source issue/task on the run: even a write to
      // the issue the run is assigned fails closed with the run-context denial.
      const before = await request(client)
        .post(`/api/issues/${issueId}/comments`)
        .send({ body: "before checkout" });
      expect(before.status, JSON.stringify(before.body)).toBe(403);
      expect(before.body.details?.code).toBe("cross_issue_influence_run_context_required");

      // Checkout anchors the run to the claimed issue.
      const checkout = await request(client)
        .post(`/api/issues/${issueId}/checkout`)
        .send({ agentId, expectedStatuses: ["in_progress"] });
      expect(checkout.status, JSON.stringify(checkout.body)).toBe(200);

      const [run] = await db
        .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId));
      expect(run.contextSnapshot).toMatchObject({ issueId, source: "timer" });

      // Same-issue comment now passes without a gate throw.
      const comment = await request(client)
        .post(`/api/issues/${issueId}/comments`)
        .send({ body: "disposition: taskless run can write to its issue" });
      expect(comment.status, JSON.stringify(comment.body)).toBe(201);

      // Same-issue status change (a real disposition) now passes too. A correct
      // disposition on the recovered issue is exactly what breaks the
      // successful_run_missing_state loop.
      const update = await request(client)
        .patch(`/api/issues/${issueId}`)
        .send({ status: "blocked", blockedByIssueIds: [blockerId] });
      expect(update.status, JSON.stringify(update.body)).toBe(200);
      expect(update.body.status).toBe("blocked");
    }, 30_000);

    it("binds once: a task-context run keeps its own source when it checks out another issue", async () => {
      const { companyId, agentId } = await seedCompanyAndAgent("BON");
      const issueId = await seedIssue(companyId, "BON", agentId);
      const sourceIssueId = randomUUID();
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
      const client = app(agentActor(companyId, agentId, runId));

      const checkout = await request(client)
        .post(`/api/issues/${issueId}/checkout`)
        .send({ agentId, expectedStatuses: ["in_progress"] });
      expect(checkout.status, JSON.stringify(checkout.body)).toBe(200);

      // The task-context source wins; the run must not reset its cross-issue
      // source by re-checking out.
      const [run] = await db
        .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId));
      expect(run.contextSnapshot).toMatchObject({ issueId: sourceIssueId });
    }, 30_000);

    it("keeps the checkout anchor when adapter completion persists runtime services", async () => {
      const { companyId, agentId } = await seedCompanyAndAgent("RTB");
      const issueId = await seedIssue(companyId, "RTB", agentId);
      const runId = await seedTasklessRun(companyId, agentId);
      const client = app(agentActor(companyId, agentId, runId));

      const checkout = await request(client)
        .post(`/api/issues/${issueId}/checkout`)
        .send({ agentId, expectedStatuses: ["in_progress"] });
      expect(checkout.status, JSON.stringify(checkout.body)).toBe(200);

      // The adapter returns runtime services at completion. That writer owns
      // only `paperclipRuntimeServices` / `paperclipRuntimePrimaryUrl`; every
      // other field, including the checkout anchor, must survive its write.
      // A wholesale write of the pre-dispatch in-memory context would drop the
      // anchor, re-open the taskless-write wall, and allow a later checkout to
      // rebind the run to a different source.
      await mergeRunRuntimeServicesIntoSnapshot(db, {
        runId,
        runtimeServices: [
          { name: "web", url: "http://runtime.example.test:4310", status: "running" },
        ],
        primaryUrl: "http://runtime.example.test:4310",
      });

      const [run] = await db
        .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId));
      expect(run.contextSnapshot).toMatchObject({
        issueId,
        source: "timer",
        paperclipRuntimeServices: [
          { name: "web", url: "http://runtime.example.test:4310", status: "running" },
        ],
        paperclipRuntimePrimaryUrl: "http://runtime.example.test:4310",
      });

      // The gate consequence: the same-issue write the run needs to record its
      // disposition still passes after adapter completion.
      const comment = await request(client)
        .post(`/api/issues/${issueId}/comments`)
        .send({ body: "disposition recorded after adapter completion" });
      expect(comment.status, JSON.stringify(comment.body)).toBe(201);
    }, 30_000);
  },
);
