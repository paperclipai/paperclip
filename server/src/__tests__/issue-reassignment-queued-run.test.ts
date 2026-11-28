import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests,
  agents,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { issueService } from "../services/issues.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping reassignment queued-run tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("reassigning a task away from the previous assignee's run", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companySequence = 0;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-reassign-queued-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => {
    await db?.$client.end();
    await tempDb?.cleanup();
  });

  function app(companyId: string, actor?: Record<string, unknown>) {
    const testApp = express();
    testApp.use(express.json());
    testApp.use((req, _res, next) => {
      (req as any).actor = actor ?? {
        type: "board",
        source: "session",
        userId: "board-owner",
        companyIds: [companyId],
        memberships: [{ companyId, status: "active", membershipRole: "owner" }],
        isInstanceAdmin: false,
      };
      next();
    });
    testApp.use("/api", issueRoutes(db, {} as any, {}));
    testApp.use(errorHandler);
    return testApp;
  }

  async function seed(options: { queuedRunHoldsLock?: boolean } = {}) {
    const companyId = randomUUID();
    const ceoId = randomUUID();
    const morganId = randomUUID();
    const issueId = randomUUID();
    const queuedRunId = randomUUID();
    const issuePrefix = `REA${++companySequence}`;
    await db.insert(companies).values({
      id: companyId, name: "Reassign Co", issuePrefix, requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([ceoId, morganId].map((id, index) => ({
      id, companyId, name: index === 0 ? "CEO" : "Morgan", role: index === 0 ? "ceo" : "engineer",
      status: "idle", adapterType: "paperclip_runner", adapterConfig: {},
      runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } }, permissions: {},
    })));
    await db.insert(companyMemberships).values({
      companyId, principalType: "user", principalId: "board-owner", status: "active", membershipRole: "owner",
    });
    await db.insert(heartbeatRuns).values([ceoId, morganId].map(agentId => ({
      companyId, agentId, status: "running", startedAt: new Date(), contextSnapshot: { issueId: randomUUID() },
    })));
    await db.insert(heartbeatRuns).values({
      id: queuedRunId, companyId, agentId: ceoId, invocationSource: "assignment", triggerDetail: "system",
      status: "queued", contextSnapshot: { issueId, wakeReason: "issue_assigned" },
    });
    await db.insert(issues).values({
      id: issueId, companyId, identifier: `${issuePrefix}-1`, title: "Write the announcement", status: "todo",
      priority: "medium", assigneeAgentId: ceoId, executionRunId: options.queuedRunHoldsLock === false ? null : queuedRunId,
    });
    return { companyId, ceoId, morganId, issueId, queuedRunId };
  }

  it.each([true, false])("cancels the old assignee's never-started run and wakes the new assignee at once (run holds the lock: %s)", async queuedRunHoldsLock => {
    const f = await seed({ queuedRunHoldsLock });
    await request(app(f.companyId)).patch(`/api/issues/${f.issueId}`)
      .send({ assigneeAgentId: f.morganId }).expect(200);

    const [stale] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.queuedRunId));
    expect(stale).toMatchObject({ status: "cancelled", errorCode: "issue_reassigned" });

    await vi.waitFor(async () => {
      const [issue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
      expect(issue.assigneeAgentId).toBe(f.morganId);
      expect(issue.executionRunId).not.toBe(f.queuedRunId);
      const newOwnerRuns = await db.select().from(heartbeatRuns).where(and(
        eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.agentId, f.morganId),
        sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${f.issueId}`));
      expect(newOwnerRuns).toHaveLength(1);
      const morganWakes = await db.select().from(agentWakeupRequests).where(and(
        eq(agentWakeupRequests.companyId, f.companyId), eq(agentWakeupRequests.agentId, f.morganId)));
      expect(morganWakes).toHaveLength(1);
      expect(morganWakes[0]!.status).not.toBe("deferred_issue_execution");
      expect(morganWakes[0]!.runId).toBeTruthy();
      const [morganRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, morganWakes[0]!.runId!));
      expect(morganRun).toMatchObject({ agentId: f.morganId });
      expect(morganRun!.status).not.toBe("cancelled");
      expect(morganRun!.contextSnapshot).toMatchObject({ issueId: f.issueId });
    });
  });

  it("leaves a queued lock holder that is not the outgoing assignee's run alone", async () => {
    const f = await seed();
    const otherRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: otherRunId, companyId: f.companyId, agentId: f.morganId, status: "queued",
      contextSnapshot: { issueId: f.issueId },
    });
    await db.update(issues).set({ executionRunId: otherRunId }).where(eq(issues.id, f.issueId));
    await request(app(f.companyId)).patch(`/api/issues/${f.issueId}`)
      .send({ assigneeAgentId: f.morganId }).expect(200);
    const [other] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, otherRunId));
    expect(other.status).toBe("queued");
  });

  it("keeps an agent's own run when it hands its task to another agent, then fences that run's task changes", async () => {
    const companyId = randomUUID();
    const issuePrefix = `REA${++companySequence}`;
    await db.insert(companies).values({ id: companyId, name: "Hand-off Co", issuePrefix });
    const [owner, peer] = await db.insert(agents).values(["Owner", "Peer"].map(name => ({
      companyId, name, role: "engineer", adapterType: "process", status: "active",
    }))).returning();
    const issueId = randomUUID();
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId, companyId, agentId: owner!.id, status: "running", invocationSource: "assignment",
      startedAt: new Date(), contextSnapshot: { issueId },
    });
    await db.insert(issues).values({
      id: issueId, companyId, identifier: `${issuePrefix}-1`, title: "Hand me off", status: "in_progress",
      assigneeAgentId: owner!.id, checkoutRunId: runId, executionRunId: runId, executionLockedAt: new Date(),
    });
    const ownerApp = app(companyId, { type: "agent", agentId: owner!.id, companyId, runId, source: "agent_jwt" });

    const handoff = await request(ownerApp).patch(`/api/issues/${issueId}`).send({ assigneeAgentId: peer!.id, status: "todo" });
    expect(handoff.status, JSON.stringify(handoff.body)).toBe(200);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(run).toMatchObject({ status: "running" });
    expect(run!.contextSnapshot).toMatchObject({ agentSelfHandoff: { issueId, toAgentId: peer!.id } });

    const comment = await request(ownerApp).patch(`/api/issues/${issueId}`).send({ comment: "Handed to the peer agent." });
    expect(comment.status, JSON.stringify(comment.body)).toBe(200);
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, issueId))).toEqual(
      expect.arrayContaining([expect.objectContaining({ body: "Handed to the peer agent." })]),
    );

    for (const late of [{ title: "Late outgoing edit" }, { status: "done" }, { assigneeAgentId: owner!.id }]) {
      const res = await request(ownerApp).patch(`/api/issues/${issueId}`).send(late);
      expect(res.status, JSON.stringify(res.body)).toBe(403);
      expect(res.body.details).toMatchObject({ code: "issue_handed_off" });
    }
    expect(await issueService(db).getById(issueId)).toMatchObject({
      title: "Hand me off", status: "todo", assigneeAgentId: peer!.id,
    });
  });
});
