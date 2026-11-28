import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentWakeupRequests, agents, companies, createDb, heartbeatRunEvents, heartbeatRuns, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";
import { documentService } from "../services/documents.js";
import { CHILD_TASK_READ_EVENT, hasPendingNativeChildCompletion } from "../services/native-runtime/native-child-completion-delivery.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

describePostgres("a parent run reading a finished child through the issue routes", () => {
  let db: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  const companyId = randomUUID();
  const agentId = randomUUID();
  const otherCompanyId = randomUUID();
  const otherAgentId = randomUUID();
  const otherRunId = randomUUID();

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-native-child-read-routes-");
    db = createDb(database.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Paperclip", issuePrefix: "CHR", defaultResponsibleUserId: "board-user",
      requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({ id: agentId, companyId, name: "Coder", role: "engineer", adapterType: "codex_local", status: "active" });
    await db.insert(companies).values({ id: otherCompanyId, name: "Other", issuePrefix: "OTH", defaultResponsibleUserId: "board-user",
      requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({ id: otherAgentId, companyId: otherCompanyId, name: "Outsider", role: "engineer",
      adapterType: "codex_local", status: "active" });
    await db.insert(heartbeatRuns).values({ id: otherRunId, companyId: otherCompanyId, agentId: otherAgentId, status: "running",
      runtimeMode: "native", startedAt: new Date(), contextSnapshot: {} });
  }, 30_000);
  afterAll(async () => { await database?.cleanup(); });

  function app(actor: Express.Request["actor"]) {
    const instance = express();
    instance.use(express.json());
    instance.use((req, _res, next) => { req.actor = actor; next(); });
    instance.use("/api", issueRoutes(db, {} as never));
    instance.use(errorHandler);
    return instance;
  }
  const agentActor = (runId: string) => ({ type: "agent", companyId, agentId, runId, source: "agent_jwt",
    onBehalfOfUserId: null, onBehalfOfMemberships: [] }) as Express.Request["actor"];
  const boardActor = { type: "board", userId: "board-user", source: "local_implicit", isInstanceAdmin: true } as Express.Request["actor"];

  async function seed(childStatus: "done" | "in_progress", issueNumber: number, options: { childRevisionAgeMs?: number; wakeAgeMs?: number } = {}) {
    const runId = randomUUID();
    const childId = randomUUID();
    const parentId = randomUUID();
    await db.insert(issues).values({ id: parentId, companyId, title: "Merge the ledgers", identifier: `CHR-${issueNumber + 100}`,
      issueNumber: issueNumber + 100, status: "in_progress", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", runtimeMode: "native",
      nativeIssueId: parentId, startedAt: new Date(Date.now() - 60_000), contextSnapshot: { issueId: parentId } });
    await db.insert(issues).values({ id: childId, companyId, parentId, title: "Child ledger", identifier: `CHR-${issueNumber}`,
      issueNumber, status: childStatus, assigneeAgentId: agentId,
      ...(options.childRevisionAgeMs ? { updatedAt: new Date(Date.now() - options.childRevisionAgeMs) } : {}) });
    await documentService(db).upsertIssueDocument({ issueId: childId, key: "ledger", format: "markdown", body: "ROUND 1" });
    if (options.childRevisionAgeMs) await db.update(issues).set({ updatedAt: new Date(Date.now() - options.childRevisionAgeMs) })
      .where(eq(issues.id, childId));
    const [wake] = await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "automation", triggerDetail: "system",
      reason: "issue_execution_deferred", requestedByActorType: "system", requestedByActorId: `native-status-wake-dispatch:${randomUUID()}`,
      status: "deferred_issue_execution", createdAt: new Date(Date.now() - (options.wakeAgeMs ?? 30_000)),
      payload: { issueId: parentId, _paperclipWakeContext: { issueId: parentId, wakeReason: "issue_children_completed",
        nativeChildCompletionDecisionId: randomUUID(), completedChildIssueId: childId } } }).returning();
    return { runId, childId, parentId, wakeId: wake!.id };
  }
  const reads = (runId: string) => db.select().from(heartbeatRunEvents)
    .where(and(eq(heartbeatRunEvents.runId, runId), eq(heartbeatRunEvents.eventType, CHILD_TASK_READ_EVENT)));
  const pending = (f: { runId: string; parentId: string }) =>
    hasPendingNativeChildCompletion(db, { companyId, issueId: f.parentId, agentId, runId: f.runId, sourceIntentId: null });

  it.each(["", "/documents", "/documents/ledger"])("records the parent run's read of a finished child (GET /issues/:id%s)", async (suffix) => {
    const f = await seed("done", 10 + suffix.length);
    expect(await pending(f)).toBe(true);
    expect((await request(app(agentActor(f.runId))).get(`/api/issues/${f.childId}${suffix}`)).status).toBe(200);
    expect(await reads(f.runId)).toEqual([expect.objectContaining({ payload: {
      parentIssueId: f.parentId, children: { [f.childId]: { status: "done", updatedAt: expect.any(String), statusDecisionId: null } } } })]);
    expect(await pending(f)).toBe(false);
  });

  it("does not count a read of a child that is still open, or a board read", async () => {
    const open = await seed("in_progress", 40);
    expect((await request(app(agentActor(open.runId))).get(`/api/issues/${open.childId}`)).status).toBe(200);
    expect(await reads(open.runId)).toEqual([]);
    expect(await pending(open)).toBe(true);

    const board = await seed("done", 41);
    expect((await request(app(boardActor)).get(`/api/issues/${board.childId}`)).status).toBe(200);
    expect(await reads(board.runId)).toEqual([]);
    expect(await pending(board)).toBe(true);
  });

  it("does not record a read by another company's agent", async () => {
    const f = await seed("done", 42);
    const outsider = { type: "agent", companyId: otherCompanyId, agentId: otherAgentId, runId: otherRunId, source: "agent_jwt",
      onBehalfOfUserId: null, onBehalfOfMemberships: [] } as Express.Request["actor"];
    for (const suffix of ["", "/documents", "/documents/ledger"]) {
      expect((await request(app(outsider)).get(`/api/issues/${f.childId}${suffix}`)).status).not.toBe(200);
    }
    expect(await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.eventType, CHILD_TASK_READ_EVENT))
      .then(rows => rows.filter(row => row.runId === otherRunId || row.companyId === otherCompanyId))).toEqual([]);
    expect(await pending(f)).toBe(true);
  });

  it.each([
    ["an invalid document key", "/documents/Not A Key!", 400],
    ["a missing document", "/documents/missing", 404],
  ])("does not count a failed request for %s as a read", async (_shape, suffix, status) => {
    const f = await seed("done", 43 + suffix.length);
    expect((await request(app(agentActor(f.runId))).get(`/api/issues/${f.childId}${encodeURI(suffix)}`)).status).toBe(status);
    expect(await reads(f.runId)).toEqual([]);
    expect(await pending(f)).toBe(true);
  });

  it("does not let a read of an older finished revision deliver a newer completion", async () => {
    const f = await seed("done", 70, { childRevisionAgeMs: 60_000, wakeAgeMs: 10_000 });
    expect((await request(app(agentActor(f.runId))).get(`/api/issues/${f.childId}`)).status).toBe(200);
    expect(await reads(f.runId)).toHaveLength(1);
    expect(await pending(f)).toBe(true);
  });
});
