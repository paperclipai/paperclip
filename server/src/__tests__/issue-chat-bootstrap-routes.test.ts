import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  activityLog, agents, assets, heartbeatRuns, issueAttachments, issueComments, issues, issueThreadInteractions,
} from "@paperclipai/db";
import { issueRoutes } from "../routes/issues.js";
import { activityRoutes } from "../routes/activity.js";
import { agentRoutes } from "../routes/agents.js";
import { errorHandler } from "../middleware/index.js";
import { describeEmbeddedPostgres, seedCompanyWithBoardAccess, useEmbeddedPostgres, type BoardActor } from "./helpers/route-test-harness.js";

describeEmbeddedPostgres("task chat bootstrap", () => {
  const ctx = useEmbeddedPostgres("paperclip-issue-chat-bootstrap-");
  const oldPrivacy = process.env.PAPERCLIP_ISSUE_PRIVACY_MODE;
  beforeAll(() => { process.env.PAPERCLIP_ISSUE_PRIVACY_MODE = "enforce"; });
  afterAll(() => {
    if (oldPrivacy === undefined) delete process.env.PAPERCLIP_ISSUE_PRIVACY_MODE;
    else process.env.PAPERCLIP_ISSUE_PRIVACY_MODE = oldPrivacy;
  });
  // Run decorations (output silence) are relative to now; hold the clock so the
  // single endpoints and the bootstrap see the same instant.
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-09T12:00:00.000Z") }); });
  afterEach(() => { vi.useRealTimers(); });

  function app(actor: BoardActor | Express.Request["actor"]) {
    const result = express();
    result.use(express.json());
    result.use((req, _res, next) => { req.actor = actor as Express.Request["actor"]; next(); });
    result.use("/api", issueRoutes(ctx.db, {} as never));
    result.use("/api", activityRoutes(ctx.db));
    result.use("/api", agentRoutes(ctx.db));
    result.use(errorHandler);
    return result;
  }
  const url = (companyId: string) => `/api/companies/${companyId}/issues/chat-bootstrap`;

  let issueCounter = 0;
  /** A task with comments, their input facts, other activity, a running run, an interaction and an attachment. */
  async function seedTask(companyId: string, options: { conversation?: boolean; description?: string | null; userId: string }) {
    const [agent] = await ctx.db.insert(agents).values({ companyId, name: `Agent ${randomUUID().slice(0, 6)}`, role: "engineer", adapterType: "process" }).returning();
    const issueId = randomUUID();
    const runId = randomUUID();
    const number = ++issueCounter;
    const [company] = await ctx.db.execute<{ issue_prefix: string }>(
      `select issue_prefix from companies where id = '${companyId}'` as never,
    ) as unknown as Array<{ issue_prefix: string }>;
    const identifier = `${company!.issue_prefix}-${number}`;
    await ctx.db.insert(issues).values({
      id: issueId, companyId, identifier, issueNumber: number, title: `Task ${number}`,
      description: options.description === undefined ? "Do the thing" : options.description,
      status: "in_progress", assigneeAgentId: agent!.id,
      ...(options.conversation ? { conversationAgentId: agent!.id, conversationUserId: options.userId, conversationState: "waiting" } : {}),
    });
    await ctx.db.insert(heartbeatRuns).values({
      id: runId, companyId, agentId: agent!.id, issueId, status: "running", runtimeMode: "native",
      contextSnapshot: { issueId }, startedAt: new Date("2026-11-09T11:59:00.000Z"),
    });
    await ctx.db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    const comments = Array.from({ length: 7 }, (_, i) => ({
      id: randomUUID(), companyId, issueId,
      ...(i % 3 === 0
        ? { authorType: "user" as const, authorUserId: options.userId }
        : { authorType: "agent" as const, authorAgentId: agent!.id, createdByRunId: runId }),
      body: `Message ${i}`, createdAt: new Date(Date.UTC(2026, 10, 9, 10, i)),
    }));
    await ctx.db.insert(issueComments).values(comments);
    await ctx.db.insert(activityLog).values([
      ...comments.map((comment) => ({
        companyId, actorType: "user", actorId: options.userId, action: "issue.comment_added",
        entityType: "issue", entityId: issueId, details: { commentId: comment.id }, createdAt: comment.createdAt,
      })),
      { companyId, actorType: "user", actorId: options.userId, action: "issue.updated", entityType: "issue", entityId: issueId, details: { status: "in_progress" } },
    ]);
    await ctx.db.insert(issueThreadInteractions).values({
      companyId, issueId, kind: "ask_user_questions", status: "pending", effectiveResolverPolicy: "human_only",
      sourceRunId: runId,
      payload: { version: 1, questions: [{ id: "q1", prompt: "Ship it?", selectionMode: "single", options: [{ id: "yes", label: "Yes" }] }] },
    });
    const [asset] = await ctx.db.insert(assets).values({
      companyId, provider: "local_disk", objectKey: `assets/${randomUUID()}`, contentType: "text/plain", byteSize: 5, sha256: "abc", originalFilename: "notes.txt",
    }).returning();
    await ctx.db.insert(issueAttachments).values({ companyId, issueId, assetId: asset!.id, issueCommentId: comments[0]!.id });
    return { issueId, identifier, runId, agentId: agent!.id, commentIds: comments.map((comment) => comment.id) };
  }

  /** The payloads the chat reads today, one request each. */
  async function singleEndpoints(server: express.Express, ref: string) {
    const get = async (path: string) => {
      const res = await request(server).get(path);
      expect(res.status, `${path}: ${JSON.stringify(res.body)}`).toBe(200);
      return res.body;
    };
    const recentComments = await get(`/api/issues/${ref}/recent-comments`);
    const commentIds = (recentComments.comments as Array<{ id: string }>).map((comment) => comment.id).sort();
    return {
      issue: await get(`/api/issues/${ref}?view=core`),
      recentComments,
      commentInputFacts: await get(`/api/issues/${ref}/activity?view=comment-inputs&commentIds=${commentIds.join(",")}`),
      recentActivity: await get(`/api/issues/${ref}/activity?view=recent`),
      recentRuns: await get(`/api/issues/${ref}/runs?view=recent`),
      interactions: await get(`/api/issues/${ref}/interactions`),
      attachments: await get(`/api/issues/${ref}/attachments`),
      liveRuns: await get(`/api/issues/${ref}/live-runs`),
      activeRun: await get(`/api/issues/${ref}/active-run`),
    };
  }

  it("serves each field exactly as its single endpoint does, for an ordinary task and a conversation", async () => {
    const f = await seedCompanyWithBoardAccess(ctx.db, "Bootstrap");
    const ordinary = await seedTask(f.companyId, { userId: f.userId, description: null });
    const conversation = await seedTask(f.companyId, { userId: f.userId, conversation: true });
    const server = app(f.actor);

    const res = await request(server).get(url(f.companyId)).query({ ids: `${ordinary.issueId},${conversation.issueId}` });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.headers["cache-control"]).toBe("private, no-store");
    expect(res.body.items.map((item: { ref: string }) => item.ref)).toEqual([ordinary.issueId, conversation.issueId]);

    for (const [index, task] of [ordinary, conversation].entries()) {
      const item = res.body.items[index];
      const expected = await singleEndpoints(server, task.issueId);
      expect(Object.keys(item).sort()).toEqual(["ref", ...Object.keys(expected)].sort());
      for (const [field, value] of Object.entries(expected)) expect(item[field], field).toEqual(value);
      // The fixture exercises every field, so equality is not vacuous.
      expect(item.recentComments.comments.length).toBeGreaterThan(0);
      expect(item.commentInputFacts.length).toBe(item.recentComments.comments.length);
      expect(item.recentActivity.length).toBeGreaterThan(item.commentInputFacts.length);
      expect(item.recentRuns.map((run: { runId: string }) => run.runId)).toEqual([task.runId]);
      expect(item.interactions).toHaveLength(1);
      expect(item.attachments).toEqual([expect.objectContaining({ contentPath: expect.stringMatching(/^\/api\/attachments\//) })]);
      expect(item.liveRuns.map((run: { id: string }) => run.id)).toEqual([task.runId]);
      expect(item.activeRun).toMatchObject({ id: task.runId, agentId: task.agentId });
    }
    // The two branches of recent comments differ: a conversation keeps a contiguous window.
    expect(res.body.items[1].recentComments.comments).toHaveLength(7);
    expect(res.body.items[1].recentComments.oldestCommentId).toBeDefined();
    expect(res.body.items[0].recentComments).not.toHaveProperty("oldestCommentId");
  });

  it("follows request order with mixed UUIDs and identifiers, and reads a task named twice once per ref", async () => {
    const f = await seedCompanyWithBoardAccess(ctx.db, "Order");
    const a = await seedTask(f.companyId, { userId: f.userId });
    const b = await seedTask(f.companyId, { userId: f.userId });
    const ids = [b.identifier.toLowerCase(), a.issueId.toUpperCase(), b.issueId, ` ${b.identifier} `];
    const res = await request(app(f.actor)).get(url(f.companyId)).query({ ids: ids.join(",") }).expect(200);
    // Normalized and deduplicated by the contract; the same task under two refs is returned for each ref.
    expect(res.body.items.map((item: { ref: string; issue: { id: string } }) => [item.ref, item.issue.id])).toEqual([
      [b.identifier, b.issueId], [a.issueId, a.issueId], [b.issueId, b.issueId],
    ]);
    expect(res.body.items[0].issue).toEqual(res.body.items[2].issue);
  });

  it("omits foreign, private, missing and unknown tasks and never discloses their data", async () => {
    const f = await seedCompanyWithBoardAccess(ctx.db, "Visible");
    const foreign = await seedCompanyWithBoardAccess(ctx.db, "Foreign");
    const visible = await seedTask(f.companyId, { userId: f.userId });
    const foreignTask = await seedTask(foreign.companyId, { userId: foreign.userId });
    const privateTask = await seedTask(f.companyId, { userId: "someone-else" });
    await ctx.db.update(issues).set({
      visibility: "private", privacyRootIssueId: privateTask.issueId, responsibleUserId: "someone-else", createdByUserId: "someone-else",
    }).where(eq(issues.id, privateTask.issueId));

    const ids = [privateTask.issueId, foreignTask.issueId, foreignTask.identifier, visible.issueId, randomUUID(), "NOPE-999"];
    const res = await request(app(f.actor)).get(url(f.companyId)).query({ ids: ids.join(",") }).expect(200);
    expect(res.body.items.map((item: { ref: string }) => item.ref)).toEqual([visible.issueId]);
    const body = JSON.stringify(res.body);
    for (const hidden of [privateTask, foreignTask]) {
      expect(body).not.toContain(hidden.issueId);
      expect(body).not.toContain(hidden.runId);
      for (const commentId of hidden.commentIds) expect(body).not.toContain(commentId);
    }
    // A private task is denied by the read policy on its single endpoint too.
    await request(app(f.actor)).get(`/api/issues/${privateTask.issueId}/recent-comments`).expect(404);
    // Another company's bootstrap is out of reach.
    await request(app(f.actor)).get(url(foreign.companyId)).query({ ids: foreignTask.issueId }).expect(403);
  });

  it("serves one task by UUID or identifier as exactly the batch item, never as a 304", async () => {
    const f = await seedCompanyWithBoardAccess(ctx.db, "Single");
    const ordinary = await seedTask(f.companyId, { userId: f.userId });
    const conversation = await seedTask(f.companyId, { userId: f.userId, conversation: true });
    const server = app(f.actor);
    for (const task of [ordinary, conversation]) {
      const batch = await request(server).get(url(f.companyId)).query({ ids: `${task.issueId},${task.identifier}` }).expect(200);
      const byUuid = await request(server).get(`/api/issues/${task.issueId.toUpperCase()}/chat-bootstrap`).expect(200);
      expect(byUuid.headers["cache-control"]).toBe("private, no-store");
      // Not the issue-detail ETag middleware (which would set `must-revalidate`); a fetch without validators is a 200.
      expect(byUuid.body).toEqual(batch.body.items[0]);
      expect(byUuid.body.ref).toBe(task.issueId);
      const byIdentifier = await request(server).get(`/api/issues/${task.identifier.toLowerCase()}/chat-bootstrap`).expect(200);
      expect(byIdentifier.body).toEqual(batch.body.items[1]);
      expect(byIdentifier.body.ref).toBe(task.identifier);
      // And each field is the single endpoint's payload.
      const expected = await singleEndpoints(server, task.issueId);
      for (const [field, value] of Object.entries(expected)) expect(byUuid.body[field], field).toEqual(value);
    }
  });

  it("returns 404 for a missing, private or other-company task through the single-task route", async () => {
    const f = await seedCompanyWithBoardAccess(ctx.db, "Single404");
    const foreign = await seedCompanyWithBoardAccess(ctx.db, "Single404 foreign");
    const foreignTask = await seedTask(foreign.companyId, { userId: foreign.userId });
    const privateTask = await seedTask(f.companyId, { userId: "someone-else" });
    await ctx.db.update(issues).set({
      visibility: "private", privacyRootIssueId: privateTask.issueId, responsibleUserId: "someone-else", createdByUserId: "someone-else",
    }).where(eq(issues.id, privateTask.issueId));
    const server = app(f.actor);
    for (const ref of [privateTask.issueId, privateTask.identifier, foreignTask.issueId, foreignTask.identifier, randomUUID(), "NOPE-999", "not a ref"]) {
      const res = await request(server).get(`/api/issues/${encodeURIComponent(ref)}/chat-bootstrap`);
      expect(res.status, ref).toBe(404);
      expect(JSON.stringify(res.body)).not.toContain("Task ");
    }
  });

  it.each([
    "", "?ids=", "?ids=,", "?ids=nope", "?ids=not-a-uuid-or-identifier!", "?ids[]=x", "?ids[x]=x",
    `?ids=${randomUUID()}&extra=1`, `?ids=${randomUUID()}&ids=${randomUUID()}`,
    `?ids=${Array.from({ length: 11 }, () => randomUUID()).join(",")}`,
  ])("rejects invalid query %s", async (query) => {
    const f = await seedCompanyWithBoardAccess(ctx.db, "Invalid");
    await request(app(f.actor)).get(url(f.companyId) + query).expect(400);
  });

  it("rejects task-bridge keys and serves ordinary same-company agents", async () => {
    const f = await seedCompanyWithBoardAccess(ctx.db, "Bridge");
    const task = await seedTask(f.companyId, { userId: f.userId });
    const actor: Express.Request["actor"] = { type: "agent", agentId: task.agentId, companyId: f.companyId, source: "agent_key" };
    const res = await request(app(actor)).get(url(f.companyId)).query({ ids: task.issueId }).expect(200);
    expect(res.body.items).toHaveLength(1);
    await request(app({ ...actor, keyScope: { kind: "task_bridge", issueId: task.issueId } } as Express.Request["actor"]))
      .get(url(f.companyId)).query({ ids: task.issueId }).expect(403);
  });

  it("is read-only and bounds the database work for ten tasks", async () => {
    const f = await seedCompanyWithBoardAccess(ctx.db, "Cost");
    const tasks = [];
    for (let i = 0; i < 10; i++) tasks.push(await seedTask(f.companyId, { userId: f.userId, conversation: i % 2 === 0 }));
    const server = app(f.actor);
    const activityBefore = await ctx.db.select({ id: activityLog.id }).from(activityLog).where(eq(activityLog.companyId, f.companyId));
    const commentsBefore = await ctx.db.select({ id: issueComments.id }).from(issueComments).where(eq(issueComments.companyId, f.companyId));

    const statements: string[] = [];
    const client = ctx.db.$client as unknown as { options: { debug?: unknown } };
    const previousDebug = client.options.debug;
    client.options.debug = (_connection: number, query: string) => { statements.push(query); };
    const started = performance.now();
    let res;
    try {
      res = await request(server).get(url(f.companyId)).query({ ids: tasks.map((task) => task.issueId).join(",") });
    } finally {
      client.options.debug = previousDebug;
    }
    const elapsedMs = performance.now() - started;
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(10);
    // Reported for the PR; the bound guards against an accidental N+1 inside a task.
    process.stdout.write(`${JSON.stringify({ chatBootstrap: { tasks: 10, statements: statements.length, perTask: statements.length / 10, elapsedMs: Math.round(elapsedMs) } })}\n`);
    if (process.env.CHAT_BOOTSTRAP_DUMP) {
      const counts = new Map<string, number>();
      for (const statement of statements) {
        const key = statement.replace(/\s+/g, " ").slice(0, 140);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      process.stdout.write(`${JSON.stringify([...counts].sort((a, b) => b[1] - a[1]), null, 1)}\n`);
    }
    expect(statements.length / 10).toBeLessThan(60);
    expect(statements.some((statement) => /^\s*(insert|update|delete)\b/i.test(statement))).toBe(false);

    expect(await ctx.db.select({ id: activityLog.id }).from(activityLog).where(eq(activityLog.companyId, f.companyId))).toHaveLength(activityBefore.length);
    expect(await ctx.db.select({ id: issueComments.id }).from(issueComments).where(eq(issueComments.companyId, f.companyId))).toHaveLength(commentsBefore.length);
  });

  it("does not start the run liveness backfill for finished runs", async () => {
    const f = await seedCompanyWithBoardAccess(ctx.db, "Backfill");
    const task = await seedTask(f.companyId, { userId: f.userId });
    const [run] = await ctx.db.select({ agentId: heartbeatRuns.agentId }).from(heartbeatRuns).where(eq(heartbeatRuns.issueId, task.issueId));
    // A finished run without a liveness state is what `/runs` backfills in the background.
    const finishedRunId = randomUUID();
    await ctx.db.insert(heartbeatRuns).values({
      id: finishedRunId, companyId: f.companyId, agentId: run!.agentId, issueId: task.issueId, status: "succeeded", runtimeMode: "native",
      contextSnapshot: { issueId: task.issueId }, startedAt: new Date("2026-11-09T11:00:00.000Z"), finishedAt: new Date("2026-11-09T11:05:00.000Z"),
    });
    const server = app(f.actor);

    expect((await request(server).get(url(f.companyId)).query({ ids: task.issueId })).status).toBe(200);
    expect((await request(server).get(`/api/issues/${task.issueId}/chat-bootstrap`)).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const [after] = await ctx.db.select({ livenessState: heartbeatRuns.livenessState }).from(heartbeatRuns).where(eq(heartbeatRuns.id, finishedRunId));
    expect(after!.livenessState).toBeNull();

    // Control: the task page's own runs read still schedules it.
    expect((await request(server).get(`/api/issues/${task.issueId}/runs`).query({ view: "recent" })).status).toBe(200);
    await expect.poll(async () => {
      const [row] = await ctx.db.select({ livenessState: heartbeatRuns.livenessState }).from(heartbeatRuns).where(eq(heartbeatRuns.id, finishedRunId));
      return row!.livenessState;
    }, { timeout: 5_000 }).not.toBeNull();
  });
});
