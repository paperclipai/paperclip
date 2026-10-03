import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog, agents, companies, createDb, heartbeatRuns, issueComments,
  issues, issueWatchdogs,
} from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { issueRoutes } from "../routes/issues.js";
import { recoveryService } from "../services/recovery/service.js";
import { taskWatchdogService } from "../services/task-watchdogs.js";

vi.mock("../services/issue-assignment-wakeup.js", () => ({
  queueIssueAssignmentWakeup: vi.fn(),
}));
vi.mock("../telemetry.js", () => ({ getTelemetryClient: () => ({ track: vi.fn(), hashPrivateRef: vi.fn(() => "test-private-ref") }) }));

describe("authenticated timer checkout liveness", () => {
  let db: ReturnType<typeof createDb>;
  let testDatabase: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;

  beforeEach(async () => {
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", randomUUID());
    testDatabase = await startEmbeddedPostgresTestDatabase("paperclip-timer-watchdog-");
    db = createDb(testDatabase.connectionString);
  }, 30_000);

  afterEach(async () => {
    await testDatabase?.cleanup();
    vi.unstubAllEnvs();
  });

  it.each(["todo", "done"] as const)("persists %s after a live checkout survives both collectors", async (status) => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const oldRunId = randomUUID();
    const oldDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    await db.insert(companies).values({ id: companyId, name: "Timer fixture", issuePrefix: `T${companyId.slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({ id: agentId, companyId, name: "Owner", role: "engineer", status: "active", adapterType: "process" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Assigned timer work", status: "todo", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values([
      { id: oldRunId, companyId, agentId, status: "succeeded", invocationSource: "assignment", contextSnapshot: { issueId }, createdAt: oldDate, startedAt: oldDate, finishedAt: oldDate },
      { id: runId, companyId, agentId, status: "running", invocationSource: "timer", contextSnapshot: {}, startedAt: new Date() },
    ]);
    const token = createLocalAgentJwt(agentId, companyId, "process", runId);
    expect(token).toBeTruthy();
    const app = express();
    app.use(express.json());
    app.use(actorMiddleware(db, { deploymentMode: "authenticated" }));
    app.use("/api", issueRoutes(db, {} as never));
    app.use(errorHandler);
    const auth = { Authorization: `Bearer ${token}`, "X-Paperclip-Run-Id": runId };
    const selected = await request(app).get(`/api/companies/${companyId}/issues`).query({ assigneeAgentId: agentId, status: "todo" }).set(auth);
    expect(selected.status).toBe(200);
    expect(selected.body).toEqual(expect.arrayContaining([expect.objectContaining({ id: issueId })]));
    const checkout = await request(app).post(`/api/issues/${issueId}/checkout`).set(auth).send({ agentId, expectedStatuses: ["todo"] });
    expect(checkout.status, JSON.stringify(checkout.body)).toBe(200);
    expect(checkout.body).toMatchObject({ checkoutRunId: runId, executionRunId: runId });
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(run.contextSnapshot).toMatchObject({ issueId, taskId: issueId });

    const [watchdog] = await db.insert(issueWatchdogs).values({ companyId, issueId, watchdogAgentId: agentId }).returning();
    const watchdogService = taskWatchdogService(db);
    const classify = () => watchdogService.revalidateMutationScope({ kind: "watchdog", companyId, watchdogId: watchdog.id, watchedIssueId: issueId, stopFingerprint: "previous-stop" });
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });
    for (const executionRunId of [runId, null]) {
      await db.update(issues).set({ executionRunId }).where(eq(issues.id, issueId));
      const classification = await classify();
      expect(classification.classification?.state).toBe("live");
      const recovered = await recovery.reconcileStrandedAssignedIssues();
      expect(recovered).toMatchObject({ issueIds: [], escalated: 0, skipped: 1 });
      expect(enqueueWakeup).not.toHaveBeenCalled();
      const [liveIssue] = await db.select().from(issues).where(eq(issues.id, issueId));
      expect(liveIssue).toMatchObject({ status: "in_progress", assigneeAgentId: agentId, checkoutRunId: runId });
    }
    await db.update(heartbeatRuns).set({ contextSnapshot: {} }).where(eq(heartbeatRuns.id, runId));
    expect((await classify()).classification?.state).toBe("stopped");
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    expect((await classify()).classification?.state).toBe("live");
    await db.update(heartbeatRuns).set({ contextSnapshot: run.contextSnapshot }).where(eq(heartbeatRuns.id, runId));
    const comment = await request(app).post(`/api/issues/${issueId}/comments`).set(auth).send({ body: "Timer verification complete." });
    expect(comment.status, JSON.stringify(comment.body)).toBe(201);
    const [storedComment] = await db.select().from(issueComments).where(eq(issueComments.id, comment.body.id));
    expect(storedComment).toMatchObject({ createdByRunId: runId, authorAgentId: agentId });
    const otherIssueId = randomUUID();
    await db.insert(issues).values({ id: otherIssueId, companyId, title: "Additional assigned work", status: "todo", assigneeAgentId: agentId });
    const otherCheckout = await request(app).post(`/api/issues/${otherIssueId}/checkout`).set(auth).send({ agentId, expectedStatuses: ["todo"] });
    expect(otherCheckout.status, JSON.stringify(otherCheckout.body)).toBe(200);
    const [boundRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(boundRun.contextSnapshot).toEqual(run.contextSnapshot);
    for (let index = 0; index < 20; index += 1) {
      const additionalComment = await request(app).post(`/api/issues/${otherIssueId}/comments`).set(auth).send({ body: `Additional write ${index}` });
      expect(additionalComment.status, JSON.stringify(additionalComment.body)).toBe(201);
    }
    const capped = await request(app).post(`/api/issues/${otherIssueId}/comments`).set(auth).send({ body: "Over the cap" });
    expect(capped.status).toBe(429);
    expect(capped.body.details?.code).toBe("cross_issue_influence_cap_exceeded");
    const additionalComments = await db.select().from(issueComments).where(eq(issueComments.issueId, otherIssueId));
    expect(additionalComments).toHaveLength(20);
    const disposition = await request(app).patch(`/api/issues/${issueId}`).set(auth).send({ status });
    expect(disposition.status, JSON.stringify(disposition.body)).toBe(200);
    const [persisted] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(persisted.status).toBe(status);
    const audit = await db.select().from(activityLog).where(eq(activityLog.entityId, issueId));
    expect(audit).toEqual(expect.arrayContaining([expect.objectContaining({ action: "issue.updated", actorType: "agent", actorId: agentId, runId })]));

    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, runId));
    await db.update(issues).set({ status: "in_progress", checkoutRunId: null, executionRunId: null }).where(eq(issues.id, issueId));
    expect((await classify()).classification?.state).toBe("stopped");

  });
});
