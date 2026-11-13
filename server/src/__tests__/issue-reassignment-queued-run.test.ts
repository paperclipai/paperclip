import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests,
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
    `Skipping reassignment queued-run tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("reassigning a task whose previous assignee's run has not started", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-reassign-queued-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.execute(sql`TRUNCATE TABLE companies CASCADE`);
  });

  afterAll(async () => {
    await db?.$client.end();
    await tempDb?.cleanup();
  });

  function app(companyId: string) {
    const testApp = express();
    testApp.use(express.json());
    testApp.use((req, _res, next) => {
      (req as any).actor = {
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
    await db.insert(companies).values({
      id: companyId, name: "Reassign Co", issuePrefix: "REA", requireBoardApprovalForNewAgents: false,
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
      id: issueId, companyId, identifier: "REA-1", title: "Write the announcement", status: "todo",
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
});
