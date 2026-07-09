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
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueRelations,
  issueWatchdogs,
  issues,
  principalPermissionGrants,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { ensureHumanRoleDefaultGrants } from "../services/principal-access-compatibility.js";
import { taskWatchdogService } from "../services/task-watchdogs.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue watchdog route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue watchdog routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-watchdogs-routes-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueComments);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issueRelations);
    await db.delete(issueWatchdogs);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(companyId: string, actor?: Record<string, unknown>) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = actor ?? {
        type: "board",
        userId: "cloud-user-1",
        companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "owner", status: "active" }],
        source: "cloud_tenant",
        isInstanceAdmin: false,
      };
      next();
    });
    app.use("/api", issueRoutes(db, {} as any, { taskWatchdogEnqueueWakeup: null }));
    app.use(errorHandler);
    return app;
  }

  function uniqueIssuePrefix() {
    return `W${randomUUID().replace(/-/g, "").slice(0, 5).toUpperCase()}`;
  }

  async function seedCloudTenantMember(companyId: string) {
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: "cloud-user-1",
      status: "active",
      membershipRole: "owner",
      updatedAt: new Date(),
    });
    await ensureHumanRoleDefaultGrants(db, {
      companyId,
      principalId: "cloud-user-1",
      membershipRole: "owner",
      grantedByUserId: null,
    });
  }

  async function seedCompany(name = "Paperclip") {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name,
      issuePrefix: uniqueIssuePrefix(),
      requireBoardApprovalForNewAgents: false,
    });
    await seedCloudTenantMember(companyId);
    return companyId;
  }

  async function seedAgent(companyId: string, overrides: Partial<typeof agents.$inferInsert> = {}) {
    const id = overrides.id ?? randomUUID();
    await db.insert(agents).values({
      id,
      companyId,
      name: overrides.name ?? "Watchdog Agent",
      role: overrides.role ?? "engineer",
      status: overrides.status ?? "active",
      adapterType: overrides.adapterType ?? "codex_local",
      adapterConfig: overrides.adapterConfig ?? {},
      runtimeConfig: overrides.runtimeConfig ?? {},
      permissions: overrides.permissions ?? {},
      reportsTo: overrides.reportsTo,
    });
    return id;
  }

  async function seedIssue(companyId: string, overrides: Partial<typeof issues.$inferInsert> = {}) {
    const id = overrides.id ?? randomUUID();
    await db.insert(issues).values({
      id,
      companyId,
      title: overrides.title ?? "Watched task",
      status: overrides.status ?? "todo",
      priority: overrides.priority ?? "medium",
      identifier: overrides.identifier,
      issueNumber: overrides.issueNumber,
      assigneeAgentId: overrides.assigneeAgentId,
      parentId: overrides.parentId,
      projectId: overrides.projectId,
      goalId: overrides.goalId,
      originKind: overrides.originKind,
      originId: overrides.originId,
      // Default to an "established" issue (created before the first-run grace
      // window) so attaching a watchdog evaluates immediately instead of being
      // deferred by the pending-first-run guard.
      createdAt: overrides.createdAt ?? new Date(Date.now() - 60 * 60 * 1000),
    });
    return id;
  }

  async function seedWatchdogRun(input: {
    companyId: string;
    watchdogAgentId: string;
    watchedIssueId: string;
    watchdogIssueId: string;
  }) {
    await db.insert(issueWatchdogs).values({
      companyId: input.companyId,
      issueId: input.watchedIssueId,
      watchdogAgentId: input.watchdogAgentId,
      watchdogIssueId: input.watchdogIssueId,
      status: "active",
    });
    await taskWatchdogService(db).reconcileTaskWatchdogs({ companyId: input.companyId });
    const [watchdog] = await db
      .select({ lastObservedFingerprint: issueWatchdogs.lastObservedFingerprint })
      .from(issueWatchdogs)
      .where(and(eq(issueWatchdogs.companyId, input.companyId), eq(issueWatchdogs.issueId, input.watchedIssueId)));
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.watchdogAgentId,
      status: "running",
      contextSnapshot: {
        issueId: input.watchdogIssueId,
        taskWatchdog: {
          watchedIssueId: input.watchedIssueId,
          watchedIssueIdentifier: "WDOG-ROOT",
          watchedIssueTitle: "Watched root",
          stopFingerprint: watchdog?.lastObservedFingerprint,
        },
      },
    });
    return runId;
  }

  async function waitForAssignmentWakeup(companyId: string) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const rows = await db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.companyId, companyId))
        .limit(1);
      if (rows.length > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  it("creates, updates, reads, lists, and removes an issue watchdog with activity logs", async () => {
    const companyId = await seedCompany();
    const issueId = await seedIssue(companyId, { identifier: "WDOG-1", issueNumber: 1 });
    const firstAgentId = await seedAgent(companyId, { name: "First Watchdog" });
    const secondAgentId = await seedAgent(companyId, { name: "Second Watchdog" });
    const app = createApp(companyId);

    const created = await request(app)
      .put(`/api/issues/${issueId}/watchdog`)
      .send({ agentId: firstAgentId, instructions: "Check screenshots and tests." });

    expect(created.status, JSON.stringify(created.body)).toBe(200);
    expect(created.body).toMatchObject({
      issueId,
      watchdogAgentId: firstAgentId,
      instructions: "Check screenshots and tests.",
      status: "active",
    });

    const updated = await request(app)
      .put(`/api/issues/${issueId}/watchdog`)
      .send({ agentId: secondAgentId, instructions: "Be skeptical." });

    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    expect(updated.body.id).toBe(created.body.id);
    expect(updated.body).toMatchObject({
      issueId,
      watchdogAgentId: secondAgentId,
      instructions: "Be skeptical.",
      status: "active",
    });

    const read = await request(app).get(`/api/issues/${issueId}/watchdog`);
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect(read.body).toMatchObject({ id: created.body.id, watchdogAgentId: secondAgentId });

    const detail = await request(app).get(`/api/issues/${issueId}`);
    expect(detail.status, JSON.stringify(detail.body)).toBe(200);
    expect(detail.body.watchdog).toMatchObject({ id: created.body.id, watchdogAgentId: secondAgentId });

    const list = await request(app).get(`/api/companies/${companyId}/issues`);
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(list.body.find((issue: { id: string }) => issue.id === issueId)?.watchdog)
      .toMatchObject({ id: created.body.id, watchdogAgentId: secondAgentId });

    const removed = await request(app).delete(`/api/issues/${issueId}/watchdog`);
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    expect(removed.body).toEqual({ ok: true });

    const afterDelete = await request(app).get(`/api/issues/${issueId}/watchdog`);
    expect(afterDelete.status, JSON.stringify(afterDelete.body)).toBe(200);
    expect(afterDelete.body).toBeNull();

    const stored = await db
      .select()
      .from(issueWatchdogs)
      .where(and(eq(issueWatchdogs.companyId, companyId), eq(issueWatchdogs.issueId, issueId)))
      .then((rows) => rows[0] ?? null);
    expect(stored).toMatchObject({
      id: created.body.id,
      status: "disabled",
      watchdogAgentId: secondAgentId,
    });

    const actions = await db
      .select({ action: activityLog.action })
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId));
    const actionNames = actions.map((row) => row.action);
    expect(actionNames.filter((action) => action.startsWith("issue.watchdog_"))).toEqual([
      "issue.watchdog_created",
      "issue.watchdog_updated",
      "issue.watchdog_removed",
    ]);
    expect(actionNames).toContain("issue.task_watchdog_triggered");
  });

  it("handles concurrent first-time watchdog upserts without duplicate-key failures", async () => {
    const companyId = await seedCompany();
    const issueId = await seedIssue(companyId, { identifier: "WDOG-RACE", issueNumber: 99 });
    const agentId = await seedAgent(companyId, { name: "Race Watchdog" });
    const app = createApp(companyId);

    const responses = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        request(app)
          .put(`/api/issues/${issueId}/watchdog`)
          .send({ agentId, instructions: `Concurrent instructions ${index}` }),
      ),
    );

    expect(responses.map((res) => res.status), JSON.stringify(responses.map((res) => res.body)))
      .toEqual(Array(12).fill(200));
    const stored = await db
      .select()
      .from(issueWatchdogs)
      .where(and(eq(issueWatchdogs.companyId, companyId), eq(issueWatchdogs.issueId, issueId)));
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ status: "active", watchdogAgentId: agentId });
  });

  it("creates an issue and watchdog atomically from the create issue route", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    const app = createApp(companyId);

    const res = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "Create with watchdog",
        watchdog: {
          agentId,
          instructions: "Confirm the final state.",
        },
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.watchdog).toMatchObject({
      issueId: res.body.id,
      watchdogAgentId: agentId,
      instructions: "Confirm the final state.",
      status: "active",
    });

    const rows = await db
      .select()
      .from(issueWatchdogs)
      .where(eq(issueWatchdogs.issueId, res.body.id));
    expect(rows).toHaveLength(1);

    const activityRows = await db
      .select({ action: activityLog.action })
      .from(activityLog)
      .where(eq(activityLog.entityId, res.body.id));
    expect(activityRows.map((row) => row.action)).toContain("issue.watchdog_created");
  });

  it("does not create an immediate watchdog review for a newly assigned issue", async () => {
    const companyId = await seedCompany();
    const workerAgentId = await seedAgent(companyId, { name: "Worker" });
    const watchdogAgentId = await seedAgent(companyId, { name: "Watchdog" });
    const app = createApp(companyId);

    const res = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "Assigned issue with watchdog",
        assigneeAgentId: workerAgentId,
        watchdog: {
          agentId: watchdogAgentId,
          instructions: "Confirm whether the worker got started.",
        },
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    await waitForAssignmentWakeup(companyId);
    expect(res.body).toMatchObject({
      assigneeAgentId: workerAgentId,
      watchdog: {
        issueId: res.body.id,
        watchdogAgentId,
        status: "active",
      },
    });

    const watchdogReviewIssues = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "task_watchdog")));
    expect(watchdogReviewIssues).toHaveLength(0);

    const [watchdog] = await db
      .select()
      .from(issueWatchdogs)
      .where(and(eq(issueWatchdogs.companyId, companyId), eq(issueWatchdogs.issueId, res.body.id)));
    expect(watchdog?.triggerCount).toBe(0);

    const taskWatchdogActivity = await db
      .select({ action: activityLog.action })
      .from(activityLog)
      .where(and(eq(activityLog.entityId, res.body.id), eq(activityLog.action, "issue.task_watchdog_triggered")));
    expect(taskWatchdogActivity).toHaveLength(0);
  });

  it("enforces persisted watchdog scope for issue mutations and child creation", async () => {
    const companyId = await seedCompany();
    const watchdogAgentId = await seedAgent(companyId, { name: "Scoped Watchdog" });
    const watchedRootId = await seedIssue(companyId, { title: "Watched root", identifier: "WDOG-ROOT" });
    const watchedChildId = await seedIssue(companyId, { title: "Watched child", parentId: watchedRootId });
    const unrelatedRootId = await seedIssue(companyId, { title: "Unrelated root" });
    const watchdogIssueId = await seedIssue(companyId, {
      title: "Reusable watchdog issue",
      parentId: watchedRootId,
      assigneeAgentId: watchdogAgentId,
      originKind: "task_watchdog",
      originId: watchedRootId,
    });
    const watchdogIssueChildId = await seedIssue(companyId, {
      title: "Watchdog issue child",
      parentId: watchdogIssueId,
    });
    const runId = await seedWatchdogRun({
      companyId,
      watchdogAgentId,
      watchedIssueId: watchedRootId,
      watchdogIssueId,
    });
    const app = createApp(companyId, {
      type: "agent",
      agentId: watchdogAgentId,
      companyId,
      runId,
      source: "agent_jwt",
    });

    const watchdogIssuePatch = await request(app)
      .patch(`/api/issues/${watchdogIssueId}`)
      .send({ title: "Reusable watchdog issue completed" });
    expect(watchdogIssuePatch.status, JSON.stringify(watchdogIssuePatch.body)).toBe(200);

    const deniedWatchdogDescendantPatch = await request(app)
      .patch(`/api/issues/${watchdogIssueChildId}`)
      .send({ title: "Denied watchdog descendant mutation" });
    expect(deniedWatchdogDescendantPatch.status, JSON.stringify(deniedWatchdogDescendantPatch.body)).toBe(403);
    expect(deniedWatchdogDescendantPatch.body.error).toBe(
      "Task-watchdog runs can only mutate the watched issue subtree.",
    );

    const deniedPatch = await request(app)
      .patch(`/api/issues/${unrelatedRootId}`)
      .send({ title: "Out-of-scope mutation" });
    expect(deniedPatch.status, JSON.stringify(deniedPatch.body)).toBe(403);
    expect(deniedPatch.body.error).toBe("Task-watchdog runs can only mutate the watched issue subtree.");

    const deniedChild = await request(app)
      .post(`/api/issues/${unrelatedRootId}/children`)
      .send({ title: "Denied unrelated child" });
    expect(deniedChild.status, JSON.stringify(deniedChild.body)).toBe(403);
    expect(deniedChild.body.error).toBe("Task-watchdog runs can only mutate the watched issue subtree.");

    const deniedWatchdogIssueChild = await request(app)
      .post(`/api/issues/${watchdogIssueId}/children`)
      .send({ title: "Denied watchdog issue child" });
    expect(deniedWatchdogIssueChild.status, JSON.stringify(deniedWatchdogIssueChild.body)).toBe(403);
    const deniedVisibleProbeIssues = await db
      .select({ id: issues.id })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.title, "Denied watchdog issue child")));
    expect(deniedVisibleProbeIssues).toHaveLength(0);

    const deniedParentCreate = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Denied parent create", parentId: unrelatedRootId });
    expect(deniedParentCreate.status, JSON.stringify(deniedParentCreate.body)).toBe(403);
    expect(deniedParentCreate.body.error).toBe("Task-watchdog runs can only mutate the watched issue subtree.");

    const deniedNestedWatchdog = await request(app)
      .put(`/api/issues/${watchedChildId}/watchdog`)
      .send({ agentId: watchdogAgentId, instructions: "Create a nested watchdog" });
    expect(deniedNestedWatchdog.status, JSON.stringify(deniedNestedWatchdog.body)).toBe(403);
    expect(deniedNestedWatchdog.body.error).toBe("Task-watchdog runs cannot change watchdog configuration.");

    const deniedWatchdogRemoval = await request(app).delete(`/api/issues/${watchedRootId}/watchdog`);
    expect(deniedWatchdogRemoval.status, JSON.stringify(deniedWatchdogRemoval.body)).toBe(403);
    expect(deniedWatchdogRemoval.body.error).toBe("Task-watchdog runs cannot change watchdog configuration.");

    const nestedWatchdogs = await db
      .select({ id: issueWatchdogs.id })
      .from(issueWatchdogs)
      .where(and(eq(issueWatchdogs.companyId, companyId), eq(issueWatchdogs.issueId, watchedChildId)));
    expect(nestedWatchdogs).toHaveLength(0);

    const allowedChild = await request(app)
      .post(`/api/issues/${watchedChildId}/children`)
      .send({ title: "Allowed watched child" });
    expect(allowedChild.status, JSON.stringify(allowedChild.body)).toBe(201);
    expect(allowedChild.body.parentId).toBe(watchedChildId);
  });

  it("routes watchdog-discovered product bugs outside the watched source tree with evidence links", async () => {
    const companyId = await seedCompany();
    const watchdogAgentId = await seedAgent(companyId, { name: "Product Bug Watchdog" });
    const watchedRootId = await seedIssue(companyId, {
      title: "Watched root",
      identifier: "PAP-100",
      issueNumber: 100,
    });
    const watchedChildId = await seedIssue(companyId, {
      title: "Watched child",
      identifier: "PAP-101",
      issueNumber: 101,
      parentId: watchedRootId,
    });
    const watchdogIssueId = await seedIssue(companyId, {
      title: "Reusable watchdog issue",
      identifier: "PAP-102",
      issueNumber: 102,
      parentId: watchedRootId,
      assigneeAgentId: watchdogAgentId,
      originKind: "task_watchdog",
      originId: watchedRootId,
    });
    const runId = await seedWatchdogRun({
      companyId,
      watchdogAgentId,
      watchedIssueId: watchedRootId,
      watchdogIssueId,
    });
    const app = createApp(companyId, {
      type: "agent",
      agentId: watchdogAgentId,
      companyId,
      runId,
      source: "agent_jwt",
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "Fix watchdog source-tree pollution",
        description: "Watchdog found a Paperclip follow-up routing bug.",
        parentId: watchedChildId,
        watchdogDiscovery: {
          kind: "product_bug",
          evidenceMarkdown: "The watchdog would otherwise create this under the watched child.",
        },
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({
      title: "Fix watchdog source-tree pollution",
      parentId: null,
      originKind: "task_watchdog_product_bug",
      originId: watchedRootId,
      originRunId: runId,
    });
    expect(res.body.description).toContain("## Watchdog Discovery");
    expect(res.body.description).toContain("Watched source issue: [PAP-100](/PAP/issues/PAP-100)");
    expect(res.body.description).toContain("Watchdog issue: [PAP-102](/PAP/issues/PAP-102)");
    expect(res.body.referencedIssueIdentifiers).toEqual(expect.arrayContaining(["PAP-100", "PAP-102"]));

    const watchedSourceChildren = await db
      .select({ id: issues.id, title: issues.title })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.parentId, watchedChildId)));
    expect(watchedSourceChildren).toHaveLength(0);

    const [createdActivity] = await db
      .select({ details: activityLog.details })
      .from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), eq(activityLog.entityId, res.body.id)));
    expect(createdActivity?.details).toMatchObject({
      watchdogDiscovery: {
        kind: "product_bug",
        sourceIssueId: watchedRootId,
        watchdogIssueId,
      },
    });
  });

  it("rejects watchdog interaction-resolution attempts outside the persisted watched subtree", async () => {
    const companyId = await seedCompany();
    const watchdogAgentId = await seedAgent(companyId, { name: "Interaction Watchdog" });
    const watchedRootId = await seedIssue(companyId, { title: "Watched root" });
    const unrelatedRootId = await seedIssue(companyId, { title: "Unrelated root" });
    const watchdogIssueId = await seedIssue(companyId, { title: "Reusable watchdog issue" });
    const runId = await seedWatchdogRun({
      companyId,
      watchdogAgentId,
      watchedIssueId: watchedRootId,
      watchdogIssueId,
    });
    const app = createApp(companyId, {
      type: "agent",
      agentId: watchdogAgentId,
      companyId,
      runId,
      source: "agent_jwt",
    });

    const res = await request(app)
      .post(`/api/issues/${unrelatedRootId}/interactions/${randomUUID()}/accept`)
      .send({});

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toBe("Task-watchdog runs can only mutate the watched issue subtree.");
  });

  it("rejects cross-company watched issues and watchdog agents", async () => {
    const companyId = await seedCompany("Allowed company");
    const otherCompanyId = await seedCompany("Other company");
    const issueId = await seedIssue(companyId);
    const otherIssueId = await seedIssue(otherCompanyId);
    const otherAgentId = await seedAgent(otherCompanyId);
    const app = createApp(companyId);

    const foreignIssue = await request(app)
      .put(`/api/issues/${otherIssueId}/watchdog`)
      .send({ agentId: otherAgentId });
    expect(foreignIssue.status, JSON.stringify(foreignIssue.body)).toBe(403);

    const foreignAgent = await request(app)
      .put(`/api/issues/${issueId}/watchdog`)
      .send({ agentId: otherAgentId });
    expect(foreignAgent.status, JSON.stringify(foreignAgent.body)).toBe(404);
  });

  it.each(["paused", "terminated", "pending_approval"])(
    "rejects %s watchdog agents",
    async (status) => {
      const companyId = await seedCompany();
      const issueId = await seedIssue(companyId);
      const agentId = await seedAgent(companyId, { status });
      const app = createApp(companyId);

      const res = await request(app)
        .put(`/api/issues/${issueId}/watchdog`)
        .send({ agentId });

      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(res.body.error).toBe("Cannot assign watchdog to an agent that is not invokable");
    },
  );
});
