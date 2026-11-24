import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import { agents, authUsers, companyMemberships, heartbeatRuns, issueInboxArchives, issues } from "@paperclipai/db";
import { INBOX_MINE_ISSUE_STATUS_FILTER, type CompactIssue, type InboxMineSnapshot } from "@paperclipai/shared";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { agentRoutes } from "../routes/agents.js";
import { issueRoutes } from "../routes/issues.js";
import * as issueServices from "../services/issues.js";
import * as heartbeatServices from "../services/heartbeat.js";
import { describeEmbeddedPostgres, seedCompanyWithBoardAccess, useEmbeddedPostgres } from "./helpers/route-test-harness.js";

describeEmbeddedPostgres("Mine inbox snapshot routes", () => {
  const ctx = useEmbeddedPostgres("inbox-mine-routes-");

  async function seed(name: string) {
    const fixture = await seedCompanyWithBoardAccess(ctx.db, name);
    await ctx.db.insert(authUsers).values({
      id: fixture.userId, name, email: `${fixture.userId}@example.test`,
      emailVerified: true, createdAt: new Date(), updatedAt: new Date(),
    });
    return fixture;
  }

  function appFor(userId: string | null, options: Parameters<typeof issueRoutes>[2] = {}, actor?: Express.Request["actor"]) {
    const app = express();
    app.use(express.json());
    if (actor) app.use((req, _res, next) => { req.actor = actor; next(); });
    else app.use(actorMiddleware(ctx.db, {
      deploymentMode: "authenticated",
      resolveSession: async () => userId ? {
        session: { id: `session-${userId}`, userId },
        user: { id: userId, name: "Inbox viewer", email: `${userId}@example.test` },
      } : null,
    }));
    app.use("/api", issueRoutes(ctx.db, {} as never, options));
    app.use("/api", agentRoutes(ctx.db));
    app.use(errorHandler);
    return app;
  }

  async function addAgent(companyId: string) {
    const [agent] = await ctx.db.insert(agents).values({
      companyId, name: `Inbox agent ${randomUUID()}`, adapterType: "process", status: "active",
    }).returning();
    return agent!;
  }

  async function addTask(companyId: string, userId: string, values: Partial<typeof issues.$inferInsert> = {}) {
    const [task] = await ctx.db.insert(issues).values({
      companyId, title: "Inbox task", status: "todo", createdByUserId: userId, ...values,
    }).returning();
    return task!;
  }

  const sortedContext = (rows: CompactIssue[]) => [...rows].sort((a, b) => a.id.localeCompare(b.id));

  it("returns the legacy authorized index, archived parent captions and canonical rich failure state in one snapshot", async () => {
    const f = await seed("Snapshot equivalence");
    const app = appFor(f.userId);
    const [failedAgent, resolvedAgent, supersededAgent] = await Promise.all([
      addAgent(f.companyId), addAgent(f.companyId), addAgent(f.companyId),
    ]);
    const indexedParent = await addTask(f.companyId, f.userId, { title: "Indexed parent" });
    const archivedParent = await addTask(f.companyId, f.userId, { title: "Archived parent", status: "done" });
    const failedTask = await addTask(f.companyId, f.userId, { title: "Failed task", status: "blocked", assigneeAgentId: failedAgent.id });
    const resolvedTask = await addTask(f.companyId, f.userId, { title: "Resolved task", status: "done", assigneeAgentId: resolvedAgent.id });
    const supersededTask = await addTask(f.companyId, f.userId, { title: "Superseded failure", assigneeAgentId: supersededAgent.id });
    await ctx.db.insert(issueInboxArchives).values({ companyId: f.companyId, issueId: archivedParent.id, userId: f.userId });
    await addTask(f.companyId, f.userId, { parentId: indexedParent.id });
    await addTask(f.companyId, f.userId, { parentId: archivedParent.id });
    await ctx.db.insert(heartbeatRuns).values([
      { companyId: f.companyId, agentId: failedAgent.id, issueId: failedTask.id, status: "failed", responsibleUserId: f.userId, contextSnapshot: { issueId: failedTask.id }, createdAt: new Date("2026-11-01T00:00:01Z") },
      { companyId: f.companyId, agentId: resolvedAgent.id, issueId: resolvedTask.id, status: "failed", responsibleUserId: f.userId, contextSnapshot: { issueId: resolvedTask.id }, createdAt: new Date("2026-11-01T00:00:02Z") },
      { companyId: f.companyId, agentId: supersededAgent.id, issueId: supersededTask.id, status: "failed", responsibleUserId: f.userId, contextSnapshot: { issueId: supersededTask.id }, createdAt: new Date("2026-11-01T00:00:03Z") },
      { companyId: f.companyId, agentId: supersededAgent.id, issueId: supersededTask.id, status: "succeeded", responsibleUserId: f.userId, contextSnapshot: { issueId: supersededTask.id }, createdAt: new Date("2026-11-01T00:00:04Z") },
    ]);

    const snapshotResponse = await request(app).get(`/api/companies/${f.companyId}/inbox/mine`).expect(200);
    const snapshot = snapshotResponse.body as InboxMineSnapshot;
    const index = await request(app).get(`/api/companies/${f.companyId}/issues`).query({
      touchedByUserId: "me", inboxArchivedByUserId: "me", status: INBOX_MINE_ISSUE_STATUS_FILTER,
      view: "index", sortField: "updated", sortDir: "desc", limit: 100,
      includeRoutineExecutions: true, includeLiveDescendantSummary: true,
    }).expect(200);
    const failures = await request(app).get(`/api/companies/${f.companyId}/heartbeat-runs`)
      .query({ summary: true, latestFailuresOnly: true, limit: 200 }).expect(200);
    const parent = await request(app).get(`/api/companies/${f.companyId}/issues`)
      .query({ view: "index", ids: archivedParent.id, includeRoutineExecutions: true, limit: 100 }).expect(200);
    const failureIds = [failedTask.id, resolvedTask.id].sort();
    const rich = await request(app).get(`/api/companies/${f.companyId}/issues`)
      .query({ view: "rows", ids: failureIds.join(","), includeRoutineExecutions: true, limit: 100 }).expect(200);

    expect(snapshot.userId).toBe(f.userId);
    expect(snapshot.issues).toEqual(index.body);
    expect(snapshot.failureRuns).toEqual(failures.body);
    expect(sortedContext(snapshot.contextIssues)).toEqual(sortedContext([...parent.body, ...rich.body]));
    expect(snapshot.failureIssueIds).toEqual(failureIds);
    expect(snapshot.contextIssues).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: indexedParent.id })]));
    expect(snapshot.contextIssues.find(row => row.id === archivedParent.id)).toMatchObject({ title: "Archived parent", listProjection: "index" });
    expect(snapshot.contextIssues.find(row => row.id === failedTask.id)?.interruption).toMatchObject({ state: "failed", canRetry: true });
    expect(snapshot.contextIssues.find(row => row.id === resolvedTask.id)?.interruption).toMatchObject({ state: "resolved", canRetry: false });
    expect(snapshot.failureRuns.map(run => run.agentId)).not.toContain(supersededAgent.id);
    expect(snapshotResponse.headers["cache-control"]).toBe("private, no-store");
    const timingPhases = new Map((snapshotResponse.headers["server-timing"] ?? "").split(", ").map((entry: string) => {
      const match = /^([a-z_]+);dur=(\d+\.\d)$/.exec(entry);
      expect(match, entry).not.toBeNull();
      return [match![1]!, Number(match![2])] as const;
    }));
    for (const phase of [
      "paperclip_inbox", "inbox_access", "inbox_issues", "inbox_parents", "inbox_failures", "inbox_failure_context",
      "inbox_issues_candidates", "inbox_issues_query", "inbox_issues_labels", "inbox_issues_user_stats", "inbox_issues_read_stats",
      "inbox_issues_last_activity", "inbox_issues_archives", "inbox_issues_live_descendants",
    ]) expect(timingPhases.get(phase), phase).toBeGreaterThanOrEqual(0);
    // Attribution: list sub-phases run inside inbox_issues, and every phase inside the request.
    expect(timingPhases.get("inbox_issues")!).toBeGreaterThanOrEqual(timingPhases.get("inbox_issues_candidates")! + timingPhases.get("inbox_issues_query")! - 0.2);
    expect(timingPhases.get("paperclip_inbox")!).toBeGreaterThanOrEqual(timingPhases.get("inbox_issues")! - 0.1);
    expect(snapshot).not.toHaveProperty("failureError");
    expect(snapshot).not.toHaveProperty("contextError");
  });

  it("keeps private and missing task runs locked and excludes another company's data", async () => {
    const f = await seed("Snapshot privacy");
    const foreign = await seed("Foreign snapshot");
    const privateUser = `private-${randomUUID()}`;
    const agent = await addAgent(f.companyId), missingAgent = await addAgent(f.companyId);
    const privateId = randomUUID(), missingId = randomUUID();
    const publicTask = await addTask(f.companyId, f.userId, { title: "Visible task" });
    await addTask(f.companyId, privateUser, {
      id: privateId, title: "PRIVATE_TASK_TITLE", visibility: "private", privacyRootIssueId: privateId,
      responsibleUserId: privateUser, assigneeAgentId: agent.id,
    });
    await addTask(foreign.companyId, f.userId, { title: "FOREIGN_TASK_TITLE" });
    const privateRunId = randomUUID(), missingRunId = randomUUID();
    await ctx.db.insert(heartbeatRuns).values([
      { id: privateRunId, companyId: f.companyId, agentId: agent.id, issueId: privateId, status: "failed", contextSnapshot: { issueId: privateId, secret: "PRIVATE_RUN_CONTEXT" }, error: "PRIVATE_RUN_ERROR" },
      { id: missingRunId, companyId: f.companyId, agentId: missingAgent.id, status: "failed", contextSnapshot: { issueId: missingId, secret: "MISSING_RUN_CONTEXT" } },
    ]);
    const app = appFor(f.userId);
    const snapshot = (await request(app).get(`/api/companies/${f.companyId}/inbox/mine`).expect(200)).body as InboxMineSnapshot;
    expect(snapshot.issues.map(row => row.id)).toEqual([publicTask.id]);
    expect(snapshot.contextIssues).toEqual([]);
    expect(snapshot.failureIssueIds).toEqual([]);
    expect(snapshot.failureRuns).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: privateRunId, redacted: true }),
      expect.objectContaining({ id: missingRunId, redacted: true }),
    ]));
    const serialized = JSON.stringify(snapshot);
    for (const secret of [privateId, missingId, "PRIVATE_TASK_TITLE", "FOREIGN_TASK_TITLE", "PRIVATE_RUN_CONTEXT", "PRIVATE_RUN_ERROR", "MISSING_RUN_CONTEXT"]) {
      expect(serialized).not.toContain(secret);
    }
    const legacy = await request(app).get(`/api/companies/${f.companyId}/heartbeat-runs`)
      .query({ summary: true, latestFailuresOnly: true, limit: 200 }).expect(200);
    expect(snapshot.failureRuns).toEqual(legacy.body);
  });

  it("limits an agent's Mine read to tasks the agent may open", async () => {
    const f = await seed("Agent Mine privacy");
    const owner = `owner-${randomUUID()}`;
    const agent = await addAgent(f.companyId);
    const privateId = randomUUID();
    const visible = await addTask(f.companyId, owner, { title: "OPEN_OWNER_TASK" });
    await addTask(f.companyId, owner, {
      id: privateId, identifier: "AMP-77", title: "PRIVATE_OWNER_TITLE", description: "PRIVATE_OWNER_DESCRIPTION",
      visibility: "private", privacyRootIssueId: privateId, responsibleUserId: owner,
    });
    const app = appFor(null, {}, { type: "agent", agentId: agent.id, companyId: f.companyId, source: "agent_key" });

    await request(app).get(`/api/issues/${privateId}`).expect(404);
    const res = await request(app).get("/api/agents/me/inbox/mine").query({ userId: owner }).expect(200);

    expect((res.body as Array<{ id: string }>).map(row => row.id)).toEqual([visible.id]);
    for (const leaked of [privateId, "AMP-77", "PRIVATE_OWNER_TITLE", "PRIVATE_OWNER_DESCRIPTION"]) {
      expect(JSON.stringify(res.body)).not.toContain(leaked);
    }
  });

  it("keeps an agent's assigned private task in its queue only when its responsible user may open it", async () => {
    const f = await seed("Agent queue privacy");
    const other = `other-${randomUUID()}`;
    const agent = await addAgent(f.companyId);
    const ownId = randomUUID(), otherId = randomUUID();
    await addTask(f.companyId, f.userId, {
      id: ownId, title: "OWN_PRIVATE_TASK", visibility: "private", privacyRootIssueId: ownId,
      responsibleUserId: f.userId, assigneeAgentId: agent.id,
    });
    await addTask(f.companyId, other, {
      id: otherId, title: "OTHER_PRIVATE_TASK", visibility: "private", privacyRootIssueId: otherId,
      responsibleUserId: other, assigneeAgentId: agent.id,
    });
    const app = appFor(null, {}, {
      type: "agent", agentId: agent.id, companyId: f.companyId, source: "agent_key", onBehalfOfUserId: f.userId,
    });

    const queue = await request(app).get("/api/agents/me/inbox-lite").expect(200);
    expect((queue.body as Array<{ id: string }>).map(row => row.id)).toEqual([ownId]);
    const mine = await request(app).get("/api/agents/me/inbox/mine").query({ userId: f.userId }).expect(200);
    expect((mine.body as Array<{ id: string }>).map(row => row.id)).toEqual([ownId]);
    expect(JSON.stringify([queue.body, mine.body])).not.toContain("OTHER_PRIVATE_TASK");
  });

  it("owns the 100-task and 200-run bounds and rejects caller filters or unauthorized identities", async () => {
    const f = await seed("Snapshot bounds");
    const ids = Array.from({ length: 105 }, () => randomUUID());
    await ctx.db.insert(issues).values(ids.map((id, index) => ({
      id, companyId: f.companyId, title: `Bounded task ${index}`, status: "todo", createdByUserId: f.userId,
      createdAt: new Date("2026-10-01T00:00:00Z"),
      updatedAt: new Date(Date.UTC(2026, 10, 1, 0, index)),
    })));
    const runAgents = await ctx.db.insert(agents).values(Array.from({ length: 205 }, (_, index) => ({
      companyId: f.companyId, name: `Bounded run agent ${index}`, adapterType: "process",
    }))).returning();
    await ctx.db.insert(heartbeatRuns).values(runAgents.map((agent, index) => ({
      companyId: f.companyId, agentId: agent.id, status: "failed",
      createdAt: new Date(Date.UTC(2026, 10, 1, 0, index)),
    })));
    const app = appFor(f.userId);
    const snapshot = (await request(app).get(`/api/companies/${f.companyId}/inbox/mine`).expect(200)).body as InboxMineSnapshot;
    expect(snapshot.issues.map(row => row.id)).toEqual([...ids].reverse().slice(0, 100));
    expect(snapshot.failureRuns).toHaveLength(200);
    expect(snapshot.failureRuns.map(run => run.agentId)).not.toContain(runAgents[0]!.id);
    for (const query of [{ limit: 1000 }, { ids: ids[0] }, { userId: "other-user" }, { view: "rows" }]) {
      await request(app).get(`/api/companies/${f.companyId}/inbox/mine`).query(query).expect(400);
    }
    await request(appFor(null)).get(`/api/companies/${f.companyId}/inbox/mine`).expect(403);
    await request(appFor(null, {}, { type: "agent", agentId: runAgents[0]!.id, companyId: f.companyId, source: "agent_key" }))
      .get(`/api/companies/${f.companyId}/inbox/mine`).expect(403);
    await request(appFor(null, {}, { ...f.actor, userId: undefined } as Express.Request["actor"]))
      .get(`/api/companies/${f.companyId}/inbox/mine`).expect(401);
    await ctx.db.update(companyMemberships).set({ status: "archived" }).where(eq(companyMemberships.principalId, f.userId));
    await request(app).get(`/api/companies/${f.companyId}/inbox/mine`).expect(403);
  });

  it("starts a fresh snapshot after archive while an older snapshot is still loading failure context", async () => {
    const f = await seed("Snapshot mutation freshness");
    const task = await addTask(f.companyId, f.userId);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let releaseAdmission!: () => void;
    const admissionGate = new Promise<void>(resolve => { releaseAdmission = resolve; });
    let holdNewComputes = false;
    const primaryRead = vi.fn();
    const heldFailureRead = vi.fn();
    const issueFactory = issueServices.issueService;
    const issueSpy = vi.spyOn(issueServices, "issueService").mockImplementation((...args) => {
      const service = issueFactory(...args);
      return { ...service, list: async (...listArgs) => {
        const rows = await service.list(...listArgs);
        if (listArgs[0] === f.companyId && listArgs[1]?.touchedByUserId === f.userId) primaryRead();
        return rows;
      } };
    });
    const heartbeatFactory = heartbeatServices.heartbeatService;
    let firstFailureRead = true;
    const heartbeatSpy = vi.spyOn(heartbeatServices, "heartbeatService").mockImplementation((...args) => {
      const service = heartbeatFactory(...args);
      return { ...service, list: async (...listArgs) => {
        const runs = await service.list(...listArgs);
        if (listArgs[0] === f.companyId && firstFailureRead) {
          firstFailureRead = false;
          heldFailureRead();
          await gate;
        }
        return runs;
      } };
    });
    const started = vi.fn(async () => { if (holdNewComputes) await admissionGate; });
    const pending: Array<Promise<request.Response>> = [];
    try {
      const app = appFor(f.userId, { issueListDiagnostics: { onComputeStart: started } });
      const path = `/api/companies/${f.companyId}/inbox/mine`;
      const original = request(app).get(path).then(response => response);
      pending.push(original);
      await vi.waitFor(() => {
        expect(primaryRead).toHaveBeenCalledTimes(1);
        expect(heldFailureRead).toHaveBeenCalledTimes(1);
      }, { timeout: 5000 });
      await request(app).post(`/api/issues/${task.id}/inbox-archive`).send({}).expect(200);
      const fresh = request(app).get(path).then(response => response);
      pending.push(fresh);
      await vi.waitFor(() => expect(started).toHaveBeenCalledTimes(2), { timeout: 2000 });
      const afterArchive = await fresh;
      expect(afterArchive.status).toBe(200);
      expect(afterArchive.headers["x-paperclip-request-cache"]).toBe("miss");
      expect(afterArchive.body.issues).toEqual([]);
      // Retiring reuse does not retire the old compute's admission. It still
      // occupies one of the same eight slots until its failure read settles.
      holdNewComputes = true;
      for (let offset = 0; offset < 7; offset += 1) {
        pending.push(request(app).get(`/api/companies/${f.companyId}/issues`)
          .query({ view: "index", offset }).then(response => response));
      }
      await vi.waitFor(() => expect(started).toHaveBeenCalledTimes(9), { timeout: 5000 });
      await request(app).get(`/api/companies/${f.companyId}/issues`).query({ view: "index", offset: 99 }).expect(429);
      expect(started).toHaveBeenCalledTimes(9);
      release();
      const beforeArchive = await original;
      expect(beforeArchive.body.issues.map((row: CompactIssue) => row.id)).toEqual([task.id]);
      pending.push(request(app).get(`/api/companies/${f.companyId}/issues`)
        .query({ view: "index", offset: 100 }).then(response => response));
      await vi.waitFor(() => expect(started).toHaveBeenCalledTimes(10), { timeout: 5000 });
      releaseAdmission();
      expect((await Promise.all(pending)).every(response => response.status === 200)).toBe(true);
    } finally {
      release();
      releaseAdmission();
      await Promise.allSettled(pending);
      issueSpy.mockRestore();
      heartbeatSpy.mockRestore();
    }
  });

  it.each([false, true])("retains admission until aborted snapshot work settles (coalesced reader: %s)", async withCoalescedReader => {
    const f = await seed("Snapshot admission");
    await addTask(f.companyId, f.userId);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = vi.fn(async () => gate);
    const app = appFor(f.userId, { issueListDiagnostics: { onComputeStart: started } });
    const requests: Array<Promise<{ status: number }>> = [];
    const snapshotPath = `/api/companies/${f.companyId}/inbox/mine`;
    const original = request(app).get(snapshotPath);
    // Retain a rejection handler before aborting the socket.
    const aborted = original.then(() => undefined, () => undefined);
    try {
      await vi.waitFor(() => expect(started).toHaveBeenCalledTimes(1), { timeout: 5000 });
      const coalesced = withCoalescedReader ? request(app).get(snapshotPath).then(response => response) : undefined;
      if (coalesced) requests.push(coalesced);
      for (let offset = 0; offset < 7; offset += 1) {
        requests.push(request(app).get(`/api/companies/${f.companyId}/issues`)
          .query({ view: "index", offset }).then(response => response));
      }
      await vi.waitFor(() => expect(started).toHaveBeenCalledTimes(8), { timeout: 5000 });
      original.abort();
      await aborted;
      const denied = await request(app).get(`/api/companies/${f.companyId}/issues`).query({ view: "index", offset: 99 }).expect(429);
      expect(denied.headers["retry-after"]).toBe("1");
      expect(started).toHaveBeenCalledTimes(8);
      release();
      const responses = await Promise.all(requests);
      expect(responses.every(response => response.status === 200)).toBe(true);
      if (coalesced) {
        const shared = await coalesced as { headers: Record<string, string> };
        expect(shared.headers["x-paperclip-request-cache"]).toBe("coalesced");
        // The coalesced reader reports the shared read's phases, not only its own access check.
        expect(shared.headers["server-timing"]).toMatch(/inbox_issues;dur=/);
        expect(shared.headers["server-timing"]).toMatch(/inbox_issues_query;dur=/);
      }
      // The aborted snapshot can outlive the seven ordinary reads. A coalesced
      // response waits for that compute to settle before we require a fresh one.
      const settled = await request(app).get(snapshotPath).expect(200);
      const fresh = settled.headers["x-paperclip-request-cache"] === "coalesced"
        ? await request(app).get(snapshotPath).expect(200)
        : settled;
      expect(fresh.headers["x-paperclip-request-cache"]).toBe("miss");
      expect(started).toHaveBeenCalledTimes(9);
    } finally {
      release();
      await aborted;
      await Promise.allSettled(requests);
    }
  });
});
