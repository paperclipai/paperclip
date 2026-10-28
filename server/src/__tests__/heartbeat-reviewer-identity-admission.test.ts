import { initializeRunIdentity } from "../services/run-identity.js";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { agents, authUsers, companies, companyMemberships, createDb, heartbeatRuns, issues, issueComments, runIdentityContexts, agentWakeupRequests } from "@paperclipai/db";
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("reviewer identity admission", () => {
  let fixture: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const markers: string[] = [];
  beforeAll(async () => {
    fixture = await startEmbeddedPostgresTestDatabase("reviewer-identity-");
    db = createDb(fixture.connectionString);
    await db.insert(authUsers).values({ id: "board", name: "Sponsor", email: "sponsor@example.test", createdAt: new Date(), updatedAt: new Date() });
  }, 90_000);
  beforeEach(async () => { await db.execute(sql`TRUNCATE TABLE companies CASCADE`); });
  afterEach(async () => { vi.useRealTimers(); await Promise.all(markers.splice(0).map(path => rm(path, { force: true }))); });
  afterAll(async () => { await db?.$client.end(); await fixture?.cleanup(); });
  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID(), authorId = randomUUID(), issueId = randomUUID(), stageId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Consumer fixture", issuePrefix: "C" + companyId.slice(0, 7), defaultResponsibleUserId: "board" });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "board",
      membershipRole: "operator", status: "active" });
    await db.insert(agents).values([
      { id: agentId, companyId, name: "Reviewer", role: "engineer", status: "idle", adapterType: "process", runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } },
      { id: authorId, companyId, name: "Author", role: "engineer", status: "idle", adapterType: "process", runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } },
    ]);
    const [issue] = await db.insert(issues).values({ id: issueId, companyId, title: "Pending review", status: "in_review",
      responsibleUserId: "board", assigneeAgentId: agentId,
      executionPolicy: { mode: "normal", commentRequired: true, stages: [{ id: stageId, type: "review", approvalsNeeded: 1,
        participants: [{ id: randomUUID(), type: "agent", agentId }] }] },
      executionState: { status: "pending", currentStageId: stageId, currentStageIndex: 0, currentStageType: "review",
        currentParticipant: { type: "agent", agentId }, returnAssignee: { type: "agent", agentId: authorId },
        completedStageIds: [], lastDecisionId: null, lastDecisionOutcome: null, changesRequestedCount: 2,
        reviewRequest: { instructions: "Review the same submission" } } }).returning();
    const [source] = await db.insert(heartbeatRuns).values({ companyId, agentId: authorId, status: "cancelled",
      errorCode: "issue_reassigned", finishedAt: new Date(), responsibleUserId: "board", contextSnapshot: { issueId },
      resultJson: { executionCancellation: { state: "acknowledged" }, reassignmentStopConfirmed: true } }).returning();
    return { companyId, agentId, issueId, source, issue };
  }

  it("executes an unchanged legacy review after legitimate null identity initialization", async () => {
    const f = await seed();
    await db.update(issues).set({ responsibleUserId: null }).where(eq(issues.id, f.issueId));
    const [busy] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running" }).returning();
    const marker = join(process.env.TMPDIR!, `identity-provider-${randomUUID()}`); markers.push(marker);
    await db.update(agents).set({ adapterConfig: { command: process.execPath,
      args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)},'started')`] } }).where(eq(agents.id, f.agentId));
    const service = heartbeatService(db, { runtimeEnv: { ...process.env, PAPERCLIP_IN_WORKTREE: "false" } });
    try {
      const run = await service.wakeup(f.agentId, { source: "assignment", reason: "execution_review_requested",
        payload: { issueId: f.issueId }, requestedByActorType: "agent", requestedByActorId: f.source.agentId });
      expect(run).toBeTruthy();
      await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, busy.id));
      await service.resumeQueuedRuns(); await service.drainActiveRunExecutions();
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run!.id)))[0])
        .toMatchObject({ status: "succeeded", errorCode: null, responsibleUserId: "board" });
      expect(await readFile(marker, "utf8")).toBe("started");
    } finally { await service.drainActiveRunExecutions(); }
  });
  it.each(["seed", "origin", "message", "operator", "non-null", "origin-null"] as const)("preserves %s identity selection while admitting a legacy review", async kind => {
    const f = await seed();
    for (const id of ["origin", "writer", "operator"]) {
      await db.insert(authUsers).values({ id, name: id, email: `${id}@example.test`, createdAt: new Date(), updatedAt: new Date() }).onConflictDoNothing();
      await db.insert(companyMemberships).values({ companyId: f.companyId, principalType: "user", principalId: id, membershipRole: "operator", status: "active" });
    }
    const origin = await initializeRunIdentity(db, { companyId: f.companyId, runId: f.source.id,
      issueId: f.issueId, responsibleUserId: kind === "origin-null" ? null : "origin", cause: "fixture" });
    await db.update(issues).set({ responsibleUserId: kind === "non-null" ? "board" : null,
      continuationIdentityContextId: ["seed", "non-null"].includes(kind) ? null : origin.id }).where(eq(issues.id, f.issueId));
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running" });
    const [message] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, authorUserId: "writer", body: "Review this instruction" }).returning();
    const manual = kind === "operator";
    const withMessage = kind === "message" || manual;
    const service = heartbeatService(db);
    const run = await service.wakeup(f.agentId, {
      source: manual ? "on_demand" : "assignment", triggerDetail: manual ? "manual" : "system", reason: "execution_review_requested",
      payload: { issueId: f.issueId, ...(withMessage ? { commentId: message.id } : {}) },
      contextSnapshot: withMessage ? { wakeCommentId: message.id, wakeCommentIds: [message.id] } : {},
      requestedByActorType: manual ? "user" : "agent", requestedByActorId: manual ? "operator" : f.source.agentId,
      ...(manual ? { manualUserWake: true } : {}),
    });
    expect(run).toBeTruthy();
    const [task] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    const expected = kind === "seed" || kind === "non-null" ? "board" : kind === "message" ? "writer" : manual ? "operator" : kind === "origin-null" ? null : "origin";
    expect(task.responsibleUserId).toBe(expected);
    if (kind !== "non-null") {
      const [identity] = await db.select().from(runIdentityContexts).where(eq(runIdentityContexts.id, run!.activeIdentityContextId!));
      expect(identity.responsibleUserId).toBe(expected);
      expect(run!.responsibleUserId).toBe(expected);
    }
    expect(task.executionPolicy).toEqual(f.issue.executionPolicy);
    expect(task.executionState).toEqual(f.issue.executionState);
  });


  it.each(["identity", "settlement"] as const)("rolls back %s failure without backfilling identity or admitting an orphan", async fault => {
    const f = await seed();
    await db.update(issues).set({ responsibleUserId: null }).where(eq(issues.id, f.issueId));
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running" });
    const observed = new Proxy(db, { get(target, key) {
      if (key !== "transaction") return Reflect.get(target, key);
      return (...args: Parameters<typeof db.transaction>) => target.transaction(async tx => {
        const fail = (transaction: typeof tx): typeof tx => new Proxy(transaction, { get(current, field) {
          if (fault === "identity" && field === "transaction") return (...nested: Parameters<typeof tx.transaction>) => current.transaction(n => nested[0](fail(n)), nested[1]);
          if (fault === "identity" && field === "insert") return (table: unknown) => {
            if (table === runIdentityContexts) throw new Error("synthetic identity settlement failure");
            return Reflect.apply(current.insert, current, [table]);
          };
          return Reflect.get(current, field);
        } });
        const value = await args[0](fail(tx));
        if (fault === "settlement" && value && typeof value === "object" && "kind" in value && value.kind === "queued") throw new Error("synthetic outer settlement failure");
        return value;
      }, args[1]);
    } });
    const opts = { source: "assignment" as const, reason: "execution_review_requested", payload: { issueId: f.issueId },
      requestedByActorType: "agent" as const, requestedByActorId: f.source.agentId };
    await expect(heartbeatService(observed).wakeup(f.agentId, opts)).rejects.toThrow("synthetic");
    expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0].responsibleUserId).toBeNull();
    expect(await db.select().from(runIdentityContexts).where(eq(runIdentityContexts.companyId, f.companyId))).toHaveLength(0);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, f.agentId))).toHaveLength(1);
    expect(await heartbeatService(db).wakeup(f.agentId, opts)).toBeTruthy();
    expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0].responsibleUserId).toBe("board");
  });

});
