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
  afterEach(async () => { vi.restoreAllMocks(); vi.useRealTimers(); await Promise.all(markers.splice(0).map(path => rm(path, { force: true }))); });
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

  it.each(["default", "origin", "operator", "non-null"] as const)("applies later ordinary queued comments with %s identity before first provider dispatch", async kind => {
    const f = await seed();
    await db.insert(authUsers).values({ id: "writer", name: "Writer", email: "writer@example.test", createdAt: new Date(), updatedAt: new Date() }).onConflictDoNothing();
    await db.insert(companyMemberships).values({ companyId: f.companyId, principalType: "user", principalId: "writer", membershipRole: "operator", status: "active" });
    await db.update(issues).set({ responsibleUserId: kind === "non-null" ? "board" : null }).where(eq(issues.id, f.issueId));
    if (kind === "origin") await initializeRunIdentity(db, { companyId: f.companyId, issueId: f.issueId,
      runId: f.source.id, responsibleUserId: "board", cause: "origin" });
    const [busy] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running" }).returning();
    await db.update(agents).set({ adapterConfig: { command: process.execPath, args: ["-e", "process.exit(0)"] } }).where(eq(agents.id, f.agentId));
    const service = heartbeatService(db, { runtimeEnv: { ...process.env, PAPERCLIP_IN_WORKTREE: "false" } });
    try {
      const original = await service.wakeup(f.agentId, { source: kind === "operator" ? "on_demand" : "assignment",
        triggerDetail: kind === "operator" ? "manual" : "system", reason: "execution_review_requested", payload: { issueId: f.issueId },
        requestedByActorType: kind === "operator" ? "user" : "agent", requestedByActorId: kind === "operator" ? "board" : f.source.agentId,
        ...(kind === "operator" ? { manualUserWake: true } : {}) });
      const [message] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId,
        authorUserId: "writer", body: "A later ordinary instruction" }).returning();
      const joined = await service.wakeup(f.agentId, { source: "automation", reason: "issue_commented",
        payload: { issueId: f.issueId, commentId: message.id }, contextSnapshot: { wakeCommentId: message.id },
        requestedByActorType: "user", requestedByActorId: "writer" });
      expect(joined?.id).toBe(original!.id);
      const [queued] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, original!.id));
      expect(queued.contextSnapshot?.reviewerAssignmentGeneration).toBe(original!.contextSnapshot?.reviewerAssignmentGeneration);
      await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, busy.id));
      await service.resumeQueuedRuns(); await service.drainActiveRunExecutions();
      const [finished] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, original!.id));
      const [finishedActive] = await db.select().from(runIdentityContexts).where(eq(runIdentityContexts.id, finished.activeIdentityContextId!));
      const expectedUser = kind === "operator" ? "board" : "writer";
      expect(finished).toMatchObject({ status: "succeeded", responsibleUserId: expectedUser });
      expect(finishedActive.responsibleUserId).toBe(expectedUser);
      expect(finished.contextSnapshot?.reviewerAssignmentGeneration).toBe(original!.contextSnapshot?.reviewerAssignmentGeneration);
      const replay = await initializeRunIdentity(db, { companyId: f.companyId, runId: finished.id, issueId: f.issueId,
        responsibleUserId: "board", messageIds: [], cause: "restart" });
      expect(replay.id).toBe(finishedActive.id);
    } finally { await service.drainActiveRunExecutions(); }
  });

  async function identityReview() {
    const f = await seed();
    await db.update(issues).set({ responsibleUserId: null,
      executionPolicy: { ...f.issue.executionPolicy!, commentRequired: false } }).where(eq(issues.id, f.issueId));
    const marker = join(process.env.TMPDIR!, `identity-boundary-${randomUUID()}`); markers.push(marker);
    await db.update(agents).set({ adapterConfig: { command: process.execPath,
      args: ["-e", `require('node:fs').appendFileSync(${JSON.stringify(marker)},process.env.PAPERCLIP_RUN_ID+String.fromCharCode(10));setTimeout(()=>process.exit(0),2000)`] } }).where(eq(agents.id, f.agentId));
    const opts = { source: "assignment" as const, reason: "execution_review_requested", payload: { issueId: f.issueId },
      requestedByActorType: "agent" as const, requestedByActorId: f.source.agentId, idempotencyKey: `identity-boundary:${randomUUID()}` };
    return { f, marker, opts };
  }

  async function recordProviderComment(f: Awaited<ReturnType<typeof seed>>, runId: string, marker: string) {
    await vi.waitFor(async () => expect((await readFile(marker, "utf8")).trim().split(String.fromCharCode(10))).toContain(runId), { timeout: 10_000 });
    await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, createdByRunId: runId,
      authorAgentId: f.agentId, authorType: "agent", body: "The fixture provider completed this review turn." });
  }

  async function expectOriginalProviderOnce(f: Awaited<ReturnType<typeof seed>>, runId: string, marker: string) {
    const entries = (await readFile(marker, "utf8")).trim().split(String.fromCharCode(10));
    expect(entries.filter(id => id === runId)).toHaveLength(1);
    const followups = entries.filter(id => id !== runId);
    expect(followups.length).toBeLessThanOrEqual(1);
    for (const id of followups) {
      const [retry] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id));
      expect(retry).toMatchObject({ companyId: f.companyId, retryOfRunId: runId,
        contextSnapshot: { retryReason: "execution_review_participant_recovery" } });
    }
  }

  it("keeps identity backfill and provider invisible until outer admission commit", async () => {
    const { f, marker, opts } = await identityReview();
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const transaction = db.transaction.bind(db);
    vi.spyOn(db, "transaction").mockImplementation((...args: Parameters<typeof db.transaction>) => transaction(async tx => {
      const value = await args[0](tx);
      if (value && typeof value === "object" && "kind" in value && value.kind === "queued") { entered(); await gate; }
      return value;
    }, args[1]));
    const service = heartbeatService(db, { runtimeEnv: { ...process.env, PAPERCLIP_IN_WORKTREE: "false" } });
    const admission = service.wakeup(f.agentId, opts);
    try {
      await Promise.race([ready, admission.then(() => { throw new Error("admission bypassed outer commit barrier"); })]);
      expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0].responsibleUserId).toBeNull();
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, f.agentId))).toHaveLength(0);
      expect(await db.select().from(runIdentityContexts).where(eq(runIdentityContexts.companyId, f.companyId))).toHaveLength(0);
      await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
      release(); const admitted = await admission; expect(admitted).toBeTruthy();
      await recordProviderComment(f, admitted!.id, marker); await service.drainActiveRunExecutions();
      await expectOriginalProviderOnce(f, admitted!.id, marker);
    } finally { release(); await admission; await service.drainActiveRunExecutions(); vi.restoreAllMocks(); }
  });

  it("recovers one identity admission after a committed response is lost", async () => {
    const { f, marker, opts } = await identityReview();
    const [busy] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running" }).returning();
    let lost = false;
    const unreliable = new Proxy(db, { get(target, key) {
      if (key !== "transaction") return Reflect.get(target, key);
      return async (...args: Parameters<typeof db.transaction>) => {
        const value = await Reflect.apply(target.transaction, target, args);
        if (!lost && value?.kind === "queued") { lost = true; throw new Error("synthetic committed identity response loss"); }
        return value;
      };
    } });
    await expect(heartbeatService(unreliable).wakeup(f.agentId, opts)).rejects.toThrow("synthetic committed identity response loss");
    expect(lost).toBe(true);
    const original = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, f.agentId))).find(run => run.id !== busy.id)!;
    const service = heartbeatService(db, { runtimeEnv: { ...process.env, PAPERCLIP_IN_WORKTREE: "false" } });
    try {
      const resumed = await service.wakeup(f.agentId, opts);
      expect(resumed?.id).toBe(original.id);
      expect(await db.select().from(runIdentityContexts).where(eq(runIdentityContexts.runId, original.id))).toHaveLength(1);
      await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, busy.id));
      await service.resumeQueuedRuns(); await recordProviderComment(f, original.id, marker); await service.drainActiveRunExecutions();
      await expectOriginalProviderOnce(f, original.id, marker);
    } finally { await service.drainActiveRunExecutions(); }
  });

  it("rolls back a comment identity claim and retries without duplicate accepted messages", async () => {
    const { f, marker, opts } = await identityReview();
    const [busy] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running" }).returning();
    await db.insert(authUsers).values({ id: "writer", name: "Writer", email: "writer@example.test", createdAt: new Date(), updatedAt: new Date() }).onConflictDoNothing();
    await db.insert(companyMemberships).values({ companyId: f.companyId, principalType: "user", principalId: "writer", membershipRole: "operator", status: "active" });
    const service = heartbeatService(db, { runtimeEnv: { ...process.env, PAPERCLIP_IN_WORKTREE: "false" } });
    const original = await service.wakeup(f.agentId, opts);
    const [message] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, authorUserId: "writer", body: "New queued instruction" }).returning();
    await service.wakeup(f.agentId, { source: "automation", reason: "issue_commented", payload: { issueId: f.issueId, commentId: message.id },
      contextSnapshot: { wakeCommentId: message.id }, requestedByActorType: "user", requestedByActorId: "writer" });
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, busy.id));
    let injected = false;
    const unreliable = new Proxy(db, { get(target, key) {
      if (key !== "transaction") return Reflect.get(target, key);
      return (...args: Parameters<typeof db.transaction>) => target.transaction(async tx => {
        const value = await args[0](tx);
        if (value && typeof value === "object" && "kind" in value && value.kind === "claimed") {
          injected = true; throw new Error("synthetic identity claim settlement failure");
        }
        return value;
      }, args[1]);
    } });
    await expect(heartbeatService(unreliable).resumeQueuedRuns()).rejects.toThrow("synthetic identity claim settlement failure");
    expect(injected).toBe(true);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, original!.id)))[0])
      .toMatchObject({ status: "queued", responsibleUserId: "board", activeIdentityContextId: original!.activeIdentityContextId });
    expect(await db.select().from(runIdentityContexts).where(eq(runIdentityContexts.messageId, message.id))).toHaveLength(0);
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
    try {
      const second = heartbeatService(db, { runtimeEnv: { ...process.env, PAPERCLIP_IN_WORKTREE: "false" } });
      await Promise.all([service.resumeQueuedRuns(), second.resumeQueuedRuns()]);
      await recordProviderComment(f, original!.id, marker);
      await Promise.all([service.drainActiveRunExecutions(), second.drainActiveRunExecutions()]);
      expect(await db.select().from(runIdentityContexts).where(eq(runIdentityContexts.messageId, message.id))).toHaveLength(1);
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, original!.id)))[0])
        .toMatchObject({ status: "succeeded", responsibleUserId: "writer" });
      await expectOriginalProviderOnce(f, original!.id, marker);
    } finally { await service.drainActiveRunExecutions(); }
  });

  it("rejects a foreign active identity without mutating that company", async () => {
    const { f, marker, opts } = await identityReview();
    const [busy] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running" }).returning();
    const service = heartbeatService(db, { runtimeEnv: { ...process.env, PAPERCLIP_IN_WORKTREE: "false" } });
    const original = await service.wakeup(f.agentId, opts);
    const foreign = await seed();
    const foreignIdentity = await initializeRunIdentity(db, { companyId: foreign.companyId, runId: foreign.source.id,
      issueId: foreign.issueId, responsibleUserId: "board", cause: "foreign fixture" });
    await db.update(heartbeatRuns).set({ activeIdentityContextId: foreignIdentity.id }).where(eq(heartbeatRuns.id, original!.id));
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, busy.id));
    await service.resumeQueuedRuns();
    expect((await db.select().from(runIdentityContexts).where(eq(runIdentityContexts.id, foreignIdentity.id)))[0]).toEqual(foreignIdentity);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, original!.id)))[0].status).toBe("cancelled");
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });

  });

});
